# docrecon · docflow

Two small, dependency-free engines for the paperwork behind a sea shipment, each in .NET 10 and JavaScript,
each pinned by hand-written shared cases and a JS↔.NET parity gate:

- **docrecon** — reconciles **Commercial Invoice ↔ Packing List ↔ Bill of Lading** against 21 rules and explains every finding.
- **docflow** — an event-sourced **dossier workflow**: documents arrive in any order → routed to the responsible role →
  structured fields extracted → docrecon gate → approval → ERP outbox with idempotency keys → notifications →
  closure only when every required document is approved *and* integrated. 17 rules, 7 document types, 6 roles.

Live demos: [dalteno.com/#proof](https://dalteno.com/#proof) (docrecon) · [dalteno.com/lab/docflow/](https://dalteno.com/lab/docflow/) (docflow).

---

## docrecon

Two implementations, one rule catalogue, one set of shared cases:

| | .NET 10 (`src/Dalteno.DocRecon`) | JavaScript (`web/docrecon.js`) |
|---|---|---|
| purpose | production library (ERP / customs-broker back office) | same rules in the browser — the live demo on [dalteno.com](https://dalteno.com) |
| tests | xUnit: 56 shared cases + helper tests | `node --test`: 56 shared cases + helper tests |
| parity | every case must reproduce the JS **golden report** field by field | every case must match the hand-written expectation |

CI runs both. A change that makes the two engines disagree fails the build.

## What it checks

21 rules (`R01`–`R21`), each with a stable id, a severity and a one-line contract.
Every finding tells you **which rule, which field, what was expected, what was found, and why** — never a bare "mismatch".

| id | code | severity | contract |
|---|---|---|---|
| R01 | PACKING_INVOICE_REF | BLOCKER | Packing list must reference the invoice number. |
| R02 | BL_SHIPMENT_REF | BLOCKER | BL and packing list must carry the same shipment reference. |
| R03 | LINE_MISSING_IN_PACKING | BLOCKER | Every invoiced SKU must appear on the packing list. |
| R04 | LINE_EXTRA_IN_PACKING | BLOCKER | Every packed SKU must appear on the invoice. |
| R05 | QTY_MISMATCH | BLOCKER | Invoiced qty = packed qty per SKU (±tolerance). |
| R06 | LINE_TOTAL_ARITHMETIC | BLOCKER | qty × unit price = line total (±0.01). |
| R07 | INVOICE_TOTAL_ARITHMETIC | BLOCKER | Σ line totals = invoice total (±0.01). |
| R08 | CURRENCY_MIXED | BLOCKER | No line priced in a foreign currency. |
| R09 | GROSS_WEIGHT_BL_VS_PACKING | WARNING | BL gross ≈ packing gross (±2 %). |
| R10 | NET_GT_GROSS | BLOCKER | Net weight never exceeds gross. |
| R11 | PACKAGE_COUNT_BL_VS_PACKING | WARNING | BL packages = packing packages. |
| R12 | DATE_ORDER | WARNING | invoice ≤ packing ≤ shipped-on-board, span ≤ 60 days. |
| R13 | HS_CODE_FORMAT | INFO | HS code is 6–10 digits. |
| R14 | HS_CODE_CONFLICT | WARNING | Same SKU, same HS code on both documents. |
| R15 | DUPLICATE_SKU_CONFLICT | WARNING | Repeated SKU on the invoice with a different price/HS. |
| R16 | NON_POSITIVE_VALUE | BLOCKER | Quantities, prices, weights, packages > 0. |
| R17 | CONSIGNEE_MISMATCH | WARNING | BL consignee = invoice buyer (legal form ignored). |
| R18 | INCOTERM_UNKNOWN | INFO | Incoterms 2020 code. |
| R19 | UNIT_MISMATCH | BLOCKER | Unit of measure agrees per SKU. |
| R20 | PACKING_TOTALS_ARITHMETIC | WARNING | Packing totals = Σ lines. |
| R21 | MISSING_REQUIRED | BLOCKER | Required document / field / line set present. |

Report status: any BLOCKER → `BLOCKED`; else any WARNING → `REVIEW`; else `PASS`.

## Design decisions (see `docs/adr`)

1. **No floating point.** Money in cents, quantities and kilograms in thousandths, all integer (`BigInteger` / `BigInt`).
   `3 × 0.10` is `0.30`, not `0.30000000000000004`. Rounding is half-away-from-zero and is itself under test.
2. **Tolerances are integers too** — basis points and minor units — so "2 %" means the same thing in both engines.
3. **Pure function.** No I/O, no clock, no randomness, input never mutated. Same bundle + same options ⇒ identical report.
4. **Fail loud, never guess.** A non-numeric quantity is a finding (`R21`), not an exception and not a silent zero.
   Absent data is skipped by the rules that need it and reported once.
5. **The cases are the spec.** `cases/generate.mjs` holds 56 hand-written expectations (19 adversarial: float traps, European number formats,
   half-cent rounding, negative lines that balance the total, duplicate SKUs, legal-suffix variants, leap days, boundary
   tolerances). Expectations are never derived from the engine.

## Use

```csharp
using Dalteno.DocRecon;

var bundle = JsonSerializer.Deserialize<Bundle>(json, Json.Options);
var report = Reconciler.Reconcile(bundle, new ReconcileOptions { WeightToleranceBp = 300 });
foreach (var f in report.Findings)
    Console.WriteLine($"{f.Rule} {f.Severity} {f.Key}: {f.Reason}");
```

```js
import { reconcile } from "./web/docrecon.js";
const report = reconcile(bundle, { weightToleranceBp: 300 });
```

Input shape: see any file under `cases/` (`bundle` key). Numeric fields may be numbers or strings. "1,200.00" is accepted (English grouping); "1.200,00" and "1,5" are **not** reinterpreted — they produce an R21 finding (fail loud, never guess).

---

## docflow

`src/Dalteno.DocFlow` · `web/docflow.js` · cases in `cases-docflow/` · ADR-0004.

`run(dossier, commands)` folds an ordered command list — `RECEIVE`, `APPROVE`, `REJECT`, `INTEGRATION_ACK`, `TICK`,
each with an `at` date — into an append-only event list. No clock, no I/O; replay is byte-identical.

| id | code | contract |
|---|---|---|
| F01 | ROLE_AUTHORISATION | Only the assigned role may approve or reject a document type. |
| F02 | IDEMPOTENT_RECEIVE | Same bytes (sha) received twice → ignored, never duplicated. |
| F03 | VERSION_SUPERSEDES | Higher version supersedes (approval + pending integration invalidated, re-routed); lower/equal rejected. |
| F04 | EXTRACTION_BEFORE_APPROVAL | No approval while required fields are missing. |
| F05 | APPROVAL_BEFORE_INTEGRATION | Only a successful approval queues an integration record. |
| F06 | INTEGRATION_IDEMPOTENCY | Key = `dossier\|type\|version`; unknown key rejected, repeated ack ignored. |
| F07 | RECONCILIATION_GATE | Invoice + packing list + BL extracted → docrecon runs; BLOCKED → compliance routed, customs entry blocked. |
| F08 | PREREQUISITE_APPROVAL | Customs entry needs an approved certificate of origin. |
| F09 | INSURANCE_COVERS_INVOICE | Cover ≥ invoice total, same currency, invoice first. |
| F10 | SLA_BREACH | Days since receipt beyond the role's SLA → one breach per document version. |
| F11 | CLOSE_WHEN_COMPLETE | Closes exactly when every required document is INTEGRATED; later commands rejected. |
| F12 | CONDITIONAL_DOCUMENT | Inspection certificate required only when the dossier says so. |
| F13 | ONE_NOTIFICATION_PER_HANDOFF | Routing, rejection, extraction failure, compliance routing, SLA breach → exactly one notification each. |
| F14 | REJECTION_NEEDS_REASON | A rejection without a reason is rejected. |
| F15 | UNKNOWN_DOCUMENT_TYPE | Types outside the definition are rejected. |
| F16 | INVALID_COMMAND | No valid ISO date, or unknown verb → rejected. |
| F17 | MONOTONIC_TIME | A command dated before the latest processed command is rejected — the dossier clock never runs backwards. |

Dossier definition (data, not code): commercial invoice → FINANCE · packing list → WAREHOUSE · bill of lading →
LOGISTICS · certificate of origin, customs entry → CUSTOMS_BROKER · insurance certificate → FINANCE ·
inspection certificate → QUALITY (conditional). Integration adapter: Oracle staging tables (`DOCFLOW_STG.STG_<TYPE>`);
the engine never writes to operational ERP tables. OCR and e-mail intake are adapters outside the engine.

## Develop

```
node cases/generate.mjs && node cases-docflow/generate.mjs   # regenerate shared cases (must leave git clean)
node --test web/tests/cases.test.mjs web/tests/docflow.test.mjs
node web/tests/write-golden.mjs && node web/tests/write-golden-docflow.mjs   # after an intentional rule change
dotnet test                                                # both .NET libraries + parity with golden
```

## Scope

Rules cover document consistency, not customs law: valuation, origin, tariff classification and sanctions
screening are out of scope. All sample data is synthetic.

MIT © Dalteno — hello@dalteno.com
