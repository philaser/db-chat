# DB Chat Design System

## Product Posture

The dominant posture is **operational desktop tool** with a secondary **editorial** quality.

The interface must optimize, in order:

1. comprehension of the current answer;
2. scan speed in returned data;
3. awareness of database and execution context;
4. fast continuation through the composer;
5. access to secondary query and schema tools.

Decoration, branding, theme novelty, and surface elevation are lower priority than all five.

## Design Principles

### 1. Hierarchy comes from alignment before decoration

Use position, spacing, font weight, and text color first. Use separators second. Use tinted fills third. Add a border only when the relationship is still unclear. Add a shadow only for an overlay, menu, tooltip, or other truly elevated object.

### 2. One surface, multiple regions

The application reads as one macOS window. Sidebar, transcript, and inspector are regions of the same workspace, not three cards placed beside each other.

### 3. Data is the strongest visual object

The transcript stays quiet. Returned columns, values, validation state, and selected context receive the strongest functional contrast.

### 4. Color is semantic

Blue identifies selection, focus, links, and the send action. Source colors appear only as small dots. Success, warning, and danger colors appear only when the state is meaningful.

### 5. Context is temporary

The inspector opens because a result, query, or schema object needs attention. It must be easy to close and must not dominate an empty or purely conversational state.

## CSS Token Contract

Implement these roles as CSS custom properties. Components must consume role tokens instead of hard-coded color values.

```css
:root,
[data-theme="light"] {
  color-scheme: light;

  /* Font families */
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text",
    "Helvetica Neue", "Segoe UI", sans-serif;
  --font-mono: ui-monospace, "SFMono-Regular", "SF Mono", Menlo,
    Monaco, Consolas, "Liberation Mono", monospace;

  /* Core surfaces */
  --color-window: #ffffff;
  --color-content: #ffffff;
  --color-inspector: #ffffff;
  --color-toolbar: rgba(255, 255, 255, 0.94);
  --color-sidebar-fallback: rgba(246, 248, 251, 0.86);
  --color-control: rgba(250, 250, 252, 0.92);
  --color-control-hover: rgba(60, 60, 67, 0.055);
  --color-control-pressed: rgba(60, 60, 67, 0.095);
  --color-selected: rgba(0, 122, 255, 0.095);
  --color-selected-strong: rgba(0, 122, 255, 0.14);

  /* Text */
  --color-text-primary: #1d1d1f;
  --color-text-secondary: #6e6e73;
  --color-text-tertiary: #8e8e93;
  --color-text-disabled: rgba(60, 60, 67, 0.34);
  --color-link: #007aff;

  /* Lines and focus */
  --color-separator: rgba(60, 60, 67, 0.12);
  --color-separator-strong: rgba(60, 60, 67, 0.2);
  --color-focus: #007aff;
  --color-focus-ring: rgba(0, 122, 255, 0.28);

  /* Actions */
  --color-accent: #007aff;
  --color-accent-hover: #006adc;
  --color-accent-pressed: #005ec4;
  --color-on-accent: #ffffff;

  /* Semantic state */
  --color-success: #34c759;
  --color-warning: #ff9f0a;
  --color-danger: #ff3b30;
  --color-info: #0a84ff;
  --color-success-soft: rgba(52, 199, 89, 0.1);
  --color-warning-soft: rgba(255, 159, 10, 0.11);
  --color-danger-soft: rgba(255, 59, 48, 0.1);
  --color-info-soft: rgba(10, 132, 255, 0.1);

  /* Source identity dots */
  --source-analytics: #0a84ff;
  --source-customer: #ff9f0a;
  --source-finance: #30b0c7;
  --source-marketing: #bf5af2;
  --source-operations: #34c759;
  --source-neutral: #8e8e93;

  /* Elevation */
  --shadow-none: none;
  --shadow-overlay: 0 18px 48px rgba(0, 0, 0, 0.14);
  --shadow-popover: 0 12px 32px rgba(0, 0, 0, 0.12);
  --shadow-tooltip: 0 6px 18px rgba(0, 0, 0, 0.16);
}
```

### Dark semantic mapping

Dark mode preserves component geometry, spacing, weight, and hierarchy. Only semantic tokens change.

```css
[data-theme="dark"] {
  color-scheme: dark;

  --color-window: #1c1c1e;
  --color-content: #1c1c1e;
  --color-inspector: #1c1c1e;
  --color-toolbar: rgba(28, 28, 30, 0.94);
  --color-sidebar-fallback: rgba(36, 36, 38, 0.88);
  --color-control: rgba(44, 44, 46, 0.92);
  --color-control-hover: rgba(255, 255, 255, 0.07);
  --color-control-pressed: rgba(255, 255, 255, 0.11);
  --color-selected: rgba(10, 132, 255, 0.2);
  --color-selected-strong: rgba(10, 132, 255, 0.28);

  --color-text-primary: #f5f5f7;
  --color-text-secondary: #aeaeb2;
  --color-text-tertiary: #8e8e93;
  --color-text-disabled: rgba(235, 235, 245, 0.3);
  --color-link: #0a84ff;

  --color-separator: rgba(84, 84, 88, 0.65);
  --color-separator-strong: rgba(99, 99, 102, 0.78);
  --color-focus: #0a84ff;
  --color-focus-ring: rgba(10, 132, 255, 0.36);

  --color-accent: #0a84ff;
  --color-accent-hover: #409cff;
  --color-accent-pressed: #0071e3;
  --color-on-accent: #ffffff;

  --color-success: #30d158;
  --color-warning: #ffd60a;
  --color-danger: #ff453a;
  --color-info: #64d2ff;

  --shadow-overlay: 0 20px 56px rgba(0, 0, 0, 0.4);
  --shadow-popover: 0 14px 36px rgba(0, 0, 0, 0.36);
  --shadow-tooltip: 0 8px 22px rgba(0, 0, 0, 0.42);
}
```

Legacy named palettes may remain wired to semantic roles during migration, but they must not alter layout, radius, typography, border width, or component structure. Light mode is the canonical acceptance target. Dark mode is the required parity target.

## Typography

### Font policy

- Use the system stack; never bundle SF Pro.
- Use `--font-sans` for all interface and prose text.
- Use `--font-mono` only for SQL/JSON, raw identifiers, and aligned technical values.
- Set `font-synthesis: none` where supported.
- Set `-webkit-font-smoothing: antialiased`.
- Set `text-rendering: optimizeLegibility`.
- Use `font-variant-numeric: tabular-nums` for times, counts, latency, and numeric table columns.
- Letter spacing is `0` unless explicitly listed.

### Type scale

| Token | Size | Line height | Weight | Use |
| --- | ---: | ---: | ---: | --- |
| `type-window-title` | `13px` | `18px` | `600` | DB Chat title in chrome |
| `type-screen-title` | `20px` | `26px` | `650` | Active chat title |
| `type-inspector-title` | `17px` | `22px` | `600` | `Data` |
| `type-body` | `13px` | `20px` | `400` | Transcript and controls |
| `type-body-medium` | `13px` | `20px` | `500` | Selected rows and labels |
| `type-body-strong` | `13px` | `20px` | `600` | Short titles only |
| `type-supporting` | `12px` | `18px` | `400` | Supporting copy |
| `type-label` | `11px` | `16px` | `500` | Section labels and metadata |
| `type-label-strong` | `11px` | `16px` | `600` | Table headers |
| `type-caption` | `10px` | `14px` | `500` | Rare technical annotations |
| `type-mono` | `12px` | `18px` | `400` | Query editor and raw schema |

Rules:

- Do not use font weights below `400`.
- Do not use weights above `650` in the app shell.
- Do not uppercase section labels.
- Do not increase font size to create emphasis if weight or color is sufficient.
- Keep transcript prose to a maximum readable line length of `68ch`.
- Use ellipsis for single-line titles and identifiers; do not wrap toolbar or sidebar labels.

## Spacing

Use a four-point base with two deliberate half-steps for optical alignment.

```css
--space-0-5: 2px;
--space-1: 4px;
--space-1-5: 6px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-9: 36px;
--space-10: 40px;
--space-12: 48px;
```

Usage:

- icon-to-label gap: `8px`;
- related metadata gap: `6px`;
- sidebar section gap: `28px`;
- sidebar horizontal padding: `16px`;
- transcript horizontal gutter: `36px`;
- inspector horizontal padding: `28px`;
- standard control internal padding: `8px 10px`;
- composer horizontal inset from transcript: `18px`;
- pane content bottom safe space: `32px`.

Do not create one-off spacing values unless an optical adjustment is documented with a comment.

## Radius

```css
--radius-none: 0;
--radius-row: 6px;
--radius-control: 8px;
--radius-composer: 10px;
--radius-popover: 12px;
--radius-round: 999px;
```

Rules:

- Panes, toolbar regions, tables, and inspector sections have no radius.
- Sidebar selected rows use `6px`.
- Search, buttons, pop-up controls, and compact inputs use `8px`.
- The composer uses `10px`.
- Popovers and menus use `12px`.
- Only circular icon buttons use `999px`.
- Never put one rounded surface inside another rounded surface.

## Borders And Separators

- Standard separator: `1px solid var(--color-separator)`.
- Strong separator: `1px solid var(--color-separator-strong)`.
- Do not use borders wider than `1px` except the visible `2px` focus treatment created through outline or box-shadow.
- Table rows, toolbar bottom, pane boundaries, transcript rows, and inspector footer use standard separators.
- The selected sidebar row has no visible border.
- The selected tab uses a `2px` accent underline; it does not use a filled pill.
- Pane boundaries never use shadows at wide widths.

## Elevation

| Level | Treatment | Allowed use |
| --- | --- | --- |
| Base | no shadow | sidebar, toolbar, transcript, inspector, table |
| Overlay | `--shadow-overlay` | constrained-width inspector overlay |
| Popover | `--shadow-popover` | menus, selectors, connection popover |
| Tooltip | `--shadow-tooltip` | tooltips only |

No other shadow is permitted.

## Motion

```css
--motion-instant: 80ms;
--motion-fast: 120ms;
--motion-standard: 180ms;
--motion-panel: 220ms;
--ease-standard: cubic-bezier(0.2, 0.8, 0.2, 1);
--ease-panel: cubic-bezier(0.25, 0.1, 0.25, 1);
```

Rules:

- Hover and pressed feedback: `120ms`.
- Focus color transitions: `80ms`.
- Inspector open/close and column reflow: `220ms`.
- Tab content fade: `180ms`, opacity only.
- Message arrival: `180ms`, opacity plus at most `4px` vertical movement.
- Never animate table row position, numeric values, pane height, or text size.
- During direct resize, disable transitions.
- Under `prefers-reduced-motion: reduce`, disable nonessential transitions and all entrance motion.

## Icons

- Keep `lucide-react`; do not add a second icon library.
- Default stroke width: Lucide's standard `2`.
- Sidebar and toolbar icons: `16px`.
- Small metadata icons: `14px`.
- Send icon: `16px`.
- Empty-state maximum: `20px`.
- Icon buttons use a minimum `28×28px` target.
- A symbol beside text must align to the text's optical center.
- Familiar actions may be icon-only only when they have `aria-label`, `title`, and tooltip behavior.
- Database vendor identity may continue using `simple-icons`, but keep it monochrome in working surfaces. Source identity color belongs on the adjacent dot, not the logo.

## Control Sizes

| Control | Height |
| --- | ---: |
| Toolbar | `52px` |
| Standard icon button | `28px` |
| Standard text button | `28px` |
| Sidebar row | `38px` |
| Search field | `32px` |
| Pop-up selector | `32px` |
| Transcript row minimum | `72px` |
| Table header | `38px` |
| Table row | `48px` |
| Composer | `62px` collapsed |
| Inspector footer | `64px` |

## Z-Index Scale

```css
--z-base: 0;
--z-sticky: 10;
--z-panel-overlay: 30;
--z-popover: 50;
--z-tooltip: 70;
--z-drag-region-controls: 80;
```

Do not use arbitrary z-index values.

## Accessibility

- Target WCAG 2.2 AA contrast for all text and controls.
- Text below `18px` requires at least `4.5:1`.
- Focus must remain visible in both light and dark themes.
- Use `:focus-visible`; do not remove outlines without an equivalent.
- Keyboard focus order follows visual order: toolbar, sidebar, transcript actions, composer, inspector tabs, inspector content, footer actions.
- All icon-only controls require accessible names.
- Status changes such as `Copied`, export completion, query error, and inspector opening require an `aria-live="polite"` announcement.
- Do not communicate state through source-dot color alone; pair it with label, status text, or accessible description.
- Table headers use semantic `<th scope="col">`.
- Inspector tabs use a real tablist, tab, and tabpanel relationship with `aria-selected`, `aria-controls`, and roving keyboard behavior.

## Do

- Let white space carry hierarchy.
- Prefer flat lists and tables.
- Use one accent color consistently.
- Keep source colors to dots.
- Keep the transcript readable and restrained.
- Keep inspector actions fixed while data scrolls.
- Test common, hover, keyboard, empty, loading, success, and error states.

## Avoid

- chat bubbles;
- card stacks;
- dashboard tiles;
- gradients inside the app;
- decorative blur on content panes;
- large avatars;
- giant call-to-action buttons;
- heavy shadows;
- saturated side panels;
- pill-shaped tab groups;
- uppercase navigation labels;
- oversized headings;
- multicolor working icons;
- dense metadata chips;
- styling copied from the superseded Codex guide.

