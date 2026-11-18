# Git & change-safety rules (always loaded)

## Never without explicit user approval in this conversation
- Delete, rename, or overwrite a file you haven't read; `rm -rf`; `git reset --hard`, `git clean`, `git checkout -- .`, `git stash`, force push, history rewrites.
- Commit or push (commit only when asked; branch first if on `main`).
- Install, remove, or upgrade dependencies.
- Run anything that writes to a database other than a test memory server; run scripts against `MONGO_URI`/`SOURCE_MONGO_URI` from `.env`.
- Send real emails (use the fake transport or a sandbox SMTP the user names).
- Deploy or touch production resources.

## Always protect
- `.env*` (except `.env.example`), credentials, `.claude/settings.local.json`, untracked and ignored files, user data, production data. Don't read `.env` values into the conversation; if you must check a variable exists, check the name only.
- The Source DB (`jojo_subscription_backend_2_0` data) — read-only, always.
- The sibling project `jojo_subscription_backend_2_0` — read it for facts, never modify it.

## Before changing existing behaviour
1. Read the affected code and `docs/requirements.md` section.
2. State the impact: which flows, data, emails, or routes change; backward compatibility for stored documents (old docs must still load).
3. If the requirement is unclear or the change contradicts the docs, ask a focused question first.

## Working style
- Inspect `git status` before and after a task; report what changed.
- Small, reviewable changes; one concern per change.
- Plans for non-trivial features go in `docs/implementation_plans/<feature>.md` before coding.
