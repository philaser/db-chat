# DB Chat: Product and Architecture

> **Status:** Describes current repository source; deployment state is separate.
> **Last verified against source:** 3 October 2026
> **Design references:** [WEB-DESIGN.md](WEB-DESIGN.md) (screens) and
> [WEB-STYLE-GUIDE.md](WEB-STYLE-GUIDE.md) (visual system)

When a change alters a product boundary described here (accounts, connections,
inference, read-only policy, persistence, or deployment), update this document
in the same pull request.

## 1. Product

DB Chat is a hosted, account-based web workspace for asking questions about
**your own databases**. Users sign up with email and password, add connections
to their databases, and chat with a read-only analyst agent that answers with
prose, tables, charts, reports, and downloadable exports.

Core loop: **ask → inspect → refine → export**.

Fixed product boundaries:

- **Permanently read-only.** There is no write, DDL, or "elevated" mode. The
  agent must never offer to modify a source.
- **Customer-owned connections.** DB Chat stores account and application
  records, not a catalog of databases. Users supply their own connection details.
- **Web-first.** `src/web` is the only interface. The Electron app in
  `src/desktop` is a sandboxed window around the hosted URL. It has no renderer,
  query engine, IPC, or database drivers of its own.
- **Email/password only.** OAuth is deferred. There is no invite-only or
  beta gate.

## 2. Repository map

| Path | Contents |
| --- | --- |
| `src/web` | React 19 + Vite single-page app. `App.tsx` holds all screens; `contentBlocks.tsx` renders structured answer blocks; `chartRenderer.tsx` renders Recharts; `styles.css` holds every token and style. |
| `src/server` | Node HTTP/SSE API (`server.ts`), account repositories, agent execution (`webAgentService.ts`, `agent/`), database connectors, model client, export jobs. |
| `src/shared` | Browser/server contracts (`types.ts`), chart schema, connection-secret helpers. |
| `src/desktop` | Optional Electron shell (`main.ts`, `navigation.ts`). |
| `supabase/` | SQL migrations, isolation test, and operations notes ([supabase/README.md](../supabase/README.md)). |
| `evals/chat` | Synthetic chat evaluation suite ([README](../evals/chat/README.md)). |
| `scripts/` | Dev server, builds, live-database integration runners, evaluation scripts. |
| `test/` | Vitest suites for server, connectors, agent, and web UI. |

## 3. Runtime architecture

~~~text
Browser (src/web) ──HTTP/JSON + SSE──▶ Node service (src/server)
                                          ├─ Supabase Auth + Postgres  (accounts, chats, turns)
                                          ├─ Supabase Storage          (uploaded SQLite files)
                                          ├─ Model provider            (OpenRouter / OpenAI / DeepSeek)
                                          └─ Customer databases        (read-only connectors)
~~~

- One Node service serves both the built static assets (`dist-web`) and the
  API under `/api/v1/*`. Legacy `/api/*` paths are still routed.
- `GET /api/v1/health` is the deployment health check.
- The server uses plain `node:http` with no framework. Routing is a sequence of
  path matches in `WebServer.handleApi`.
- In Supabase mode, worker leases (30 seconds, renewed every 5 seconds) own
  accepted turns. Progress and terminal events are durable; any worker can serve
  a saved snapshot or SSE stream and request cancellation. Expired workers are
  recovered; stale writes are fenced. Health is 503 after lease loss.
- Upload registration, cleanup, account deletion and export metadata live in
  Postgres; files live in private Storage. Short request budgets and SSE viewers
  remain process-local. Daily allowances and active turn/export limits are shared.
- The first upgrade from the old non-coordinated binary requires a maintenance
  cutover. New coordinated workers can overlap afterward.

### Configuration

All configuration comes from the environment (`src/server/config.ts`; example
in `.env.example`). Key rules:

- `NODE_ENV=production` requires `DBCHAT_WEB_AUTH_MODE=app` and Supabase storage.
- Supabase mode requires `SUPABASE_URL`, a publishable key, a service-role key,
  `DBCHAT_WEB_SECRET_KEY` (32 characters or more), and a public origin.
  `DBCHAT_WEB_ALLOWED_ORIGIN` falls back to Render's `RENDER_EXTERNAL_URL`.
- `DBCHAT_STORAGE_MODE=local` selects the JSON account store (`~/.dbchat`) for
  development and tests only.
- `DBCHAT_WEB_AUTH_MODE=dev` creates a development user and can expose an
  environment-configured database (`DBCHAT_WEB_DATABASE_*`).

## 4. Accounts and sessions

- Supabase Auth owns identities and passwords. Sign-up, login, email
  verification (`/auth/confirm` with token-hash links), password recovery and
  reset, logout, logout-all-sessions, and account deletion are implemented.
- The browser holds one opaque, HTTP-only cookie (`dbchat_auth_session`). The
  server stores only its SHA-256 hash plus an encrypted Supabase token bundle.
  The idle timeout is 30 minutes and the absolute timeout is 30 days. Recovery
  sessions last 15 minutes and cannot call normal APIs.
- Requests from a foreign `Origin` are rejected. Authenticated mutations are
  limited per account (120/min), with separate IP budgets for sign-up, recovery,
  verification, and failed logins. Forwarded client addresses are used only when
  the operator configures the exact trusted proxy hop count; direct deployments
  use the socket address. Database checks, including suggestions, have account
  and instance budgets.
- Password-confirmed account deletion commits a durable gate before destructive
  work and returns HTTP 202. New activity is denied on all workers. Cleanup waits
  for admitted uploads and leased turn/export execution, removes private objects,
  then deletes the Auth user and cascades saved records. Failed steps retry;
  a lost successful Auth response is checked before retry. Completion is durable.
- Login sessions are bounded (20 per account by default), with a separate bounded
  recovery allowance (2). Expired rows are pruned; live sessions are not evicted.
  Password confirmation for deletion does not require another saved session.

Production email delivery requires SMTP/sending-domain configuration and real
confirmation/recovery tests on the selected project. Local checks do not verify
those deployment settings or successful delivery.

## 5. Connections

Supported engines: **PostgreSQL, MySQL, MongoDB, Elasticsearch, SQLite
(uploaded file)**.

- A save always runs a read-only connection test. A successful save is ready
  for chat. A failed test keeps the user in the form.
- Statuses: `ready`, `testing`, `needs_test`, `unavailable`, `needs_attention`.
  Chat refuses connections that are not `ready`.
- **Destination policy** (`connectionPolicy.ts`): hosts must be publicly
  reachable. Localhost, private, link-local, and reserved IPv4/IPv6 ranges are
  rejected after DNS resolution, and the checked address is pinned for the
  connection attempt. MongoDB requires one explicit host (no SRV) and an
  allowlist of URI options with password authentication only. The optional
  `DBCHAT_WEB_ALLOWED_DATABASE_HOSTS` setting can only narrow access further.
- **Secrets:** passwords, full MongoDB and Elasticsearch URIs, provider keys,
  and Auth token bundles are encrypted with AES-256-GCM using
  `DBCHAT_WEB_SECRET_KEY`. The browser sees only sanitized metadata and
  `hasSavedSecret`. Losing the key makes saved secrets unrecoverable.
- **SQLite:** files (`.db`, `.sqlite`, `.sqlite3`, up to 50 MiB) are uploaded to
  `POST /sqlite-files` and stored in the private Supabase Storage bucket
  `dbchat-sqlite` under the owner's ID. Each test, schema request, or chat turn
  downloads a temporary copy. Admission permits one active upload per account
  and two per instance by default. Daily defaults are 10 attempts / 250 MiB per
  account and 100 attempts / 1 GiB globally. Count and bytes are reserved before
  reading the body; chunked requests reserve the per-file maximum, and failed
  accepted uploads remain charged. Exhaustion returns HTTP 429.
- Upload registration precedes the Storage write. Pending upload tokens survive
  restarts and can attach once through a transactional connection trigger. Pending
  uploads expire after one hour. Cleanup claims are leased and retryable; attached
  files are retained until their connection is removed. Orphan reconciliation
  checks durable references and uses a grace period. Retained SQLite capacity is
  reserved before a Storage write (1 GiB per account by default).
- **Connection knowledge:** each connection has a private glossary and
  user-verified query examples. Examples are bound to a schema fingerprint and
  invalidated when the schema changes.

## 6. Read-only enforcement

The layers, from outermost to innermost:

1. **Prompt.** The system prompt (`agent/prompts/system.ts`) declares the agent
   permanently read-only and treats schema, rows, errors, and history as
   untrusted evidence.
2. **Tool allowlist.** `PermissionManager` permits only the eight web tools.
3. **Query classification.** `QueryValidator.classifyQuery` is a conservative
   SQL lexer. It accepts only a single `SELECT`/`WITH` statement and rejects
   ambiguous syntax (dollar quoting, `#`, backslashes, MySQL executable
   comments, multiple statements, `INTO`, `PRAGMA`, `COPY`, `CALL`, and
   similar). MongoDB and Elasticsearch queries go through their own
   validators, which block write stages and keys.
4. **Policy connector.** `WebPolicyConnector` pins connectors to `safe` and
   bounds results to 100 rows and 1 MiB. Previews fetch one extra row to
   detect truncation.
5. **Database layer.** PostgreSQL and MySQL run each query inside a
   `READ ONLY` transaction. SQLite opens the file read-only and rejects
   statements that aren't read-only. Statement timeouts apply. Users should
   still connect with a read-only role.

Result display limits are separate from transport and execution bounds:

| Engine | Bound before exposing a result |
| --- | --- |
| PostgreSQL / MySQL | 8 MiB wire messages/packets and 16 MiB buffered responses; exports retain frame/batch bounds while streaming under the export limits. |
| MongoDB | 20 MiB wire messages, compressed messages rejected, and 8 MiB decoded document/result or export-batch bounds. |
| Elasticsearch | 8 MiB HTTP response before JSON parsing. |
| SQLite | Killable child processes for queries, schema reads and exports; 64 MiB native SQLite heap, 96 MiB V8 old-space, and 8 MiB result/export batches. |

These limits do not guarantee a total process-memory ceiling. Driver stream
guards fail closed if an incompatible driver removes the required integration.
SQLite requires a native build with memory accounting: `npm ci` runs
`scripts/prepare-sqlite.mjs`, verifies allocation rejection and rebuilds
`better-sqlite3` when needed. Native compilation needs Python, make and a C++
compiler; the Docker build installs them. Do not skip install scripts. After
replacing the native module, run `npm run prepare:sqlite` again.

## 7. Chat turns

~~~text
POST /chat/turns ─▶ claimTurn (atomic: quota + message + retry context + dedupe)
                 ─▶ WebAgentService.run (fresh connector, introspect)
                 ─▶ runAgentLoop ─▶ events ─▶ WebSessionStore ─▶ SSE
                 ─▶ finalizeTurn (atomic: assistant message + artifacts, once)
~~~

- A turn belongs to a saved chat, and a chat is bound to one connection for
  life. The request carries client-generated IDs (`clientRequestId`, user and
  assistant message IDs) for idempotent retries.
- Events stream from `GET /chat/turns/:id/events` with `Last-Event-ID` replay.
  Event types: `status`, `text-delta`, `tool-start`, `tool-complete`,
  `result`, `thinking-*`, `approval-*`, `complete`, `error`, `aborted`.
- Leaving or reloading the page detaches the viewer without cancelling the
  turn. `POST /chat/turns/:id/abort` cancels it. Turns time out after 120 s
  (`DBCHAT_WEB_TURN_TIMEOUT_MS`).
- Concurrency limits: 2 active turns per user and 16 per instance.
- Managed inference also has durable UTC-day allowances: 100 accepted turns per
  account and 1,000 globally by default. The allowance and question are claimed
  in one database transaction. Failed/cancelled attempts count; idempotent
  retries and personal-provider turns do not. The selected credentials/model
  are captured at admission and reused for execution. Exhaustion returns HTTP 429.
  These are request limits, not a guarantee about provider spending; configure
  provider-side monetary limits separately.
- Failed, aborted, and interrupted attempts persist with their partial
  evidence and offer Retry/Edit. Follow-up intents (`compare`, `filter`,
  `explain`, `inspect-exceptions`, `change-chart`, `rerun`) carry the target
  message or result ID.
- The server rebuilds bounded conversation context (`conversationContext.ts`)
  from stored history. Clients cannot inject evidence.

## 8. Agent

`runAgentLoop` (`src/server/agent/AgentLoop.ts`) runs an OpenAI-style
tool-calling loop. The web service caps it at 6 rounds and 8 tool calls per
turn. It compacts context, blocks a failing call after it repeats twice, and
requires one corrected query (or an explicit limitation) after a failed query.

Tools (`webToolRegistry.ts`):

| Tool | Purpose |
| --- | --- |
| `run_database_query` | Read-only query. Results become owned artifacts (`resultId`) with analytical assumptions and checks. |
| `get_schema_info` | Search or retrieve schema when the prompt excerpt (40 tables × 40 columns, 200-name directory) is insufficient. |
| `sample_data` | Column profiles by default. Raw rows only when explicitly needed. |
| `get_result` | Re-read a saved result from this chat. |
| `visualize_data` | Validated chart from an owned `resultId`. The server attaches the chart. |
| `ask_clarification` | One focused question with selectable choices. |
| `create_report` | KPIs, tables, charts, and findings built from owned results, delivered in chat and as HTML/Markdown. |
| `export_data` | Queue a full export of an owned result or an explicit record-level query. |

Structured output (charts, reports, downloads) comes only from validated tool
results. The model cannot author rows, KPI values, download URLs, or
executable UI. `visualizationEnrichment.ts` adds a chart when the user asked
for one and the model did not produce it.

The prompt version is recorded with each turn, along with metrics: phase
timings, time to first useful evidence, query/tool/retry counts,
provider-reported tokens and cost, and terminal reason.

## 9. Inference

- **Managed (default):** every account uses `google/gemini-2.5-flash` through
  DB Chat's OpenRouter key (`DBCHAT_WEB_OPENROUTER_API_KEY`). Managed users
  cannot change the model.
- **Personal provider:** when `DBCHAT_WEB_USER_KEY_UI_ENABLED=true`, a user may
  add an **OpenAI** or **DeepSeek** key. The key is validated against the
  provider's `/models` endpoint, stored encrypted, and never returned. Personal
  users choose from the models in `model/providers.ts`. OpenAI users can also
  set a reasoning effort. Removing the key returns the account to managed
  inference.
- Personal OpenRouter keys are not accepted; the old route returns `410`. The
  managed OpenRouter key is never sent to a personal provider host.
- With no usable key, the turn returns a plain "inference is not configured"
  answer.

## 10. Results, exports, and reports

- Chat and the data inspector show at most 100 rows / 1 MiB per result. The
  inspector supports search, sort, column visibility, and copy, plus local
  CSV/Excel/JSON export of the visible view.
- **Full exports** (`POST /chats/:id/exports`) rerun the original read-only
  query on a separate connection and stream CSV, `.xlsx`, or JSON.
  Defaults: 1,000,000 rows, 100 MiB, 5 minutes (`DBCHAT_EXPORT_*`). Two jobs
  run concurrently (one per account). Each account keeps 5 retained files
  and the hosted service 10. Files expire after one hour; completed files survive
  worker replacement in private Storage. Leased jobs publish only after upload
  succeeds, and cancellation holds capacity until execution stops. CSV
  neutralizes spreadsheet formulas.
- Elasticsearch full exports require a document search. Aggregates need an
  explicit record-level follow-up.
- **Reports** are HTML/Markdown snapshots containing saved evidence, queries,
  provenance, and limitations.

## 11. Persistence

Supabase Postgres tables (`supabase/migrations`): `dbchat_profiles`,
`dbchat_sessions`, `dbchat_connections`, `dbchat_chats`, `dbchat_messages`,
`dbchat_artifacts`, `dbchat_turns`, `dbchat_connection_knowledge`,
`dbchat_managed_usage`, `dbchat_upload_usage`, worker/execution leases, retained
usage/policy/reservations, SQLite assets, account deletions and exports.

- Row-level security is enabled and all browser-role access is revoked. Only
  the Node service, using the service role, touches these tables, and every
  repository call filters by owner.
- Transactional RPCs: `dbchat_claim_turn`, `dbchat_save_turn`,
  `dbchat_finalize_turn`, `dbchat_update_chat`,
  `dbchat_update_message_metadata`, `dbchat_search_chats`,
  `dbchat_interrupt_pending_turns`, `dbchat_claim_turn_with_limits`,
  `dbchat_reserve_upload`, `dbchat_prune_usage`.
- The `202610030001_managed_turn_limits.sql` and
  `202610030002_upload_limits.sql` migrations add the usage tables and quota
  RPCs. Each allowance uses a daily advisory transaction lock across accounts.
  Counters store the UTC day, account UUID/global scope, counts and reserved
  bytes without question/file contents. They survive account/chat deletion.
  Pruning runs at startup and hourly, retaining today and yesterday; it resumes
  at startup after downtime. Separate retained-data triggers enforce configurable
  connection/chat/message/artifact counts and logical JSON bytes. Defaults are
  100/1,000/100,000/100,000 and 100 MiB. Existing over-limit data is preserved;
  growth is denied, while deletion and shrinking remain available. Accepted turns
  reserve 16 MiB, one message and eight artifacts, with a bounded terminal
  allowance of 64 MiB added bytes and 128 artifacts. Actual retained growth is
  counted afterward and can block later admission. No saved-history age deletion
  is scheduled. See the exact policy in `supabase/README.md`.
- Chats record a source snapshot, so history stays readable after its
  connection is deleted. Saved reads are streamed with a 16 MiB response/aggregate
  history budget and an 8 MiB artifact budget. Context loads compact recent,
  pinned/definition and explicitly selected earlier evidence; it does not load the
  whole chat. Oversized reads fail clearly without deleting saved data. New turn
  progress is capped at 14 MiB and terminal snapshots at 15 MiB, independently of
  the retained-row completion allowance. Existing larger legacy records are kept.
- API handlers and buffered responses have a per-process allowance (default 8,
  Render template 4); health/static delivery bypass it. SSE has separate lifetime
  limits of 16 viewers per process and 2 per account. Completed durable turns are
  removed from memory and remain available through database-backed replay.
- Apply all migrations in filename order before deploying. Before listening,
  startup probes required tables through PostgREST, initializes export cleanup,
  registers a worker, prunes usage/expired sessions and recovers only expired
  execution. Missing schema or unusable credentials prevent startup. Database
  readiness does not establish external SMTP, backup restore or customer reachability.

## 12. Deployment

- `Dockerfile` (Node 22, non-root, port 8787) builds the web and server bundles.
  `render.yaml` proposes one Render Starter web service in Frankfurt with
  `/api/v1/health`. Auto-deploy is off.
- Stop the old non-coordinated binary before the first migration cutover. Later
  deployments can overlap coordinated workers. Do not roll back to legacy
  recovery while new workers serve traffic.
- Database operation admission bounds driver/child allocations per process
  (`DBCHAT_WEB_MAX_DATABASE_OPERATIONS`, default 2; Render template 1), with a
  bounded queue. Container memory/CPU limits and measured capacity remain required.
- CI (`.github/workflows/checks.yml`) runs `npm test`, `npm run typecheck`,
  `npm run build`, and `npm run desktop:build` on Node 22 and 24, plus disposable
  migration verification, scripted analytical evaluation, a hosted dependency
  advisory gate, real PostgreSQL/MySQL/MongoDB/Elasticsearch integration and concurrent
  account quota checks on PostgreSQL. This describes the configured workflow,
  not a completed hosted CI run. PRs into `main` need exactly one
  `major`/`minor`/`patch` label. Merges are tagged automatically.
  Desktop installers come from the release workflow and require
  `DBCHAT_DESKTOP_URL`.

## 13. Testing and evaluation

- `npm test` runs the Vitest suites, including real SQL quota checks using
  embedded Postgres. `test:persistence` applies all migrations to a disposable
  embedded Postgres with Auth/Storage schema shims and verifies persistence
  contracts. Its single connection does not demonstrate backend contention.
- `npm run test:databases` runs PostgreSQL/MySQL/MongoDB/Elasticsearch integrations and the
  account suite in owned disposable localhost Docker containers. Select the
  account suite with `npm run test:databases -- accounts`: it applies all
  migrations, observes twelve independent service-role sessions waiting on
  advisory locks and verifies concurrent quotas, retry deduplication, rollback,
  deletion accounting, browser privileges, Storage policy and
  `supabase/tests/account_isolation.sql`. Fixtures are synthetic and containers
  are removed. Minimal Auth/Storage schema shims do not verify hosted Supabase
  Auth, PostgREST, Storage HTTP, email or deployment behavior.
- `npm run eval:chat` runs deterministic contract checks, and `-- --live`
  runs the model against a synthetic fixture. Output goes to `audit-output/`
  (local only).

## 14. Known limits and open decisions

- Short Auth/request rate windows are per-process; use edge limits when scaling.
- No OAuth, sharing, or collaboration.
- Hosted connections cannot reach private networks. There is no agent or
  tunnel option yet.
- MongoDB SRV URIs are not supported.
- One encryption key, with no rotation tooling.
- Production email delivery requires deployment verification.
- Daily usage limits do not provide a provider spending ceiling. Backups must
  include private objects and the separately retained encryption key.
