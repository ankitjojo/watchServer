---
paths:
  - "src/**/*.ts"
  - "tests/**/*.ts"
---

# TypeScript rules

Full rationale and examples: `docs/coding-standards.md` §1–3.

- Strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` is on. Fix the type, never loosen `tsconfig.json`.
- No `any`. Untrusted input (req, env, Source DB values, SMTP/HTTP results) is `unknown` → narrow with Zod or type guards.
- No non-null assertions (`!`), no `as` casts on untrusted data, no `@ts-ignore`. `@ts-expect-error` only with a reason.
- Exported functions declare explicit return types.
- ESM + nodenext: relative imports end with `.js`; type-only imports use `import type`.
- Derive types from Zod schemas (`z.infer`) — don't hand-write a parallel interface.
- Domain values are `as const` objects + union types in `src/constants/` (no TS `enum`). Reuse existing ones before adding new ones.
- Results/states are discriminated unions (`{ kind: 'STALE', ageMs } | { kind: 'NO_DATA', reason }`), handled with exhaustive `switch` + `never` check.
- Types belong to their module (`<module>.types.ts`); move to `src/types/` only when ≥ 2 modules need them. Never define the same shape twice.
- Policies/evaluators take `now: Date` or a `Clock`; they don't call `new Date()`.
