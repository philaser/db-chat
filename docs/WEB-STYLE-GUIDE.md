# DB Chat Web Style Guide

> **Status:** Target visual system for the hosted web product
> **Version:** 0.1
> **Date:** 2026-08-08
> **Owner:** DB Chat
> **System name:** Composed Clarity
> **Applies to:** src/web/ and web-facing authenticated/public flows

This guide is the visual and interaction source of truth for DB Chat Web. The
product and architecture decisions live in [SDD-WEB-CHAT.md](SDD-WEB-CHAT.md);
the screen-level direction is summarized in [WEB-DESIGN.md](WEB-DESIGN.md).

The web product is an internet-hosted, multi-user account product. It is not a
responsive port of the Electron renderer and must not inherit the desktop
Scape/macOS layout, chrome, dark utility aesthetic, or token names.

## 1. The design decision

### Chosen paradigm: Composed Clarity

DB Chat Web should use a calm, expressive, AI-native utility language:

- **Calm:** a light, low-noise canvas lets users focus on their question and
  the evidence behind the answer.
- **Composed:** the interface assembles the right answer packet, connection
  context, query disclosure, and next action around the current task.
- **Expressive:** color and shape create a clear hierarchy for intent, health,
  caveats, and data—not decoration for its own sake.
- **Trustworthy:** connection identity, read-only policy, query lineage,
  loading state, and failure state are visible at the moment they matter.
- **Responsive:** the same product model works as a focused one-column mobile
  experience and a spacious desktop workspace.

This is an original synthesis, not a request to reproduce any referenced
product. The visual rule is: borrow the principle, not the identity.

### Why this is the best fit

DB Chat has two kinds of uncertainty to reduce:

1. **Setup uncertainty:** Is my account ready? Is the right database connected?
   Where does the inference come from? Are my credentials safe?
2. **Answer uncertainty:** What did the system run? Which source did it use?
   Can I inspect the result? Is the answer read-only and bounded?

Composed Clarity addresses both with a predictable hierarchy:

~~~text
intent → context → action → evidence → refinement
~~~

The interface should feel more like a well-edited data workspace than a generic
chatbot or an administration console.

### What we considered and deliberately did not choose

| Paradigm | Useful signal | Why it is not the primary DB Chat language |
| --- | --- | --- |
| Liquid Glass / translucent material UI | Dynamic hierarchy, adaptive controls, depth | It is a platform material language. Blur, translucency, and floating chrome can reduce data legibility on the web. Use solid surfaces and restrained depth instead. |
| Material 3 Expressive | Purposeful color, personality, stronger interaction feedback | The expressive range is useful, but DB Chat needs analytical restraint. Use expressive accents only for intent and state. |
| Dark developer command center | Dense information, strong technical identity | It would make account setup and connection trust feel more operational than approachable, and would inherit the desktop mood we are explicitly leaving behind. |
| Maximalist bento dashboard | Fast visual scanning and modularity | A grid of equal cards would make a single question compete with irrelevant modules. Reserve modular artifacts for the answer packet. |
| Chat-only AI shell | Familiar conversation, low initial complexity | Plain chat hides evidence, connection context, and result inspection. Chat is the input path, not the whole product. |

### Non-negotiable boundaries

- Do not use the desktop Scape/macOS navigation or inspector patterns.
- Do not use dark mode as the default web treatment.
- Do not use glass, backdrop blur, gradients, decorative grain, or animated
  background effects as structural UI.
- Do not hide the active database connection while a question is running.
- Do not display raw database credentials or an OpenRouter key after save.
- Do not represent every state with a colored pill; prefer labels, dots,
  inline descriptions, and clear action text.
- Do not let AI-generated content invent new component styles at runtime.
  Generated output must render through the approved answer-packet primitives.

## 2. Research frame

The research question was: how should a small hosted data assistant combine
account trust, connection setup, AI interaction, and inspectable results without
becoming a generic dashboard?

| Reference | Pattern observed | DB Chat adaptation |
| --- | --- | --- |
| [Apple Human Interface Guidelines: Materials](https://developer.apple.com/design/human-interface-guidelines/materials) | Recent platform guidance treats materials as a hierarchy tool that should keep controls legible over content. | Keep the hierarchy principle, but use opaque web surfaces for tables, SQL, and form fields. |
| [Google Material 3 Expressive](https://developer.android.com/design/ui/wear/guides/get-started/design-language) | Newer design guidance expands tonal color, shape, and interaction expression while preserving familiar component roles. | Use a compact expressive accent system for primary actions and semantic data states; keep controls familiar. |
| [SAP: Evolving design systems for AI-driven UX](https://www.sap.com/uk/design/stories-resources/evolving-design-systems-for-ai-driven-ux) | AI interfaces increasingly compose the relevant parts of a workflow around user intent and context. | Define approved answer-packet compositions and state rules so the agent can adapt content without inventing visual language. |
| [Vercel AI SDK 7](https://vercel.com/blog/ai-sdk-7) | Current AI application patterns include typed tool context, approvals, rich tool UI, and agent observability. | Show connection context and read-only policy as first-class UI, and expose progress without revealing secrets or internal chain-of-thought. |
| [Vercel AI Elements](https://vercel.com/changelog/introducing-ai-elements) | AI interfaces are moving beyond a single chat bubble into composable messages, response actions, reasoning/tool states, and custom components. | Build the answer as a bounded packet with evidence, SQL disclosure, table, caveat, and refinement actions. |
| [Linear account preferences](https://linear.app/docs/account-preferences) | Settings are grouped into understandable preference areas and keep personalization close to the account context. | Use a narrow, predictable settings navigation for the implemented Profile, Security, Connections, and Inference surfaces. |
| [Linear security and access](https://linear.app/docs/security-and-access) | Sessions, passkeys, applications, and access controls are visible as managed resources. | Give account security its own surface and show session/access state without mixing it into database connection setup. |
| [Clerk sign-up and sign-in strategies](https://clerk.com/docs/guides/configure/auth-strategies/sign-up-sign-in-options) | Auth flows are explicit about sign-in methods, verification, recovery, passkeys, and profile management. | Keep sign-up/login focused, make verification and recovery first-class states, and leave provider configuration out of the first screen. |
| [Stripe Dashboard basics](https://docs.stripe.com/dashboard/basics) | Personal, account, product, and team/security settings are separated into a comprehensible hierarchy. | Separate personal/security settings from product connections and inference settings. |
| [Supabase: connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres) | Connection setup explains where connection info lives, which mode to choose, SSL, and what common failures mean. | Use guided connection forms, a test action, SSL guidance, and actionable failure copy instead of a bare credential dump. |
| [Deepnote generative analysis](https://deepnote.com/docs/ai-analysis) | AI can create and execute blocks, but the product makes mode, context, stop, and query-safety boundaries visible. | Show streaming progress, allow cancel, disclose query and source context, and keep DB Chat read-only. |
| [Hex Explore](https://hex.tech/product/explore/) | Natural-language prompts lead to visual and tabular artifacts that can be refined. | Make the answer artifact the center of the conversation and keep follow-up refinement one action away. |
| [Metabase questions](https://www.metabase.com/docs/latest/questions/introduction) | Questions can start from natural language or structured exploration and can be saved, inspected, and placed into a broader collection. | Keep the first version lightweight: answer, inspect, refine, export. Defer collections and sharing until the core loop is proven. |
| [Observable notebooks](https://observablehq.com/documentation/notebooks/) | Text, code, SQL, and visual output are interleaved as inspectable work. | Use progressive disclosure for SQL and result metadata rather than forcing a notebook canvas into the MVP. |
| [Mode notebooks](https://mode.com/notebooks/) | Query output is central, with paths to reports, exports, and sharing. | Give every answer packet stable export and copy actions, even before full report persistence exists. |
| [Rill Explore](https://docs.rilldata.com/guide/dashboards/explore) | Measures, dimensions, drilldowns, search, and export form a compact exploration vocabulary. | Use the same vocabulary in answer actions and table controls without turning chat into a dashboard builder. |

### Research conclusion

The strongest common pattern is not a fashionable surface treatment. It is
structured composition:

1. make the next action obvious;
2. keep context adjacent to the action;
3. turn AI output into a typed, inspectable artifact;
4. preserve user control when the system is connecting, querying, or failing;
5. reveal advanced detail progressively.

That is the design system DB Chat should own.

## 3. Brand and visual vocabulary

### Product character

DB Chat Web should feel:

- clear, not sterile;
- capable, not intimidating;
- analytical, not corporate;
- warm, not playful;
- precise, not overly technical;
- quiet while idle, informative while working.

### Visual metaphor

Use the metaphor of a well-organized workshop:

- the canvas is the workbench;
- the connection selector is the active instrument;
- the prompt is the question card;
- the answer packet is the finished artifact;
- SQL and metadata are the labeled tools kept available for inspection;
- the account and settings surfaces are the supply cabinet, not the room itself.

Do not illustrate the metaphor literally. It is a decision aid for hierarchy
and tone, not a request for wood textures, workshop icons, or skeuomorphism.

### Shape language

- Controls: compact rounded rectangles with clear hit areas.
- Panels: quiet rounded rectangles with one clear job.
- Result artifacts: larger radius and modest internal padding to distinguish
  them from ordinary conversation.
- Status: small dot plus text or a short inline label.
- Avatar: circle only for identity.
- Pills: reserved for model/provider labels or compact filters; never use
  pills for every navigation item.

### Depth language

Prefer one of three layers:

1. canvas;
2. surface;
3. raised artifact.

Use borders for separation and soft shadows for lift. Do not stack multiple
shadows, use inner glows, or create floating glass sheets over content.

## 4. Foundation tokens

The values below are the starting contract. Implement them as web-owned
variables in src/web/styles.css or the web token module. Do not reuse the
desktop token names or values.

### Color roles

| Token | Value | Use |
| --- | --- | --- |
| canvas | #FBFAF7 | App background and public-page background |
| surface | #FFFEFA | Forms, settings panels, answer packets |
| surface-soft | #F4F0EA | Secondary fields, muted artifact regions |
| surface-accent | #F7E9E2 | Selected/action context background |
| ink | #17232D | Headings, primary body text, SQL |
| ink-secondary | #536170 | Supporting copy, metadata, descriptions |
| ink-muted | #536170 | Placeholder and nonessential labels when readable text is required |
| border | #E3DED5 | Default separation and field boundaries |
| border-strong | #C9C5BD | Focus-adjacent or selected boundaries |
| primary | #C8491D | Main action, active navigation, focus accent |
| primary-hover | #A83A16 | Hover and pressed primary |
| primary-soft | #F7E9E2 | Primary tint, active context background |
| teal | #1E7B72 | Healthy/ready state and positive data signal |
| teal-soft | #EDF5F1 | Healthy state background |
| amber | #B77916 | Attention, pending, caution |
| amber-soft | #F8EFD9 | Attention state background |
| coral | #AA3C2B | Error, destructive, unavailable |
| coral-soft | #F7E5E0 | Error state background |
| olive | #68714D | Informational state and secondary data signal |
| olive-soft | #EDF0E6 | Informational state background |
| ochre | #B77928 | Secondary data signal and quiet proof accent |
| on-primary | #FFFEFA | Text and icons on primary controls |

Charts use a restrained bookish sequence rather than a default dashboard blue:
rust, olive, ochre, plum, umber, and slate. The first series is rust so a
single-series chart remains aligned with the primary action language.

Color is never the only state channel. Pair it with text, icon shape, position,
or an explicit status sentence. Validate all combinations in the browser
against WCAG 2.2 AA before release; the values above are design inputs, not a
completed contrast certification. Normal-size muted/supporting text must use a
foreground/background pair with at least 4.5:1 contrast; do not use the muted
role to justify faint, low-contrast copy.

### Typography

Use Georgia for editorial headings and a Helvetica-like stack for interface
copy and controls:

~~~css
font-family: Helvetica, Arial, ui-sans-serif, system-ui, sans-serif;
~~~

Headings use `Georgia, "Times New Roman", serif`. Do not add a blocking font
dependency.

| Role | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| Display | 44 / 52 | 650 | Public-page promise and first-run welcome, desktop only |
| Page title | 28 / 36 | 650 | Settings and workspace headings |
| Section title | 20 / 28 | 650 | Panel headings and answer titles |
| Body | 15–16 / 24 | 400 | Explanations, prompts, normal copy |
| Body strong | 15 / 24 | 600 | Important inline labels |
| Dense | 13 / 20 | 400 | Metadata, connection details, table controls |
| Label | 12 / 16 | 600 | Form labels, overlines, status labels |
| Caption | 12 / 16 | 500 | Timestamps and supporting metadata only |
| Code | 12 / 18 | 450 | SQL, identifiers, hostnames, error codes |

Rules:

- Use sentence case in headings and actions.
- Use tabular numerals for counts, durations, dates, and table values.
- Never use all caps for normal product labels.
- Keep body measure near 65 characters for explanatory copy.
- Use monospace only for code, query text, IDs, and technical values.

### Spacing

Use a 4-point base with named steps:

~~~text
space-1   4px
space-2   8px
space-3  12px
space-4  16px
space-5  20px
space-6  24px
space-7  32px
space-8  40px
space-9  48px
space-10 64px
space-11 80px
~~~

These are named 4-point scale tokens used by the current web implementation;
the 20px, 40px, and 80px steps are intentional scale members, not ad hoc
exceptions. Prefer these tokens over new one-off values.

### Radius

~~~text
radius-control   5px
radius-panel     7px
radius-composer  9px
radius-round   999px
~~~

Use radius-round only for avatars, small status dots, and compact filter
tokens. The app should not look like it is made from pills.

### Borders and elevation

~~~text
border-default  1px solid #E3DED5
border-strong   1px solid #C9C5BD
shadow-popover  0 12px 30px rgba(23, 35, 45, 0.12)
shadow-focus    0 0 0 3px rgba(169, 71, 43, 0.2)
~~~

Default surfaces are flat. Apply shadow-popover only to a raised answer packet,
modal, or floating account menu. Never use shadow as a substitute for visible
focus.

### Motion

~~~text
motion-fast    120ms
motion-normal  180ms
motion-slow   240ms
ease-standard  cubic-bezier(0.2, 0.8, 0.2, 1)
~~~

Motion should explain:

- a panel entering or leaving;
- a connection changing state;
- an answer packet progressing from query to result;
- a toast appearing or disappearing.

Never animate a full-page background, continuously pulse a healthy state, or
make a loading indicator the only evidence that a request is progressing.
Honor prefers-reduced-motion by removing transforms and reducing transitions
to opacity or an immediate state change.

### Iconography

Use one coherent outline icon set, preferably the existing project icon
dependency if present. If a new set is introduced, use 16px icons for dense
controls, 18px for standard controls, and 20px for navigation or empty states.
Use a consistent stroke weight and optical alignment.

Icons must support a text label, tooltip, or accessible name. Do not use
emoji as status icons or substitute database logos for provider-independent
meaning.

## 5. Responsive composition

### Breakpoints

Use behavior-based breakpoints:

~~~text
compact  0–719px
standard 720–1099px
wide    1100px and above
~~~

At 1280px and above, cap the main application content at 1180px. At smaller
widths, use 16px page gutters. At wide widths, use 24px gutters and allow the
chat answer column to remain narrower than the viewport.

### Compact behavior

- one-column layout;
- top bar remains visible and horizontally scroll-safe;
- settings navigation becomes a select or disclosure menu;
- connection and inference forms stack;
- answer packet actions wrap below the title;
- tables become horizontally scrollable with an explicit overflow label;
- composer remains reachable without requiring a second panel;
- dialogs become full-width sheets with a clear close action.

### Standard behavior

- two-column settings layout may appear if the local navigation remains at
  least 224px wide;
- connection form may use a form column plus a guidance column;
- answer artifacts may use a result area plus a narrow metadata rail;
- keep the active connection and account menu in the top bar.

### Wide behavior

- use generous whitespace around the central chat column;
- keep the main answer/form column bounded at 760px;
- when an inspector/result rail is present, default it to about 400px and
  allow resizing down to 360px;
- optional conversation history may be a collapsible drawer, not a permanent
  desktop inspector;
- never allow side rails to compress the answer below 640px without reason.

## 6. Page recipes

### 6.1 Public entry

Purpose: establish value and move a new user to account creation.

Structure:

~~~text
brand mark
short promise
one proof point about inspectable read-only answers
Create account
Log in
privacy/data-handling link
~~~

The public page can use one quiet illustration or abstract data motif, but
the product must still work with images disabled. Avoid a marketing wall
between the user and the form.

### 6.2 Authentication

At wide widths, use a centered form stage with an optional narrow supporting
column. The form itself should remain 420–480px wide.

The form order is:

1. heading and one-sentence expectation;
2. email;
3. password;
4. confirm password only during sign-up;
5. terms acknowledgement;
6. primary action;
7. alternate route and recovery link.

Authentication errors should appear both inline and in a summary region. Do not
confirm whether a particular email exists in a recovery or login failure
message.

Required states:

- initial;
- field focused;
- invalid field;
- submit pending;
- generic submit failure;
- verification pending;
- recovery requested;
- rate limited;
- successful redirect.

### 6.3 First-run onboarding

Use a short guided sequence, not a setup dashboard:

~~~text
Account ready → Add a connection → Test it → Ask a question
~~~

The user may defer a connection only when the next screen clearly explains why
chat is unavailable until one is configured. Keep the progress indicator
descriptive and compact; it is not a gamified progress bar.

### 6.4 Settings shell

Settings are a local information architecture, not the main application
navigation.

~~~text
Settings
├── Profile
├── Security
├── Connections
└── Inference
~~~

Desktop settings use a 224px local navigation column and a content column
limited to 760px. Each page begins with a title, a sentence explaining what
can be changed, and one or more task-oriented sections.

Use explicit save actions for profile, password, and connection forms. Show a
small confirmation message after a successful save.

### 6.5 Connections

The connections page should answer, at a glance:

- what is connected;
- which connection is active;
- what type it is;
- whether it was tested successfully;
- what the next action is.

List row anatomy:

~~~text
provider/type icon
connection name
host or safe identifier
health dot + status sentence
active indicator
overflow actions
~~~

Do not display passwords, full connection strings, or private network details.
Use safe host text only when it helps the user recognize the source.

Connection setup recipe:

1. name;
2. database type;
3. host, port, database, username;
4. password or secret input;
5. SSL mode and optional advanced fields;
6. Test connection;
7. Save connection;
8. Set active, if more than one exists.

Keep the basic form short. Place SSL certificates, pooler mode, and advanced
network settings behind an Advanced disclosure with explanatory copy.

Test results must distinguish:

- testing;
- healthy;
- authentication failed;
- network unreachable;
- SSL/configuration issue;
- provider unsupported;
- service unavailable.

Each failure state includes a next action. Never say only Connection failed.

### 6.6 Inference settings

Default product behavior:

- show that DB Chat inference is managed by the service;
- do not show an OpenRouter key field or key-management navigation item;
- do not expose the internal key or provider request details;
- explain that the service uses its managed inference path unless an enabled
  account setting says otherwise.

Future feature-flagged behavior:

- reveal an Advanced provider key section under Inference;
- label the input as an optional user-supplied OpenRouter key;
- show a security explanation before the field;
- use a masked input with reveal-on-hold or reveal-on-click;
- after save, show only Configured, last updated, Replace, and Remove;
- never prefill or return the raw value;
- preserve the internal-key fallback when the user key is absent or invalid.

The web visual language must not make provider configuration feel required for
the first useful question.

### 6.7 Chat workspace

The chat screen is a focused work surface:

~~~text
top bar
connection context strip
conversation column
answer packets
composer
~~~

Top bar:

- DB Chat mark;
- active connection selector;
- read-only label;
- account menu.

Connection context strip:

- connection name;
- type;
- health state;
- change connection action;
- safe note that queries are read-only.

Conversation column:

- user prompts are visually distinct but quiet;
- assistant response is not a speech bubble;
- tool/progress events are compact and collapsible;
- answer packets get the strongest visual frame;
- follow-up suggestions are simple text actions or small outlined controls,
  with 12–16px vertical padding and 4–8px internal separation; avoid turning
  each suggestion into a pill or card.

Composer:

- one primary multiline input;
- clear placeholder with an example question;
- send action with keyboard shortcut hint;
- disabled state explains what is missing;
- connection context is visible without repeating the whole form.

Empty state copy should say what the user can ask and name the active
connection. It should never imply that the model knows the user's data before
the user has connected a source.

### 6.8 Answer packet

The answer packet is the signature component of DB Chat Web.

An answer packet contains:

~~~text
answer title or direct conclusion
short explanation
primary result artifact
source and query context
caveat or freshness note
refine / copy / export actions
~~~

Hierarchy:

1. conclusion first;
2. result second;
3. evidence and query disclosure third;
4. actions last.

For a table:

- use a strong header row;
- right-align numeric values;
- use tabular numerals;
- show a row count;
- preserve horizontal scrolling on compact screens;
- make empty results explicit;
- show a compact footer with source and duration when available.

For a chart:

- include a plain-language title;
- label axes and units;
- provide a text summary for screen readers;
- do not use color as the only series identifier;
- default to the quiet editorial treatment: no grid or legend unless it adds
  information, and use direct labels when a small number of marks can carry
  their own values;
- use a slope chart for two-endpoint comparisons, with explicit start and end
  labels and collision-aware endpoint labels;
- keep annotations sparse and purposeful: use them for a meaningful point,
  reference line, range, or slope callout rather than decorating every mark;
- allow table fallback when chart rendering fails.

Query disclosure:

- collapsed by default after the first successful answer;
- expanded on explicit action;
- syntax-highlighted but still readable without color;
- includes a copy action;
- never exposes credentials or internal headers.

### 6.9 Failure and recovery

Use a stable failure anatomy:

~~~text
what happened
what is still safe
what the user can do next
retry or settings action
~~~

Examples:

- “The connection timed out. Your saved credentials were not changed. Check
  the host and firewall, then test again.”
- “The answer could not be generated. No write query was run. Try again or
  choose another connection.”
- “Inference is temporarily unavailable. Your question is still in this
  conversation; retry when the service is ready.”

Do not erase the user prompt when a request fails. Preserve it for retry or
editing.

## 7. Component contracts

Every component must define anatomy, variants, states, and responsive
behavior before implementation.

### Buttons

Variants:

- Primary: one per region, filled primary color.
- Secondary: outlined or neutral surface, for adjacent alternatives.
- Quiet: text action for low-emphasis actions.
- Destructive: coral treatment, only for irreversible or risky actions.

States:

- default;
- hover;
- focus-visible;
- pressed;
- disabled;
- pending.

Rules:

- action labels use verbs;
- pending buttons retain the action label and add a progress indicator;
- disabled buttons explain the missing prerequisite nearby;
- icon-only buttons need an accessible name and a tooltip after a short delay.

### Fields

An input includes a visible label, optional helper text, input, and a reserved
error region so error messages do not cause unpredictable layout jumps.

Rules:

- labels are always visible;
- placeholders are examples, not labels;
- password fields have a reveal control;
- secret fields never render the secret after save;
- focus uses border-strong plus shadow-focus;
- validation runs on blur and submit, not on every keystroke unless it is
  necessary to prevent an obvious invalid value.

### Connection selector

The selector is a compact control in the top bar and a larger field in
onboarding. It shows name, type, and health. It must expose an explicit empty
state when no connection exists and offer Add connection without navigating
away from the current task when practical.

### Status indicator

Use:

~~~text
small dot + status label + optional explanatory sentence
~~~

Good: teal dot, Healthy, Tested 2 minutes ago.

Avoid: a large green pill that only says CONNECTED.

### Account menu

The account menu contains:

- name and email;
- Settings;
- help/privacy link if available;
- Log out.

Do not put connection credentials, model keys, or destructive account actions
in the first-level menu. Destructive account actions belong in Profile or
Security with confirmation.

### Alerts and toasts

Inline alerts are for issues that affect the current task. Toasts are for
completed background actions such as Saved or Connection removed.

Every alert has:

- a short title or lead sentence;
- body copy;
- optional action;
- semantic role for assistive technology.

Never use a toast as the only report of a failed form submission.

### Dialogs and sheets

Use dialogs for:

- confirm deletion;
- change active connection when it would discard work;
- reveal advanced settings.

Use sheets on compact screens. Trap focus, restore focus on close, and keep
the primary action visible without scrolling when practical.

### Streaming progress

Show a compact sequence such as:

~~~text
Reading connection schema
Building a read-only query
Running query
Preparing answer
~~~

The sequence communicates operation, not hidden model reasoning. Never expose
chain-of-thought. Include Stop when cancellation is supported.

## 8. Content and voice

### Voice

DB Chat speaks like a precise, patient technical partner:

- direct;
- specific;
- calm under failure;
- transparent about uncertainty;
- never theatrical.

### Preferred vocabulary

Use:

- connection;
- active connection;
- read-only;
- test connection;
- answer;
- result;
- query;
- source;
- retry;
- managed inference;
- optional provider key.

Avoid:

- magic;
- unleash;
- unleash your data;
- autonomous genius;
- neural engine;
- connected forever;
- guaranteed insight.

### Copy patterns

| Situation | Preferred copy |
| --- | --- |
| Empty chat | Ask a question about the data in your active connection. |
| No connection | Add and test a connection before asking DB Chat to query data. |
| Healthy connection | Ready. Read-only queries can run against this connection. |
| Missing inference config | Inference is managed by DB Chat. You can start chatting now. |
| Pending test | Testing the connection… |
| Success | Connection tested successfully. |
| Unsupported provider | This database type is not supported yet. Choose another type or return to connections. |
| Error | We could not reach this database. Check the host, port, and network access, then try again. |
| Query disclosure | Show query |
| Refine | Ask a follow-up |
| Export | Export result |

## 9. Accessibility and trust

Target WCAG 2.2 AA for the shipped web product.

Required:

- keyboard access to every action;
- visible focus ring with at least 3px total visual area around controls;
- logical heading hierarchy;
- labels associated with inputs;
- error summary announced and linked to invalid fields;
- status changes announced through a live region without interrupting typing;
- no color-only state communication;
- reduced-motion support;
- 44px minimum touch target on compact screens;
- sufficient contrast for body text, controls, and focus;
- text alternative or data table for every chart;
- query/code blocks that can be read and copied without horizontal layout
  destroying the page;
- no secret values in URLs, page titles, browser logs, or clipboard actions
  unless explicitly requested by the user.

Trust requirements:

- show which connection will receive the query before execution;
- state that the product is read-only at the point of use;
- preserve the user prompt when a request fails;
- distinguish service failure from database failure;
- avoid returning raw provider or credential errors to the browser;
- never reveal the internal inference key;
- show a masked configured state for optional user keys;
- use confirmation for deletion and account-destructive actions.

## 10. Implementation guardrails

### Source locations

- Visual tokens and global web styles: src/web/styles.css.
- Web shell and route composition: src/web/App.tsx.
- Shared web components: src/web/components/.
- Authentication screens: src/web/screens/auth/.
- Onboarding and setup: src/web/screens/onboarding/.
- Settings and connection screens: src/web/screens/settings/.
- Chat and answer artifacts: src/web/screens/chat/ and
  src/web/components/answer/.
- Web server/API behavior: src/server/.
- Product and architecture decisions: docs/SDD-WEB-CHAT.md.

If the current prototype does not yet have these directories, create the
smallest structure that makes the ownership clear. Do not move desktop
renderer code into src/web/ merely to reuse styling.

### CSS rules

- use the tokens in this guide; do not introduce arbitrary hex values in
  component styles;
- prefer class-based states over inline style mutations;
- keep layout rules in the web stylesheet or a web-owned component style
  boundary;
- use container queries where a component's layout depends on its own width;
- avoid global important overrides except for an explicit accessibility need;
- keep mobile behavior in the same component contract as desktop behavior;
- do not add a global reset that changes desktop renderer assumptions.

### AI output rules

AI responses may choose among approved artifact types:

- prose answer;
- result table;
- chart with table fallback;
- query disclosure;
- warning or caveat;
- follow-up suggestion.
- validated KPI and report sections;
- a focused clarification with selectable choices.

The agent may choose the composition based on the result, but it may not emit
arbitrary HTML, CSS, unapproved actions, or secret-bearing content.

Report controls use the existing quiet text-action pattern. KPI values use
tabular numerals and retain units; result controls wrap within their inspector
surface. Chart controls change the saved display without adding another chat
message. Pending structured output shows a short preparing state, never raw JSON.
Failed or stopped attempts retain a plainly labeled state with Retry/Edit and
their available evidence. Feedback/correction controls must have accessible names
and a saved/error state. Avoid turning every answer into a toolbar-heavy card.

## 11. Quality bar

Before a web visual change is considered complete:

- verify the target screen at compact, standard, and wide widths;
- verify empty, loading, success, error, and disabled states;
- verify keyboard traversal and focus visibility;
- verify a screen reader name for icon-only controls;
- verify the active connection is visible while chatting;
- verify no raw secrets appear in the DOM, URL, network payload rendered to the
  client, or screenshots;
- run the repository-required tests, typecheck, and build;
- capture screenshots or DOM/computed-style evidence for visual claims;
- compare against this guide and the target screen recipe, not the desktop
  renderer.

## 12. Deferred choices

These are intentionally not settled by this guide:

- final logo and wordmark geometry;
- custom display typeface, if a later performance budget permits it;
- dark mode;
- collections beyond saved/pinned conversations and answers;
- collaborative sharing;
- additional database providers;
- visible user-supplied OpenRouter key controls;
- linked multi-chart brushing and advanced statistical visualizations.

Any future change to these choices should update this guide and the SDD
together, with a short decision note explaining why the product boundary
changed.
