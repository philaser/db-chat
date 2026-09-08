# DB Chat Web Design

> **Status:** Target design direction for the hosted web product
> **System:** Composed Clarity
> **Authority:** The product and architecture decisions are defined in
> [SDD-WEB-CHAT.md](SDD-WEB-CHAT.md).
> **Style guide:** Visual tokens, component contracts, responsive behavior,
> and research-backed design rules live in
> [WEB-STYLE-GUIDE.md](WEB-STYLE-GUIDE.md).

DB Chat Web is an internet-hosted account product. The design must support the
complete path from public entry to authenticated account, connection setup,
inference settings, and data chat.

It is not a responsive port of the Electron renderer and does not inherit the
desktop Scape/macOS layout or visual language.

## Product posture

The web product combines:

- consumer-app clarity during sign-up and onboarding;
- developer-tool precision in connection forms and query results;
- an editorial, artifact-led conversation surface for analysis.

The dominant design posture is approachable precision: make setup feel safe
and understandable, then make data work fast to scan and verify.

## Design principles

1. **Account before complexity.** Explain why a user is signing in and what
   happens next before asking for connection details.
2. **Connection state is visible.** Users should always know which connection
   is active, whether it is healthy, and that chat is read-only.
3. **Secrets are represented, never exposed.** Show configured/missing/rotated
   states, not passwords or provider keys.
4. **The answer packet is the primary object.** Chat is the path to an
   inspectable result, not the product's final form.
5. **Responsive web composition.** Account, settings, connection, and chat
   flows must work as one-column mobile screens without desktop chrome.

## Visual direction

Composed Clarity is a light-first, editorial, artifact-led workspace:

- warm neutral canvas and white work surfaces;
- rust for primary actions and focus;
- green, amber, coral, and bookish secondary colors for semantic/data signals;
- restrained depth for framed forms and result artifacts;
- clear typography with tabular numerals for data;
- short motion that explains state changes;
- no dark desktop utility aesthetic, glass effects, gradients, or decorative
  metadata.

## Application shell

### Public shell

Used for landing, sign-up, login, verification, and password recovery.

- compact DB Chat mark;
- short product promise;
- one centered form stage;
- explicit privacy/data-handling link;
- link between sign-up and login;
- no connection or provider controls before authentication.

### Authenticated shell

Used for chat, settings, and connection management.

~~~text
Utility bar
├── DB Chat mark
├── active connection selector
├── read-only status
├── connection health
└── account menu
    ├── signed-in identity
    ├── Settings
    └── Log out
~~~

The utility bar remains compact but is not a desktop title bar. On narrow
screens, the connection selector and account menu remain available through
accessible controls rather than disappearing.

On wide screens, authenticated chat may include a 224px conversation
navigation rail and an adaptive result/inspector rail that defaults to about
400px with a 360px minimum. These rails collapse into the content flow or a
mobile drawer when space is constrained.

## Account and onboarding screens

### Sign-up

An uncluttered single-column form:

- email;
- password;
- confirm password;
- terms/privacy acknowledgement;
- primary Create account action;
- existing-account Log in link.

Use inline validation and a form-level error summary. Do not make password
requirements appear only after submission.

### Login

- email;
- password;
- primary Log in action;
- password recovery link;
- sign-up link;
- verification-pending state.

Do not reveal whether an email exists through overly specific failure copy.

### First-run onboarding

After authentication, show a short progress path:

~~~text
Account ready → Add your first connection → Test connection → Start chatting
~~~

The user can skip adding a connection only if the app can clearly return them
to the setup state. Chat without an owned usable connection is not a valid
empty state.

## Settings information architecture

Settings is a responsive web page, not a desktop inspector:

~~~text
Settings
├── Profile and security
│   ├── display name
│   ├── email/status
│   ├── password change
│   └── active sessions/logout all
├── Database connections
│   ├── connection list
│   ├── add connection
│   ├── test connection
│   ├── edit connection
│   └── delete connection
└── Inference
    ├── provider status
    ├── internal/user credential source
    └── hidden user OpenRouter-key control
~~~

Use a settings navigation list on desktop and a select/back pattern on narrow
screens. Do not turn every setting into a floating card stack.

### Profile and security

Show:

- signed-in email and verification status;
- display-name field;
- change-password form;
- active-session summary;
- log out all sessions action with confirmation.

### Database connections

The connections page is a scan-friendly list of owned sources:

| Row content | Behavior |
| --- | --- |
| Label and kind | Primary identity of the connection |
| Health/status | Ready, testing, unavailable, needs attention, or disabled |
| Last tested | Useful freshness signal |
| Read-only policy | Always visible |
| Actions | Use, test, edit, delete |

Connection credentials are never shown in the list. A saved credential is
represented by configured/missing/needs update, not by a masked copy that
could be mistaken for the original.

### Add/edit connection

Use a guided form with clear sections:

1. **Identity:** label and database kind.
2. **Location:** host, port, database/index.
3. **Credentials:** username and password/secret.
4. **Transport:** TLS/SSL and certificate verification.
5. **Safety:** read-only role recommendation and query limits.
6. **Test and save:** visible progress, safe result, and recovery path.

The form must explain that the hosted service needs network reachability to the
database. If a private network, VPN, firewall, or allowlist is required, the
user should see a clear “cannot reach this source from the hosted service”
state rather than a generic error.

### Inference settings

The default settings surface shows:

- provider: OpenRouter;
- current credential source: internal service key;
- model name if safe to disclose;
- a short explanation that inference may process prompts, schema context, and
  bounded results.

The user OpenRouter-key field and navigation item are hidden while
user-key UI is disabled. The backend still reports only:

~~~text
hasUserKey: true/false
userKeyUiEnabled: true/false
credentialSource: user/internal
~~~

When the feature flag is enabled, reveal a password-style field with:

- “Add or replace key” action;
- never-display-after-save behavior;
- delete/rotate action;
- explicit precedence: user key first, internal key fallback;
- safe success/error feedback.

## Chat workspace

### Entry

The entry stage shows:

- selected connection;
- connection health;
- read-only status;
- three to five useful example questions;
- one prominent composer.

If there is no usable connection, replace the composer with an Add connection
action and a short explanation.

### Conversation

The conversation is a vertical analysis thread:

- user question as a distinct question strip;
- assistant narrative;
- compact activity disclosure;
- answer packet;
- follow-up composer.

The active connection label is associated with each answer packet. A connection
change starts a new context boundary and must be explicit.

### Answer packet

An answer packet contains:

- concise answer;
- purpose and evidence summary;
- row/column count and latency;
- returned-data artifact;
- collapsible query/provenance disclosure;
- Copy and data-export actions;
- future typed refinements.

The table remains bounded and horizontally scrollable inside the packet. Nulls
use an em dash; numbers use tabular alignment; headers remain sticky within
the artifact.

The first 100 rows form the immediate preview. Export offers Visible rows and
All matching rows with CSV, Excel and JSON formats. Visible rows preserve the
current filter, sort and visible columns. All matching rows rerun the original
read-only query and identify the export as refreshed data. Progress,
cancellation, recoverable failure and the final authenticated download remain
inside the inspector. The inspector restores a compact list of recent downloads
for the chat so users can resume, download or remove jobs before they expire.
Printable HTML and Markdown remain the report formats.
Requests for records beneath an aggregate return to chat as an explicit
row-level data question.

## Core components and states

| Component | Required states |
| --- | --- |
| Auth form | default, focus, validating, invalid, submitting, success, verification-pending, locked/rate-limited |
| Password field | empty, filled, invalid, reveal/hide, autocomplete-safe, disabled |
| Connection row | ready, testing, unavailable, needs attention, selected, deleting |
| Connection form | default, field validation, testing, test success, test failure, save success, save failure |
| Connection selector | ready, no connection, loading, unavailable, open, selected |
| Account menu | closed, open, keyboard navigation, logout pending, logout error |
| Settings navigation | current, hover, focus, mobile back/select |
| Secret setting | hidden, configured, missing, replacing, deleting, error |
| Composer | empty, focused, draft, submitting, generating, cancelled, disabled |
| Answer packet | streaming, complete, capped, empty, error, disconnected |
| Data export | configured, queued, running, ready, cancelled, error, expired |
| Alert/toast | info, success, warning, error, dismissible |
| Confirm dialog | open, cancel, destructive action pending |

Use semantic controls and preserve layout during loading. Errors state what
happened, what was not changed, and what the user can do next.

## Web-owned tokens

The target token set is independent from the desktop system:

| Token family | Target |
| --- | --- |
| Canvas | Warm ivory #FBFAF7 |
| Surface | #FFFEFA; soft region #F4F0EA |
| Ink | #17232D primary; #536170 supporting and muted text (minimum 4.5:1 for normal text) |
| Action | Rust #C8491D; hover #A83A16 |
| Data signal | Green #1E7B72; amber for attention; coral for errors |
| Typography | Georgia serif headings; Helvetica-like sans for UI; system mono for query and numeric data |
| Radius | 5px controls, 7px panels, 9px composer; round only for identity and compact actions |
| Shadow | One low-contrast surface shadow; no glass blur |
| Spacing | Reusable 4-point scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80px |
| Motion | 120–180ms; reduced-motion removes nonessential animation |

## Responsive behavior

- Public auth forms remain readable at 320px and never require horizontal
  scrolling.
- Settings navigation becomes a select/back pattern below tablet width.
- Connection forms use one column on narrow screens and preserve clear field
  grouping.
- The connection selector remains reachable in the authenticated header.
- Tables and query disclosures scroll inside their bounded artifacts.
- Account menus and confirm dialogs fit within the viewport and trap focus.
- The composer remains available after authentication and connection setup.

## Accessibility and trust

- WCAG 2.2 AA target.
- Visible focus for every field, menu item, selector, tab, button, and link.
- Proper form labels, autocomplete attributes, field-level errors, and
  form-level error summary.
- Never communicate connection or provider-key state by color alone.
- Announce connection-test and save results through a polite live region.
- Do not expose raw secrets in accessible names, DOM attributes, URLs, logs, or
  browser storage.
- Require confirmation for connection deletion and logout-all-sessions.
- Respect reduced motion and high-contrast/forced-color modes.

## Do

- Make sign-up and first connection feel like one guided path.
- Show the active connection before the user asks a question.
- Use clear “configured”, “testing”, “ready”, and “needs attention” language.
- Keep credential entry and error handling calm and specific.
- Treat provider source and data provenance as trust information.
- Reuse the same form, alert, selector, table, and composer tokens across
  account and chat surfaces.

## Avoid

- Do not inherit the desktop sidebar, inspector, title bar, or three-pane
  composition.
- Do not put connection credentials or provider keys in local storage.
- Do not display a fake masked key as if it were recoverable.
- Do not make users hunt through chat to add a connection.
- Do not hide an unavailable connection behind a generic “something went wrong”
  message.
- Do not let the model generate arbitrary UI or choose a connection.
- Do not use gradients, glass, saturated surfaces, heavy pills, or decorative
  metadata that does not help the user act.

## Implementation locations

### Conversation behavior

Keep the answer as the primary reading surface. Result filters, sorting, column
visibility and chart controls operate on the saved bounded result; they must not
silently execute another query. Explain, compare, filter and rerun actions carry
the selected answer/result identity. Rerun states that it refreshes the source.

An interrupted answer keeps its verified evidence and exposes Retry/Edit.
Reload reconnects to active work. A removed source leaves historical answers
readable and identifies the original source; the composer cannot use a different
connection under that history. Long chats load incrementally and expose Jump to
latest rather than forcing scrolling while the reader inspects earlier work.

Reports combine rich text with validated KPI, table and chart components. Export
actions distinguish one answer from the loaded conversation and preserve source,
capture time and limits. Connection knowledge and answer corrections are explicit
user edits, not silently inferred preferences.

### Code routing

- src/web/App.tsx — authenticated workspace composition.
- src/web/components/auth/ — sign-up, login, recovery, verification.
- src/web/components/settings/ — profile, connection, and inference settings.
- src/web/components/connections/ — list, selector, form, test, and delete.
- src/web/components/chat/ — composer, activity, answer packet, and results.
- src/web/styles.css or src/web/theme/ — web-owned tokens and responsive rules.
- src/server/auth/ — account/session boundary.
- src/server/accounts/ — user settings and ownership.
- src/server/connections/ — credential validation, testing, and lifecycle.
- src/server/secrets/ — encryption and secret-manager integration.
- src/server/providers/ — user-key/internal-key resolution.

Future implementation work should update the SDD first when an account,
connection, provider, or visual interaction decision changes the product
boundary.
