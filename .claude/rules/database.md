---
paths:
  - "src/database/**"
  - "src/modules/**/*.repository.ts"
  - "src/modules/sourceData/**"
  - "src/scheduler/**"
  - "scripts/**"
---

# Database rules

Schema, indexes and concurrency design: `docs/database-design.md`.

## Source DB (JOJO subscription backend) — READ ONLY
- Allowed: `listCollections` (nameOnly), `find().sort({key:-1}).limit(1)` with projection `{_id:1,[key]:1}`, `indexes()`. Nothing else.
- Every query sets `maxTimeMS` from config. Never read full documents (they contain webhook payloads/headers).
- Collection must be in the live `listCollections` result; timestamp key must match `^[A-Za-z_][A-Za-z0-9_.]{0,63}$`.
- Use source field names exactly as they exist (`dCreatedAt`). Don't invent fields — verify in `jojo_subscription_backend_2_0` or the live DB.
- Never create indexes or write anything to the Source DB, even "to help".

## Monitor DB
- camelCase fields; collection names from the `COLLECTIONS` constant; every doc has `createdAt`/`updatedAt`.
- Typed documents per module (`<module>.types.ts`); map docs → domain in the repository.
- Always project list queries; keyset pagination (max 200); never load alert bodies in lists.
- Single-document atomic updates (`findOneAndUpdate` with conditional filters) for state changes; never read-modify-write a whole document.
- Idempotency via unique `dedupeKey` on alerts; duplicate key (11000) on these = already done, not an error.
- Don't assume transactions are available (replica set unknown).
- Soft delete monitors (`deletedAt`); list queries filter `deletedAt: null`.
- New index → add to `src/database/indexes.ts` AND `docs/database-design.md`. Don't claim an index exists unless it's in that file (and, for prod, verified).

## Safety
- No `drop`, `deleteMany`, `updateMany` without a filter, or bulk rewrites without explicit user approval. Scripts in `scripts/` default to dry-run and print what they would change.
- Never put connection strings or credentials in code, docs, logs, or errors. Log host only.
- Map driver errors to `AppError`s; never return raw driver messages to clients.
