---
paths:
  - "src/**"
---

# Architecture rules

Source: `docs/architecture.md` (layers, modules, flows) and `docs/project-structure.md` (folders).

## Layers (top → bottom only)
`routes → controllers → services → repositories → database`
- Routes: wire middleware + role guards + controller. No logic.
- Controllers: validate with the module's Zod schema, call ONE service method, render/redirect/JSON. No DB, no SMTP, no HTTP probes.
- Services: business rules, audit logging, scheduler notifications. No `req`/`res`.
- Repositories: the only code that queries a Monitor DB collection; one repository per collection, owned by one module.
- Pure logic (`*.evaluator.ts`, `*.policy.ts`): no I/O, no logger, time passed in.

## Boundaries
- Never import another module's repository — call its service.
- `modules/sourceData` is the ONLY importer of the Source DB client. It exposes no write method and returns only `_id` + timestamp, collection names, index info.
- `notifications/email` is the ONLY importer of Nodemailer.
- `constants/`, `types/`, `utils/`, `config/`, `errors/` never import from `modules/`, `scheduler/`, `middlewares/`.
- No import cycles. `alerts` never imports monitor modules; runners pass a monitor snapshot in.
- `process.env` is read only in `src/config/`.

## Adding things
- New feature → follow the module template in `docs/project-structure.md`; create only the files needed.
- Don't add a service/repository layer for something that has no logic or persistence.
- Dependencies are passed via factory functions (`createXService(deps)`); no DI container.
- If a change alters a layer boundary, module ownership, or a flow in `docs/architecture.md`, update that doc and add a TD entry in `docs/technical-decisions.md`.
