# ADR-0003 — The shared cases are the specification; expectations are hand-written

**Status:** accepted · 2026-10-15

## Context
A test that asserts whatever the engine currently returns proves nothing. Two implementations that are only
compared to each other can share the same bug.

## Decision
- `cases/generate.mjs` builds every case from one consistent synthetic bundle plus a named mutation, and states the
  expected finding set **by hand** (`RULE|key`). The generator never calls the engine.
- Both engines must produce exactly that set (no extra, no missing finding).
- Separately, the JS engine's full reports are frozen as golden files; the .NET engine must reproduce them field by
  field. Golden files are refreshed only after an intentional rule change, in the same commit as the change.
- Adversarial cases (flagged `adversarial: true`) exist to try to fool the engine: balancing negative lines,
  split SKUs, legal-suffix variants, separators in HS codes, leap days, exact tolerance boundaries.

## Consequences
- A rule change is visible three times in review: generator, golden diff, both engines.
- `git diff --exit-code -- cases` in CI prevents hand-edited case files from drifting from the generator.
