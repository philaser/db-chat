# Inspector Toggle Icon Change

## Overview

Replace the existing `PanelRightOpen`/`PanelRightClose` Lucide icons used for the inspector toggle with a simpler `ChevronRight`/`ChevronLeft` pair.

## Motivation

The `PanelRightOpen`/`PanelRightClose` pair adds visual weight and looks out of place in the clean macOS/Scape design language. A directional chevron is more minimal and clearly communicates the action: the arrow points in the direction the panel will move.

## Design

- **Icon closed:** `ChevronRight`
- **Icon open:** `ChevronLeft`
- **Size:** 16 px (unchanged)
- **Button:** existing `.inspector-toggle` at 30 × 30 px in the top-right of the conversation pane
- **Tooltip / ARIA label:** unchanged — "Show inspector panel" / "Hide inspector panel"
- **Close button inside inspector panel:** keep the existing `PanelRightClose` at 18 px as-is, since the user only asked about the conversation-pane toggle.

## Affected Files

- `src/renderer/App.tsx`: swap the import and the two rendered icons.
- `test/App.test.tsx`: update assertions that reference the old icon names if present.

## Acceptance Criteria

- [x] Inspector toggle shows `ChevronRight` when the inspector is closed.
- [x] Inspector toggle shows `ChevronLeft` when the inspector is open.
- [x] Existing tests pass after any icon-specific assertions are updated.
- [x] TypeScript and production build remain clean.
