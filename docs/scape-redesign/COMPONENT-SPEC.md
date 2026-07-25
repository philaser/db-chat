# Component Specification

## Component Model

The redesign may refactor the current monolithic renderer into shared components, but it must not change the framework or add a component library.

Recommended component boundaries:

```text
AppShell
├── WindowToolbar
│   ├── SidebarToggle
│   ├── HistoryNavigation
│   ├── GlobalSearch
│   └── ConnectionSelector
├── WorkspaceSidebar
│   ├── SidebarSection
│   ├── SidebarActionRow
│   ├── ConnectionRow
│   └── ChatRow
├── ConversationPane
│   ├── ConversationHeader
│   ├── Transcript
│   │   ├── TranscriptRow
│   │   ├── InlineActivity
│   │   └── ResultLink
│   └── Composer
└── DataInspector
    ├── InspectorHeader
    ├── InspectorTabs
    ├── ResultsView
    ├── QueryView
    ├── SchemaView
    └── InspectorFooter
```

These names are recommendations, not a requirement. The anatomy and behavior below are requirements.

## Global Interaction State Matrix

Every interactive component must define:

- default;
- hover, only on hover-capable pointers;
- focus-visible;
- pressed/active;
- selected/current when applicable;
- disabled;
- busy/loading when applicable;
- success when applicable;
- error when applicable.

Do not implement only the default screenshot state.

## Button

### Variants

- `text`: Copy, Export CSV, View rows.
- `ghost`: toolbar and sidebar actions.
- `accent`: send and explicit safe run.
- `danger`: destructive confirmation only.

### Anatomy

- optional leading icon;
- label;
- optional busy spinner;
- accessible status text.

### Behavior

- height `28px` except send;
- horizontal padding `8–10px`;
- radius `8px`;
- text does not wrap;
- busy state preserves dimensions;
- disabled state remains readable;
- text actions use secondary color until hover/focus;
- accent action uses blue only when enabled.

## Icon Button

- target `28×28px`;
- icon `14–16px`;
- default background transparent;
- hover fill neutral;
- focus ring external;
- no visible border unless the control is inside a field or pop-up;
- require `aria-label`, `title`, and tooltip.

## Sidebar Row

Anatomy:

1. icon or source dot;
2. primary label;
3. optional trailing count or state.

Rules:

- one line only;
- height `38px`;
- selected state uses quiet blue fill;
- trailing count uses `11/16` tertiary text;
- hidden row actions appear on hover and focus-within;
- entire row is the target;
- current page uses `aria-current="page"`;
- connection status uses accessible text in addition to dot color.

## Search Field

- semantic `type="search"`;
- label through `aria-label`;
- leading search icon;
- trailing clear action only when nonempty;
- Escape clears first, then yields to enclosing overlay behavior;
- results use keyboard navigation;
- empty search never shifts field height.

## Pop-Up Selector

Used for connection/model/context selection.

- trigger height `32px`;
- monochrome leading icon;
- truncated label;
- trailing chevron;
- menu width at least trigger width;
- selected item has checkmark;
- keyboard navigation and Escape dismissal;
- menu uses popover shadow, not a card-like trigger.

## Transcript Row

Anatomy:

1. actor;
2. content;
3. time;
4. optional inline status or result action under content.

Rules:

- no avatar;
- no bubble;
- no background in default state;
- no per-message radius;
- user and assistant use the same grid;
- Markdown headings inside an answer must be normalized to the body hierarchy;
- tables in Markdown should prefer opening Results rather than rendering a second large data table in the transcript;
- code blocks are permitted only when the answer genuinely requires code; keep them light and flat.

## Inline Activity

- one compact disclosure row;
- initial text such as `Running safe query…`;
- spinner `14px`;
- detail list uses flat rows;
- success collapses to a concise summary;
- error stays expanded until acknowledged;
- never wrap the activity in a card.

## Result Link

- visible only when a result exists;
- copy format `View {rowCount} row(s)`;
- link blue;
- icon optional;
- opens inspector to Results;
- current/open state may use `aria-expanded`;
- disabled only while result state is unavailable.

## Composer

Anatomy:

1. autosizing textarea;
2. send button;
3. optional validation/help line outside the main field.

States:

- empty;
- typing;
- focus;
- disabled because no connection;
- sending;
- error;
- multiline expanded.

Rules:

- one bordered surface;
- no nested footer surface;
- no character count in canonical view;
- connection and SAFE status do not become chips inside the composer;
- placeholder changes only when a more actionable message is necessary;
- preserve draft on non-destructive errors.

## Inspector

Anatomy:

1. header with close/back and title;
2. source context;
3. tablist;
4. metadata/action strip;
5. scrollable panel;
6. fixed footer.

Behavior:

- Results opens automatically after a successful returned result unless the user has intentionally pinned another inspector tab;
- Query opens when requested or when a validation problem needs attention;
- Schema opens explicitly;
- tab content preserves scroll where practical;
- closing returns focus to the control that opened it;
- in overlay mode, focus remains inside only when the inspector is modal; the preferred medium-width behavior is nonmodal with explicit close.

## Inspector Tabs

- real tab semantics;
- flat labels with underline;
- no segmented pill container;
- selected underline remains visible under focus;
- active state does not change height;
- disabled tabs remain in place when their data is unavailable and explain why via tooltip.

## Result Table

Capabilities:

- sticky header;
- horizontal and vertical scroll;
- readable empty state;
- row hover;
- keyboard focus for interactive cells only;
- copy complete result;
- export complete result.

Formatting:

- preserve raw values for copy/export;
- UI may apply locale formatting only when type confidence is high;
- numbers right aligned;
- strings left aligned;
- dates use a consistent local or ISO format and state which;
- values truncate with tooltip or accessible title;
- never use colored badges for ordinary scalar values.

Loading:

- keep header geometry;
- use quiet row skeletons or inline status;
- no full-panel spinner.

Error:

- preserve headers/metadata if known;
- show retry in context;
- keep footer actions disabled.

## Query Editor

- textarea/editor remains keyboard-first;
- mono font;
- visible focus;
- copy action;
- validation text;
- safe run action;
- no dark code-card treatment in light mode;
- do not weaken existing query safety rules.

## Schema Browser

- flat searchable disclosure list;
- table/collection/index name is primary;
- raw name and type are secondary;
- field count is tertiary;
- expanded field rows inherit indentation and hairlines;
- Pro/Raw remains available;
- prompt suggestions, if retained, are flat text actions rather than pills.

## Inspector Footer Actions

### Copy

Icon recommendation: Lucide `Copy`.

States:

- default `Copy`;
- hover;
- focus-visible;
- pressed;
- busy if clipboard operation is asynchronous;
- success `Copied`;
- failure retains `Copy` plus an error announcement;
- disabled when no result.

### Export CSV

Icon recommendation: Lucide `Share` or `Download`; choose one and use it consistently. The visual reference reads like Share, but `Download` communicates file export more directly. Prefer `Download` unless product copy testing chooses Share.

States:

- default `Export CSV`;
- hover;
- focus-visible;
- pressed;
- busy `Exporting…`;
- success returns to `Export CSV`;
- cancel returns silently;
- error returns and announces failure;
- disabled when no result.

Footer layout never shifts when labels change. Reserve sufficient width for `Exporting…`.

## Tooltip

- delay `500ms`;
- appears for icon-only actions;
- maximum one line where possible;
- `12/16`;
- dark neutral surface in light mode and light neutral surface in dark mode;
- pointer events none;
- dismiss on action, blur, Escape, or pointer leave.

## Popover And Menu

- radius `12px`;
- one `1px` border;
- popover shadow only;
- item height `32px`;
- no decorative header unless context is needed;
- separators only between meaningful groups;
- keyboard complete.

## Toast Or Announcement

Prefer inline status and `aria-live` for Copy/Export. Use a toast only for nonlocal application state.

If used:

- bottom trailing;
- compact;
- maximum one action;
- automatically dismiss success after `3s`;
- errors persist until dismissed or resolved;
- do not cover composer or inspector footer.

## Empty States

Empty states use:

- one short heading or sentence;
- one supporting sentence only when needed;
- one next action;
- no illustration;
- icon optional, maximum `20px`;
- normal app typography, not marketing typography.

## Forms And Settings

Existing connection/settings forms remain functionally available.

Restyle them with:

- flat grouped rows;
- labels above or leading depending on space;
- `32px` controls;
- help text `11/16`;
- errors immediately adjacent;
- no large cards;
- destructive actions isolated;
- native dialogs when file or credential behavior benefits from them.

