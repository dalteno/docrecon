# ADR-0006 — A REVIEW reconciliation never passes the gate silently (F18)

**Date:** 2026-10-23 · **Status:** accepted · **Relates to:** ADR-0005 (R22).

## Context
After R22, a bundle with a blank BL gross weight reconciles as `REVIEW` with zero blockers. docflow's gate (F07) only stopped on `BLOCKED`,
so the customs entry could be approved while the weight check had never run — and nothing recorded that anyone had noticed.
"The approver sees the warnings" is not evidence; an event with a name and a reason is.

## Decision
- **F18 REVIEW_NEEDS_SIGNOFF**: when reconciliation is `REVIEW` and the dossier definition has `reconciliation.reviewNeedsSignoff` (default `true`),
  approving the gated document is rejected unless the command carries `acceptWarnings: true` and a non-empty `reason`.
- The acceptance is stored on the reconciliation state (`acceptedBy: {role, at, reason, findings}`) and emitted as `ReconciliationWarningsAccepted`.
- Any re-run of reconciliation (a new version of invoice / packing list / BL) clears the acceptance: it was given for specific findings.
- `BLOCKED` can never be accepted — F07 keeps precedence.
- Operators who want the old behaviour set `reviewNeedsSignoff: false` in their definition; the engine does not change for them.

## Consequences
- docflow 1.0.0 → 1.1.0; rules 17 → 18; cases 42 → 45 (D43–D45); goldens regenerated; JS and .NET tests assert that the flow *stops*,
  that the acceptance is recorded, and that a re-run clears it — not merely that the status "is not PASS".
