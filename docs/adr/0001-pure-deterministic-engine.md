# ADR-0001 — The engine is a pure, deterministic function

**Status:** accepted · 2026-10-15

## Context
Reconciliation results end up in audit trails and customs filings. A result that differs between two runs, two
machines or two implementations is worse than no result: nobody can tell which one to trust.

## Decision
`Reconcile(bundle, options)` has no I/O, no clock, no randomness and never mutates its input. Findings are emitted
in a fixed order (rule id, then key). The same input always yields a byte-identical report.

## Consequences
- Dates come from the documents, never from "today"; a span check compares document dates only.
- Golden reports can be committed and diffed; the JS and .NET engines are compared byte for byte.
- Anything environmental (locale, culture, timezone) is forbidden inside the engine: formatting is invariant.
