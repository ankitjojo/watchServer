# Plan: stop false ENDPOINT_DOWN alerts caused by the monitor's own network

> Request (2026-11-21): two `ENDPOINT_DOWN` emails for `https://jojoapp.in/` while the site was up. Fix it so it does not happen again.
> Status: **DONE** 2026-11-21 (F1 + F2). Answers: N = 2 in config; acceptance text unchanged; F3 skipped; webhook side unchanged.

## 1. What happened (from the local Monitor DB, read-only)

Monitor "web JOJO APP": check every 1 min, retry count 2, alert mode `EVERY_CHECK`. 2867 checks since 2026-11-19, only 2 failed.

| Check start (UTC) | Result | Attempts |
|---|---|---|
| 05:36:44 | DOWN | DNS_ERROR 30012 ms, 30006 ms, 30004 ms (finished 05:38:25) |
| 05:38:44 | OK | 200, 105 ms |
| 05:43:45 | DOWN | TIMEOUT 10013 ms, TIMEOUT 10007 ms, DNS_ERROR 30004 ms |
| 05:45:45 | OK | TIMEOUT **24136 ms**, then 200 in 98 ms |

At the same moments the email sends failed too: "The mail server could not be reached" (05:38:25) and "did not answer in time" (05:44:45, 05:46:00). So **the machine running payMonitor was offline**, not the site. Each blip lasted about 1 minute.

Two causes:

1. **Design gap**: one failed check (3 attempts in roughly 15–60 s) is enough to send `ENDPOINT_DOWN`. payMonitor cannot tell "the site is down" from "my own network is down". The webhook side already has this distinction for the Source DB (FR-A4a); the endpoint side has none.
2. **Bug**: an attempt must end after `ENDPOINT_TIMEOUT_MS` (10 s), but attempts took 30012 ms and 24136 ms. In `src/modules/endpointMonitors/httpProbe.ts` `probeOnce`, the pre-check `await deps.lookup(host)` runs outside the `AbortSignal.timeout`, so a hung DNS lookup waits for the OS limit (about 30 s). The `05:36:44` check ran for 100 s on a 1-minute schedule, so the next run was skipped (FR-S2).

Honest limit: no code can make a monitor on an offline machine produce perfect results. The goal is: **a short network blip on the monitor's side never sends an email, and a long one is reported as "monitor offline", not as "site down".**

## 2. Fixes

### F1. Bug: the timeout covers the DNS lookup too (must do)

- `httpProbe.ts`: `ProbeDeps.lookup(host, { signal })`; `probeOnce` passes the attempt's signal.
- `httpProbe.deps.ts`: race `resolve(host)` against the signal (reject with the signal's `TimeoutError`, classified as `TIMEOUT`).
- Result: every attempt ends within `ENDPOINT_TIMEOUT_MS`. Worst case per check: `(retryCount + 1) × timeout + retryCount × retryDelay` = 3 × 10 + 2 × 5 = 40 s.
- Not a behaviour change for working sites. No config, no DB change.

### F2. Confirm DOWN over consecutive checks (recommended, fixes this incident)

- New config `ENDPOINT_DOWN_AFTER_CHECKS` (§5.1), default **2**, range 1–10. `1` = today's behaviour.
- The check itself is still stored as `DOWN` (truth, FR-H1) and the dashboard shows DOWN.
- The **alert** (incident open + `ENDPOINT_DOWN` email) only fires when the last N checks in a row were DOWN. With the incident open, the alert mode works exactly as today (FR-A3).
- State: new `oState.nConsecutiveFailures` on `endpoint_monitors` (missing = 0, so old documents load). Reset to 0 on OK.
- Where: `endpointMonitors.runner.ts` skips `alerts.processCheckOutcome` while `count < N` and no incident is open. The pure rule ("should we alert yet?") goes in a small pure function with unit tests; `alert.policy.ts` is unchanged.
- Effect on this incident: both blips were single failed checks followed by OK. With N = 2: **no emails**.
- Cost: a real outage is reported one check interval later (1 min for this monitor).

### F3. Monitor-offline guard (optional, covers long blips)

When every attempt failed with a network-class error (`DNS_ERROR`, `TIMEOUT`, `CONNECTION_*`, `NETWORK_ERROR`, not an HTTP status), test our own connectivity before blaming the site:

- New config `NETWORK_CHECK_URLS` (comma-separated, default empty = guard off). Example: two well-known, independent HTTPS hosts.
- If **all** of them also fail, the check is stored as `ERROR` with reason `MONITOR_OFFLINE`; no `ENDPOINT_DOWN` alert, `nConsecutiveFailures` unchanged, and the monitor's status stays as it was (like FR-A4a leaves STALE/NO_DATA unchanged).
- A warn log `monitor.offline` per check; no email (SMTP is usually unreachable at that moment anyway).
- Needs a requirements decision (§6 Q3): it adds a rule and sends traffic to third-party hosts.

### F4. Operations (no code)

- Change this monitor's alert mode to `Once + recovery`: one DOWN email plus a RECOVERED email instead of a lone "down" per failing check.
- Run payMonitor on an always-on server, not a laptop on Wi-Fi (requirements §8 Q3). This is what makes it reliable; F1–F3 only reduce noise.

## 3. Files

| Fix | Files |
|---|---|
| F1 | `src/modules/endpointMonitors/httpProbe.ts`, `httpProbe.deps.ts`, `tests/integration/probe/httpProbe.test.ts` |
| F2 | `src/config/env.schema.ts` + `loadConfig.ts` + `.env.example`; `src/modules/endpointMonitors/endpointMonitors.runner.ts`, `.types.ts`, `.mapper.ts`, `.repository.ts` (`$set`/`$inc` on `oState.nConsecutiveFailures`), new pure `endpointMonitors.downConfirm.ts`; `src/compositionRoot.ts` (pass N) |
| F3 | config as F2; `endpointMonitors.runner.ts`; `httpProbe.ts` (reuse `probeOnce` for the check URLs, same SSRF vetting) |

No route, view or Source DB change. No migration: the new state field defaults to 0.

## 4. Tests

| Test | What |
|---|---|
| T1 | F1: a lookup that never resolves ends at `timeoutMs` as `TIMEOUT` (fake clock / fake deps) |
| T2 | F2 pure rule: N = 1, 2, 3; OK resets; open incident keeps today's FR-A3 flow |
| T3 | F2 runner (integration, memory DB): fail, OK → no alert; fail, fail → one `ENDPOINT_DOWN`; old document without the field loads |
| T4 | F2 + modes: `EVERY_CHECK` with N = 2 emails from the 2nd failing check on; `ONCE_WITH_RECOVERY` sends one DOWN + one RECOVERED |
| T5 | F3: all attempts DNS_ERROR + all check URLs fail → check `ERROR`/`MONITOR_OFFLINE`, no alert, status unchanged; check URL OK → normal DOWN path; HTTP 500 never triggers the guard |
| T6 | Acceptance 04 (endpoint down): update for N (see Q2) |
| T7 | Config: default, range, invalid value stops startup |

Gates: typecheck, lint, format:check, `npm test`, `npm run test:acceptance`, build.

## 5. Docs

- `docs/requirements.md`: FR-E2 (DOWN alert after N consecutive failed checks), §5.1 new keys, acceptance criterion "500 on all attempts produces one ENDPOINT_DOWN" (now: on N consecutive checks).
- `docs/database-design.md`: `oState.nConsecutiveFailures`.
- `docs/architecture.md`: endpoint check flow (confirmation, offline guard).
- `docs/technical-decisions.md`: TD-39.
- `docs/implementation_progress.md`: log entry.

## 6. Open questions (answer before coding)

1. **F2 default N**: `2` (recommended: one blip never alerts, real outage reported 1 interval later) or `3`?
2. **Acceptance change**: OK to change the criterion "an endpoint that fails on all attempts produces one `ENDPOINT_DOWN`" to "… on N consecutive checks"? (Setting N = 1 keeps the old behaviour.)
3. **F3 monitor-offline guard**: build it now (which check URLs?), or skip it and rely on F2 + running on a server?
4. **Webhook side**: when the laptop is offline the Source DB looks unreachable too, which already sends one grouped `MONITOR_ERROR` to master recipients (FR-A4a). Leave as is, or apply the same confirmation idea there?

## 7. Checklist

- [x] §6 answered
- [x] F1 + T1
- [x] F2 + T2, T3, T7 (T4/T6 not needed: tests pin N = 1, acceptance unchanged)
- [x] F3 skipped (user)
- [x] Docs §5 + TD-39
- [x] Gates run, real results reported
