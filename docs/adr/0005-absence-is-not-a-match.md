# ADR-0005 — Absence is not a match (R22)

**Date:** 2026-10-23 · **Status:** accepted · **Supersedes:** the "absent data is skipped and reported once" sentence of the README, which was only half true.

## Context
Rules R09, R11, R12, R17, R19 and R20 compared two values and skipped the comparison when either side was absent.
R21 covered only the structurally required fields (document, number, currency, lines, total, references).
Result: a bundle whose bill of lading had **no gross weight, no consignee and no date** reconciled as `PASS` with zero findings.
Found by an external review (23 fields could be blanked silently on `C00_clean`; 14 of them are read by a rule).

## Decision
1. New rule **R22 FIELD_ABSENT (WARNING)**: a field another rule reads is absent → one finding per field, the dependent rule is skipped. Key is the field path (`billOfLading.grossKg`, `packingList:VLV-050:unit`).
2. A non-number where a number is expected (weights, package counts, packing totals, BL physicals) is **R21**, never a silent skip.
3. Fields no rule reads (seller, shipper, ports, line descriptions) are not reported — reporting them would be noise, not evidence.
4. Severity is WARNING, not BLOCKER: an absent field means "could not check", which is `REVIEW`, not a proven defect.

## Consequences
- Rule count 21 → 22; six synthetic test lines gained HS codes they should always have had; cases C54–C56 pin the behaviour.
- A sweep test (JS and .NET) blanks every rule-read field on `C00_clean` and asserts R21/R22 names it — so a future rule that reads a new field without declaring it fails the suite.
- Golden reports regenerated; parity gate unchanged.
