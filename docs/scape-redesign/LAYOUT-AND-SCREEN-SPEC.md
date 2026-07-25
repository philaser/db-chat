# Layout And Screen Specification

## Source Synthesis

The canonical screen is the generated **temporary data inspector** concept. It contributes:

- a translucent leading sidebar;
- a large, quiet answer canvas;
- a contextual trailing inspector;
- `Results`, `Query`, and `Schema` tabs;
- a flat returned-data table;
- a low-profile composer.

The generated **selected result detail** concept contributes only:

- a fixed inspector footer;
- a left-aligned `Copy` action;
- a right-aligned `Export CSV` action.

Do not import the third concept's selected transcript row, `Data / SQL` tab model, or header layout. The canonical tab model remains `Results / Query / Schema`.

## Reference Viewport

The primary implementation and acceptance viewport is the existing Electron window:

- window width: `1440px`;
- window height: `920px`;
- minimum width: `980px`;
- minimum height: `680px`;
- device pixel ratio: test at `1` and `2`;
- canonical platform: macOS;
- canonical appearance: light mode.

The original generated references were `1487×1058`; their proportions are normalized below to stable CSS dimensions suitable for the current app.

## Window And Native Chrome

### macOS

Use the native window frame with an inset hidden titlebar:

- `titleBarStyle: "hiddenInset"`;
- keep native traffic-light controls;
- target traffic-light origin approximately `18px` from the leading edge and `18px` from the top if manual positioning is necessary;
- renderer toolbar height: `52px`;
- draggable toolbar regions use `-webkit-app-region: drag`;
- interactive controls within the toolbar use `-webkit-app-region: no-drag`.

The application content starts behind the integrated titlebar. Do not draw fake traffic lights.

For a macOS material effect, Electron may use window vibrancy with opaque content and inspector surfaces layered over it. The leading sidebar is the only region intended to reveal the material. If vibrancy produces inconsistent cross-version results, retain native chrome and use the documented translucent CSS fallback.

### Windows And Linux

- Keep native platform window controls.
- Do not display macOS traffic lights.
- Preserve the `52px` toolbar content rhythm below or within the platform titlebar overlay.
- Keep identical application layout, typography, pane widths, and semantic tokens.

## Wide Layout

At viewport widths `>= 1180px`:

```text
┌─────────────── 240 ───────────────┬──────── flexible ≥ 560 ────────┬──── 384 ────┐
│ sidebar                           │ conversation                    │ inspector    │
│                                  │                                 │              │
└──────────────────────────────────┴─────────────────────────────────┴──────────────┘
```

CSS model:

```css
grid-template-columns:
  var(--sidebar-width, 240px)
  minmax(560px, 1fr)
  var(--inspector-width, 0px);
```

Inspector states:

- closed: `--inspector-width: 0px`;
- open default: `384px`;
- resize minimum: `320px`;
- resize maximum: `480px`;
- double-clicking the resize separator returns to `384px`.

The inspector is not permanently open. Open it when:

- a query returns data;
- the user activates `View N rows`;
- the user explicitly activates Query or Schema;
- a saved chat with result/query/schema context is reopened.

Close it when:

- the user presses its back/close control;
- the user presses `Escape` while focus is inside the inspector and no modal/popover is open;
- a new empty chat starts, unless the user intentionally pinned it open.

Remember width across open/close within the session. Do not remember an open inspector across a fresh empty-chat launch.

## Constrained Layout

### Medium: `980px` to `1179px`

- sidebar width: `220px`;
- conversation remains at least `560px`;
- inspector becomes a trailing overlay with width `min(384px, calc(100vw - 24px))`;
- overlay begins below the `52px` toolbar;
- overlay uses `--shadow-overlay` and a `1px` leading separator;
- no dark scrim;
- clicking outside may close it only if no editor has unsaved query changes;
- the composer remains attached to the conversation and may be partially obscured only while the inspector is open.

### Narrow fallback: below `980px`

The packaged app currently prevents this through `minWidth`, but implement a defensive layout:

- sidebar becomes a `52px` collapsed rail or an overlay;
- inspector is a full-height trailing overlay beneath the toolbar;
- transcript horizontal gutter becomes `20px`;
- actor column may reduce from `88px` to `68px`;
- table retains horizontal scrolling;
- no component wraps into a second toolbar row.

This is a desktop application, not a mobile layout. Do not invent mobile navigation.

## Shell Regions

## 1. Integrated Toolbar

Dimensions:

- height: `52px`;
- bottom separator: `1px`;
- surface: `--color-toolbar`;
- padding: leading space must clear native traffic lights on macOS;
- interior control gap: `8px`.

Order, leading to trailing:

1. native traffic-light reserve;
2. sidebar toggle, `28×28px`;
3. back action, `28×28px`;
4. forward action, `28×28px`;
5. search field, flexible with `max-width: 680px`;
6. flexible spacer;
7. database connection selector, `32px` tall;
8. account/settings control, `28×28px`.

Search:

- height `32px`;
- radius `8px`;
- `1px` border;
- search icon `14px`;
- text `13/20`;
- internal horizontal padding `10px`;
- placeholder `Search`;
- clear action appears only when nonempty.

Connection selector:

- text format: database label or concise fallback;
- in the canonical mock, `DB Chat` occupies this location, but production must show actual connection context;
- maximum width `220px`;
- truncate with ellipsis;
- use a monochrome database icon and trailing chevron.

## 2. Leading Sidebar

Dimensions:

- wide width: `240px`;
- medium width: `220px`;
- full height beneath/behind integrated toolbar;
- horizontal padding: `16px`;
- top content padding below toolbar: `24px`;
- bottom padding: `24px`;
- vertical scrolling permitted when necessary.

Material:

- native/translucent material on macOS;
- CSS fallback `--color-sidebar-fallback`;
- content and inspector remain opaque so only the sidebar reads as material.

Navigation order:

1. `New chat`;
2. `Search`;
3. `Connections` section;
4. connection rows;
5. `All connections`;
6. `Chats` section;
7. recent chat rows;
8. `Show more`;
9. optional bottom settings/account row when required.

Section labels:

- `11px / 16px / 500`;
- color `--color-text-tertiary`;
- margin top `28px`;
- margin bottom `8px`;
- sentence case.

Rows:

- height `38px`;
- radius `6px`;
- horizontal padding `10px`;
- icon/dot column `16px`;
- gap `8px`;
- label `13px / 20px`;
- selected label weight `500`;
- selected fill `--color-selected`;
- hover fill `--color-control-hover`;
- pressed fill `--color-control-pressed`.

Connection source dots:

- visible circle `8×8px`;
- no shadow or ring in default state;
- pair color with a readable label;
- offline source uses `--source-neutral`;
- never color the entire row or vendor icon.

The selected chat is `Revenue by customer segment`. The selection is quiet and must not resemble a button.

## 3. Conversation Canvas

Surface:

- opaque `--color-content`;
- no internal panel container;
- no shadow;
- no card framing.

Content padding:

- wide horizontal gutter: `36px`;
- medium horizontal gutter: `28px`;
- narrow fallback: `20px`;
- top padding below toolbar: `36px`;
- bottom space above composer: `24px`.

The transcript content uses:

- width `100%`;
- maximum readable width `840px`;
- alignment to the leading content gutter, not visually centered in the whole window.

### Title block

- title: `20px / 26px / 650`;
- single line with ellipsis;
- label below: `Today`, `12px / 18px`, secondary color;
- title-to-label gap: `20px`;
- label-to-first-row gap: `12px`;
- divider under label block: `1px`.

### Transcript rows

Rows are editorial and full-width. Do not use bubbles.

Grid:

```css
grid-template-columns: 88px minmax(0, 1fr) 72px;
column-gap: 20px;
```

Row:

- minimum height `72px`;
- vertical padding `18px 0`;
- bottom separator `1px`;
- actor: `13/20`, primary or secondary text;
- content: `13/20`, primary text, max `68ch`;
- time: `11/16`, tertiary text, right aligned, tabular numerals.

Actors:

- user label: `You`;
- assistant label: `DB Chat`;
- no avatars in transcript rows;
- no assistant sparkle, logo, or colored badge.

Result access:

- after an answer with rows, show `View 5 rows` as a small inline text action;
- use link blue, `13/20/500`;
- place it under the answer copy, not as a new card;
- activation opens Results in the inspector;
- announce inspector opening to assistive technology.

### Activity and generation

Replace the current bordered activity panel with quiet inline status:

- one `12/18` secondary line under the assistant actor/content;
- optional `14px` spinner;
- stages may update in place;
- detailed activity may expand as a flat disclosure list with hairline rows;
- never show a rounded activity card.

## 4. Composer

Placement:

- sticky to the bottom of the conversation region;
- margin: `0 18px 32px`;
- maximum width tracks the conversation region;
- collapsed height `62px`;
- expands vertically to a maximum `160px` as text grows;
- never covers transcript content; reserve layout space.

Appearance:

- surface `--color-content`;
- `1px solid --color-separator-strong`;
- radius `10px`;
- no default shadow;
- focus ring `0 0 0 3px --color-focus-ring`;
- placeholder `Ask a follow-up`;
- textarea uses `13/20`;
- internal padding `12px 48px 12px 14px`.

Send:

- `28×28px`;
- circular;
- bottom/right inset `10px`;
- blue fill when enabled;
- disabled fill is transparent or neutral with disabled text;
- `16px` arrow/send icon;
- pressing `Enter` sends; `Shift+Enter` inserts a newline;
- while sending, preserve size and replace the icon with a spinner.

Do not show character count, connection metadata, or SAFE-mode chips inside the canonical composer. Those states belong in toolbar/context menus or in error/help text when relevant.

## 5. Contextual Data Inspector

Wide state:

- trailing column, default width `384px`;
- surface `--color-inspector`;
- leading separator `1px`;
- no shadow;
- starts below the shared toolbar;
- layout rows: header, tab strip, metadata/actions, scrollable body, fixed footer.

```css
grid-template-rows: auto auto auto minmax(0, 1fr) 64px;
```

### Inspector header

- horizontal padding `28px`;
- top padding `28px`;
- title row height `28px`;
- leading close/back icon `28×28px`;
- title `Data`, `17/22/600`;
- source row margin top `12px`;
- source icon `14px`;
- source text example: `Postgres · Analytics DB`;
- source text `12/18`, secondary color.

### Tabs

- labels: `Results`, `Query`, `Schema`;
- top margin `22px`;
- height `42px`;
- flat row, not a filled segmented pill;
- label `13/20/500`;
- horizontal gap `32px`;
- selected text uses accent;
- selected underline `2px` accent;
- full-width bottom hairline.

Keyboard:

- Left/Right moves selection;
- Home/End selects first/last;
- focus remains visible;
- tab panels preserve appropriate internal state.

### Results metadata and header actions

- row height `54px`;
- padding `0 28px`;
- metadata left: `5 rows · 2 columns`;
- optional latency follows: `· 423 ms`;
- metadata `11/16`, tertiary color;
- optional top export shortcut may remain only if footer action is still present, but the canonical implementation should avoid duplicating `Export CSV`;
- do not render metric cards.

### Result table

- full inspector width;
- horizontal scrolling when needed;
- sticky header below tabs/metadata;
- header height `38px`;
- data row height `48px`;
- horizontal cell padding `12px`;
- first/last cells align to inspector `28px` outer gutter;
- header `11/16/600`;
- cells `12/18/400`;
- numeric columns right aligned with tabular numerals;
- text columns left aligned;
- null uses em dash `—` and tertiary color;
- booleans use `True`/`False`, not colored pills;
- row hover uses `--color-control-hover`;
- selected cell/row uses `--color-selected`;
- separators are horizontal only;
- no outer border;
- no zebra striping by default;
- column widths may be resized if existing behavior supports it, but resizing is not required for the first pass.

### Query tab

- use a flat code editor region;
- background stays near the inspector surface, not black;
- `12px / 18px` mono;
- padding `20px 28px`;
- line numbers are optional and must be quiet;
- validation appears as a flat status row, not a colored card;
- `Copy Query` and run action live in the fixed footer when Query is active;
- unsafe state must be explicit and must preserve existing SAFE behavior.

### Schema tab

- search field at top, `32px` high;
- flat disclosure rows for tables/collections/indices;
- each object row uses name, type, and field count;
- expanded fields appear as nested hairline rows;
- remove card framing from schema objects;
- preserve Pro/Raw behavior through a quiet pop-up or compact two-option control;
- keep search, expand/collapse, keyboard access, and `Return to top`.

## 6. Inspector Footer

This is the only visual element imported from the third concept.

Dimensions:

- height `64px`;
- top separator `1px`;
- padding `0 28px`;
- surface matches inspector;
- remains fixed while table/query/schema body scrolls.

Results footer:

- left action: `Copy`;
- right action: `Export CSV`;
- both are flat text+icon toolbar actions;
- icon `14px`;
- label `12/18/500`;
- control target at least `28px` high;
- gap icon-to-text `8px`;
- default text secondary;
- hover text primary with hover fill;
- pressed fill `--color-control-pressed`;
- focus ring visible;
- disabled opacity through disabled token.

Copy behavior:

- copy the complete current result, not only visible rows;
- format as tab-separated values with a header row;
- preserve `result.columns` order;
- represent null/undefined as empty text;
- retain raw scalar values without locale formatting;
- after success, change label to `Copied` for `1500ms`;
- announce success using `aria-live="polite"`;
- on failure, preserve `Copy` and show an actionable error.

Export CSV behavior:

- export the complete current result;
- preserve `result.columns` order;
- UTF-8 encoding;
- use CRLF row endings;
- quote a field when it contains comma, quote, CR, or LF;
- escape embedded quotes by doubling them;
- null/undefined becomes an empty field;
- default filename: sanitized chat title plus ISO date, for example `revenue-by-customer-segment-2026-07-24.csv`;
- use Electron's native save dialog through existing IPC architecture;
- no new dependency is required;
- canceling is silent;
- success and failure are announced;
- disable while no result exists or while an export is active.

Query footer:

- left: `Copy Query`;
- right: existing safe run action;
- preserve validation and disabled logic.

Schema footer:

- omit footer actions unless a clear schema-specific action is implemented;
- do not display disabled Copy/Export controls that do not apply.

## Empty, Loading, Error, And Success States

### No connection

- sidebar remains usable;
- main canvas shows one concise sentence and a `Connect database…` text button;
- no illustration or large icon;
- inspector stays closed.

### Empty new chat

- title `New chat`;
- one quiet prompt explaining that DB Chat answers questions about the connected database;
- starter prompts may appear as a flat list of rows, not cards;
- inspector stays closed.

### Generating

- preserve row positions;
- use a small spinner and status line;
- composer send control becomes busy;
- inspector may open only when meaningful query/result content exists.

### Empty results

- Results tab shows `No rows returned`;
- retain column headers if known;
- Copy and Export CSV are disabled;
- do not treat zero rows as an error.

### Query blocked

- show danger color only in the small status icon/text;
- explain why it was blocked;
- keep the query readable;
- do not auto-run;
- preserve SAFE-mode behavior.

### Inspector failure

- keep inspector open;
- show concise error text in place of body;
- retain close control and relevant retry action;
- do not replace the whole application with an error page.

### Copy/export success

- use temporary inline label change or a small nonblocking announcement;
- no modal confirmation;
- never shift the footer layout.

## Window And Pane Resize

- Sidebar is fixed at wide widths; it does not need user resizing.
- Inspector retains the existing keyboard-resizable separator.
- Separator hit target: `12px`; visible line remains `1px`.
- Pointer drag disables pane transition.
- Keyboard Left/Right adjusts inspector by `24px`.
- Clamp to `320–480px`.
- At constrained widths, do not allow resize beyond available viewport.

## Pixel Acceptance Table

At `1440×920`, light mode:

| Measurement | Required value | Tolerance |
| --- | ---: | ---: |
| Toolbar height | `52px` | `±2px` |
| Sidebar width | `240px` | `±2px` |
| Open inspector width | `384px` | `±2px` |
| Main transcript gutter | `36px` | `±2px` |
| Sidebar row height | `38px` | `±1px` |
| Transcript row minimum | `72px` | `±2px` |
| Composer height, empty | `62px` | `±2px` |
| Composer bottom margin | `32px` | `±2px` |
| Inspector footer height | `64px` | `±1px` |
| Table header height | `38px` | `±1px` |
| Table row height | `48px` | `±1px` |
| Pane separators | `1px` | exact |

Computed-style tests or a development-only geometry assertion may be used to verify these values. A text-only agent must not claim visual parity from passing unit tests alone.

