# DB Chat application data and identity

The Node backend uses Supabase Auth for email/password identity, Postgres for application records, and private Storage buckets for SQLite files and temporary downloads. Customer databases remain separate. Starting the app does not create Supabase resources. OAuth is not implemented.

## Deployment and migration

Apply **all nine migrations in filename order** before starting this version. Applying them to a remote project requires explicit authorization for that project.

| Migration | Purpose |
| --- | --- |
| `202609050001_dbchat_accounts.sql` | Accounts, encrypted sessions, connections and conversations |
| `202609060001_sqlite_storage.sql` | Private SQLite bucket |
| `202609080001_conversation_recovery.sql` | Server-owned evidence, provenance, knowledge and recovery |
| `202610030001_managed_turn_limits.sql` | Atomic daily managed-answer allowances |
| `202610030002_upload_limits.sql` | Daily upload count/byte allowances and pruning |
| `202610030003_worker_coordination.sql` | Worker leases, fenced turns, cross-worker cancellation and active capacity |
| `202610030004_asset_lifecycle.sql` | Durable uploads, orphan cleanup and resumable account deletion |
| `202610030005_retention_limits.sql` | Saved-data quotas, completion headroom and bounded sessions |
| `202610030006_durable_exports.sql` | Shared temporary download registry, files and cleanup |

The schema requires PostgreSQL 15 or newer. No customer fixtures or default accounts are seeded. Existing retained data is kept; accounts already above a new quota cannot add further data until usage falls below the applicable limit.

The **first upgrade from a binary without worker coordination requires a maintenance stop/start**: stop every old process, apply the complete chain, then start the new binary. Old startup recovery can otherwise interrupt live turns. Subsequent replacements may overlap when all processes use this coordination protocol and the same database, encryption key and capacity configuration. Roll back only to a compatible binary: the old unfenced turn RPCs are intentionally unavailable to the service role.

Configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (or legacy `SUPABASE_ANON_KEY`), `SUPABASE_SERVICE_ROLE_KEY`, `DBCHAT_STORAGE_MODE=supabase`, `DBCHAT_WEB_ALLOWED_ORIGIN`, and `DBCHAT_WEB_SECRET_KEY` (at least 32 random characters). Keep server secrets out of source control and frontend build variables. Production rejects local JSON storage. Both Render and a VPS can use the same external persistence; persistent application-host disk and sticky routing are unnecessary.

Startup probes the required tables/default retention policy and registers a worker before listening. Missing schema or unusable credentials prevent readiness. `/api/v1/health` returns 503 during shutdown or after worker coordination fails; this is not an email-delivery or backup-restore check.

## Auth, ownership and encryption

Enable email confirmations and configure production SMTP, sending domain, rate limits and redirect URLs. Set Supabase Site URL to the app origin. Use these email links:

- Confirm signup: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup`
- Reset password: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`

The browser removes the token from history and posts it to Node. Do not use implicit-flow templates that place access/refresh tokens in URL fragments. Verify delivery to actual external recipients, confirmation, login, recovery and session invalidation in the intended environment before launch.

Each account owns its settings, connections, chats, messages, artifacts, knowledge and turns. Passwords belong to Supabase Auth. Cookies contain random opaque values; only their SHA-256 hash and encrypted Auth token bundle are stored. Recovery sessions last at most 15 minutes, cannot authenticate ordinary APIs and are invalidated with all account sessions after reset. Access-token refresh uses a database lease and an in-process shared promise. Backend response bodies and tokens are never returned to the browser.

Application tables enable RLS and deny browser roles (`anon`, `authenticated`) access. Browser clients call Node, which uses the privileged service role. Owner filters, composite ownership foreign keys and owner-bearing transactional RPCs provide the application boundary; the service role itself is trusted and bypasses RLS. Never expose its key. Browser roles also cannot invoke the privileged RPCs or read either private bucket.

Connection passwords, full MongoDB/Elasticsearch URIs, provider keys and Auth token bundles use AES-256-GCM. Retain the stable encryption key separately from database backups. Losing it makes saved credentials unreadable. Rotation requires a controlled decrypt/re-encrypt migration and verification; replacing the environment value alone breaks existing ciphertext.

## Worker coordination and conversations

Each process registers a unique worker UUID with a 30-second database lease and renews every five seconds. A conservative local deadline, failed renewal or failed recovery makes the worker unavailable and aborts its active model work. Expired leases cannot be revived. Database fencing rejects a stale worker's progress and finalization even if its transport is slow to stop.

Turn admission atomically saves the question and retry context, reserves active capacity and checks managed usage. Defaults are two active turns/account and 16 globally (`DBCHAT_WEB_MAX_ACTIVE_TURNS_PER_USER`, `DBCHAT_WEB_MAX_ACTIVE_TURNS`). These counts cover all compatible workers. The supplied small-host configuration can use lower values; keep them consistent during deployment. Idempotent `(owner, request_id)` retries return the original turn without another reservation or charge.

Finalization commits the assistant answer and artifacts exactly once. Metadata endpoints cannot replace server-owned evidence. Cancellation is durable and reaches a different execution worker on its next heartbeat. If cancellation/deletion wins the database coordination lock before completion, the saved outcome is aborted. The UI receives the actual committed outcome.

Saved-turn GET and SSE read durable snapshots on any worker. Progress saves coalesce at 500 ms; SSE polls at 500 ms and replays committed event IDs with `Last-Event-ID`. The Node process bounds subscriber queues and allows at most eight durable subscriptions/account locally. Recovery checks only abandoned executions: a live worker's turn is untouched. After a crash, recovery normally follows the 30-second lease expiry and next sweep; an acknowledged stopped execution can be recovered sooner. No progress is fabricated while persistence is unavailable.

SIGTERM/SIGINT stop admission, abort/drain active work, close streams and release the worker lease. `DBCHAT_WEB_SHUTDOWN_GRACE_MS` defaults to 25 seconds; the CLI also has a hard termination deadline. Configure the host to allow that drain interval.

## Daily allowances

| Allowance | Default | Environment variable |
| --- | --- | --- |
| Managed turns/account/day | 100 | `DBCHAT_WEB_MANAGED_TURNS_PER_ACCOUNT_PER_DAY` |
| Managed turns globally/day | 1,000 | `DBCHAT_WEB_MANAGED_TURNS_PER_DAY` |
| Upload attempts/account/day | 10 | `DBCHAT_WEB_SQLITE_UPLOADS_PER_ACCOUNT_PER_DAY` |
| Upload attempts globally/day | 100 | `DBCHAT_WEB_SQLITE_UPLOADS_PER_DAY` |
| Upload bytes/account/day | 250 MiB | `DBCHAT_WEB_SQLITE_UPLOAD_BYTES_PER_ACCOUNT_PER_DAY` |
| Upload bytes globally/day | 1 GiB | `DBCHAT_WEB_SQLITE_UPLOAD_BYTES_PER_DAY` |

Postgres supplies the UTC date and serializes the check/increment. Personal-provider turns do not consume managed allowances. Accepted failed/cancelled managed attempts count; duplicate retries and rolled-back claims do not. These counts are **not a provider currency cap**; configure hard provider spending control separately.

Uploads reserve count and bytes before reading the request body. Known Content-Length reserves that size; chunked requests reserve the per-file maximum. Failures after reservation count. Quota exhaustion returns HTTP 429. Each process additionally admits one active upload/account and two globally by default (`DBCHAT_WEB_MAX_CONCURRENT_UPLOADS`); those memory-admission limits are local to the process, while daily and retained-byte quotas are durable across workers.

Usage counters store UTC day, scope/account UUID, count and upload bytes, without question or file content. They survive account deletion so deletion cannot reset the day's allowance. Startup and hourly pruning retain only current and previous UTC days and remove expired application sessions. Cleanup resumes when a process starts after downtime.

## Saved-data and session policy

`public.dbchat_retention_policy` contains a `scope='project'` default row. An optional row keyed by an account UUID is a **full-row override**, not a partial inheritance layer. Copy the intended project values when creating an override; omitted columns use SQL defaults. Policy changes are privileged remote configuration changes and need approval.

| Policy column | Default | Meaning |
| --- | --- | --- |
| `max_connections` | 100 | Saved connections/account |
| `max_chats` | 1,000 | Saved chats/account |
| `max_messages` | 100,000 | Saved messages plus accepted-turn reservations/account |
| `max_artifacts` | 100,000 | Saved artifacts plus reservations/account |
| `max_retained_bytes` | 104,857,600 | UTF-8 JSON row bytes plus reservations/account |
| `retained_sqlite_bytes` | 1,073,741,824 | Registered non-deleted SQLite bytes/account |
| `turn_reserve_bytes` | 16,777,216 | Admission headroom per accepted turn |
| `turn_reserve_artifacts` | 8 | Reserved artifact slots per accepted turn |
| `max_sessions` | 20 | Simultaneously live application login sessions/account |
| `max_recovery_sessions` | 2 | Separate live recovery-session slots/account |

The JSON ledger counts profiles, connections, chats, messages, artifacts, turn snapshots and knowledge. It excludes PostgreSQL/index overhead, Auth's own internal storage, and application sessions. SQLite and temporary exports have separate controls. These are per-account policies, not a total project disk quota; monitor real database size and egress.

New turns also reserve one assistant-message slot. Already accepted, fenced terminal commits have a bounded exception if capacity is later filled or reduced: at most 64 MiB of additional logical JSON, one assistant and 128 artifacts. Actual growth stays counted and blocks subsequent admission. An oversized completion becomes an explicit terminal error, retains already saved evidence and returns that saved error to SSE. Saved customer history is never automatically deleted because of age or quota; deleting/shrinking records releases capacity.

At the session limit, new sessions are rejected without evicting existing sessions. Recovery has separate capacity. Password confirmation for account deletion does not create an application session; it revokes only the temporary Auth session used to prove the password. Session insertion failure also attempts to revoke the just-issued Auth session. Existing devices stay signed in until explicit logout/revocation or expiry.

## Durable SQLite assets

`dbchat-sqlite` is private and caps objects at 50 MiB. The backend validates the SQLite header and registers a deterministic owner-scoped key in `dbchat_sqlite_assets` **before** uploading. The durable states are `uploading`, `pending`, `attached`, `deleting`, `deleted`. Attachment is checked atomically with connection persistence, so one pending upload cannot attach to two connections or another owner. An unexpired pending token remains resolvable after worker replacement.

An upload execution lease lasts two minutes; an unattached completed upload expires after one hour. Cleanup claims have two-minute leases and retry after one minute. Reconciliation scans run every ten seconds while a server is active, with bounded batches. Discovery compares old, well-formed Storage keys with durable assets and saved connection references after at least a one-hour grace. It catches lost replies and previously unregistered orphan objects. Never delete an object merely because it is old: attached customer files are retained.

Deleting a connection commits its removal and makes an unreferenced asset eligible for retried Storage removal. Retained-byte capacity is released after the registry records deletion, so a Storage outage cannot create unlimited unaccounted files. Existing connection references are backfilled during migration; unknown legacy size conservatively reserves 50 MiB.

Each test, schema request, query or export downloads a size-limited copy into a private temporary directory and removes it after completion/error/cancellation. A hard process kill may leave temporary files until the ephemeral host filesystem is cleared. Existing local JSON/SQLite files are not automatically uploaded.

SQLite work runs in killable children with a 64 MiB native SQLite heap limit, 96 MiB V8 old-space limit and 8 MiB result/batch budget. These are not total RSS limits. `npm ci` verifies native allocation rejection and rebuilds `better-sqlite3` with memory accounting when needed; Python, make and a C++ compiler are required for rebuilding. Do not skip install scripts. Run `npm run prepare:sqlite` after replacing the module. See [connector resource bounds](../docs/SDD-WEB-CHAT.md#6-read-only-enforcement).

## Durable temporary downloads

`dbchat_exports` reserves private keys in `dbchat-exports` before export work starts. Metadata and ready files are shared across workers; any instance can serve an authorized download. Execution leases last 90 seconds and are checked before publication. Cancel/remove requests are durable. A dead worker's export becomes an error that can be generated again; another process does not silently rerun the customer query.

The registry permits five outstanding downloads/account and ten globally, including files awaiting cleanup. Execution is limited to one/account and two globally. These counts are currently SQL constants in migration 006. Per-export defaults are one million rows, 100 MiB, five minutes of execution and one hour of availability; row/byte/timeout settings come from `DBCHAT_EXPORT_MAX_ROWS`, `DBCHAT_EXPORT_MAX_BYTES`, and `DBCHAT_EXPORT_TIMEOUT_MS`. The registry validates those bounds and holds capacity until cleanup is acknowledged.

Maintenance runs every five seconds. Expired, cancelled and removed objects are deleted with a leased claim; failures remain retryable. After deletion, metadata remains for a 24-hour grace with repeated object deletion to catch late Storage commits, then is pruned. Exports are temporary copies; their expiry does not delete saved chat evidence.

## Resumable account deletion

Password confirmation precedes `dbchat_begin_account_deletion`. The durable tombstone gates new account writes and revokes application sessions before destructive work starts. The API returns HTTP 202 with `pending: true` and clears the cookie. This means deletion was accepted, not that every object has already disappeared.

A leased job moves through `waiting`, `storage`, `auth`, `complete`. It durably cancels turns across workers, waits for live execution/upload leases and export cleanup, removes the owner's Storage prefix, then deletes the Auth user. Owned application records cascade. Storage and Auth are separate transactions: a partial failure leaves the account gated and the job retryable; the next reconciler continues rather than reopening access or claiming rollback. An already absent Auth user is success. Successful completion checks that the profile and SQLite prefix are gone. Other owners remain usable.

Do not remove a pending deletion tombstone to retry it. Restore service access/credentials and allow reconciliation to continue; inspect `phase`, `attempts`, `next_attempt_at` and lease timestamps if it remains pending. Currently completed account-deletion tombstones and deleted SQLite asset rows remain as crash-reconciliation metadata. They contain account UUID/key/file metadata and timestamps, not database-file contents; they are not age-pruned automatically. Any future metadata-retention cleanup must verify absent Auth identity, Storage objects and saved references and preserve late-write reconciliation.

## Bounded saved-data reads

REST responses and complete compatibility-history reads have a 16 MiB streaming ceiling, shared across pages. History pages return complete messages and related artifacts, or a clear size error; they never silently drop saved rows. Associated artifacts have a separate 8 MiB aggregate ceiling. Context reads also include older saved results without message linkage within that same budget, so existing report and export tools retain their evidence. Reduce the page size or select one result when a history read is too large.

Model context reads recent 30 relevant messages, up to 128 older definitions, pins and known limitations, and an explicitly selected earlier answer and its question. It projects only message text and small turn fields, with a 4 MiB response budget; it never loads every artifact in a chat. Older evidence beyond that candidate bound is omitted only when the existing 64,000-character model-context window is already full; otherwise the request fails before turn admission and managed usage. A single-result export read uses the owning chat and an 8 MiB ceiling, including its live-turn fallback.

New progress snapshots are limited to 14 MiB and terminal snapshots to 15 MiB, leaving room below the response ceiling. Oversized terminal completion becomes a durable error preserving previously saved evidence. The separate 64 MiB finalization allowance covers total saved-row growth. Existing larger snapshots remain stored; their direct reads return an actionable size error rather than allocating an unbounded response. Paginated saved history remains available within its page limits.

## Operations and verification

Monitor readiness failures, recovery/cleanup error logs, expired worker/export leases with unfinished work, usage approaching limits, pending deletion age and actual database/Storage size. Backend tables provide read-only operational surfaces:

| Table | Useful fields |
| --- | --- |
| `dbchat_workers`, `dbchat_turn_executions` | `lease_until`, `worker_id`, `cancel_requested`, `execution_finished` |
| `dbchat_retained_usage` | Counts, `retained_bytes`, `reserved_bytes`, reserved message/artifact slots |
| `dbchat_sqlite_assets` | `state`, `bytes`, `attempts`, `next_attempt_at`, upload/cleanup leases |
| `dbchat_account_deletions` | `phase`, `attempts`, `next_attempt_at`, `completed_at` |
| `dbchat_exports` | `status`, `executing`, `lease_until`, `object_deleted`, cleanup/tombstone timestamps |
| `dbchat_managed_usage`, `dbchat_upload_usage` | UTC-day account/global accepted usage |

Recovery prunes at most 100 worker rows per sweep when their lease expired over 24 hours ago and no execution references remain. Turn execution rows cascade with the saved turn. It never prunes customer turns or a worker still referenced by one. Asset/deletion tombstone retention is described above; plan and disclose that small metadata retention explicitly.

Test backup/restore of application records **and both Storage buckets** into an isolated project with the retained encryption key. Verify representative secret decryption, histories and attached SQLite files. Do not restore or replay stale active-worker leases as evidence that an old process is running. Define monitoring, capacity/egress alerts and provider spending limits before opening access.

Existing local JSON records require an explicit destination-owner mapping and controlled import; local scrypt passwords cannot be imported as managed Auth passwords. Preserve local files until counts and representative histories are verified. No unattended private-data migration is provided.

`npm run test:persistence` applies every migration and the maintained isolation fixture in embedded PostgreSQL with Auth/Storage shims. Worker and retention tests exercise actual SQL; the embedded connection alone does not establish competing-backend behavior. `npm run test:databases -- accounts` uses separate clients in a disposable PostgreSQL container for real lock contention, quotas, rollback, worker fencing, retention/session limits and permissions. HTTP regressions use two local app instances for progress replay, remote cancellation and admission. Local fixtures do not certify the intended hosted project's Auth/email settings, deployment signals or restore procedures. Never run fixture setup against a customer project.

References: [Supabase password authentication](https://supabase.com/docs/guides/auth/passwords), [email templates](https://supabase.com/docs/guides/auth/auth-email-templates), [sign-out scopes](https://supabase.com/docs/guides/auth/signout), [service-role security](https://supabase.com/docs/guides/database/secure-data).
