# Reference Analysis

## Purpose

This document records what was extracted from the two approved generated
references and which details are authoritative. It exists so a text-only
implementation agent does not need image access.

Both source images are `1487×1058`.

## Reference A: Canonical Temporary Data Inspector

This is the user's selected direction.

### Measured visual regions

Approximate source-image coordinates:

| Region | Source bounds | Approximate proportion |
| --- | --- | ---: |
| Integrated toolbar | `x 0–1487`, `y 0–76` | `7.2%` of height |
| Leading sidebar | `x 0–307`, `y 0–1058` | `20.7%` of width |
| Conversation region | `x 308–1043`, `y 76–1058` | `49.5%` of width |
| Data inspector | `x 1044–1487`, `y 76–1058` | `29.8%` of width |
| Empty composer | `x 339–998`, `y 927–989` | `62px` high in source |

The implementation dimensions normalize those proportions to the current
`1440×920` Electron window:

- sidebar `240px`;
- toolbar `52px`;
- inspector `384px`;
- flexible conversation with `560px` minimum;
- composer `62px`.

### Visual hierarchy

1. The toolbar is a thin, continuous part of the window rather than a header
   card.
2. The sidebar is the only visibly material/translucent surface.
3. The conversation and inspector are white, opaque, and almost completely
   flat.
4. Sidebar source colors are tiny dots rather than icon or row fills.
5. The conversation title is the largest text but remains compact.
6. Transcript roles are plain labels in a shared grid. There are no bubbles,
   avatars, or assistant branding.
7. Returned data is accessed through the quiet blue `View 5 rows` action.
8. The inspector is separated from the conversation by one hairline.
9. Results, Query, and Schema are flat text tabs with an accent underline.
10. The table uses alignment and horizontal rules instead of a containing card.

### Density and rhythm

- Sidebar rows are visually about `38–40px` high.
- Transcript rows are visually about `72–82px` high.
- The main content uses roughly `36px` leading and trailing gutters.
- The inspector uses roughly `28px` horizontal gutters.
- Table rows are visually about `48px` high.
- Most text is equivalent to `11–13px` system text.
- Only the screen title and inspector title rise above the body scale.

### Color behavior

- Primary text is near-black, not pure black.
- Secondary and metadata text use neutral system grays.
- Blue is limited to selection, active tabs, links, and the send action.
- Orange, teal, purple, green, and blue appear only in source dots.
- Pane surfaces do not use colored tints.
- Separators are low-contrast neutral gray.

## Reference B: Footer Action Source

Reference B is not the canonical layout. It contributes only the bottom
inspector actions.

### Imported details

- A fixed footer sits at the bottom of the inspector.
- A `1px` top separator divides the footer from the scrollable inspector body.
- `Copy` is left aligned.
- `Export CSV` is right aligned.
- Each action uses a small outline icon plus a compact text label.
- The actions are flat toolbar controls, not filled buttons.
- The footer surface matches the inspector surface.

Approximate source-image footer region:

- inspector begins near `x 1043`;
- footer begins near `y 963`;
- footer ends at the window bottom;
- normalized implementation height: `64px`;
- normalized horizontal padding: `28px`.

### Explicitly rejected details from Reference B

Do not import:

- the selected `Query result · 5 rows` transcript row;
- the `Data / SQL` two-tab model;
- the `Query result` inspector title;
- the top-right close/export arrangement;
- the more strongly outlined selected transcript treatment.

The selected reference keeps:

- inspector title `Data`;
- source context under the title;
- `Results / Query / Schema`;
- `View N rows` as the conversation-to-inspector bridge.

## Final Synthesis

The final screen is therefore:

```text
Reference A shell
+ Reference A sidebar
+ Reference A editorial conversation
+ Reference A contextual inspector
+ Reference A Results / Query / Schema tabs
+ Reference A table
+ Reference B fixed Copy / Export CSV footer
```

Nothing else from the previous DB Chat design or Reference B is part of the
approved visual system.

