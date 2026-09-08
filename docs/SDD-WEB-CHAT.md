# Software Design Document: DB Chat Web Chat

> **Status:** Draft target architecture and product direction — hosted account model
> **Date:** 2026-08-08
> **Owner:** DB Chat
> **Decision:** Preserve the core agent harness; build a hosted multi-user web product
> **Scope:** An internet-hosted, account-based, read-only browser experience with user-managed database connections
> **Design references:** [WEB-DESIGN.md](WEB-DESIGN.md) and
> [WEB-STYLE-GUIDE.md](WEB-STYLE-GUIDE.md)

## Current product contract — 8 September 2026

This section supersedes the earlier draft's pilot, persistence, chart and
desktop migration assumptions. The hosted web app and Node backend are the
primary product. Electron is an optional wrapper and is not required for
hosting. Supabase Postgres and Auth provide the hosted account boundary;
customers connect their own supported database types. There is no separate
bounded-beta product mode, and database writes remain outside this product.

The conversation contract now includes:

- Server-owned history, query evidence and source identity. Browser updates
  may change titles, pins and answer feedback, never replace stored answers,
  results or a chat's original connection.
- Saved active-turn identity, ordered SSE replay, terminal reconciliation,
  durable interrupted attempts, Retry/Edit, and retained partial query results.
  Leaving a route disconnects the viewer without cancelling server work.
  Restart recovery marks interrupted work honestly; it does not rerun it.
- Bounded conversation context with retained definitions/corrections, explicit
  result/message follow-up targets, and private connection glossaries and
  user-verified examples. Schema changes invalidate examples until reverified.
- Read-only analytical prompting, material-ambiguity clarification, checks for
  join grain and denominators, sampled-profile labels, and honest incomplete
  answers when tool, model or time limits prevent completion.
- Owned result references for retrieving evidence, validated charts and
  structured reports. KPI values, tables and chart rows come from saved query
  results. The model cannot supply executable presentation code.
- Searchable/pinned chats, incremental history, answer feedback and saved
  answers, local table controls, and chart display controls that do not query
  the source. Explicit reruns are new read-only queries, with new capture times.
- Markdown/rich-text answers and a closed report component set. Printable HTML
  and Markdown exports contain saved evidence, SQL, provenance and limits;
  exports are snapshots and clearly identify partially loaded history.
- Saved query results show up to 100 rows in chat and the data inspector. The
  inspector exports its current filtered, sorted, visible-column view as CSV,
  Excel or JSON, or requests a refreshed export of all rows matching the
  original read-only query. Jobs expose progress, cancellation, failure and an
  authenticated download. Typed download blocks contain a server-owned export
  ID instead of a model-provided URL. Underlying records for an aggregate
  require an explicit row-level follow-up query.
- Prompt/model version and phase timing, first useful evidence, query/tool
  counts, retries, and provider-reported token/cost usage. Missing provider usage
  is unavailable rather than an invented zero. Synthetic evaluation distinguishes
  deterministic contracts from live model correctness and narrative review.

The inference contract uses Gemini 2.5 Flash for every account through DB
Chat's managed OpenRouter path. Managed accounts see the selected model as
read-only. A user may switch models only after adding and validating their own
OpenAI or DeepSeek API key; OpenRouter keys are not accepted as user keys.
Personal keys remain server-side and are represented only by their configured
state. Removing a personal key immediately returns the account to managed
Gemini 2.5 Flash.

The runtime remains a single Node instance for active-turn ownership. Additional
instances require coordinated leases/recovery before horizontal scaling. New
control-plane migrations must be applied before deploying a build that needs
them. A local implementation or test run does not imply production deployment.

Portable evaluation instructions live in [evals/chat/README.md](../evals/chat/README.md).

## 1. Executive decision

DB Chat should have a real internet product, not a browser-shaped copy of the
Electron renderer or a self-deployed shell around one configured database.

The recommended approach is a controlled rewrite of the web product layer
around a preserved and extracted core harness:

1. Keep the agent loop, connector contracts, safety validation, model
   streaming contract, structured result artifacts, and audit/policy behavior.
2. Move those capabilities behind runtime-neutral ports that do not import
   Electron, DOM APIs, or desktop persistence.
3. Keep Electron as an adapter while the web product stabilizes.
4. Replace the current web shell, web session model, API contract, and
   presentation layer with a web-native experience designed around the loop
   **ask → inspect → refine → export**.
5. Treat the desktop visual system as a reference for neither layout nor
   styling. The web product gets its own visual language, tokens, responsive
   rules, and component states.
6. Make account creation, login, logout, user settings, connection
   management, and per-user data isolation first-class product capabilities.
7. Support user-supplied OpenRouter keys in the backend and encrypted settings
   model, while keeping the end-user key controls hidden behind a feature flag
   until the product is ready to expose them.
8. Use the internal OpenRouter key as the server-side fallback when a user key
   is not configured.

The service operator owns the hosted control plane. The user owns their
account, connection metadata, credentials, and optional inference-key setting.
The browser never receives raw database credentials or OpenRouter keys.

The current web implementation is useful as an integration harness and
contract proof. It is not the target product design. The implementation plan
therefore permits replacing src/web/ and reshaping src/server/ after the core
boundaries are in place.

## 2. Product statement

### 2.1 Problem

DB Chat makes database questions approachable, but the desktop app assumes
installation, a local runtime, and a multi-pane workspace. An internet user
needs a product that handles the account and connection lifecycle before chat:

- a simple account lifecycle;
- one or more user-owned database connections;
- clear connection health and read-only policy;
- an inference provider setting that does not leak secrets;
- one question at a time;
- clear evidence for each answer;
- a result that can be inspected and taken elsewhere.

The web app should make the first useful question feel like the end of a
short setup journey, not like a deployment console or database administration
tool.

### 2.2 Vision

DB Chat Web is a hosted analytical instrument for signed-in users who want to
turn natural-language questions into inspectable, bounded data answers from
their own connected sources.

The central object is not a chat bubble. It is an **answer packet**:

- the question asked;
- the short explanation;
- the data artifact that supports it;
- the query and source context, disclosed progressively;
- the next useful refinement.

### 2.3 Primary users

| User | Need | MVP behavior |
| --- | --- | --- |
| Question asker | Get a reliable answer without writing SQL | Sign up, connect a source, ask, read, refine, export |
| Data-aware operator | Verify how an answer was produced | Inspect query, row count, source, limits, and activity |
| Account owner | Manage access and data sources | Log in/out, edit profile, add/test/remove connections, manage settings |
| Service operator | Run a safe hosted product | Operate auth, control-plane storage, internal provider fallback, limits, and observability |

The MVP is not a database admin console, a collaborative BI suite, a general-
purpose AI workspace, or a self-deployment kit.

## 3. Goals and non-goals

### 3.1 Goals

1. Let a user sign up, log in, log out, and recover an authenticated session.
2. Let a signed-in user add, test, edit, select, and remove database
   connections from user settings.
3. Let a signed-in user ask natural-language questions against a selected
   owned connection.
4. Preserve the core harness as one source of truth across Electron and web.
5. Enforce read-only behavior below the prompt layer.
6. Stream progress and answer artifacts without polling.
7. Make every tabular answer inspectable, bounded, copyable, and downloadable.
8. Support an encrypted user OpenRouter-key setting in the backend while
   hiding its normal UI until enabled.
9. Fall back to an internal server-side OpenRouter key when no user key is
   configured.
10. Give the web product an independent visual identity optimized for browser
    reading, responsive layout, and analytical trust.
11. Create a migration path that does not destabilize the desktop application.

### 3.2 Non-goals for the first release

- Browser-direct database connections.
- Write queries, DDL, elevated safety levels, or approval prompts.
- Full desktop inspector, query editor, schema browser, or native file dialog.
- Team workspaces, organization administration, billing, public sharing, and
  collaboration.
- Enterprise SSO and social login in the first account implementation.
- Arbitrary model-generated HTML, CSS, or executable UI.
- Supporting every existing connector in the first hosted release.
- Exposing the user OpenRouter-key field in the default settings UI before the
  feature flag is enabled.

### 3.3 Account-based MVP boundary

The first hosted release includes:

- email/password sign-up, login, logout, and authenticated session renewal;
- account settings and a user-owned connection list;
- connection create, test, update, delete, and select-for-chat flows;
- server-side encrypted storage for connection credentials;
- server-side encrypted storage for an optional user OpenRouter key;
- hidden BYOK controls, with internal-key fallback;
- browser upload of a local SQLite file through drag-and-drop or the native
  file picker, with server-side ownership checks and read-only testing;
- read-only chat execution scoped to the selected connection;
- per-user turn, artifact, and audit isolation.

Email verification, password reset, account deletion, and OAuth should be
designed as part of the account boundary. They may be staged behind the first
working sign-up/login flow only if the deployment does not expose an account
to real users before those protections are ready.

## 4. Design research and inspiration

The web direction is informed by public, shipped or documented product
patterns. These are pattern sources, not visual templates. Brand identity,
distinctive layouts, illustrations, and proprietary assets must not be copied.

### 4.1 Inspiration matrix

| Reference | Observed pattern | Adopt for DB Chat Web | Adapt or avoid |
| --- | --- | --- | --- |
| [Hex self-serve analytics](https://hex.tech/product/explore/) | A question can begin with natural language and resolve into a visualization or spreadsheet, then be refined through natural language or direct manipulation. | Prompt-first entry; answer artifacts are the product, not a transcript alone. | Avoid reproducing Hex's workspace branding, marketing tone, or broad no-code scope. |
| [Metabase Questions](https://www.metabase.com/docs/latest/questions/introduction) | Questions combine query construction, visualization, natural-language assistance, and explicit saving/organization. | Show how an answer was produced and give it a stable, inspectable identity. | Avoid the density of a full BI navigation model in the scaled-down web MVP. |
| [Observable notebooks](https://observablehq.com/documentation/notebooks/) | Text, code, tables, visualizations, lightweight inputs, sharing, and history coexist as composable analytical units. | Treat returned data as a composable artifact with a clear type and bounded interactions. | Avoid turning chat into a notebook or requiring a cell-based authoring model. |
| [Deepnote](https://deepnote.com/docs/getting-started) | AI, SQL, data, and visual outputs share a flexible analysis canvas; the agent can handle multi-step work and inspect outputs. | Stream meaningful work states and make the result more useful than a plain-text reply. | Avoid a permanent notebook/sidebar environment for a one-question MVP. |
| [Mode notebooks](https://mode.com/notebooks/) | SQL results are immediately available and outputs can move into reports; CSV export and sharing are explicit. | Put the result in front, keep export obvious, and support a future handoff path. | Avoid implementing a full SQL/Python/R notebook or collaboration model now. |
| [Rill Explore](https://docs.rilldata.com/guide/dashboards/explore) | Measures, dimensions, drill-down, search, comparison, and export create a strong path from overview to detail. | Offer focused follow-up actions such as filter, explain, compare, and show rows. | Avoid dashboard-scale density and predefined metric administration in MVP. |
| [Vercel Generative UI](https://vercel.com/blog/ai-sdk-3-generative-ui) | Tool-backed responses can stream into structured components instead of ending as Markdown. | Use a closed set of typed artifacts such as tables, query disclosures, and later charts. | Do not allow the model to invent arbitrary client components or executable markup. |

### 4.2 Synthesis

The recurring useful pattern is not a particular color or card style. It is a
change in the unit of interaction:

~~~text
question
  → visible work
  → answer narrative
  → evidence artifact
  → targeted refinement
~~~

This leads to the following product direction:

> **Composed Clarity:** a bright, editorial, artifact-led web workspace where
> questions become compact evidence packets.

The direction should feel precise, energetic, and trustworthy. It should not
feel like a dark desktop utility, a database admin console, or a generic
consumer chatbot.

### 4.3 Anti-copying boundaries

- Use the references to extract interaction patterns, not colors, logos,
  typefaces, illustrations, or exact compositions.
- Do not use a notebook metaphor as the primary navigation model.
- Do not recreate a permanent BI sidebar or dashboard grid.
- Do not use model-generated UI outside a reviewed, typed component registry.
- Do not use a generic chat template with only a new accent color.
- Document any later reference additions with the same adopt/adapt/avoid
  treatment.

## 5. Independent web design direction

### 5.1 Product personality

| Attribute | Target |
| --- | --- |
| Tone | Clear, intelligent, calm under pressure |
| Energy | Focused and lightly expressive, with color reserved for data meaning |
| Density | Spacious at entry; information-rich once an artifact exists |
| Trust | Visible source, query, limits, timing, and read-only policy |
| Motion | Short state transitions; no decorative animation |
| Material | Light canvas, layered work surfaces, restrained depth |

The web product is light-first. Dark mode is a later theme, not a requirement
for the first pilot.

### 5.2 Composition

The primary route is one responsive analysis workspace:

~~~text
Web workspace
├── Utility bar
│   ├── DB Chat mark
│   ├── active connection selector
│   ├── read-only indicator
│   └── account menu
├── Account surfaces
│   ├── sign up
│   ├── log in
│   ├── log out
│   └── settings
│       ├── profile and security
│       ├── database connections
│       └── inference settings
├── Question stage
│   ├── prompt invitation or conversation header
│   ├── suggestion strip
│   └── analysis thread
├── Answer packets
│   ├── narrative answer
│   ├── evidence summary
│   ├── result table or future typed visualization
│   ├── query/provenance disclosure
│   └── refinement actions
└── Composer dock
    ├── question input
    ├── send/cancel action
    └── privacy/read-only helper
~~~

The web app does not recreate the desktop title bar or three-pane inspector.
On wide screens it may use a 224px conversation navigation rail and an
adaptive result/inspector rail; both collapse into the content flow or a
drawer on smaller screens. Account and connection management remain responsive
web flows, not desktop panels.

### 5.3 Visual system

These are target tokens for the rewrite. They are intentionally separate from
the desktop token set and should live in a web-owned theme file.

| Token family | Target |
| --- | --- |
| Canvas | Warm ivory #FBFAF7; content surface #FFFEFA; soft region #F4F0EA |
| Ink | Dark blue-black #17232D; supporting text #536170; muted text must meet 4.5:1 contrast |
| Primary action | Rust #C8491D; hover #A83A16; focus ring with visible contrast |
| Data signal | Green #1E7B72 for healthy/ready; amber for attention; coral for errors |
| Chart sequence | Rust, olive, ochre, plum, umber, and slate; pair every signal with text or shape |
| Typography | Georgia for editorial headings; Helvetica-like sans for interface; system mono for SQL and numeric cells |
| Radius | 5px controls, 7px panels, 9px composer; round only for identity and compact actions |
| Elevation | One low-contrast surface shadow; no glass blur; no stacked floating cards |
| Dividers | Neutral hairlines used only to separate information groups |
| Spacing | Reusable 4-point scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80px |
| Motion | 120–180ms interaction transitions; reduced-motion removes nonessential motion |

The exact values are subject to contrast testing. Tokens, not one-off values,
must drive the implementation.

### 5.4 Responsive rules

| Width | Composition |
| --- | --- |
| 1100px and above | Utility bar, a 224px conversation navigation rail, and centered analysis stage; the inspector/result rail defaults to about 400px and may resize to a 360px minimum. |
| 720–1099px | Same information architecture with reduced outer gutters; settings switches to compact navigation early when the form would be constrained; no hidden critical actions. |
| Below 720px | Single column; navigation becomes a drawer; inspector/results collapse below the content; tables scroll within the packet; composer remains reachable. |
| Below 420px | 16px page gutter; suggestion labels may wrap; metadata collapses before content is truncated. |

The browser must never require horizontal page scrolling. Only bounded
artifacts such as tables and long query disclosures may scroll horizontally.

### 5.5 Accessibility principles

- WCAG 2.2 AA target for text, focus, controls, and status states.
- Use semantic landmarks: header, main, form, article/section, table.
- All interactive elements are keyboard reachable with a visible focus state.
- Enter sends; Shift+Enter inserts a newline. This behavior is announced in
  the composer helper text.
- Streaming state is announced through a polite live region without
  re-announcing every token.
- Query and table controls have accessible names and predictable focus order.
- Do not encode data meaning using color alone.
- Respect prefers-reduced-motion.
- Result tables expose correct headers, caption/summary, and null values.

## 6. User experience specification

### 6.1 Account and onboarding journey

The first-run journey is:

~~~text
Landing → Sign up → Confirm account → Add connection → Save and test
        → Choose inference mode → Open chat
~~~

Required account surfaces:

| Surface | Required behavior |
| --- | --- |
| Sign up | Email, password, password confirmation, validation, terms/privacy acknowledgement, and recoverable errors. |
| Log in | Email/password, pending verification state, invalid-credential state, and a path to password recovery. |
| Log out | Clear the authenticated browser session and return to the public/auth entry state. |
| Account menu | Show the signed-in identity, link to settings, and provide logout. |
| Settings | Organize profile/security, connections, and inference settings without exposing secrets. |
| Connection setup | Collect connector-specific fields, validate them, test the connection, and show a safe result. |
| Empty account | Explain that a connection is needed and take the user directly to add one. |

The user should be able to reach chat after adding one valid connection. A
user may add more connections later and choose the active connection from the
chat utility bar.

### 6.2 Connection management

Connection setup is a guided web form, not a raw configuration dump.

Common fields:

- display name;
- database kind;
- host and port;
- database or index name;
- username;
- password or secret;
- SSL/TLS preference and certificate-verification policy;
- optional connector-specific fields.

The form must:

1. validate required fields before submission;
2. explain that the hosted service must be able to reach the database over the
   network;
3. recommend TLS and a read-only database role;
4. run the connection test as part of saving, so a successful save is already
   ready for chat;
5. never echo the password after submission;
6. show connection health without showing credentials;
7. warn before deletion and explain that saved chat artifacts may refer to the
   removed connection.

For SQLite connections, the form replaces a server filesystem path with a
file upload control. Users can drop a `.db`, `.sqlite`, or `.sqlite3` file onto
the control or click it to open the browser file picker. The browser uploads
the file to an authenticated, server-managed data directory and receives an
opaque upload ID. Connection create/update requests may reference only an
upload owned by the current account; arbitrary server paths are not accepted
for hosted accounts. Saving immediately runs the normal read-only connector
test. A successful save is ready for chat; a failed test leaves the connection
unavailable and keeps the user in the management form with the error to fix.
Uploaded SQLite files remain available across server restarts and are removed
when their owning connection is deleted.

A connection that later becomes unreachable is shown as unavailable. Chat must
make that state explicit and take the user to connection management; it should
not require a separate setup-time test action for a connection that was just
saved.

### Hosted persistence

The local hosted runtime persists users, account settings, selected connection,
connection metadata, encrypted connection/provider secrets, and hashed session
identifiers in an atomic JSON account store. A stable server vault key is
created alongside that store and is reused after restarts so saved credentials
remain decryptable. Sessions have idle and absolute expiry and remain valid
across a single-instance restart. The default data directory is `~/.dbchat`; deployments can override it
with `DBCHAT_WEB_DATA_DIR`, `DBCHAT_WEB_ACCOUNT_STORE_PATH`,
`DBCHAT_WEB_SECRET_KEY_FILE`, and `DBCHAT_WEB_SQLITE_UPLOAD_DIR`.

This file-backed store is the first hosted persistence boundary for the app,
not the final multi-instance deployment architecture. A production service
with more than one web process should replace it with a transactional database
and shared object storage without changing the account or connection API.

### 6.3 Inference settings

The product supports two provider-resolution paths:

~~~text
user OpenRouter key, when configured and enabled
        ↓ otherwise
internal server-side OpenRouter key
        ↓ otherwise
safe provider-not-configured error
~~~

The user-key capability exists in the backend from the beginning:

- store only an encrypted secret reference or ciphertext;
- return only hasUserKey and provider status;
- never return the raw key to the browser after save;
- never log the key, provider authorization header, or raw provider payload;
- allow deletion and rotation without displaying the existing value.

The default web settings UI hides the user-key field and navigation item behind
a feature flag. Internal operators may enable it for controlled testing. When
the feature flag is enabled for users, the field is a password-style input
with explicit explanation of precedence and data handling.

### 6.4 Hosted account-to-chat journey

~~~mermaid
flowchart LR
  A["Open hosted app"] --> B{"Authenticated?"}
  B -- "No" --> C["Sign up or log in"]
  B -- "Yes" --> D["Load account and connections"]
  C --> D
  D --> E{"Usable connection?"}
  E -- "No" --> F["Add connection"]
  E -- "Yes" --> G["Choose connection"]
  F --> G
  G --> H["Ask a question"]
  H --> I["See bounded work status"]
  I --> J["Read answer packet"]
  J --> K["Inspect, refine, or export"]
  K --> H
~~~

### 6.5 Core journey

~~~mermaid
flowchart LR
  A["Open hosted app"] --> B["Confirm connection and read-only policy"]
  B --> C["Ask a question"]
  C --> D["See bounded work status"]
  D --> E["Read answer packet"]
  E --> F["Inspect result or query"]
  F --> G["Refine or export"]
  G --> C
~~~

### 6.6 Entry state

The entry state should answer three questions before the user types:

1. What can I ask?
2. Which connection will answer?
3. What is the safety boundary?

Required content:

- one sentence describing the capability;
- active connection label;
- explicit read-only statement;
- connection health state;
- three to five real example questions;
- one focused composer.

Suggested questions are compact actions with a result-oriented label, such as
“Find the most active customers” and “Show weekly signups”. They should not be
large promotional cards.

### 6.7 Active turn

The active state communicates work without exposing hidden reasoning:

- “Checking the schema”
- “Running a read-only query”
- “Preparing the result”

The user can cancel. The draft remains intact after cancellation. Tool activity
is a short disclosure row; it is not a full debug console.

### 6.8 Answer packet

Each successful assistant turn is rendered as an answer packet:

1. **Answer:** concise narrative in plain language.
2. **Evidence summary:** active connection, row count, column count, elapsed time, and
   any limit or caveat.
3. **Artifact:** table in MVP; typed visualization or summary card later.
4. **Query disclosure:** collapsed by default, copyable, with effective
   read-only/limit information.
5. **Next action:** refine, explain, filter, compare, or export where supported.

The answer may say that it cannot determine something. The UI must not imply
confidence merely because a table exists.

### 6.9 Follow-up behavior

Follow-ups reuse the same authenticated session and selected connection. The
composer may show lightweight context such as “Ask about these rows”, but it
must not silently change the source, account, or safety policy.

Future refinement actions should be typed requests, not arbitrary model UI:

~~~text
filter result → { artifactId, predicate }
compare       → { artifactId, dimension }
explain       → { artifactId, question }
export        → { artifactId, format }
~~~

These are deferred beyond the initial table/copy/CSV surface unless the pilot
shows strong demand.

### 6.10 Error and recovery states

| State | User-facing behavior |
| --- | --- |
| Authentication required | Show the public auth entry state and preserve no sensitive result data. |
| Invalid credentials | Explain the failure without identifying whether an account exists beyond the chosen policy. |
| Session expired | Return to login, preserve only a local draft, and do not replay sensitive results before re-authentication. |
| No connection | Take the user to add a connection with a clear next action. |
| Connection unavailable | Show the connection label, a safe explanation, and a test/edit action. |
| Provider unavailable | Preserve the question and explain whether neither the user nor internal key is available. |
| Query blocked | Explain read-only policy in plain language; never suggest bypassing it. |
| Result capped | Show that the answer was bounded and offer a narrower question. |
| Turn cancelled | Keep the question and offer retry. |
| Network/SSE interrupted | Reconnect automatically using the last event ID, then show the final snapshot. |
| Connection deleted | Mark historical artifacts as disconnected from a live source; never attempt to reconnect with deleted credentials. |

## 7. Information architecture and routes

The MVP intentionally has very few routes:

| Route | Purpose |
| --- | --- |
| / | Public landing or authenticated chat workspace |
| /signup | Account creation |
| /login | Account login |
| /settings | Authenticated profile, connections, and inference settings |
| /settings/connections/new | Add a database connection |
| /settings/connections/:connectionId | Edit/test/delete an owned connection |
| /turn/:turnId | Optional deep link to a retained active/final turn in a later phase |
| /health | Deployment-level health endpoint; no user interface required |

The browser exposes account and connection management because they are core
product features. It does not expose arbitrary query execution, provider
credentials, raw secret retrieval, schema browsing, or session administration.

## 8. Architecture

### 8.1 Dependency rule

The core harness must be runtime-neutral:

~~~text
src/web ───────────────┐
src/renderer ──────────┼──> shared contracts / typed client adapters
src/server ────────────┘
                            │
                            ▼
                     src/core
                            │
                 connector / model / policy ports
~~~

src/core must not import:

- Electron or BrowserWindow;
- ipcMain, WebContents, or preload globals;
- DOM or browser APIs;
- desktop filesystem persistence;
- web-server request/response objects.

### 8.2 Hosted multi-user boundary

The hosted product has two distinct planes:

~~~text
Browser
  │ HTTPS, account session
  ▼
Web API
  ├── Auth and account service
  ├── User/connection/provider-key control plane
  ├── Turn/session/event service
  └── Core agent runtime
        ├── owned database connection selected for this turn
        └── OpenRouter resolver
              ├── decrypted user key, when enabled/configured
              └── internal server key fallback
~~~

The control plane stores account metadata and encrypted secret material. The
data plane opens a database connection only after the API has verified:

1. the request has an authenticated principal;
2. the selected connection belongs to that principal;
3. the connection is enabled and passes policy checks;
4. the resolved provider credential is allowed for that principal.

The core agent receives a connection and model client for the turn. It does
not receive a user ID and then look up arbitrary records by itself.

### 8.3 Target repository shape

~~~text
src/
├── core/
│   ├── agent/
│   │   ├── AgentLoop.ts
│   │   ├── ActivityManager.ts
│   │   ├── ContextManager.ts
│   │   ├── PermissionManager.ts
│   │   ├── ToolRegistry.ts
│   │   ├── types.ts
│   │   ├── prompts/
│   │   └── tools/
│   ├── connectors/
│   ├── model/
│   ├── policy/
│   └── types/
├── adapters/
│   ├── electron/
│   │   ├── ipc.ts
│   │   ├── persistence/
│   │   └── model/
│   └── web/
│       ├── WebAgentService.ts
│       ├── WebPolicyConnector.ts
│       └── auth/
├── server/
│   ├── api/
│   ├── sessions/
│   ├── auth/
│   ├── accounts/
│   ├── connections/
│   ├── secrets/
│   ├── providers/
│   ├── persistence/
│   └── observability/
├── renderer/
└── web/
    ├── api/
    ├── components/
    ├── state/
    ├── theme/
    └── App.tsx
~~~

Temporary compatibility re-exports from src/main/ are allowed during
extraction. New web code must import the core or web adapter, not another
runtime's implementation.

### 8.4 Preserved core harness

The following behavior is intentionally preserved and tested:

- AgentLoop round/tool orchestration;
- ToolRegistry definitions and tool execution contract;
- connector DatabaseConnector interface;
- schema introspection and context generation;
- QueryValidator SAFE-mode enforcement;
- model streaming and tool-call handling;
- AgentEvent vocabulary and cancellation semantics;
- typed QueryResult and QueryResultArtifact;
- permission decisions and audit entries;
- bounded memory abstraction where enabled;
- connector-specific safety behavior.

### 8.5 Rewritten web product layer

The following should be redesigned rather than extended indefinitely:

- browser information architecture and visual system;
- signup, login, logout, account settings, and onboarding;
- connection CRUD, test, selection, and health lifecycle;
- provider-key resolution and user-setting lifecycle;
- authenticated session and turn lifecycle;
- HTTP/SSE DTOs and versioning;
- responsive transcript and answer-packet presentation;
- result table, query disclosure, export, and refinement affordances;
- reconnect, error, empty, loading, and session-expired states;
- hosted account, control-plane, and secret-storage boundary.

### 8.6 Runtime ports

The core should depend on explicit interfaces:

~~~typescript
interface AgentModelClient {
  sendChatWithTools(
    messages: ModelChatMessage[],
    options: ModelChatOptions,
    signal?: AbortSignal
  ): Promise<ModelProviderResponse>;
}

interface AgentEventSink {
  publish(event: AgentEvent): void;
}

interface AuditSink {
  record(entry: AuditEntry): void;
}

interface AgentController {
  getConnector(): DatabaseConnector | null;
  getSchema(): DatabaseSchema | null;
  refreshSchema(): Promise<DatabaseSchema>;
  getMemoryStore(): MemoryStore;
  getConnectionId(): string;
  audit(entry: AuditEntry): void;
}

interface ConnectionResolver {
  getOwnedConnection(principalId: string, connectionId: string): Promise<DatabaseConnector>;
  testOwnedConnection(principalId: string, connectionId: string): Promise<ConnectionHealth>;
}

interface InferenceKeyResolver {
  resolve(principalId: string): Promise<{
    source: 'user' | 'internal';
    apiKey: string;
  } | null>;
}
~~~

The Electron adapter maps these ports to IPC and local persistence. The web
adapter maps them to HTTP session state, SSE, account auth, encrypted
connection storage, and provider-key resolution.

## 9. Agent execution and policy

### 9.1 Web turn policy

Every web turn receives a fixed server policy:

~~~text
safety level: safe
database: one user-owned connector selected for this turn
allowed tools: get_schema_info, sample_data, run_database_query
disabled tools: writes, DDL, memory writes, native export, arbitrary code
maximum rounds: 6
maximum tool calls: 8
maximum query rows: service-configured, default 100
maximum serialized result: service-configured, default 1 MiB
turn timeout: service-configured, default 120 seconds
~~~

The API resolves the selected connection by ownership before creating the
connector. The policy is then enforced by the connector, tool registry, and
server runtime. Prompt text cannot weaken it.

### 9.2 Structured result contract

The model may produce text, but the database tool produces a typed artifact:

~~~typescript
interface QueryResultArtifact {
  kind: 'query-result';
  queryId: string;
  query: string;
  result: QueryResult;
  purpose?: string;
  limits?: {
    maxRows: number;
    maxBytes: number;
    truncated: boolean;
  };
}

interface AgentRunResult {
  message: ChatMessage;
  artifacts: QueryResultArtifact[];
  events: AgentEvent[];
}
~~~

The client never parses Markdown to discover data. An artifact is rendered by
its kind and validated at the server boundary.

### 9.3 Trust and provenance

An answer packet should show, where available:

- selected connection label and owner scope;
- source kind;
- query execution time;
- row and column counts;
- whether the result was capped;
- effective query, with safe disclosure;
- tool activity summary.

Raw database rows must not be written to logs by default.

## 10. Web API design

### 10.1 API versioning

The target contract is versioned from the first rewrite:

~~~text
/api/v1/health
/api/v1/auth/signup
/api/v1/auth/login
/api/v1/auth/logout
/api/v1/auth/me
/api/v1/bootstrap
/api/v1/settings
/api/v1/settings/openrouter-key
/api/v1/connections
/api/v1/connections/:connectionId
/api/v1/connections/:connectionId/test
/api/v1/chat/turns
/api/v1/chat/turns/:turnId
/api/v1/chat/turns/:turnId/events
/api/v1/chat/turns/:turnId/abort
~~~

The current unversioned /api routes may remain as compatibility aliases
during the migration, then be removed after the pilot.

### 10.2 Endpoint contract

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /api/v1/health | Liveness/readiness; no secrets or schema |
| POST | /api/v1/auth/signup | Create an account and establish a session |
| POST | /api/v1/auth/login | Authenticate an account and establish a session |
| POST | /api/v1/auth/logout | Revoke the current session |
| GET | /api/v1/auth/me | Return safe current-user identity and session state |
| GET | /api/v1/bootstrap | Return user, owned connections, capabilities, limits, and provider status |
| GET/PATCH | /api/v1/settings | Read or update non-secret account preferences |
| POST | /api/v1/settings/openrouter-key | Store or replace an encrypted user key; UI is feature-flagged |
| DELETE | /api/v1/settings/openrouter-key | Remove the user key and restore internal-key fallback |
| GET | /api/v1/connections | List owned connection metadata and health |
| POST | /api/v1/connections | Create an owned connection with encrypted credentials |
| GET/PATCH/DELETE | /api/v1/connections/:connectionId | Read, update, or delete owned connection metadata/credentials |
| POST | /api/v1/connections/:connectionId/test | Test an owned connection without starting a chat turn |
| POST | /api/v1/chat/turns | Validate history, ownership, and selected connection, then create a turn |
| GET | /api/v1/chat/turns/:turnId/events | Ordered SSE event stream with replay |
| GET | /api/v1/chat/turns/:turnId | Authorized final snapshot or active state |
| POST | /api/v1/chat/turns/:turnId/abort | Idempotent cancellation |

The browser receives credential-write endpoints only. It never receives raw
credential reads, provider-key reads, native file dialogs, arbitrary query
execution, or desktop persistence.

### 10.3 Request and response examples

~~~json
POST /api/v1/chat/turns
{
  "connectionId": "conn_opaque_id",
  "messages": [
    {
      "role": "user",
      "content": "Which customers placed the most orders last month?"
    }
  ]
}

202 Accepted
{
  "turnId": "turn_opaque_id"
}
~~~

~~~json
GET /api/v1/bootstrap
{
  "ready": true,
  "user": {
    "id": "user_opaque_id",
    "email": "person@example.com",
    "displayName": "Person"
  },
  "connections": [
    {
      "id": "conn_opaque_id",
      "label": "Analytics warehouse",
      "kind": "postgres",
      "status": "ready",
      "readOnly": true
    }
  ],
  "inference": {
    "provider": "openrouter",
    "credentialSource": "internal",
    "hasUserKey": false,
    "userKeyUiEnabled": false
  },
  "capabilities": {
    "queryResults": true,
    "csvExport": true,
    "charts": false
  },
  "limits": {
    "maxHistoryMessages": 20,
    "maxMessageChars": 4000,
    "maxResultRows": 100,
    "maxResultBytes": 1048576
  }
}
~~~

~~~json
POST /api/v1/connections
{
  "label": "Analytics warehouse",
  "kind": "postgres",
  "host": "db.example.com",
  "port": 5432,
  "database": "analytics",
  "username": "dbchat_readonly",
  "password": "<submitted over HTTPS>",
  "ssl": true
}

201 Created
{
  "connection": {
    "id": "conn_opaque_id",
    "label": "Analytics warehouse",
    "kind": "postgres",
    "status": "unavailable",
    "readOnly": true
  }
}
~~~

~~~json
POST /api/v1/settings/openrouter-key
{
  "apiKey": "<submitted over HTTPS>"
}

202 Accepted
{
  "hasUserKey": true,
  "credentialSource": "user",
  "userKeyUiEnabled": false
}
~~~

The key-setting endpoint exists for the hidden capability and controlled
rollout. Its request body is accepted only over an authenticated HTTPS
session, and its response never contains the submitted key.

### 10.4 SSE event contract

Every event has a monotonic per-turn ID:

~~~typescript
interface WebTurnEvent {
  id: number;
  turnId: string;
  type:
    | 'status'
    | 'thinking-delta'
    | 'text-delta'
    | 'tool-start'
    | 'tool-progress'
    | 'tool-complete'
    | 'result'
    | 'complete'
    | 'error'
    | 'aborted';
  timestamp: string;
  data: Record<string, unknown>;
}
~~~

Rules:

- text-delta contains visible assistant text only.
- Hidden provider reasoning is never streamed to the browser.
- Tool events contain safe labels, counts, and status, not credentials or
  unrestricted payloads.
- result carries or references a validated artifact.
- complete includes the final message and artifact IDs.
- error contains a safe message and correlation ID.
- Last-Event-ID replays retained events for the same authorized principal.

### 10.5 Turn lifecycle

~~~mermaid
sequenceDiagram
  participant Browser
  participant API
  participant Core
  participant Model
  participant DB

  Browser->>API: POST turn
  API-->>Browser: turnId
  Browser->>API: GET SSE stream
  API->>Core: start turn with policy and AbortSignal
  Core->>Model: stream response/tool calls
  Model-->>Core: text and tool calls
  Core->>DB: validated bounded read
  DB-->>Core: QueryResult
  Core-->>API: result artifact and answer events
  API-->>Browser: ordered SSE events
  Browser->>API: optional abort
~~~

## 11. Authentication, sessions, and security

### 11.1 Authentication

The web app is a hosted account product. Authentication is part of the
application, not an assumed reverse-proxy property.

~~~typescript
interface Principal {
  id: string;
  displayName?: string;
  roles: string[];
}

interface AuthProvider {
  authenticate(request: IncomingMessage): Promise<Principal | null>;
}
~~~

The first account flow is email/password with:

- sign-up;
- login;
- logout;
- session renewal;
- email verification;
- password reset;
- rate-limited credential attempts.

Passwords should be hashed with Argon2id or an equivalent memory-hard password
hashing scheme. Plaintext passwords, reset tokens, and verification tokens must
never be logged or persisted after their single-use lifecycle.

OAuth, enterprise SSO, and organization membership can be added through the
same AuthProvider boundary later. Development-only local identity may exist
behind an explicit development mode and must never be the production default.

### 11.1.1 Account and ownership model

Minimum control-plane entities:

| Entity | Required fields | Ownership rule |
| --- | --- | --- |
| User | id, email, password hash, display name, status, timestamps | Top-level account owner |
| Session | id, user id, expiry, revocation timestamp, device metadata | Read/write only by owning user |
| Connection | id, user id, label, kind, non-secret config, secret reference, status | Visible only to owning user |
| User provider key | user id, provider, encrypted secret, enabled flag, timestamps | One optional key per provider/user |
| Turn | id, user id, connection id, status, timestamps | User ownership plus connection ownership at creation |
| Audit record | event metadata, user id, connection id, redacted outcome | Access controlled by service operator policy |

Every connection, turn, artifact, and setting lookup must be scoped by the
authenticated user ID. IDs alone are never authorization.

### 11.2 Session model

- Opaque cryptographically random session ID stored in an HttpOnly,
  Secure, SameSite=Lax cookie.
- Server-side session record with idle and absolute expiry, revocation, and
  optional device metadata.
- Session renewal only after a valid authenticated session; no silent identity
  switching.
- Principal-scoped access on every settings, connection, turn, snapshot, SSE,
  and abort endpoint.
- Bounded message history and result artifacts in the turn store.
- No provider key, database password, or raw connection string in the browser
  session or serialized bootstrap response.
- Browser-side draft retention is optional, local-only, and must be disclosed.
- Logout revokes the current session and optionally all sessions for the
  account when the user chooses security reset.

### 11.3 Threat controls

| Threat | Control |
| --- | --- |
| Provider-key exposure | User and internal keys exist only in encrypted server-side storage/process memory; browser receives status, never raw key material. |
| Database credential exposure | User credentials are accepted only over authenticated HTTPS, encrypted at rest, decrypted only for an owned turn/test, and never returned to the browser. |
| Prompt injection | Treat schema, rows, and tool output as untrusted data; server policy remains authoritative. |
| Unsafe query execution | SAFE validator, read-only connector, allowlisted tools, row/byte/time caps. |
| XSS from rows or answers | React text rendering, safe Markdown configuration, no unsanitized HTML. |
| Cross-user access | User ownership check for every settings, connection, session, snapshot, SSE, and abort request. |
| CSRF | Same-origin API, SameSite cookies, origin checks, and CSRF token if cross-origin hosting is introduced. |
| SSRF and egress abuse | User-supplied hosts require validation, DNS/IP policy, private-network policy, TLS controls, and connector-specific egress restrictions. |
| Resource exhaustion | Request limits, per-user active-turn limits, bounded history/results, connection-test limits, rate limits, and timeouts. |
| Log leakage | Redact credentials, full SQL, row values, provider payloads, and raw model responses. |
| SSE abuse | Authenticated subscriptions, heartbeat, per-principal connection limits, and cleanup. |
| Account takeover | Password hashing, verification/reset flows, rate limiting, secure cookies, session revocation, and suspicious-login monitoring. |
| Credential persistence failure | Envelope encryption with a service-managed key, key rotation plan, and secret deletion on connection removal. |

### 11.4 Data handling

The product must tell users:

- which database connection is active;
- that the app is read-only;
- which provider credential source is active for inference;
- that prompts, schema context, and bounded results may be sent to OpenRouter;
- whether drafts, turns, or connection metadata are retained;
- how to delete a connection and its stored credentials.

The hosted product requires a control-plane database for accounts, sessions,
connection metadata, encrypted secret references, and settings. Turn history
and result artifacts should remain bounded and have an explicit retention
policy; they must not be silently treated as permanent records.

The product must not send database content, raw prompts, connection details, or
provider payloads to third-party product analytics by default.

### 11.5 Secret and provider-key handling

Connection credentials and the optional user OpenRouter key are secrets, not
ordinary user profile fields.

- Encrypt secrets before persistence using envelope encryption.
- Keep the data-encryption key in a managed secret/KMS boundary, not in source
  control or the browser.
- Store a secret reference plus ciphertext metadata, never a plaintext secret.
- Decrypt only inside a short-lived connection-test or agent-turn scope.
- Zero or release decrypted values as soon as the connector/provider client
  no longer needs them.
- Redact secrets from errors, traces, event payloads, and audit records.
- Support rotation and deletion; deleting a connection deletes its credential
  material after the retention policy permits.
- Keep the internal OpenRouter key outside the user database and resolve it
  from the service secret manager.

Provider resolution is deterministic:

1. If user-key support is enabled and the user has a valid stored key, use it.
2. Otherwise use the internal OpenRouter key.
3. If neither exists, fail with a safe provider-not-configured state.

The client receives only provider, credential source, hasUserKey, and
userKeyUiEnabled fields. It never receives a key or an authorization header.

## 12. Persistence and deployment

### 12.1 MVP persistence

The hosted product requires durable control-plane persistence for:

- users and password hashes;
- sessions and revocation;
- connection metadata and encrypted credential references;
- user settings and provider-key metadata;
- connection health/status timestamps;
- retention metadata for turns and artifacts.

Use a managed PostgreSQL-compatible database for the control plane. Use a
shared turn/event store or a single process only during the earliest
integration phase; the hosted product should not silently lose active turns
when an API instance restarts.

Connection credentials and the internal provider key belong in an encrypted
secret boundary. The control-plane database stores references and ciphertext,
not plaintext secrets.

Full conversation persistence is a product decision, not an implementation
accident. Default retention should be bounded and documented, with deletion
behavior for users, connections, turns, and artifacts.

### 12.2 Deployment topology

~~~text
Browser
  │ HTTPS
  ▼
CDN / API gateway
  ├── public/authenticated web assets
  └── long-running Node API
          ├── account and session service
          ├── control-plane database
          ├── encrypted secret manager
          ├── user-selected database connections
          └── OpenRouter
~~~

Operational requirements:

- reverse proxy must not buffer SSE;
- proxy idle timeout must exceed the maximum turn duration;
- production uses TLS and secure cookies;
- API egress must be restricted and monitored for user-supplied database hosts;
- readiness must distinguish process health, control-plane health, and
  connector/provider readiness;
- API instances must share account/session authorization state;
- active-turn/event state must use a shared store before horizontal scaling;
- the product is hosted by the service operator; users do not configure or
  deploy the API locally.

### 12.3 Configuration

Example service configuration:

~~~text
DBCHAT_CONTROL_DATABASE_URL=<secret-managed postgres connection string>
DBCHAT_SECRET_MANAGER=<managed secret provider>
DBCHAT_WEB_OPENROUTER_API_KEY=<service secret>
DBCHAT_WEB_MODEL=deepseek/deepseek-v4-flash-0731
DBCHAT_WEB_USER_KEY_UI_ENABLED=false
DBCHAT_MAX_RESULT_ROWS=100
DBCHAT_MAX_RESULT_BYTES=1048576
~~~

PostgreSQL is the recommended control-plane database. PostgreSQL, Elasticsearch,
MySQL, MongoDB, and SQLite can be offered as user connections only after each
connector has a hosted-network, TLS, credential, timeout, and read-only policy.
SQLite connections require a separate decision because a browser user cannot
grant the hosted service access to a local filesystem path.

## 13. Observability and operations

Every request and turn receives a correlation ID.

Allowed structured log fields:

- request/turn ID;
- privacy-safe user ID;
- owned connection ID and label;
- model ID;
- provider credential source, as user or internal;
- tool name;
- permission outcome;
- duration, row count, and result byte count;
- terminal status and error category.

Minimum metrics:

- active sessions and turns;
- sign-up, login, logout, verification, and password-reset outcomes;
- connection create, test, failure, update, and delete outcomes;
- success, error, and abort counts;
- time to first visible token;
- total turn latency;
- provider and connector failures;
- user-key versus internal-key usage counts, without recording key material;
- blocked query count;
- result row/byte cap rejections;
- SSE reconnects and disconnects;
- authentication failures and rate-limit responses.

No raw result rows, passwords, provider keys, full provider payloads, or
unredacted user/database content belong in default logs.

## 14. Testing and quality strategy

### 14.1 Core characterization tests

Before moving code:

- fake-model/fake-connector AgentLoop test;
- SAFE policy denies writes and DDL;
- query limits and result byte caps are enforced;
- artifacts preserve columns, order, nulls, numbers, booleans, and timing;
- cancellation stops the model/tool loop;
- core modules contain no Electron imports.

### 14.2 API tests

- sign-up validates fields, hashes passwords, and creates a session;
- login accepts valid credentials and rejects invalid credentials safely;
- logout revokes the current session;
- verification and password-reset tokens expire and cannot be reused;
- unauthenticated account/settings/connection/chat requests are rejected;
- principal isolation blocks foreign settings, connections, turns, and artifacts;
- connection credentials are never returned in list, bootstrap, or error bodies;
- connection test and deletion are ownership-scoped and auditable;
- hidden user-key UI state is reflected in bootstrap without exposing a key;
- provider resolution prefers an enabled user key, then internal key, then safe error;
- body, history, and message limits are enforced;
- SSE IDs are ordered and replayable;
- abort is idempotent and terminal;
- provider/database errors become safe client messages;
- audit logs omit secrets and raw rows;
- concurrent-turn and rate-limit behavior is deterministic.

### 14.3 Browser tests

Cover:

- landing, sign-up, login, logout, verification, settings, add-connection,
  connection-test, connection-error, typing, streaming, result, aborted,
  reconnect, and session-expired states;
- hidden user-key settings behavior and masked secret state when the feature
  flag is enabled;
- Enter send and Shift+Enter newline;
- table semantics, numeric alignment, null display, long values, and empty
  results;
- copy and CSV serialization for commas, quotes, tabs, newlines, nulls, and
  empty datasets;
- no dependency on window.dbchat or Electron APIs.

### 14.4 Visual and accessibility QA

At minimum, validate:

- 1440px desktop;
- 1024px tablet;
- 390px narrow viewport;
- keyboard-only path;
- forced-colors or high-contrast behavior where available;
- reduced-motion behavior;
- no page-level horizontal overflow;
- focus visibility and table reading order.

Visual claims require screenshot or DOM/computed-style evidence. The web
rewrite is not complete when only the happy path has been inspected.

### 14.5 Required repository checks

The implementation must keep these checks green:

~~~text
npm test
npm run typecheck
npm run build
npm run web:build
git diff --check
~~~

## 15. Migration and implementation plan

### Phase 0 — Freeze the contract

- Mark the current web UI as a prototype.
- Add shared web DTOs and typed event/artifact contracts.
- Add fake model/connector fixtures.
- Add characterization tests for desktop behavior.
- Agree on authentication, first connector, provider, and result limits.

### Phase 1 — Extract the core harness

- Move pure agent, connector, model, policy, and artifact code into src/core.
- Introduce AgentEventSink, AuditSink, and runtime-neutral controller ports.
- Keep compatibility re-exports from src/main while Electron is migrated.
- Make the desktop IPC layer an explicit adapter.
- Verify desktop tests, typecheck, and build after every move.

### Phase 2 — Rebuild the web runtime boundary

- Create a versioned API adapter.
- Implement hosted auth, sessions, account ownership, and control-plane
  persistence.
- Implement connection CRUD, connection testing, encrypted credential storage,
  and selected-connection resolution.
- Implement hidden user OpenRouter-key storage and internal-key fallback.
- Separate turn execution and SSE from core execution.
- Add connector-owned web policy enforcement for user-owned connections.
- Add bounded result artifacts and safe error mapping.
- Add service health/readiness, egress controls, and redacted audit events.

### Phase 3 — Rewrite the web product layer

- Replace the current web composition with the Composed Clarity system.
- Implement public landing, sign-up, login, logout, onboarding, settings,
  connection management, and chat.
- Implement entry, active-turn, answer-packet, result, error, reconnect, and
  credential-status states.
- Implement the light-first token system and responsive rules.
- Add connection selector, result table, query disclosure, copy, CSV, and
  focused refinement hooks.
- Keep the product web-first and avoid desktop shell parity.

### Phase 4 — Hosted pilot

- Deploy the hosted control plane with account creation and service-managed
  secrets.
- Validate SSE through the actual reverse proxy.
- Use an approved read-only source reachable by the hosted service.
- Validate add/test/remove connection flows and user isolation.
- Validate internal provider-key fallback and hidden BYOK state.
- Observe onboarding completion, task success, trust, latency, errors, and
  result-cap behavior.
- Conduct an accessibility and visual review with representative users.

### Phase 5 — Expand only from evidence

Consider, in order of validated demand:

1. charts as a typed result artifact;
2. query/schema inspection;
3. durable history;
4. visible user-provided OpenRouter keys;
5. sharing/collaboration;
6. additional connectors;
7. controlled write workflows.

Do not infer these requirements from desktop feature parity alone.

## 16. Success measures

The hosted pilot should measure:

| Measure | Why it matters |
| --- | --- |
| Sign-up completion rate | Does the account flow explain the product and avoid unnecessary friction? |
| Login/logout success rate | Is the account boundary reliable and understandable? |
| First-connection completion rate | Can a user reach a usable source without support? |
| Connection-test success rate | Are connector fields and network requirements clear? |
| First-question completion rate | Does the entry state explain the product? |
| Time to first useful answer | Does the web flow feel immediate enough? |
| Answer inspection rate | Do users verify evidence rather than accept text blindly? |
| Follow-up rate | Can users refine without restarting? |
| Export/copy success | Is the result useful outside the app? |
| Cancellations and retries | Are turns too slow or unclear? |
| Blocked-query rate | Are prompts aligned with the read-only boundary? |
| Internal-key fallback rate | How often do users run without BYOK, without exposing key material? |
| Provider/connector error rate | Is the deployment reliable? |
| Accessibility defects | Can the experience be used with keyboard and assistive technology? |

No database row values or raw prompts should be sent to product analytics
without an explicit data-handling decision.

## 17. Risks and alternatives

### 17.1 Reusing Electron main directly

Rejected. It keeps IPC, window lifetime, and desktop persistence inside the
web path. Extracting a core harness creates one source of truth while leaving
runtime security boundaries explicit.

### 17.2 Browser-direct database access

Rejected for MVP. It exposes credentials or forces broad browser-side
connector support, complicates CORS and egress controls, and weakens policy
enforcement.

### 17.3 WebSocket instead of SSE

SSE is preferred because the MVP primarily streams server-to-browser events
and uses a separate abort request. WebSocket is reasonable later for
bidirectional approvals, collaboration, or multiplexed sessions.

### 17.4 Durable history immediately

Deferred. It creates retention, deletion, tenancy, and sensitive-data
obligations before the browser workflow is validated.

### 17.5 Full notebook or BI workspace

Rejected for the scaled-down product. Hex, Deepnote, Mode, Observable, and Rill
show valuable patterns, but their larger workspace models would obscure the
one-question-to-evidence journey.

### 17.6 Arbitrary generative UI

Rejected. The model may select from a reviewed artifact registry; it may not
ship executable UI or unbounded client-side code.

### 17.7 Hosting user database credentials

Accepted as the requested product model, but only with explicit limits. The
service becomes responsible for protecting credentials and for connecting to
user-controlled network endpoints. The first connector release must therefore
define supported network reachability, TLS, timeout, IP/DNS restrictions, and
read-only-role guidance.

### 17.8 Internal provider-key fallback

Accepted as the default onboarding path. The internal key must be isolated
from the user control plane, rate-limited, monitored for abuse, and covered by
provider terms and cost controls. A missing or exhausted internal key must
produce a safe service error rather than silently accepting an unconfigured
state.

## 18. Open decisions

1. Which email delivery/authentication service will support verification and
   password reset?
2. Which control-plane database and secret manager will be used?
3. Is PostgreSQL the first user connection type, or should another connector
   be enabled first?
4. What hosted-network rules will apply to user-supplied database hosts?
5. Which provider/model is approved to receive bounded schema and results?
6. How will the internal OpenRouter key be rate-limited, monitored, and cost
   controlled per user?
7. When should the hidden user-key UI feature flag be enabled?
8. Should refresh clear the transcript or restore a bounded local draft?
9. What row/byte limits balance usefulness and data sensitivity?
10. Is a table sufficient for pilot validation, or is one typed chart artifact
    required?
11. Should the web product support a light/dark theme before pilot, or remain
    light-first?
12. What audit and turn-retention periods apply to hosted accounts?

## 19. Definition of done

The web product is ready for a hosted pilot when:

- the browser cannot access database or provider secrets;
- the web runtime uses the extracted core harness rather than a forked agent;
- a user can sign up, log in, log out, and recover an authenticated session;
- a user can add, test, select, update, and delete an owned connection;
- a user-owned read-only database connection can answer natural-language questions;
- connection credentials are encrypted at rest and absent from client responses;
- user-key storage exists but its default UI remains hidden;
- inference uses a user key when enabled/configured, otherwise the internal key;
- SAFE policy is enforced by server, tool registry, validator, and connector;
- status, visible text, result artifacts, completion, error, reconnect, and
  abort states work;
- result packets expose source, limits, timing, and inspectable data;
- tables are semantic, bounded, copyable, and downloadable as CSV;
- principal-scoped account, settings, connection, session, and turn access is tested;
- logs and metrics do not leak sensitive data;
- SSE works through the selected proxy;
- the web UI passes desktop, tablet, narrow, keyboard, and reduced-motion QA;
- the web visual system is independent from the desktop design system;
- desktop tests, typecheck, build, web build, and diff checks remain green;
- pilot metrics and unresolved decisions have named owners.

## 20. Appendix: research notes

The research sources were selected because they expose public descriptions or
documentation of real data-workflow patterns:

- Hex connects natural-language questions to visualizations/spreadsheets and
  refinement.
- Metabase connects questions to query building, visualization, and explicit
  organization.
- Observable makes data tables, visualizations, text, code, and lightweight
  inputs composable.
- Deepnote combines AI, SQL, code, and visual outputs in a flexible analysis
  workspace.
- Mode puts SQL results and export/share paths close to the analytical output.
- Rill demonstrates focused exploration through measures, dimensions,
  drill-down, comparison, and export.
- Vercel's generative UI work supports the architectural distinction between
  plaintext chat and typed tool-backed components.

These observations support the product direction, but the final visual system
must be original, accessible, and derived from DB Chat's own user tasks.
