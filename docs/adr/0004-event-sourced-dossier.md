# ADR-0004 — The dossier workflow is an event-sourced pure function with time as input

**Status:** accepted · 2026-10-16

## Context
The real process (customs-document dossiers for an Egyptian broker, built by our team) has documents arriving in
any order, several roles acting on them, SLAs, an existing ERP that must receive data exactly once, and auditors who
ask "who decided what, when, and why". Workflow engines that hide state in a database and read the wall clock are
hard to test and impossible to replay.

## Decision
- `run(dossier, commands)` folds an ordered command list into an append-only event list; state is derived, never stored.
- Every command carries `at`; SLA breaches are evaluated against command dates. There is no clock.
- Every refused command is itself an event (`CommandRejected`, with rule id and reason); idempotent no-ops are
  `CommandIgnored`. Nothing is silently dropped.
- Side effects are outbox records: `IntegrationQueued` (key = `dossier|type|version`) and `NotificationQueued`.
  Sending, writing to Oracle staging tables and e-mail are adapters outside the engine. The engine never writes to
  operational ERP tables — that is a red line, not a configuration.
- The reconciliation gate reuses docrecon unchanged; the three trade documents are reconciled whenever their
  version set changes, and a BLOCKED result routes to compliance and blocks the customs entry.

## Consequences
- Replaying the same commands yields the same events, byte for byte; the JS and .NET engines are compared on it.
- A visitor can drive the demo with any order of commands and read the exact rule behind every refusal.
- Scanned documents (OCR) and e-mail intake are adapters with their own confidence thresholds and review queues;
  they are documented, not demonstrated — the engine's correctness does not depend on them.
