# payMonitor — Requirements

> This file says WHAT the system must do and WHY. HOW to build it goes in `docs/implementation_plans/`.
> Status: DRAFT v1 · Last updated: 2026-11-18

---

## 1. Goal

payMonitor watches the **JOJO Subscription Backend 2.0** (`jojo_subscription_backend_2_0`) from outside and sends an email when something looks wrong:

1. **Webhook monitors**: a payment gateway has stopped sending webhooks. No new document has been written to its webhook collection within a time limit the admin sets.
2. **Endpoint monitors**: a server endpoint does not return HTTP `200`.

It has two parts:
- **Dashboard** (web UI) where admins create and manage monitors, recipients and users, and where anyone logged in can see status and history.
- **Triggering system** (background scheduler) that runs each monitor on its own schedule. It **stores every alert in the DB first**, then sends the email and records whether the email was sent.

---

## 2. Glossary

| Term | Meaning |
|------|---------|
| Source DB | The subscription backend's MongoDB. **payMonitor only reads it.** |
| Monitor DB | payMonitor's own MongoDB. It stores monitors, check results, alerts, email logs, users and recipients. |
| Webhook monitor | A scheduled check on one collection in the source DB. It finds the newest document by timestamp and compares its age with a threshold. |
| Endpoint monitor | A scheduled HTTP GET on one URL. It expects status `200`. |
| Check | One run of a monitor. Every check is stored. |
| Incident | The period from the moment a monitor first fails until it recovers. |
| Alert | A record of a notification that must be sent, such as DOWN/STALE or RECOVERED. It is stored before any email goes out. |
| Recipient | A person who receives alert emails. This is a separate list from dashboard login users. |
| Master recipient | A protected recipient who always gets every alert. |

---

## 3. Users and Roles (Dashboard Login)

| Role | Can do |
|------|--------|
| **Admin** | Everything: CRUD on monitors, recipients and dashboard users; pause/resume; run check now; test email; resend failed emails; view all history. |
| **Viewer** | Read only: dashboard, monitor list, monitor details, history and charts, alert and email logs. Cannot create, edit, delete, pause, run or resend. |

- Users log in with **email + password**. Passwords are stored hashed (bcrypt).
- Admins can create, edit, deactivate and delete dashboard users and set each user's role.
- An inactive user cannot log in.
- The **first admin** is created automatically at first startup from `.env` (`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`). This only happens when no users exist yet.
- An admin cannot delete or demote themselves if they are the last active admin.
- Every page and API except login requires a session. Admin-only actions are also checked on the server, not just hidden in the UI.

---

## 4. Functional Requirements

### 4.1 Webhook Monitors (Collection Staleness)

**FR-W1. Create a webhook monitor.** Admin fills in:

| Field | Rules | Example |
|-------|-------|---------|
| Monitor name | Required, unique | `Razorpay webhooks` |
| Payment gateway name | Required, free text | `Razorpay` |
| Collection name | Required. Chosen from a **dropdown of live collections in the source DB**. | `razor_pay_webhook_data` |
| Timestamp key | Required, typed. Validated before saving (see FR-W2). | `dCreatedAt` |
| Check every (cron duration) | Number + unit. Units: `minute`, `hour`. Minimum 1 minute, maximum 24 hours (`MAX_CHECK_INTERVAL_MIN`, TD-30). | `every 10 minute` |
| Trigger when no doc for (threshold) | Number + unit. Units: `minute`, `hour`, `day`, `week`, `month` (1 month = `DAYS_PER_MONTH` days, default 30; see §5.1). | `2 hour` |
| Alert mode | `Once + recovery`, `Every check` or `Repeat every N` (see FR-A3) | `Once + recovery` |
| Repeat interval | Only shown and required when mode is `Repeat every N`. Number + unit (`minute`, `hour`, `day`). Must be ≥ the check interval. | `30 minute` |
| Enabled | Default on | |

- One monitor watches **exactly one collection**. To watch more collections, create more monitors.
- There is **no document filter** in v1. The check always uses the newest document in the collection.
- Several monitors may watch the same collection, for example with different thresholds.

**FR-W2. Validate the timestamp key on save.** payMonitor reads the newest document in the collection, sorted by that key descending, and checks that the key exists and holds a valid date. If the check fails, the monitor is not saved and the admin sees a clear error.
- Accepted timestamp formats: BSON `Date`, ISO‑8601 string, epoch milliseconds, epoch seconds (a number below 10^11 is treated as seconds).
- An empty collection is allowed with a warning, because the key cannot be validated yet.

**FR-W3. Run the check.** On each scheduled run:
1. Read the newest document: `find({}).sort({<key>: -1}).limit(1)` with a projection of only `_id` and `<key>`.
2. Compute `age = now − doc[<key>]`.
3. Result:
   - `OK` if `age ≤ threshold`
   - `STALE` if `age > threshold`
   - `NO_DATA` if the collection is empty or the key is missing or invalid on the newest document
   - `ERROR` if the source DB query fails or times out
4. Store the check (FR-H1). Then apply the alert rules (FR-A).

**FR-W4.** A STALE email includes:
- Monitor name, gateway, collection and timestamp key
- `_id` and timestamp of the last document
- Age, written for people to read (e.g. "3 h 12 min")
- Configured threshold and check interval
- Time of the check (UTC)
- A link to the monitor's page on the dashboard

### 4.2 Endpoint Monitors (Server Health)

**FR-E1. Create an endpoint monitor.** Admin fills in:

| Field | Rules | Example |
|-------|-------|---------|
| Server name | Required, unique | `Subscription API – prod` |
| Endpoint URL | Required, valid `http(s)://` URL | `https://api.example.com/health` |
| Check every | Number + unit. Units: `minute`, `hour`. Minimum 1 minute, maximum 24 hours (TD-30). | `every 5 minute` |
| Retry count | Integer 0–5, default 2 | `2` |
| Alert mode | `Once + recovery`, `Every check` or `Repeat every N` | |
| Repeat interval | Only for `Repeat every N`; same rules as FR-W1 | |
| Enabled | Default on | |

- Admins can create **as many endpoint monitors as they want**.
- The request is always an HTTP **GET** with no custom headers or body.
- These values come from the system config (§5.1), not the form:
  - Request timeout: `ENDPOINT_TIMEOUT_MS` (default 10 s)
  - Time between retries: `ENDPOINT_RETRY_DELAY_MS` (default 5 s)
  - Maximum redirects followed: `ENDPOINT_MAX_REDIRECTS` (default 5)

**FR-E2. Run the check.** A check passes only if the final status is exactly **200**. If an attempt fails (any other status, a timeout, a DNS error or a connection error), retry up to *retry count* times. The check is `DOWN` only if **all attempts fail**.
- Store the status code, response time and error message of every attempt.

**FR-E3.** A DOWN email includes:
- Server name and endpoint URL
- Timestamp of the failure (UTC)
- Number of attempts, with the last status code or error and the response time
- A link to the monitor's page on the dashboard

### 4.3 Alerting and Email (Triggering System)

**FR-A1. Store first, then send.** When a check needs a notification:
1. Insert an **alert** document with status `PENDING`. It holds the monitor snapshot, alert type, check reference, recipient list and email subject/body.
2. Send the email.
3. Update the alert to `SENT` (with `dSentAt` and the SMTP message ID in `sMessageId`) or start the retry flow.

**FR-A2. Retry when sending fails.** On an SMTP error, retry using the backoff list in `EMAIL_RETRY_BACKOFF_MIN` (default `1,5,15`, which means 3 retries after 1, 5 and 15 minutes). After the last failure, set the status to `FAILED` and keep the error text. FAILED alerts are highlighted on the dashboard and have a **Resend** button (admin only).
- Status flow: `PENDING → SENT` or `PENDING → RETRYING → SENT | FAILED`. A manual resend moves `FAILED → PENDING`.

**FR-A3. Alert mode.** The admin sets this per monitor:
- **Once + recovery**:
  - Send one email when the monitor goes from OK to failing. This opens an incident.
  - Send nothing more while it keeps failing.
  - When it next passes, send one **RECOVERED** email that includes the downtime duration. This closes the incident.
- **Every check**: send an email on every failing check. No recovery email.
- **Repeat every N**:
  - Send one email when the incident opens.
  - While it keeps failing, send a reminder email each time at least *repeat interval* has passed since the last email for this incident. The reminder is checked at each scheduled check, so it goes out at the first check after the interval ends.
  - Send one **RECOVERED** email when it passes again.
  - Each reminder says how long the incident has been open and how many reminders came before it.

**FR-A4. Alert types:**
- `WEBHOOK_STALE`
- `WEBHOOK_NO_DATA`
- `ENDPOINT_DOWN`
- `RECOVERED`
- `MONITOR_ERROR`: either (a) the source DB is unreachable (an outage, FR-A4a), or (b) one monitor's own collection could not be read: the collection is missing, the query timed out or the query errored (TD-29)
- `TEST` (sent by the test email button)

**FR-A4a. A source DB outage is handled differently.** An outage means the source DB itself cannot be reached: server selection, network or authentication failure. A failure limited to one collection is **not** an outage; it is that monitor's own `MONITOR_ERROR`, sent to the normal recipients (FR-A5) under the monitor's alert mode, not grouped, and recovered only by that monitor's own next successful check (TD-29, decided 2026-11-18). For an outage:
- It goes to **master recipients only**.
- It **ignores the monitor's alert mode**: one email per outage, then one RECOVERED email (also to masters only) when the source DB answers again.
- If many webhook monitors fail at the same time because the source DB is down, they are grouped into **one** `MONITOR_ERROR` incident that lists every affected monitor, instead of one email per monitor.
- During a source DB outage the monitors' own STALE/NO_DATA state is left unchanged, so an outage does not look like a gateway problem.

**FR-A5. Recipients for each alert.** Every **active** recipient plus every **master** recipient. A source DB outage (`MONITOR_ERROR`, FR-A4a) is the exception. The list is worked out when the alert is created and is saved on the alert. If there are no recipients at all, the alert is still stored, with status `FAILED` and the reason "no recipients".

**FR-A6. Subject format:** `[<APP_NAME>] <TYPE> – <monitor name>`, where `APP_NAME` is the product name from the environment (§5.1, default `payMonitor`). The examples below use the default:
- `[payMonitor] WEBHOOK_STALE – Razorpay webhooks`
- `[payMonitor] RECOVERED – Subscription API – prod`

### 4.4 Recipients (Alert Email List)

**FR-R1.** Admin can create, read, update and delete recipients. Fields: **sName**, **sEmail** (unique, validated), **bIsActive**, **eType** (`normal` or `master`, stored as `NORMAL`/`MASTER`).

**FR-R2.** Only **active** normal recipients receive alerts. Master recipients **always** receive every alert.

**FR-R3. Master recipients are protected.**
- They are stored in the DB and shown in the UI with a "Master" badge.
- They **cannot be deactivated or deleted**. Their name and email can be edited.
- At first startup, a master recipient is created from `.env` (`MASTER_ALERT_EMAIL`, `MASTER_ALERT_NAME`) if none exists.
- At least one master recipient must always exist.

### 4.5 Dashboard

**FR-D1. Overview page:**
- Count cards: total monitors, OK, failing, paused, open incidents, emails FAILED
- A table of all monitors showing type, current status (OK / STALE / NO_DATA / DOWN / ERROR / PAUSED), last check time, next check time and last document age or last response time

**FR-D2. Monitors pages:**
- Separate lists for webhook monitors and endpoint monitors
- Create and edit forms (FR-W1, FR-E1) with validation
- Delete with a confirmation step. Deleting a monitor keeps its history; the monitor is soft-deleted.

**FR-D3. Actions on each monitor (admin only):**
- **Pause / Resume**: stops or starts scheduling without deleting. Pausing does not close an open incident. After resume, the next check decides the status.
- **Run check now**: runs the check immediately, shows the result inline, stores it, and applies the alert rules the same way a scheduled run does.
- **Test email**: sends a sample `TEST` alert to the current recipients. It is stored like any other alert.

**FR-D4. Monitor detail page:**
- Configuration
- Current status
- **History table**: every check, with filters and pagination
- **Incidents list**: start, end and duration
- **Alerts and emails list**: type, status, recipients, sent time, error, and Resend
- **Charts**:
  - Webhook monitors: document age over time, with the threshold as a line
  - Endpoint monitors: response time and up/down over time
- Range picker: 24 h, 7 d, 30 d or custom

**FR-D5. Global alert log page:**
- All alerts, with filters by monitor, type, email status and date range

**FR-D6. Admin pages:**
- Recipients CRUD (FR-R)
- Dashboard users CRUD (§3)

**FR-D7. Times:** All times are shown in **UTC**, labelled "UTC". This applies to both the dashboard and emails.

### 4.6 Scheduler

**FR-S1.** Each enabled monitor runs on its own interval. When a monitor is created, edited, paused, resumed or deleted, the scheduler updates **right away, without restarting the server**.

**FR-S2.** A new run of the same monitor does not start while the previous run is still going. The skipped run is logged.

**FR-S3.** On server start, the scheduler loads all enabled monitors and schedules them. Interval runs missed while the server was down are **not** replayed. The first check runs right after startup.

**FR-S4.** A failure in one monitor never stops the other monitors.

### 4.7 History and Audit

**FR-H1.** Every check is stored with:
- Monitor ID
- Type
- Start and end time
- Result
- Details: last document ID and timestamp, and age, for webhook checks; status codes, response times and errors for each attempt, for endpoint checks
- Whether it was triggered by `schedule` or `manual`

**FR-H2.** Changes to monitors, recipients and users are written to an audit log: who, what, when, plus the before and after values.

**FR-H3. Retention:** keep **everything**. Nothing is deleted automatically.

---

## 5. Non-Functional Requirements

- **Read-only source DB:**
  - payMonitor connects with a separate `SOURCE_MONGO_URI` that uses a MongoDB user with the **`read` role only**.
  - The code only calls `find` and `listCollections` on the source DB. Nothing writes to it.
- **Light load on the source DB:**
  - Each check runs one indexed `find().sort().limit(1)` with a projection.
  - The query timeout is 10 s (`maxTimeMS`).
  - Each monitored collection should have a **descending index on the timestamp key**; the existing `dCreatedAt` index on `google_play_billing_webhook_logs` is one. When an admin saves a monitor whose collection has no such index, the dashboard shows a warning. payMonitor cannot create the index itself.
- **Security:**
  - bcrypt passwords
  - HTTP-only session cookies
  - CSRF protection on forms
  - Rate limiting on login
  - Secrets only in `.env`
  - Role checks on every write route
- **Reliability:**
  - Alerts are saved before sending, so no alert is lost to a crash
  - On startup, PENDING or RETRYING alerts are picked up again
- **Accuracy:** each check should start within ±30 s of its scheduled time.
- **Logging:** structured console logs for each check, alert and email attempt.
- **Tech stack** (new project, starting from scratch):
  - **Node.js + TypeScript** (strict mode), matching the subscription backend
  - **Express 5**, with server-rendered **EJS** views
  - Native **MongoDB** driver
  - **Nodemailer**
  - Source in `src/`, compiled to `dist/`

### 5.1 System Config (adjustable defaults)

All tuning values live in **one typed config module** (`src/config/`). Each value reads from an environment variable and falls back to the default below if the variable is unset. To change a value, edit `.env` and restart; no code change is needed. Values are checked at startup, and an invalid value stops the server with a clear message.

| Config key | Default | Used for |
|------------|---------|----------|
| `ENDPOINT_TIMEOUT_MS` | `10000` | Timeout for each endpoint request (FR-E1) |
| `ENDPOINT_RETRY_DELAY_MS` | `5000` | Wait between endpoint retries (FR-E2) |
| `ENDPOINT_MAX_REDIRECTS` | `5` | Redirects followed (FR-E1) |
| `ENDPOINT_MAX_RETRY_COUNT` | `5` | Highest retry count allowed in the form |
| `ENDPOINT_DEFAULT_RETRY_COUNT` | `2` | Pre-filled retry count in the form |
| `EMAIL_RETRY_BACKOFF_MIN` | `1,5,15` | Email retry schedule; the number of values = number of retries (FR-A2) |
| `SOURCE_QUERY_TIMEOUT_MS` | `10000` | `maxTimeMS` on source DB queries |
| `DAYS_PER_MONTH` | `30` | Converts the `month` unit (FR-W1) |
| `MIN_CHECK_INTERVAL_MIN` | `1` | Smallest allowed check interval |
| `MAX_CHECK_INTERVAL_MIN` | `1440` | Largest allowed check interval (at most 1440 = 24 h; TD-30) |
| `APP_NAME` | `payMonitor` | Product name people see: browser title and brand, email subject prefix (FR-A6) and footer, warnings and the startup log message. 1–40 characters, no control characters. Technical identifiers (MongoDB app name, log `service` field, default DB name) do not change (TD-35) |
| `TIMEZONE` | `UTC` | Time zone for display and emails (FR-D7) |
| `LOGIN_RATE_LIMIT` | `5 per 15 min` | Login attempts per IP |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | — | First admin (§3) |
| `MASTER_ALERT_EMAIL` / `MASTER_ALERT_NAME` | — | First master recipient (FR-R3) |
| `SOURCE_ERROR_GROUP_WINDOW_MS` | `60000` | How long to wait before sending the grouped `MONITOR_ERROR` email so more affected monitors can join it (FR-A4a) |
| `ACTION_RATE_LIMIT` | `10 per 1 min` | Run-check-now and test-email calls per user |
| `MAIL_TRANSPORT` / `MAIL_OUTBOX_DIR` | `smtp` / `./.sandbox/outbox` | `outbox` writes `.eml` files instead of sending (dev and sandbox only; startup refuses it when `NODE_ENV=production`) |
| `SMTP_TIMEOUT_MS` / `SMTP_SECURE` | `15000` / `false` | SMTP connection timeout and TLS mode |
| `DISPATCHER_POLL_MS` / `DISPATCHER_LOCK_MS` | `10000` / `120000` | Alert dispatcher polling and claim lock time. The lock must be greater than 2 × `SMTP_TIMEOUT_MS`, the overall deadline of one send (TD-32) |
| `LEASE_TTL_MS` / `LEASE_RENEW_MS` | `45000` / `15000` | Scheduler lease (single active instance) |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Max wait for in-flight checks on shutdown |
| `SCHEDULER_CONCURRENCY` | `5` | Max webhook checks (Source DB reads) running at once. Endpoint probes are not limited by it (review M7) |
| `SESSION_MAX_AGE_MS` | `28800000` | Login session length (8 h) |
| `MONGO_DB_NAME`, `TRUST_PROXY`, `LOG_LEVEL` | `paymonitor`, `0`, `info` | Monitor DB name, proxy hops, log level |

---

## 6. Data (Monitor DB Collections)

Field names use the **same type-prefix convention as the subscription DB** (`s` string, `n` number, `b` boolean, `d` date, `e` enum, `o` object, `a` array, `i` ObjectId reference), e.g. `sName`, `bIsActive`, `dCreatedAt`. Full field lists: `docs/database-design.md`.

| Collection | Purpose |
|------------|---------|
| `users` | Dashboard login users: sName, sEmail, sPasswordHash, eRole, bIsActive |
| `recipients` | Alert email list: sName, sEmail, bIsActive, eType (`NORMAL`/`MASTER`) |
| `webhook_monitors` | Webhook monitor configs (FR-W1) and current status/incident state |
| `endpoint_monitors` | Endpoint monitor configs (FR-E1) and current status/incident state |
| `checks` | Every check result (FR-H1) |
| `incidents` | Start/end of each failing period |
| `alerts` | Alerts and email delivery status (FR-A) |
| `audit_logs` | Config change history (FR-H2) |

### Source DB collections to monitor at launch

All of these use `dCreatedAt` as the timestamp key:
- `amazon_pay_webhook_data` (Amazon Pay)
- `apple_pay_webhook_data` (Apple Pay)
- `razor_pay_webhook_data` (Razorpay)
- `me_pass_webhooks` (ME Pass)
- `google_play_billing_webhook_logs` (Google Play)

### Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port |
| `MONGO_URI` | Monitor DB connection |
| `SOURCE_MONGO_URI` | Source DB connection (read-only user) |
| `SOURCE_DB_NAME` | Source database name |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Email sending |
| `SESSION_SECRET` | Session cookie signing |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | First dashboard admin |
| `MASTER_ALERT_EMAIL`, `MASTER_ALERT_NAME` | First master recipient |
| `DASHBOARD_BASE_URL` | Base URL for links in emails |

---

## 7. Out of Scope (v1)

- Notification channels other than email: Slack, SMS, WhatsApp
- Document filters on webhook monitors
- Several source databases or projects (the design should not block adding this later)
- Endpoint checks with custom methods, headers, body or expected-body matching
- Routing recipients per monitor
- Quiet hours, maintenance windows and escalation
- Writing anything to the source DB

---

## 8. Open Questions

1. Which server endpoints should be added at launch? List their names and URLs.
2. What threshold and check interval should each gateway start with?
3. Where will payMonitor be deployed? This decides `DASHBOARD_BASE_URL` and whether the server is always on.

---

## 9. Acceptance Criteria

- [ ] Admin can create a webhook monitor by picking a collection from the source DB. An invalid timestamp key is rejected.
- [ ] Sample setup: a monitor with threshold `1 minute` on a collection that has received no new doc. After the next check, exactly one `WEBHOOK_STALE` alert is stored, followed by one email (mode `Once + recovery`).
- [ ] When a new document arrives in that collection, the next check stores and sends one `RECOVERED` alert, and the incident shows its duration.
- [ ] An endpoint that returns 500 (or times out) on all `retry count + 1` attempts produces one `ENDPOINT_DOWN` alert. An endpoint that fails once and then returns 200 produces no alert.
- [ ] With `Every check` mode, every failing check produces an email.
- [ ] With `Repeat every N` mode (repeat interval 30 min, check every 10 min), a 1-hour outage sends:
  - 1 alert when the incident opens
  - about 2 reminders
  - 1 RECOVERED email
- [ ] When the source DB is unreachable, only master recipients get a single `MONITOR_ERROR` email listing the affected monitors, and a RECOVERED email follows when the DB answers again. No STALE alerts are sent during the outage.
- [ ] Changing `ENDPOINT_TIMEOUT_MS`, `EMAIL_RETRY_BACKOFF_MIN` or `DAYS_PER_MONTH` in `.env` and restarting changes behaviour without any code change. An invalid value stops startup with an error.
- [ ] With SMTP down, alerts move PENDING → RETRYING → FAILED. Resend works once SMTP is back.
- [ ] Inactive recipients get no email. Master recipients always get email and cannot be deactivated or deleted.
- [ ] A viewer can see everything and cannot change anything (UI and API both enforce this).
- [ ] Creating, editing or pausing a monitor takes effect without restarting the server.
- [ ] The source DB user has the read role only, and no write call to the source DB exists in the code.
