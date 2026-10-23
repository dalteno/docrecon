/** Shared docflow cases through the JS engine. Run: node --test web/tests/cases.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, RULES, DEFAULT_DEFINITION } from "../docflow.js";

const casesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cases-docflow");
const files = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();

export function summarize(report) {
  return {
    status: report.status,
    documents: Object.fromEntries(Object.entries(report.documents).map(([t, d]) => [t, d.status])),
    reconciliation: report.reconciliation ? report.reconciliation.status : null,
    rejected: report.rejected.map((x) => `${x.rule}|${x.type ?? x.cmd}`).sort(),
    ignored: report.ignored.map((x) => `${x.rule}|${x.type ?? x.cmd}`).sort(),
    slaBreached: Object.entries(report.documents).filter(([, d]) => d.slaBreached).map(([t]) => t).sort(),
    slaBreaches: report.events.filter((e) => e.type === "SlaBreached").length,
    notifications: report.notifications.length,
    integrationQueued: report.integration.length,
    integrationAcked: report.integration.filter((i) => i.status === "ACKED").length,
  };
}

test("at least 40 shared cases", () => assert.ok(files.length >= 40, String(files.length)));

for (const f of files) {
  const c = JSON.parse(readFileSync(join(casesDir, f), "utf8"));
  test(`${c.id} — ${c.title}`, () => {
    const report = run(c.dossier, c.commands);
    assert.deepEqual(summarize(report), c.expect, JSON.stringify(report.events, null, 1));
    // F13: one notification per hand-off event
    const handoffs = report.events.filter((e) => ["Routed", "ApprovalRejected", "ExtractionFailed", "RoutedToCompliance", "SlaBreached"].includes(e.type)).length;
    assert.equal(report.notifications.length, handoffs, "F13");
    // every rejection names a rule and a reason
    for (const r of report.rejected) assert.ok(r.rule && r.reason);
    // seq is strictly increasing
    report.events.forEach((e, i) => assert.equal(e.seq, i + 1));
  });
}

test("determinism and no input mutation", () => {
  const c = JSON.parse(readFileSync(join(casesDir, "D40_late_approvals_full_dossier.json"), "utf8"));
  const before = JSON.stringify(c.commands);
  const a = JSON.stringify(run(c.dossier, c.commands)), b = JSON.stringify(run(structuredClone(c.dossier), structuredClone(c.commands)));
  assert.equal(a, b); assert.equal(JSON.stringify(c.commands), before);
});

test("rule catalogue: 18 rules, unique ids; definition has 7 documents and 6 required by default", () => {
  assert.equal(RULES.length, 18); assert.equal(new Set(RULES.map((r) => r.id)).size, 18);
  assert.equal(DEFAULT_DEFINITION.documents.length, 7);
  assert.equal(DEFAULT_DEFINITION.documents.filter((d) => d.required).length, 6);
});

test("golden reports (if present) match exactly", () => {
  const goldenDir = join(casesDir, "golden"); let n = 0;
  for (const f of files) {
    const c = JSON.parse(readFileSync(join(casesDir, f), "utf8"));
    let golden; try { golden = readFileSync(join(goldenDir, `${c.id}.report.json`), "utf8"); } catch { continue; }
    assert.equal(JSON.stringify(run(c.dossier, c.commands), null, 2) + "\n", golden, c.id); n++;
  }
  assert.ok(n === 0 || n === files.length, `golden coverage ${n}/${files.length}`);
});

// The flow must STOP on REVIEW, not merely "not be PASS" (external review, 23 Oct): assert the gate itself, the recorded acceptance,
// and that a re-run of reconciliation (new document version) clears the acceptance so it cannot be inherited.
test("F18: REVIEW stops the gated approval; an explicit, reasoned acceptance is recorded; a reconciliation re-run clears it", () => {
  const base = JSON.parse(readFileSync(join(casesDir, "D44_review_accepted_with_reason.json"), "utf8"));
  const r1 = run(base.dossier, base.commands);
  assert.equal(r1.reconciliation.status, "REVIEW");
  assert.equal(r1.documents.CUSTOMS_ENTRY.status, "APPROVED");
  assert.ok(r1.reconciliation.acceptedBy && r1.reconciliation.acceptedBy.role === "CUSTOMS_BROKER" && r1.reconciliation.acceptedBy.reason.length > 0);
  assert.equal(r1.events.filter((e) => e.type === "ReconciliationWarningsAccepted").length, 1);
  // same commands without the acceptance flag → the approval is rejected with F18 and the document stays AWAITING_APPROVAL
  const cmds = base.commands.map((c) => (c.cmd === "APPROVE" && c.type === "CUSTOMS_ENTRY" ? { ...c, acceptWarnings: undefined, reason: undefined } : c));
  const r2 = run(base.dossier, cmds);
  assert.equal(r2.documents.CUSTOMS_ENTRY.status, "AWAITING_APPROVAL");
  assert.ok(r2.rejected.some((x) => x.rule === "F18"));
  // after acceptance, a new BL version re-runs reconciliation and the acceptance is gone
  const bl = base.commands.find((c) => c.cmd === "RECEIVE" && c.type === "BILL_OF_LADING");
  const r3 = run(base.dossier, [...base.commands, { ...bl, version: 2, sha: "sha-bl-v2", at: "2026-03-12" }]);
  assert.equal(r3.reconciliation.acceptedBy, null);
});
