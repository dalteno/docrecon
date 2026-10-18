/**
 * Writes cases/golden/<id>.report.json — the full JS report for every shared case.
 * The C# test suite must reproduce these byte-for-byte (after canonical JSON re-serialisation): that is the parity gate.
 * Run only after cases.test.mjs is green: node web/tests/write-golden.mjs
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcile } from "../docrecon.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const casesDir = join(root, "cases"), goldenDir = join(casesDir, "golden");
mkdirSync(goldenDir, { recursive: true });
let n = 0;
for (const f of readdirSync(casesDir).filter((x) => x.endsWith(".json")).sort()) {
  const c = JSON.parse(readFileSync(join(casesDir, f), "utf8"));
  const report = reconcile(c.bundle, c.options ?? {});
  writeFileSync(join(goldenDir, `${c.id}.report.json`), JSON.stringify(report, null, 2) + "\n");
  n++;
}
console.log(`wrote ${n} golden reports to ${goldenDir}`);
