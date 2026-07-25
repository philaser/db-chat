# Connections Page Redesign

## Status

Approved — Option 1 from 2026-07-25 brainstorming session.

## Goal

Make the Connections page feel clean, Apple-like, and intentional. Remove the busy connection-type grid, hide the configuration form until a database type is chosen, simplify saved-connection rows, and add motion.

## Page structure

1. **Current connection** — quiet status row.
2. **New connection** — single "Connection type" selector; form appears only after selection.
3. **Saved connections** — single-line hairline list.

## Current connection status

- Single flat row.
- Leading `8px` status dot: green when connected, `--source-neutral` when offline.
- Primary label: connection name, `13/20` primary color, truncated.
- Optional trailing schema summary such as "108 indices connected", `12/18` secondary color.
- No card, no border, no background by default.

## New connection selector

- Pop-up trigger, `32px` high, `8px` radius, `1px` border, full width of content column.
- Leading monochrome DB icon (`16px`), selected label, trailing chevron.
- Default label: "Choose connection type…"
- Menu items: SQLite, Elasticsearch, MySQL, PostgreSQL, MongoDB. Each shows its monochrome icon and label.
- Selecting an item closes the menu and reveals the configuration form directly below the selector.

## New connection form

- Flat grouped rows.
- Two-column layout where space permits: leading label `120px`, control fills remaining width.
- Labels: `13/20`, `--color-text-secondary`.
- Inputs: `32px` high, `8px` radius, `1px` border.
- Help text: `11/16`, `--color-text-tertiary`, immediately adjacent.
- Errors: `11/16`, `--color-danger`, immediately adjacent.
- Checkboxes use `16px` native control with `--color-accent`; label uses `--color-text-primary`.
- Primary action "Connect" uses `accent` button, left-aligned below the form.
- A secondary "Cancel" text action resets the selector and hides the form.

## Saved connections list

- Flat list with `1px` hairline separators between rows.
- Row height `38px`, `6px` radius, horizontal padding `10px`.
- Leading monochrome vendor icon (`16px`), `8px` gap.
- Primary label: connection name, `13/20` primary, truncated with ellipsis.
- Trailing metadata: last connected date, `11/16` tertiary, right-aligned.
- No separate type label; the icon communicates the vendor.
- Entire row is clickable to connect.
- Delete button (`28×28px` icon button) appears on row hover or focus-within.
- Active/selected connection uses `--color-selected` fill and weight `500` for the label.

## Iconography

- All database icons on this page are monochrome (`--color-text-secondary` default, `--color-text-primary` on hover/focus).
- Colored vendor icons are not used in working surfaces, per DESIGN-SYSTEM.md.
- The only colored element is the connection status dot.

## Motion

- Form reveal: opacity `0 → 1`, translateY `4px → 0`, `220ms`, `--ease-panel`.
- Menu open/close: opacity `0 → 1`, translateY `8px → 0`, `180ms`.
- Row hover/pressed: background-color transition `120ms`.
- Focus-visible rings: `80ms` color transition.
- Respect `prefers-reduced-motion: reduce` by disabling transform and opacity transitions.

## Accessibility

- Selector uses a real `button` with `aria-expanded` and `aria-haspopup`.
- Menu items are focusable and dismissible with `Escape`.
- Saved-connection rows are buttons; delete action has an accessible name.
- Status dot is paired with visible label text.
- `aria-live="polite"` for connection success/failure announcements.

## Out of scope

- Refactoring connection creation logic or IPC calls.
- Adding new database types.
- Changing the sidebar connection rows (this spec targets the Connections page only).
- Rewriting tests beyond updating selectors affected by markup changes.
