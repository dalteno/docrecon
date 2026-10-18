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

test("rule catalogue: 17 rules, unique ids; definition has 7 documents and 6 required by default", () => {
  assert.equal(RULES.length, 17); assert.equal(new Set(RULES.map((r) => r.id)).size, 17);
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
