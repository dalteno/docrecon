# ADR-0002 — Integer arithmetic in minor units, tolerances in basis points

**Status:** accepted · 2026-10-15

## Context
`3 × 0.10` in binary floating point is `0.30000000000000004`. Two engines (C# `decimal`, JS `Number`) round
differently at the half-cent. Either problem produces false findings or, worse, masks real ones.

## Decision
- Money is parsed to cents, quantities and weights to thousandths, counts to integers — as `BigInteger` / `BigInt`.
- Multiplication qty × price is integer multiplication followed by one rounding step, **half away from zero**.
- Tolerances are basis points (1 bp = 0.01 %) and minor units; a relative tolerance is tested as
  `|a − b| × 10000 > bp × max(|a|, |b|)` — no division anywhere.
- Inputs are specified to at most the scale precision; a further digit is used only to round.

## Consequences
- Case C15 (float trap), C16/C17/C17b (half-cent) and C33/C34 (tolerance boundary) are part of the shared cases.
- The parity gate is meaningful: identical integers in, identical text out.
