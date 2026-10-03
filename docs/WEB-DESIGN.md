# DB Chat Web Design

> **Status:** Current. Describes the screens as built in `src/web`.
> **Last verified against source:** 3 October 2026
> **Product and architecture:** [SDD-WEB-CHAT.md](SDD-WEB-CHAT.md)
> **Visual system:** [WEB-STYLE-GUIDE.md](WEB-STYLE-GUIDE.md)

DB Chat is a hosted account product. The design covers the whole path from
public entry to account, connection setup, inference settings, and data chat.

## Product posture

- Consumer-app clarity for sign-up and setup.
- Developer-tool precision in connection forms and results.
- An editorial, artifact-led conversation surface for analysis.

The aim is **approachable precision**: setup should feel safe and
understandable, and data work should be fast to scan and verify.

## Design principles

1. **Connection state is visible.** Users always know which connection a chat
   uses, whether it is healthy, and that chat is read-only.
2. **Secrets are represented, never exposed.** Show configured or missing
   states, never passwords or keys, and no fake masked values.
3. **The answer is the primary object.** Chat is the path to an inspectable
   result, not the end product.
4. **One responsive product.** Every flow works as a one-column mobile screen.
5. **Errors say what happened, what did not change, and what to do next.**

## Routes

| Route | Screen |
| --- | --- |
| `/` | Landing (signed out) or new chat (signed in) |
| `/signup`, `/login` | Auth forms |
| `/forgot-password`, `/auth/confirm`, `/reset-password` | Recovery and email verification |
| `/privacy` | Privacy and data policy |
| `/chat/:chatId` | Saved chat |
| `/settings` | Profile and security |
| `/settings/connections`, `/settings/connections/new`, `/settings/connections/:id` | Connection list, add, edit |
| `/settings/inference` | Inference |

## Public shell

Used for landing, auth, recovery, and privacy pages: compact brand, one
centered stage, and a footer reading "Private by default · Privacy and data ·
Read-only queries". The landing page pairs a short promise ("Ask your
database.") with a static example result. No connection or provider controls
appear before sign-in.

**Sign-up:** display name, email, password (at least 8 characters, with helper
text shown up front), confirm password, privacy acknowledgement checkbox,
**Create account**, and a link to log in. When email confirmation is required,
a "Check your email" alert replaces the redirect.

**Login:** email, password (with a reveal toggle), **Log in**, a recovery
link, and a sign-up link. Failures never reveal whether an email exists.

## Authenticated shell

~~~text
┌ App bar ─────────────────────────────────────────────────────────┐
│ ☰ (narrow)  DB Chat   · Read-only               Account menu ▾   │
├ Sidebar 224px ┬ Chat column (≤760px) ────────┬ Data inspector ──┤
│ New chat      │ entry stage / conversation   │ 400px default,   │
│ Search chats  │                              │ 360–480 resize,  │
│ Connection    │                              │ expand/collapse  │
│   filter      │                              │                  │
│ Chats (pin,   │                              │                  │
│   rename,     │                              │                  │
│   delete)     │                              │                  │
│ Connections   │                              │                  │
│ Settings      │ composer                     │                  │
└───────────────┴──────────────────────────────┴──────────────────┘
~~~

- **Account menu:** avatar, identity (name and email), Settings, and Log out.
  Destructive account actions live in Profile and security.
- **Sidebar:** becomes a toggleable drawer on narrow screens. Choosing a
  connection starts a new chat on it. Each chat is bound to one connection
  for life. Opening saved history uses that chat's source and does not change
  the default connection for new chats. Navigation detaches the viewer; only
  Stop cancels an accepted answer.
- **Data inspector:** holds results, query, and source details for the
  selected answer, plus export controls and recent downloads. Between 761px
  and 1100px it becomes an overlay panel. At 760px and below it flows into
  the page and the expand control is hidden.

## Chat workspace

### Entry states

| Condition | Shown |
| --- | --- |
| No connections | "Add a connection." with a reassurance that DB Chat won't modify data, plus **Add your first connection** |
| Active connection not ready | Connection attention state with **Manage connection** |
| Ready | "Ask a question." with suggestions derived from the connection's real schema (no model call), and the composer |

### Conversation

- The user's question is a quiet, distinct strip. The assistant answer is
  editorial prose, not a speech bubble.
- While a turn runs, a compact activity line shows human-readable progress
  (never chain-of-thought), with elapsed time and Stop.
- Answers may contain validated structured blocks: tables, charts (with type,
  grouping, and measure controls that do not re-query), KPIs, report
  sections, clarification choices, and download blocks.
- Follow-up actions (Explain, Compare, Filter, Exceptions, Rerun) are quiet
  text actions tied to that answer's result. Rerun states that it refreshes
  the source.
- "More actions" covers save/pin answer, feedback and correction, and
  answer or conversation export (HTML/Markdown).
- Failed, stopped, and interrupted answers keep their verified evidence and
  offer Retry/Edit.
- Long chats load up to 50 messages at a time, with "load earlier" and a Jump to
  latest control. Oversized pages automatically retry smaller sizes down to one
  message, preserving the history cursor. Other failures are shown without retries. Reloading reconnects to an in-flight answer. Closed streams
  recover from a saved snapshot with bounded reconnection attempts; a startup
  service failure shows a retry action while preserving the requested chat.
- If a chat's connection was deleted, its history stays readable and
  identifies the original source, but it cannot be used with another
  connection.

### Results and exports

- Previews show up to 100 rows. Tables support search, numeric sort, column
  visibility, and copy. Nulls show an em dash. Numbers are tabular and
  right-aligned. Headers stay sticky inside the bounded, scrollable artifact.
- Comparison charts initially retain every original metric. The Metric control
  can select one measure or restore **All original metrics**.
- Export offers **Visible rows** (the current filter, sort, and columns) or
  **All matching rows** (reruns the original query, labelled as refreshed
  data) in CSV, Excel, or JSON. Progress, cancellation, failure, download,
  and removal stay in the inspector. Hosted completed downloads survive service
  restarts until their one-hour expiry.
- Requests for the records beneath an aggregate go back to chat as an
  explicit row-level question.

## Settings

The settings side navigation becomes a "Settings section" select at 1180px
and below. Each page has an overline, a title, and one sentence of purpose.

**Profile and security:** display name, email and verification status,
change password, **Log out all sessions** (confirmed), and delete account
(password-confirmed). Hosted deletion signs out immediately after accepting a
durable deletion job; failed cleanup steps retry automatically. Saved data has
capacity limits and is otherwise kept until explicitly deleted.

**Database connections:** scan-friendly rows showing name, type, safe host,
status dot and label, and last tested. Below the list, the connection
knowledge editor (glossary and verified examples) appears for a chosen
connection. Credentials are never listed.

**Add/edit connection:** sections for Identity (name, database type), location
and credentials per engine (host, port, database, username, and password; a
MongoDB URI; an Elasticsearch URL; or a SQLite file drop zone with "How this
file is used"), transport (Use TLS/SSL, Verify the server certificate), and
Connection safety (a read-only access recommendation). Saving always tests
the connection. Failures stay in the form with a specific next action.
Deleting asks for confirmation and explains that history remains readable.
MongoDB URI input is masked because it can contain credentials. Its helper text
requires one public host using `mongodb://`; SRV and private destinations are
not supported.

**Inference:** a status line (Ready/Unavailable) and a summary of Mode
(Managed by DB Chat or Personal provider), Provider, and Model. Managed users
see the model read-only. When the personal-key flag is enabled, the page
shows a provider select (OpenAI or DeepSeek) and a key field with "OpenRouter
keys are not accepted." After saving a key, the page shows a model select,
reasoning effort (OpenAI only), Save settings, and Remove personal key. A
"How your data is used" disclosure explains what is sent to the provider.

## Component states

| Component | States |
| --- | --- |
| Auth form | default, focus, invalid, submitting, verification-pending, rate-limited |
| Connection row | ready, testing, needs test, unavailable, needs attention |
| Connection form | default, field error, uploading (SQLite), testing, saved, failed |
| Composer | empty, draft, submitting, generating, stopped, disabled with reason |
| Answer | streaming, complete, truncated, empty, incomplete, failed, aborted, interrupted |
| Export job | queued, running, ready, cancelled, failed, expired |
| Confirm dialog | open, pending, cancel |

## Accessibility and trust

- Target WCAG 2.2 AA, with visible focus on every control.
- Visible labels, autocomplete attributes, and field-level errors.
- Status is never communicated by color alone.
- Polite live regions announce test, save, and export results.
- No secrets in DOM attributes, URLs, logs, or browser storage.
- Confirmations for connection deletion, logging out all sessions, and
  account deletion.
- `prefers-reduced-motion` and `forced-colors` are honored.

## Avoid

- Hiding an unavailable connection behind a generic error.
- Letting the model generate arbitrary UI or choose a connection.
- Gradients, glass, saturated surfaces, heavy pills, or decorative metadata.
- Putting credentials or provider keys in local storage.
