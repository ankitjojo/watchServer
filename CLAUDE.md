# payMonitor — Claude Code instructions

payMonitor watches the JOJO Subscription Backend 2.0 from outside: it **reads** the newest timestamp in payment-webhook collections and **probes** server endpoints on admin-defined schedules, stores every alert first, then emails recipients. It has an EJS dashboard (admin/viewer roles) and an in-process scheduler.

**Requirements (source of truth), always loaded:** @docs/requirements.md
Requirement IDs (FR-W1, FR-A4a, …) are referenced throughout the code and docs.

## Status
Foundation docs exist; **no application code yet**. Stack decided: Node 22 + TypeScript (strict, ESM/nodenext), Express 5, EJS, native MongoDB driver, Nodemailer, Zod, Pino, Jest. Dependencies are proposed in `docs/testing-strategy.md` §6 and **not installed** until the user approves.

## Read before working
| Task | Read |
|------|------|
| Any feature | `docs/requirements.md`, `docs/architecture.md` |
| Folders / new files | `docs/project-structure.md` |
| DB / repositories / Source DB | `docs/database-design.md` |
| Routes, controllers, schemas | `docs/api-standards.md` |
| Auth, input, outbound HTTP | `docs/security.md` |
| Tests | `docs/testing-strategy.md` |
| Why something is the way it is | `docs/technical-decisions.md` (TD-xx) |
| Implementing a feature plan | `docs/implementation_plans/` |

Topic rules in `.claude/rules/` load automatically (security and git-safety always; others by path).

## Non-negotiables
1. **Source DB is read-only** and accessed only through `src/modules/sourceData` (`_id` + timestamp projection). Never write to it, never create indexes on it, never modify the sibling repo `jojo_subscription_backend_2_0`.
2. **Layers**: routes → controllers → services → repositories. No DB in controllers/templates, no business logic in routes/views, no cross-module repository imports, no import cycles.
3. **Store first, then send**: every alert is persisted (`PENDING`) before any email; status reflects reality (`SENT` only after SMTP accepted).
4. **Reuse** existing constants (`src/constants`), Zod schemas, types, utils, errors, logger before creating new ones.
5. **Don't invent** business rules, routes, DB fields, alert behaviour, Source DB field names or provider behaviour. If `docs/requirements.md` doesn't say it, ask one focused question.
6. Tunables come from `src/config` (requirements §5.1), never hard-coded.

## Changing things
- Before changing existing behaviour: read the code + requirement, state the impact and backward compatibility (existing stored documents must still work).
- Non-trivial feature → write `docs/implementation_plans/<feature>.md` first.
- Add/adjust tests per `docs/testing-strategy.md` §2 (critical areas must be tested).
- Update docs in the same change when behaviour, routes, collections/indexes, architecture or decisions change (and add a TD entry for new decisions).
- Run quality gates (`docs/testing-strategy.md` §5). Never claim a command passed without running it.

## Never without explicit approval
Deleting/overwriting unread files, destructive git commands, commits/pushes, installing/upgrading packages, DB writes outside test memory servers, sending real email, deployments. Never read or print `.env` values or other secrets. Details: `.claude/rules/git-and-change-safety.md`.

## Standing instructions from the user
Permanent rules the user gives during development are appended here (newest last). They override older guidance in docs/rules if they conflict — then update the conflicting doc too.
- All project Markdown docs (requirements, plans, guides, rules for humans) live in `docs/`; feature plans in `docs/implementation_plans/`.
- Ask focused questions (multiple-choice where possible) when anything is unclear, instead of assuming.
- For multi-step work, keep a progress checklist file in `docs/` so an interrupted session can be resumed.

## Report at the end of every task
Files changed (created/modified/deleted) · commands run and their real results · tests/gates status (incl. those not run and why) · assumptions made · open risks/questions.
