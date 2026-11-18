---
paths:
  - "src/**/*.ts"
  - "tests/**/*.ts"
  - "src/public/js/**/*.js"
---

# Code quality rules

Naming table and examples: `docs/coding-standards.md` §4–6.

- Before writing anything new, search for an existing constant, schema, util, formatter, or service that does it. Reuse; don't duplicate.
- Naming: camelCase folders/files as `<feature>.<role>.ts`; PascalCase types (no `I` prefix); UPPER_SNAKE constant objects; numeric durations suffixed `Ms`/`Min`.
- Functions: one job, ~≤ 40 lines, ≤ 3 positional params (else an options object), early returns, no deep nesting.
- Extract pure decision logic from I/O so it can be unit-tested.
- Tunables (timeouts, retries, backoffs, limits) come from `src/config` — no magic numbers. One-off local literals are fine.
- Comments explain why (cite requirement IDs like `FR-A4a`), not what.
- Every promise awaited or explicitly handled; no floating promises.
- Clean up timers, listeners, sockets, response bodies.
- No dead code, commented-out code, or speculative abstractions ("might need later").
- Keep a change focused on its task; don't refactor unrelated code in the same change without asking.
