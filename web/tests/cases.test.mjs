/** Runs every shared case through the JS engine. Expectation = exact set of "RULE|key". Run: node --test web/tests */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcile, toMinor, fromMinor, mulQtyPrice, exceedsTolerance, dayNumber, normParty, DEFAULT_OPTIONS, RULES } from "../docrecon.js";

const casesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cases");
const files = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();

test("at least 40 shared cases exist", () => assert.ok(files.length >= 40, `found ${files.length}`));

for (const f of files) {
  const c = JSON.parse(readFileSync(join(casesDir, f), "utf8"));
  test(`${c.id} — ${c.title}`, () => {
    const report = reconcile(c.bundle, c.options ?? {});
    const got = report.findings.map((x) => `${x.rule}|${x.key}`).sort();
    assert.deepEqual(got, c.expect, JSON.stringify(report.findings, null, 1));
    for (const x of report.findings) {
      assert.ok(x.reason && x.field && x.severity, "every finding explains itself");
      assert.ok(x.expected !== undefined && x.actual !== undefined);
    }
    const expectedStatus = report.summary.BLOCKER ? "BLOCKED" : report.summary.WARNING ? "REVIEW" : "PASS";
    assert.equal(report.status, expectedStatus);
  });
}

test("determinism: same input → identical JSON", () => {
  const c = JSON.parse(readFileSync(join(casesDir, "C50_everything_wrong.json"), "utf8"));
  const a = JSON.stringify(reconcile(c.bundle)), b = JSON.stringify(reconcile(structuredClone(c.bundle)));
  assert.equal(a, b);
});

test("input is never mutated", () => {
  const c = JSON.parse(readFileSync(join(casesDir, "C50_everything_wrong.json"), "utf8"));
  const before = JSON.stringify(c.bundle); reconcile(c.bundle); assert.equal(JSON.stringify(c.bundle), before);
});

test("toMinor / fromMinor round-trip and rounding", () => {
  assert.equal(toMinor("1200.00", 100), 120000n);
  assert.equal(toMinor("0.015", 100), 2n); // half away from zero
  assert.equal(toMinor("-0.015", 100), -2n);
  assert.equal(toMinor("1,200.5", 100), 120050n);
  assert.equal(toMinor("abc", 100), null);
  assert.equal(toMinor("1.200,00", 100), null); // German grouping is never reinterpreted
  assert.equal(toMinor("1,5", 100), null); // comma decimal is never read as 15
  assert.equal(toMinor("12,34,567", 100), null); // Indian grouping: not supported, not guessed
  assert.equal(toMinor("", 100), null);
  assert.equal(toMinor(null, 100), null);
  assert.equal(fromMinor(-5n, 100), "-0.05");
  assert.equal(fromMinor(12n, 1), "12");
});

test("mulQtyPrice: integer, half away from zero", () => {
  assert.equal(mulQtyPrice(3000n, 10n), 30n); // 3 × 0.10
  assert.equal(mulQtyPrice(1500n, 1n), 2n); // 1.5 × 0.01 = 0.015 → 0.02
  assert.equal(mulQtyPrice(-1500n, 1n), -2n);
  assert.equal(mulQtyPrice(2500n, 1n), 3n); // 0.025 → 0.03
});

test("exceedsTolerance uses the larger value as base", () => {
  assert.equal(exceedsTolerance(2029800n, 1990000n, 200), false);
  assert.equal(exceedsTolerance(2031000n, 1990000n, 200), true);
  assert.equal(exceedsTolerance(100n, 100n, 0), false);
  assert.equal(exceedsTolerance(101n, 100n, 0), true);
});

test("dayNumber validates calendar", () => {
  assert.equal(dayNumber("2026-02-30"), null);
  assert.equal(dayNumber("2028-02-29") !== null, true);
  assert.equal(dayNumber("2027-02-29"), null);
  assert.equal(dayNumber("2026-03-09") - dayNumber("2026-03-02"), 7);
  assert.equal(dayNumber("2026-03-01") - dayNumber("2025-03-01"), 365);
  assert.equal(dayNumber("2026/03/01"), null);
});

test("normParty strips punctuation and one trailing legal suffix", () => {
  assert.equal(normParty("Rheinwerk Automation, GmbH.", DEFAULT_OPTIONS.legalSuffixes), "RHEINWERK AUTOMATION");
  assert.equal(normParty("GmbH", DEFAULT_OPTIONS.legalSuffixes), "GMBH"); // never reduce to empty
});

test("rule catalogue is stable: 22 rules, unique ids", () => {
  assert.equal(RULES.length, 22);
  assert.equal(new Set(RULES.map((r) => r.id)).size, 22);
});

test("golden reports (if present) match the current engine output exactly", () => {
  const goldenDir = join(casesDir, "golden");
  let n = 0;
  for (const f of files) {
    const c = JSON.parse(readFileSync(join(casesDir, f), "utf8"));
    let golden;
    try { golden = readFileSync(join(goldenDir, `${c.id}.report.json`), "utf8"); } catch { continue; }
    assert.equal(JSON.stringify(reconcile(c.bundle, c.options ?? {}), null, 2) + "\n", golden, c.id);
    n++;
  }
  assert.ok(n === 0 || n === files.length, `golden coverage ${n}/${files.length}`);
});

test("non-object line entries never throw: null, number, string, array → R21 for that line", () => {
  const base = JSON.parse(readFileSync(join(casesDir, "C00_clean.json"), "utf8")).bundle;
  for (const bad of [null, 5, "x", [], true]) {
    const b = structuredClone(base);
    b.invoice.lines[0] = bad;
    b.packingList.lines[1] = bad;
    const r = reconcile(b, {});
    assert.ok(r.findings.some((f) => f.rule === "R21" && f.key === "invoice.lines[0].sku"), `invoice ${String(bad)}`);
    assert.ok(r.findings.some((f) => f.rule === "R21" && f.key === "packingList.lines[1].sku"), `packing ${String(bad)}`);
  }
});

// Absence is never a match. Every field some rule reads must produce a finding when blanked — a sweep, not a hand-picked list,
// so a future rule that reads a new field without declaring it shows up here.
const RULE_READ_FIELDS = {
  invoice: ["number", "date", "currency", "incoterm", "buyer", "total"],
  packingList: ["number", "date", "invoiceRef", "shipmentRef", "totalPackages", "totalNetKg", "totalGrossKg"],
  billOfLading: ["number", "date", "shipmentRef", "consignee", "packages", "grossKg"],
};
const RULE_READ_LINE_FIELDS = { invoice: ["sku", "qty", "unit", "unitPrice", "lineTotal", "hsCode"], packingList: ["sku", "qty", "unit", "packages", "netKg", "grossKg", "hsCode"] };
test("blanking any field a rule reads never yields a clean PASS (R21 or R22 is raised, once, naming the field)", () => {
  const base = JSON.parse(readFileSync(join(casesDir, "C00_clean.json"), "utf8")).bundle;
  assert.equal(reconcile(base, {}).findings.length, 0, "C00 must be clean to start");
  for (const [doc, fields] of Object.entries(RULE_READ_FIELDS)) for (const k of fields) for (const blank of ["", null, undefined]) {
    const b = structuredClone(base); b[doc][k] = blank;
    const r = reconcile(b, {});
    const hits = r.findings.filter((f) => (f.rule === "R21" || f.rule === "R22") && f.field === k);
    assert.ok(hits.length >= 1, `${doc}.${k} blanked (${String(blank)}) → no R21/R22`);
    assert.ok(r.findings.filter((f) => f.rule === "R22").length <= 1, `${doc}.${k}: R22 must be reported once`);
  }
  for (const [doc, fields] of Object.entries(RULE_READ_LINE_FIELDS)) for (const k of fields) {
    const b = structuredClone(base); b[doc].lines[0][k] = "";
    const r = reconcile(b, {});
    assert.ok(r.findings.some((f) => (f.rule === "R21" || f.rule === "R22") && f.field === k), `${doc}.lines[0].${k} blanked → no R21/R22`);
  }
});

test("non-numeric where a number is expected is R21, not a silent skip", () => {
  const base = JSON.parse(readFileSync(join(casesDir, "C00_clean.json"), "utf8")).bundle;
  for (const [doc, k] of [["packingList", "totalGrossKg"], ["packingList", "totalPackages"], ["billOfLading", "grossKg"], ["billOfLading", "packages"]]) {
    const b = structuredClone(base); b[doc][k] = "n/a";
    assert.ok(reconcile(b, {}).findings.some((f) => f.rule === "R21" && f.field === k), `${doc}.${k}`);
  }
});
