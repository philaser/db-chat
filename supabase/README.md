# DB Chat application data and identity

DB Chat's Node backend uses Supabase Auth for email/password identity and Postgres for its own application records. Customer database connections remain separate. No Supabase resources are created by starting this repository, and OAuth is not implemented.

## Deployment prerequisites

1. Create the intended Supabase project and apply all SQL files in `migrations/` in filename order with your normal migration process. This changes remote data and must be explicitly authorized. The schema requires Postgres 15 or newer. No sample customer records or default accounts are seeded.
2. Configure the backend's `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (or legacy `SUPABASE_ANON_KEY`), `SUPABASE_SERVICE_ROLE_KEY`, `DBCHAT_STORAGE_MODE=supabase`, `DBCHAT_WEB_ALLOWED_ORIGIN`, and `DBCHAT_WEB_SECRET_KEY` (at least 32 random characters). Keep both server secrets outside source control and outside frontend build variables. Production configuration rejects local JSON storage.
3. Enable email confirmations and configure production SMTP, sending domain, rate limits and allowed redirect URLs in Supabase. Set Site URL to the hosted app origin. The backend uses token-hash email verification, not bearer tokens in browser URLs.
4. Configure the **Confirm signup** template link as `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup` and **Reset password** as `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`. The web page strips the token from history and posts it to the backend. Do not use the default implicit-flow template that sends access/refresh tokens in URL fragments.
5. Deploy one Node instance initially. Startup calls `interruptPendingTurns` before accepting requests, marking previously unfinished turns interrupted. Multiple active replicas require worker leases/heartbeats instead; do not run a rolling overlap of instances with this startup strategy.
6. Validate actual signup, confirmation email delivery, login, recovery, cross-device history, connection secret decryption, process restart and deletion on the selected project before publishing. Local mock tests and disposable Postgres tests do not verify hosted Auth settings or email delivery.

## Persistence and authorization

Each account owns profile/settings, connections, chats, message rows, result artifact rows and durable turns. Passwords belong solely to Supabase Auth. Session cookies are random opaque values; only their SHA-256 hash and encrypted Supabase token bundle are stored. Recovery sessions last at most 15 minutes, cannot authenticate normal APIs and are invalidated with all sessions after a password reset. Access-token refresh uses an in-process shared promise and a database lease for concurrent refreshes. No tokens or upstream error bodies are returned to the browser.

All application tables enable RLS and revoke access from `anon` and `authenticated`. Browser clients call the Node API, never these tables directly. This is deliberately stricter than client-readable RLS policies. The server uses the privileged service role, which bypasses RLS; therefore its repository explicitly filters every tenant operation by owner. Composite owner/connection/chat foreign keys and owner-bearing transactional RPCs provide additional checks. RPC execution is also revoked from browser roles. Never expose the service-role key.

Connection passwords, full MongoDB/Elasticsearch URIs, provider keys and Auth token bundles use AES-256-GCM encryption. Sanitized metadata is returned separately. Retain the stable encryption key independently of database backups; losing it makes saved credentials unusable. This version supports one key, so rotation requires a controlled decrypt/re-encrypt migration and verification before replacing the key. Never just change the environment value against existing ciphertext.

Messages and artifacts are separate ordered rows, with chat counts and titles stored on the parent. Turn claiming atomically appends the user's message and deduplicates `(owner, request_id)`. Finalization atomically appends the assistant/result records exactly once. After durable turns exist, stale browser autosave can edit metadata but cannot overwrite committed messages or artifacts. Startup recovery preserves the user's question and records an interrupted terminal turn. Deleting the Auth user cascades all their application rows without affecting other owners.

## SQLite file storage

The `dbchat-sqlite` bucket is private. The Node backend uploads validated SQLite files under the authenticated account ID and stores the object key with the connection. Browser roles cannot access this bucket directly. Each test, schema request or chat turn downloads its own size-limited copy to a private temporary directory, then removes it on success, error or cancellation. No persistent host disk is needed in Supabase mode. Saved connections survive process restarts; an upload not yet attached to a connection must be selected again after a restart.

Deleting a connection removes its object; deleting an account removes all objects under its owner prefix, including unattached uploads. Storage and Postgres deletion are not a single transaction: operational cleanup should reconcile orphaned objects after failures or abandoned uploads. A hard process termination can leave temporary files until the host clears its ephemeral disk. Existing local SQLite files are not automatically migrated; upload them again before switching an existing deployment. The bucket caps files at 50 MiB. Storage capacity and download egress count against your Supabase plan; every query turn downloads the file again. Single-instance deployment is still required for turn recovery, independently of file storage.

## Operations and migration

Use Supabase's backup/restore facilities appropriate to the chosen plan, and test restoration into a separate project along with the external encryption key. Schedule deletion of expired session rows (`expires_at` and `absolute_expires_at` are epoch milliseconds). Define customer result retention and storage quotas before permitting unbounded retained histories; per-query output is already bounded by the Node service, but cumulative account storage is separate.

Existing local JSON records are **not automatically uploaded or converted**. Back up the local store and its encryption key. Inventory real records versus fixtures, require an explicit destination account mapping, and migrate metadata/messages/results with ownership validation. Existing local scrypt password hashes are not imported into Auth; use verified enrollment/recovery. Preserve source files until counts and representative histories are verified in the destination. This implementation intentionally has no unattended import of private local databases or credentials.

## Verification

`test/supabaseAccountStore.test.ts` exercises managed-session exchange, encrypted storage, ownership-bearing requests, confirmation handling, refresh concurrency and transactional RPC invocation. `test/webAuthRoutes.test.ts` verifies recovery/verification/reset/deletion HTTP contracts.

`tests/account_isolation.sql` runs in a transaction and rolls back its fixtures. Use a disposable Supabase/local Postgres database with the migration applied; for plain Postgres, create the minimal `auth.users(id uuid primary key)` table and `anon`, `authenticated`, `service_role` roles first. It verifies duplicate claims/finalization, retained artifacts, cross-owner rejection, denied browser grants, startup interruption and cascade deletion. Do not run fixture setup against an existing customer project.

Reference: [Supabase password authentication](https://supabase.com/docs/guides/auth/passwords), [email templates](https://supabase.com/docs/guides/auth/auth-email-templates), [service-role security](https://supabase.com/docs/guides/database/secure-data).
