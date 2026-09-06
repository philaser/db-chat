# DB Chat

A hosted web workspace for asking questions of **your own database connections**.
The browser interface and Node backend run independently of Electron. Supabase
Postgres stores application records and Supabase Auth handles email/password
accounts. Customer databases remain separate; they are queried by the Node server
under a read-only policy.

## Architecture

- `src/web`: the single React interface, including account, connection and chat flows.
- `src/server`: HTTP/SSE API, persistence adapters, agent execution, model client and database connectors.
- `src/shared`: browser/server contracts and chart schemas.
- `src/desktop`: optional sandboxed Electron window opening the hosted web URL.
- `supabase/migrations`: versioned application database schema and ownership policies.

The desktop package contains no query engine, database drivers, preload bridge or
second renderer. No desktop process participates in serving the web application.
The former desktop renderer, IPC and local desktop stores have been retired.
Existing desktop user-data files are not modified or automatically uploaded.

## Local development

Use Node 22 or newer (the container uses Node 22). Install dependencies and copy
the example environment file:

```sh
npm ci
cp .env.example .env
npm run dev
```

Configure the Supabase project URL, publishable key, server-only service role key,
stable encryption key and model key in `.env` before starting managed mode. Apply
the SQL migrations to the selected project before use. Configure the Supabase site
URL and redirect allowlist for your browser origin. Production email/password
accounts also need functioning verification/recovery email delivery.

Development serves the browser at `http://localhost:5173` and proxies its API to
the Node backend at `http://127.0.0.1:8787`. Browser and server source changes reload.
Set `DBCHAT_WEB_ALLOWED_ORIGIN` to the browser origin. For isolated tests or local
fixtures, `DBCHAT_STORAGE_MODE=local` selects the legacy local adapter; it is not
permitted for production. OAuth is intentionally deferred.

```sh
npm test                 # Backend, connector, web UI and shell-policy checks
npm run typecheck
npm run build            # Browser assets + Node backend, without Electron
npm start                # Serve the built product
```

The SQLite native module runs under Node only. Tests rebuild it for Node when
necessary; Electron never loads it. The `web:*` commands remain aliases for
existing development tooling.

## Hosting

Deploy one Node-compatible service and one Supabase project. The included
`Dockerfile` builds the web interface and backend, runs as a non-root user, and
exposes port 8787. `compose.yaml` requires explicit managed-service credentials.
Place the service behind HTTPS and set the public application origin accordingly.
Static-only hosting is insufficient: database drivers, SSE, secret decryption and
SQLite execution require the Node service.

For Render Free, `render.yaml` uses the existing Dockerfile, one Frankfurt web
service, and `/api/v1/health`, without a Render database or persistent disk.
Supply the prompted environment variables through Render's secret settings;
retain the existing encryption key. The app uses Render's `RENDER_EXTERNAL_URL` as its origin automatically; set
`DBCHAT_WEB_ALLOWED_ORIGIN` only when using a custom domain. Do not upload `.env`. Automatic deploys are
disabled: suspend the existing service before deploying a replacement because
startup recovery currently assumes no other active instance. Verify it is stopped
before resuming/deploying; this entails downtime. Configure the same public origin
in Supabase Auth and complete email setup before customer signup.

Render Free sleeps after 15 idle minutes and can take about a minute to wake.
Its monthly limits and service-initiated traffic restrictions apply to calls to
Supabase, model APIs, and customer databases. Do not upgrade or enable paid
resources automatically. Supabase sends Auth emails through its configured SMTP
provider, so Render Free's SMTP-port restriction does not block that integration.
See [Render Free limits](https://render.com/docs/free).

Keep the service role key, model key and connection-encryption key server-only.
Do not use browser build variables for secrets. Retain the encryption key securely
and separately from database backups; losing it makes saved connection secrets
unrecoverable. Uploaded SQLite files live in the private Supabase Storage bucket
`dbchat-sqlite`; the Node service uses temporary files during queries and needs no
persistent disk in Supabase mode. Apply both SQL migrations before use. Configure
outbound network rules, process/resource limits, model spend limits, monitoring,
backup restore checks and rollback before serving customers. Review the migration
and operations documentation shipped with the Supabase adapter.

Customers bring connection details for PostgreSQL, MySQL, MongoDB or Elasticsearch,
or explicitly upload a SQLite file. The server must be able to reach their database.
A hosted service cannot reach the customer's localhost/private LAN merely because
the browser or optional desktop shell is running there. Use read-only database
roles and appropriate TLS/network restrictions. Public destination validation and
application query checks complement, rather than replace, network egress controls
and least-privilege credentials. Each engine needs live integration verification;
new engines can be added incrementally without an invitation-only launch model.

## Optional desktop shell

Desktop distribution is secondary and does not block web hosting. Set the actual
hosted HTTPS URL before building:

```sh
DBCHAT_DESKTOP_URL=https://your-app.example npm run desktop:package
```

For local shell development, run `npm run dev` separately, then:

```sh
DBCHAT_DESKTOP_URL=http://localhost:5173 npm run desktop:dev
```

`desktop:build` produces a dependency-free application directory; `desktop:dist`
creates installers. Without a configured URL, the shell shows a configuration
error instead of inventing a deployment address. It keeps native window lifecycle,
user-chosen download destinations and external browser links. Node integration is
off, isolation and sandboxing are on, and navigation stays on the configured origin.
No OAuth-in-Electron flow is implemented.

The desktop release workflow requires the repository's `DBCHAT_DESKTOP_URL`
variable and appropriate signing credentials. It does not deploy the web service.
No cloud project creation, migration execution, publishing or deployment occurs as
part of a local build. Pull requests into `main` require exactly one semantic
version label: `major`, `minor` or `patch`.

## Design

Start with [DESIGN.md](DESIGN.md). The web design and style guide govern the single
customer experience. The previous Scape desktop specifications are historical.
