# DB Chat: Product and Architecture

> **Status:** Current. Describes the product as built on `main`.
> **Last verified against source:** 2 October 2026
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
- **Single instance only.** Active turns, SSE subscribers, export jobs, upload
  handles, and rate-limit windows live in process memory. On startup,
  `interruptPendingTurns` marks unfinished turns as interrupted. Running more
  than one replica requires worker leases first.

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
- Requests from a foreign `Origin` are rejected. Non-GET requests are rate
  limited per IP (120/min), with tighter budgets for sign-up, recovery,
  verification, and failed logins.
- Account deletion cascades to all of the user's application rows and stored
  SQLite objects.

Outstanding: production email delivery (SMTP provider and verified sending
domain) is not configured yet, so sign-up confirmation and recovery emails
are not production-ready.

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
  downloads a temporary copy.
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

## 7. Chat turns

~~~text
POST /chat/turns ─▶ claimTurn (atomic: user message + request-id dedupe)
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
  and each instance 10. Files expire after one hour or on restart. CSV
  neutralizes spreadsheet formulas.
- Elasticsearch full exports require a document search. Aggregates need an
  explicit record-level follow-up.
- **Reports** are HTML/Markdown snapshots containing saved evidence, queries,
  provenance, and limitations.

## 11. Persistence

Supabase Postgres tables (`supabase/migrations`): `dbchat_profiles`,
`dbchat_sessions`, `dbchat_connections`, `dbchat_chats`, `dbchat_messages`,
`dbchat_artifacts`, `dbchat_turns`, `dbchat_connection_knowledge`.

- Row-level security is enabled and all browser-role access is revoked. Only
  the Node service, using the service role, touches these tables, and every
  repository call filters by owner.
- Transactional RPCs: `dbchat_claim_turn`, `dbchat_save_turn`,
  `dbchat_finalize_turn`, `dbchat_update_chat`,
  `dbchat_update_message_metadata`, `dbchat_search_chats`,
  `dbchat_interrupt_pending_turns`.
- Chats record a source snapshot, so history stays readable after its
  connection is deleted.
- Apply new migrations before deploying a build that needs them.

## 12. Deployment

- `Dockerfile` (Node 22, non-root, port 8787) builds the web and server bundles.
  `render.yaml` targets one Render Free web service in Frankfurt with
  `/api/v1/health`. Auto-deploy is off.
- Because of the single-instance assumption, suspend the old service before
  deploying a replacement.
- CI (`.github/workflows/checks.yml`) runs `npm test`, `npm run typecheck`,
  `npm run build`, and `npm run desktop:build`. PRs into `main` need exactly
  one `major`/`minor`/`patch` label. Merges are tagged automatically.
  Desktop installers come from the release workflow and require
  `DBCHAT_DESKTOP_URL`.

## 13. Testing and evaluation

- `npm test` runs the Vitest suites. `test:databases` runs the live-engine
  integration scripts. `supabase/tests/account_isolation.sql` verifies tenant
  isolation against a disposable Postgres.
- `npm run eval:chat` runs deterministic contract checks, and `-- --live`
  runs the model against a synthetic fixture. Output goes to `audit-output/`
  (local only).

## 14. Known limits and open decisions

- Horizontal scaling requires distributed turn/export ownership.
- No OAuth, sharing, or collaboration.
- Hosted connections cannot reach private networks. There is no agent or
  tunnel option yet.
- MongoDB SRV URIs are not supported.
- One encryption key, with no rotation tooling.
- Production email delivery is not yet configured.
