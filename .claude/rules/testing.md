---
paths:
  - "tests/**"
  - "src/**/*.ts"
---

# Testing rules

Strategy, critical cases, Jest ESM config, quality gates: `docs/testing-strategy.md`.

- Framework is **Jest** (ts-jest ESM). Test files: `tests/unit/**/<name>.test.ts`, `tests/integration/**/<name>.test.ts`, mirroring `src/` paths.
- Changing logic in an area listed as critical in `docs/testing-strategy.md` §2 requires adding/updating tests for it in the same change.
- Bug fix → first a failing test that reproduces it.
- Prefer dependency injection fakes (FakeClock, fake mail transport, in-memory repos) over module mocking; `jest.mock` hoisting doesn't work in ESM.
- DB tests use `mongodb-memory-server`, unique DB per file, cleanup in `afterEach`. Never connect tests to real `MONGO_URI`, `SOURCE_MONGO_URI`, or SMTP; build test config in code.
- Endpoint probe tests use a local `http.createServer`, not the internet.
- Table-driven tests for RBAC (every mutating route × viewer → 403) and for policy transitions.
- Assert behaviour (returned result, stored docs, emails recorded), not implementation details.
- Run the quality gates in `docs/testing-strategy.md` §5 and report the actual command + outcome. If a gate can't run (e.g. no package.json yet), say so. Never claim a test passed without running it.
