# Inspector Toggle Overlap Fix

## Overview

The inspector toggle button in the conversation pane overlaps the "New chat" button in the project sidebar header.

## Problem

- `.inspector-toggle` is absolutely positioned at `right: 20px; top: 20px` inside `.conversation-pane`.
- The sidebar's project-detail header includes a "New chat" primary button at roughly the same vertical position.
- The two buttons visually collide at the narrow seam between sidebar and conversation pane.

## Design

Move the inspector toggle from the fixed top-right corner of the conversation pane into the right side of `.conversation-header`. This anchors the toggle to the chat title area and removes the overlap.

### Changes

- Move the `<button className="inspector-toggle">` element from before `conversation-header` into the `.conversation-header` div.
- Change `.inspector-toggle` positioning from absolute to static (remove `position: absolute`, `right`, `top`, `z-index`) and let it sit on the right side of the header.
- Update `.conversation-header` layout to use `display: flex`, `justify-content: space-between`, and `align-items: center` so the title/metadata stack sits on the left and the toggle sits on the right.
- Keep the title/metadata in a single wrapper inside the flex header so the row stays tidy.

## Affected Files

- `src/renderer/App.tsx`: move the inspector toggle button inside `.conversation-header`.
- `src/renderer/styles.css`: update `.conversation-header` and `.inspector-toggle` styles.

## Acceptance Criteria

- [ ] Inspector toggle no longer overlaps the sidebar "New chat" button.
- [ ] Toggle remains clickable and toggles the inspector panel open/closed.
- [ ] Header layout keeps the title, date label, status, and toggle aligned cleanly.
- [ ] Existing tests pass; typecheck and build remain clean.
