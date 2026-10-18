/** The demo form must never lose fields it does not display (regression for C23: currency on a line was dropped). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcile } from "../docrecon.js";
import { roundTrip, effectiveBundle, applyEdit } from "../formmerge.js";

const casesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cases");
for (const f of readdirSync(casesDir).filter((x) => x.endsWith(".json")).sort()) {
  const c = JSON.parse(readFileSync(join(casesDir, f), "utf8"));
  test(`form round-trip preserves ${c.id} (incl. hidden fields) and its expected findings`, () => {
    const rt = effectiveBundle(roundTrip(c.bundle));
    assert.deepEqual(rt, effectiveBundle(c.bundle));
    const got = reconcile(rt, c.options ?? {}).findings.map((x) => `${x.rule}|${x.key}`).sort();
    assert.deepEqual(got, c.expect);
  });
}
test("editing a visible field keeps the hidden line currency (C23)", () => {
  const c = JSON.parse(readFileSync(join(casesDir, "C23_mixed_currency_line.json"), "utf8"));
  const b = structuredClone(c.bundle);
  applyEdit(b, "invoice", 1, "qty", "151");
  assert.equal(b.invoice.lines[1].currency, "USD");
  const rules = reconcile(effectiveBundle(b)).findings.map((x) => x.rule);
  assert.ok(rules.includes("R08") && rules.includes("R05"));
});
