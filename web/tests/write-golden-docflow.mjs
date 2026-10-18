import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../docflow.js";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); const casesDir = join(root, "cases-docflow"), goldenDir = join(casesDir, "golden");
mkdirSync(goldenDir, { recursive: true }); let n = 0;
for (const f of readdirSync(casesDir).filter((x) => x.endsWith(".json")).sort()) { const c = JSON.parse(readFileSync(join(casesDir, f), "utf8")); writeFileSync(join(goldenDir, `${c.id}.report.json`), JSON.stringify(run(c.dossier, c.commands), null, 2) + "\n"); n++; }
console.log(`wrote ${n} golden reports`);
