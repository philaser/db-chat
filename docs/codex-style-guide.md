# DB Chat Codex Style Guide

## Goal

Make DB Chat feel like a focused Codex desktop surface for talking with data:

- Quiet, dense, native-feeling, and thread-first.
- The chat is the primary work surface.
- Query, schema, and result tools support the conversation without turning the app into a dashboard.
- Visual feedback is precise and alive, but never ornamental.

This guide targets the current DB Chat renderer in `src/renderer/App.tsx` and `src/renderer/styles.css`.

## Research Basis

### Observed Codex evidence

The guide is based on these Codex app signals:

- OpenAI describes the Codex desktop app as a command center organized around projects, threads, parallel work, review, and long-running agent tasks. OpenAI Academy describes its core app elements as a sidebar menu, projects, settings, and a chat window. For DB Chat, the equivalent unit is a data conversation with one connected source and its supporting inspector state.
- The locally installed macOS Codex app inspected for this guide is version `26.519.22136`.
- Its packaged frontend exposes:
  - A native/system sans stack: `-apple-system`, `BlinkMacSystemFont`, and `Segoe UI` fallback.
  - A native/system mono stack: `ui-monospace`, `SFMono-Regular`, `SF Mono`, `Menlo`, `Consolas`, and `Liberation Mono`.
  - A 4px spacing base.
  - Text tokens at `11px`, `12px`, `14px`, `16px`, plus heading sizes.
  - Radius tokens from small radii through full pills, with Electron increasing the radius scale slightly.
  - Theme tokens built from neutral surfaces, translucent hover fills, light borders, link/accent color, and status colors.
  - Small standalone icon modules and icon-size utility classes rather than heavy illustrated controls.
  - Motion infrastructure including Framer Motion, an ease curve of `duration: 0.5` and `[0.19, 1, 0.22, 1]`, shimmer effects, and reduced-motion handling.
  - Button variants shaped around ghost, outline, primary, secondary, icon, toolbar, and composer controls.

### What is not copied

Do not treat minified Codex bundle details as a component library to clone. DB Chat should implement the observed design grammar with its own names, components, and data workflows. The target is visual and interaction parity in spirit and surface behavior, not a dependency on Codex internals.

## Visual Reference Board

Use these official Codex screenshots side by side with DB Chat while implementing the redesign. They are stronger references than generic AI chat inspiration because they show Codex's actual shell, sidebar rhythm, composer treatment, and review/context panes.

| Reference | What to study |
| --- | --- |
| [Overview light screenshot](https://developers.openai.com/images/codex/app/app-screenshot-light.webp) | Full desktop shell, sidebar width, thread density, review pane balance. |
| [Overview dark screenshot](https://developers.openai.com/images/codex/app/app-screenshot-dark.webp) | Dark surfaces, dividers, code/context pane contrast, low-chrome titlebar feel. |
| [Multitask dark screenshot](https://developers.openai.com/images/codex/app/multitask-dark.webp) | Project/thread list rows, grouped sidebar sections, selected row emphasis. |
| [Composer modes dark screenshot](https://developers.openai.com/images/codex/app/modes-dark.webp) | Composer frame, tiny toolbar icons, mode chips, send affordance. |
| [Skill selector dark screenshot](https://developers.openai.com/images/codex/app/skill-selector-dark.webp) | Picker density, list rows, overlay elevation, icon and metadata balance. |
| [Git commit dark screenshot](https://developers.openai.com/images/codex/app/git-commit-dark.webp) | Inspector/review density, compact metadata, commit action hierarchy. |

### Overview shell reference

![Official Codex app dark overview showing sidebar, active thread, and review pane](https://developers.openai.com/images/codex/app/app-screenshot-dark.webp)

### Composer reference

![Official Codex composer reference showing Local, Worktree, and Cloud mode options](https://developers.openai.com/images/codex/app/modes-dark.webp)

### Screenshot takeaways

- Codex gives the left sidebar persistent visual authority without turning each project or thread into a large card.
- The central work surface uses readable empty space inside the thread, while toolbar chrome and repeated rows stay compact.
- The composer is a framed control surface with icon affordances and secondary mode/context controls built into it.
- Context panes accept higher density than chat panes because they are for review, inspection, and decisions.
- The most obvious contrast changes happen at selection, active review data, code syntax, and call-to-action buttons. Most other chrome stays neutral.

## Design Thesis

Codex reads as a workbench because hierarchy comes from placement, restraint, and state. It does not need giant headlines, loud cards, broad gradients, or constant elevation.

For DB Chat:

- A user should open the app and immediately see conversation, data source context, and where results will appear.
- Repeated navigation rows should look like rows, not cards.
- The composer should feel like the main action point.
- Results should feel attached to the current question.
- SQL should stay in the Query inspector unless the user explicitly asks for it in chat.

## Visual Principles

1. Prefer soft neutral layers over tinted panels.
2. Use borders and hover fills before shadows.
3. Keep controls compact and highly legible.
4. Let the selected thread, selected inspector tab, focus ring, and current status carry the strongest contrast.
5. Use motion to explain state changes: entering a thread, revealing the inspector, generating a response, sending a prompt.
6. Avoid marketing composition inside the app. No hero welcome page, oversized feature copy, decorative gradients, or floating section cards.

## Layout

### Recommended shell

Use a three-zone desktop shell:

```text
| Left navigation and sources | Chat thread and composer | Context inspector |
```

Suggested first pass:

| Region | Width | Behavior |
| --- | --- | --- |
| Left rail/sidebar | `264px` default | Project-like list of chats and data sources. Collapse to icon rail. |
| Main thread | `minmax(520px, 1fr)` | Scrollable conversation, sticky composer. |
| Inspector | `360px` default | Results, Query, Schema tabs. Collapse when context is not needed. |

Keep DB Chat's existing resize and collapse affordances. Restyle them to be quieter.

### Codex-like hierarchy for DB Chat

- Left: database/source switcher, new chat, conversation history, saved connections, settings.
- Center: compact titlebar/header, thread transcript, composer.
- Right: inspector with narrow tabs and compact result metadata.

The current UI already has these regions. The redesign is mostly a density and surface-language change, not an information-architecture rewrite.

### Header

Replace the current large central header with a toolbar-like thread header:

- Height: `46px` normal toolbar target.
- Primary text: active chat title or `New data chat`.
- Secondary affordances: connection label, SAFE read status, model/status controls.
- Use overflow truncation. Do not wrap the toolbar into a hero block.

The current `Ask your database anything` header and status card are too tall for the Codex feel.

## Token System

### Spacing

Use a 4px base.

| Token | Value | Typical use |
| --- | --- | --- |
| `--space-1` | `4px` | icon gaps, tight inset |
| `--space-2` | `8px` | row gaps, control inset |
| `--space-3` | `12px` | panel padding compact |
| `--space-4` | `16px` | standard panel padding |
| `--space-5` | `20px` | roomy panel padding |
| `--space-6` | `24px` | thread gutters at desktop |
| `--space-8` | `32px` | top thread inset or large breaks |

### Typography

Use system UI fonts by default. On macOS this means San Francisco through the system stack, which is the part the user loves without bundling a proprietary font.

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-mono: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
```

| Role | Size | Weight | Line height |
| --- | --- | --- | --- |
| Fine label | `11px` | `500-600` | `16px` |
| Supporting text | `12px` | `400-500` | `18px` |
| Body/control | `14px` | `400-500` | `21px` |
| Strong row title | `14px` | `500-600` | `20px` |
| Compact heading | `16px` | `600` | `22px` |
| Page heading only | `20px` | `600` | `26px` |

Rules:

- Default renderer base should move from `15px` toward `14px`.
- Use weight and color before increasing size.
- Use mono only for SQL, schema syntax, ids when useful, and result values that need alignment.
- Keep letter spacing at `0`.

### Radius

Codex uses a range of small radii and pills. DB Chat should stop making every surface feel equally rounded.

| Role | Radius |
| --- | --- |
| Dense rows and inputs | `6px` |
| Buttons and small panels | `8px` |
| Composer and menus | `12px` |
| Icon-only round buttons | `9999px` when circular |

### Light theme starter tokens

These are implementation targets for DB Chat, not literal Codex token names:

```css
:root {
  --db-bg-under: #f7f7f5;
  --db-surface: #ffffff;
  --db-surface-raised: rgba(255, 255, 255, 0.78);
  --db-surface-fog: rgba(26, 28, 31, 0.035);
  --db-surface-hover: rgba(26, 28, 31, 0.07);
  --db-text: #1a1c1f;
  --db-text-secondary: rgba(26, 28, 31, 0.65);
  --db-text-tertiary: rgba(26, 28, 31, 0.46);
  --db-border: rgba(26, 28, 31, 0.08);
  --db-border-heavy: rgba(26, 28, 31, 0.12);
  --db-focus: rgba(51, 156, 255, 0.72);
  --db-link: #1671d9;
  --db-success: #0b8f46;
  --db-warning: #d25a12;
  --db-danger: #d53a36;
}
```

### Dark theme starter tokens

```css
[data-theme="dark"] {
  --db-bg-under: #0b0b0c;
  --db-surface: #171717;
  --db-surface-raised: rgba(33, 33, 33, 0.96);
  --db-surface-fog: rgba(255, 255, 255, 0.045);
  --db-surface-hover: rgba(255, 255, 255, 0.08);
  --db-text: #f4f4f4;
  --db-text-secondary: rgba(244, 244, 244, 0.68);
  --db-text-tertiary: rgba(244, 244, 244, 0.48);
  --db-border: rgba(255, 255, 255, 0.08);
  --db-border-heavy: rgba(255, 255, 255, 0.14);
  --db-focus: rgba(51, 156, 255, 0.72);
  --db-link: #67a9ff;
  --db-success: #36bb6f;
  --db-warning: #ff9a58;
  --db-danger: #ff6b67;
}
```

Rules:

- The neutral system is primary. Blue is for links, focus, selected action, and important live state.
- Status colors should be quiet backgrounds plus readable text, not large saturated panels.
- Prefer `color-mix()` or translucent surfaces for hover and active states.

## Design System Map

Build the DB Chat implementation as a small design system instead of a one-off stylesheet sweep.

### Foundations

| Foundation | DB Chat artifact |
| --- | --- |
| Color | Surface, text, border, action, focus, success, warning, danger tokens for light and dark themes. |
| Type | System sans scale, mono SQL/result scale, weights, line heights, truncation rules. |
| Spacing | 4px spacing steps and panel/thread gutters. |
| Shape | Radius scale, divider thickness, focus ring geometry. |
| Motion | Durations, Codex ease, shimmer/spinner rules, reduced-motion policy. |
| Icons | Icon sizes, stroke consistency, labels/tooltips for icon-only actions. |

### Primitives

Create or normalize these primitives before restyling feature-specific surfaces:

| Primitive | Variants and states |
| --- | --- |
| `Button` | Primary, secondary, outline, ghost, danger, icon, composer. Hover, pressed, focus, disabled, busy. |
| `IconButton` | Toolbar, row accessory, destructive accessory. Tooltip and `aria-label` required. |
| `Row` | Navigation row, thread row, connection row, schema row. Default, hover, selected, disabled. |
| `Badge` | SAFE, connection type, result count, warning/error. Quiet fill and text variants. |
| `SegmentedControl` | Inspector tabs and future source/result mode switches. |
| `Panel` | Sidebar, thread, inspector, overlay/menu. Border and surface variants, not card nesting. |
| `Composer` | Text entry, utility actions, send button, context/status line. |
| `ListPicker` | Model/source/skill-like picker pattern for searchable dense menus. |
| `CodeSurface` | Query editor, inline code, result/code review surface. Mono and scroll rules. |

### DB Chat patterns

| Pattern | Composition |
| --- | --- |
| Data thread | Thread header + messages + inline state artifacts + sticky composer. |
| Source switcher | Sidebar section + connection rows + add/connect actions + live state badge. |
| Results review | Inspector tabs + metadata strip + data table with sticky header. |
| Query safety | Query code surface + SAFE validation row + copy/run actions. |
| Empty chat | Lightweight starter prompts inside the thread, not a marketing welcome panel. |
| Settings | Compact row entry plus overlay/panel form; model and API key controls follow picker/input primitives. |

## Icons

### Visual language

Use:

- Simple outline symbols.
- Consistent optical size.
- Small controls with a balanced stroke presence.
- Icon-only buttons for repeated toolbar commands, with tooltips and accessible names.

Avoid:

- Multicolor decorative icons in working surfaces.
- Oversized empty-state icons.
- Text labels in compact toolbars when a common icon is enough.

### DB Chat recommendation

DB Chat already uses `lucide-react`. Keep it for the first implementation pass because its outline style is close to the observed Codex grammar and the app already imports it.

Use these optical sizes:

| Context | Icon size |
| --- | --- |
| Tiny row accessory | `12-14px` |
| Standard control | `16px` |
| Toolbar / icon button | `16-18px` |
| Empty state maximum | `20px` |

Audit icon choices while restyling:

- Keep: `Plus`, `Search`, panel toggles, `Send`, `Settings`, `Trash2`, copy/run controls.
- Prefer quieter data symbols for connection context; avoid making the database glyph a repeated badge everywhere.
- Hide destructive row actions until hover or focus, as the current history list already does.

## Components

### Buttons

Implement a small button matrix:

| Variant | Use |
| --- | --- |
| Ghost | navigation rows, icon actions, toolbar actions |
| Outline | lower-frequency commands |
| Secondary | neutral surfaced actions |
| Primary | send, connect, explicit commit-like action |
| Danger | destructive confirmation context |

Button behavior:

- Default body button text at `14px`.
- Toolbar and row actions should not hop upward on hover.
- Hover should mostly be a subtle fill or foreground increase.
- Active should compress visually with fill/opacity, not a broad scale bounce.
- Disabled opacity around `0.4-0.55`.

### Left navigation rows

History, connections, and view switches should share one row grammar:

- Height around `32-36px`.
- Transparent base.
- Rounded hover fill.
- Active row uses stronger fill and text contrast.
- Accessory actions fade in on hover/focus.
- No boxed card around every repeated item.

### Chat transcript

Codex-like chat should read as a thread, not as stacked alert cards.

DB Chat direction:

- Use a content column with a max readable width around `720-820px`.
- Make assistant content mostly unboxed or barely surfaced.
- Keep user turns compact and distinguishable with a soft fill or alignment, not a saturated bubble.
- Use message metadata sparingly.
- Render tool/result summaries as inline thread artifacts when they explain what changed in the inspector.

Current `.message` surfaces are useful structurally but too card-like and elevated.

### Composer

The composer is the strongest framed surface in the main thread:

- Rounded container around `12px`.
- Neutral border plus a quiet raised/translucent surface.
- Focus ring and border shift are more important than a large shadow.
- Send is a compact primary icon button.
- Put connection state, SAFE state, and prompt affordances near the composer only when they help answer the next message.

Keep the affordance that SQL runs as safe read-only work from chat. Do not make the composer look like a SQL editor.

### Inspector

The inspector should feel attached to the active thread:

- Use compact tabs: Results, Query, Schema.
- Use a light divider and low-contrast panel background.
- Results summary should be a narrow row, not a set of metric cards.
- Query editor should use mono typography and quiet SAFE validation.
- Schema should be a scan-friendly tree/list before it becomes a grid of cards.

## Motion

### Motion personality

Codex motion feels micro and stateful:

- Smooth ease-out entrance.
- Hover feedback kept small.
- Loading text can shimmer.
- Panels and surfaces reveal without calling attention to choreography.
- Reduced-motion is honored.

### Tokens

```css
--ease-codex: cubic-bezier(0.19, 1, 0.22, 1);
--motion-instant: 90ms;
--motion-fast: 140ms;
--motion-medium: 220ms;
--motion-slow: 500ms;
```

### Required DB Chat micro animations

| Interaction | Motion |
| --- | --- |
| New assistant turn | opacity and `translateY(4px)` in `180-220ms` |
| Composer focus | border/focus ring transition `140ms` |
| Send ready state | icon opacity/fill transition; avoid bouncing whole composer |
| Sidebar row hover | background and accessory opacity `120-140ms` |
| Panel collapse | width/opacity `220ms` with overflow control |
| Inspector tab switch | content fade plus `translateY(2-4px)` |
| Generating answer | spinner or text shimmer, never both at large scale |
| SAFE/live status | low-key pulse only when connection state changes or needs attention |

### Reduced motion

Add a global motion fallback:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
```

Do not rely only on CSS animation. If React animation primitives are later introduced, gate them behind the same preference.

## Current DB Chat Gap Analysis

| Current area | What works | What should change |
| --- | --- | --- |
| Shell | Three-pane structure, collapsible/resizable context | Remove giant reveal/elevation feel; use calmer surfaces and denser chrome |
| Typography | Already prefers SF/system fonts | Base size and headings are too large for Codex density |
| Left sidebar | Has history, source state, settings | Connection card and provider card dominate repeated work rows |
| Center header | Shows connection and SAFE context | Height and welcome framing read like a product page |
| Chat messages | Markdown and status states exist | Message cards, borders, and shadows are too heavy |
| Composer | Clear affordance and send action | It can become tighter, less shadowed, more toolbar-aware |
| Inspector | Results, Query, Schema already exist | Metrics and schema cards should become scan-first rows |
| Motion | Many transitions already exist | Current translate/scale lifts are too frequent; add reduced-motion discipline |

## Implementation Sequence

### Phase 1: Tokens and density

1. Replace renderer color, radius, spacing, typography, and motion tokens in `styles.css`.
2. Set body/app chrome to neutral Codex-like surfaces.
3. Add a reduced-motion block.
4. Keep existing semantic class names during this pass.

### Phase 2: Shell and navigation

1. Shrink the central header into a toolbar-like thread header.
2. Convert repeated sidebar cards into row/list treatment.
3. Keep connection details accessible, but move bulky forms into expandable settings or compact disclosures.
4. Make collapsed rails, resize handles, and inspector tabs visually quiet.

### Phase 3: Thread and composer

1. Reduce assistant message boxing.
2. Restyle user turns and inline generated states.
3. Make the composer the main raised surface.
4. Keep generated SQL out of chat while Query and Results update beside it.

### Phase 4: Inspector

1. Restyle result summary as a compact metadata strip.
2. Turn schema cards into dense hierarchy rows.
3. Keep Query mono and SAFE validation highly legible.

### Phase 5: Polish and verification

1. Check light and dark themes.
2. Check hover/focus/keyboard states.
3. Verify collapsed panels, panel resizing, large tables, empty history, long connection labels, and long chat titles.
4. Verify motion with reduced-motion enabled.
5. Capture screenshots before and after at desktop widths that fit the Electron shell.

## Acceptance Checklist

- The first viewport reads as a desktop work surface, not a landing page.
- Chat remains the dominant surface.
- Navigation rows, tabs, and toolbar actions share a compact visual grammar.
- Fonts read as native and clean on macOS.
- Icons are consistent in stroke, size, and button treatment.
- Hover and active feedback is subtle but obvious.
- Micro animations explain state changes and respect reduced motion.
- Query and data inspection remain discoverable without pushing SQL into the chat transcript.
