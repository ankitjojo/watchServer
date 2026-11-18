# Engineering Setup — Progress Tracker

> Tracks progress of `docs/claude_project_engineering_setup_prompt.txt`.
> If a session stops mid-way, resume from the first unchecked item.
> Legend: `[x]` done · `[~]` in progress · `[ ]` not started

## Phases

- [x] Phase 0 — Safety, scope, working agreement (inspect repo, git status)
- [x] Phase 1 — Discover and understand the project
- [x] Decisions — focused questions answered by user
- [x] Phase 2 — Architecture decisions
- [x] Phase 3 — Coding & TypeScript standards
- [x] Phase 4 — Database standards
- [x] Phase 5 — API standards
- [x] Phase 6 — EJS frontend standards (content lives in .claude/rules/ejs-frontend.md)
- [x] Phase 7 — Security standards
- [x] Phase 8 — Error handling, logging, operations (content lives in .claude/rules/error-handling-logging.md)
- [x] Phase 9 — Testing & quality gates
- [x] Phase 10 — Dependencies & tooling (list in docs/testing-strategy.md §6)
- [x] Phase 11 — CLAUDE.md + modular rules
- [x] Phase 13 — Project structure recommendation
- [x] Phase 14 — Consistency review
- [x] Final report

## Files (Phase 12)

- [x] CLAUDE.md
- [x] .claude/rules/typescript.md
- [x] .claude/rules/architecture.md
- [x] .claude/rules/database.md
- [x] .claude/rules/api-development.md
- [x] .claude/rules/security.md
- [x] .claude/rules/ejs-frontend.md
- [x] .claude/rules/error-handling-logging.md
- [x] .claude/rules/testing.md
- [x] .claude/rules/code-quality.md
- [x] .claude/rules/git-and-change-safety.md
- [x] docs/architecture.md
- [x] docs/database-design.md
- [x] docs/api-standards.md
- [x] docs/security.md
- [x] docs/testing-strategy.md
- [x] docs/coding-standards.md
- [x] docs/project-structure.md
- [x] docs/technical-decisions.md

## Log

- 2026-11-18 — Tracker created. Starting Phase 0.
- 2026-11-18 — Phase 0/1 done. Findings:
  - Project root contains only `docs/` (no code, no package.json/tsconfig). Not a git repo.
  - Requirements live at `docs/requirements.md`.
  - Source backend (`jojo_subscription_backend_2_0`): ESM + `module: nodenext`, strict TS with
    `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, Zod, native MongoDB driver,
    Hungarian-prefixed field names (`dCreatedAt`, `sX`, `eX`, `bX`, `oX`).
  - All 5 webhook collections write `dCreatedAt` as BSON `Date`.
  - Source index script defines `dCreatedAt:-1` on google_play / apple_pay / razor_pay webhook
    collections; NONE on `amazon_pay_webhook_data`, `me_pass_webhooks` (script only — not verified live).
- Next: ask user decisions (git init, module system, field naming, deployment instances).
- 2026-11-18 — Decisions answered:
  - `git init` done (no commit). `.gitignore` created (protects `.env`).
  - payMonitor's own DB uses **plain camelCase** fields. Source DB fields keep their own names.
  - **Single instance** in production; in-process scheduler + Mongo lease lock as safety net.
  - Libraries: Zod, Pino, **Jest** (not Vitest), ESLint + Prettier, helmet, express-session +
    connect-mongo, bcrypt, CSRF protection, express-rate-limit, tsx; ESM + `nodenext`.
  - Runtime found: Node v22.23.1, npm 10.9.8.
- Next: write docs (Phases 2–10, 13), then rules + CLAUDE.md (Phase 11), then review (Phase 14).
- 2026-11-18 — All 19 files written. Phase 14 review:
  - All doc/rule paths referenced from CLAUDE.md, docs and rules exist.
  - Secret scan (URIs with credentials, emails, passwords): none found.
  - Rule frontmatter: 8 path-scoped; `security.md` + `git-and-change-safety.md` always loaded.
  - No package.json / node_modules → no dependency installed; no code; requirements.md unchanged.
  - Fixed: password policy marked as recommendation; retention risk marked [Open];
    noted constant casing (NORMAL/MASTER) and extra collections (scheduler_locks, sessions).
- SETUP COMPLETE. Pending user decisions listed in final report (csrf-sync, retention, replica set,
  deployment, private-IP endpoints, password policy, source indexes, dependency approval).
