# DB Chat Connection-Projects Design Spec

## Status

Draft spec for the connection-as-project redesign.

## Date

2026-07-25

## Problem

DB Chat currently has a "Connections" inline focus view where users pick a database kind, fill out a form, and then return to chat. Once connected, the only way to use a different database is to reopen the Connections page and connect again. The connection selector in the toolbar is effectively a shortcut to that page.

The user wants connections to behave like **projects**: a persistent list of saved connections on the left,Selecting one connects to it and scopes chat sessions to that connection . Creating a new connection becomes a modal action, not a full-page focus view.

## Goals

1. Replace the `connections` focus view with a project-style left-sidebar list.
2. Make selecting a project connect and switch the visible context.
3. Scope chat sessions to the active project.
4. Turn new-connection creation into a modal.
5. Move full connection management to Settings.
6. Follow the Scape/macOS design pack already in use.

## Non-Goals

1. Do not introduce a new server-side entity; a project is a saved connection.
2. Do not add shared cross-connection chats.
3. Do not change the database connector stack, agent harness, or safety model.

## Existing Foundation

- `ConnectionConfig` and `ConnectionHistoryItem` are already persisted in `AppStore`.
- `PersistedChatSession.connection` already exists and is populated by `persistChatSession`.
- `AppStore.deleteConnection` already removes the `connection` field from linked sessions.
- The sidebar already has a "Connections" section showing the last 4 saved connections.
- The toolbar has a connection selector that opens the `connections` view.

## Proposed Model

A **Project** is a saved `ConnectionHistoryItem`. The active project is either:

- a connection currently loaded and held in the renderer's `connection` state, or
- `null` when no project is selected.

When a project is active:

- Its database is connected.
- New chats are associated with it (`connection` optional field on the session).
- Sidebar shows the project's detail view.
- Main canvas shows the project home or the current chat.

When no project is active:

- Sidebar shows the full project list.
- Main canvas shows an empty state.

## Sidebar Modes

### Mode 1: Projects List

Layout follows `docs/scape-redesign/LAYOUT-AND-SCREEN-SPEC.md` sidebar specification.

- Top section label: "Projects".
- Rows:
  - Each saved connection as a `SidebarRow`.
  - Monochrome database icon on the left.
  - Label, single line, ellipsized.
  - 8×8 source dot in neutral/identity color.
  - Selected row uses `--color-selected`.
- Bottom row: "Add project…" with a plus icon.

Keyboard and accessibility:

- Each project row is a `button`.
- Selected project uses `aria-current="true"`.
- Pressing Enter activates the row.

### Mode 2: Project Detail

- Top row: back button "All projects" with a left chevron.
- Section label: project label.
- Row: "New chat".
- Section label: "Chats".
- Rows: recent chat sessions where `session.connection?.id === activeProject.id`, ordered by `updatedAt` desc.
- If no chats in this project, show "No chats yet".
- "Show more" row if more than 6 chats.

## Main Canvas States

### No Active Project

- Title: "Projects".
- Supporting text: "Select a project to start asking questions about your data."
- Below that, a flat list of all projects (same rows as sidebar list mode, rendered in the canvas for discoverability).
- "Add project" action at the bottom of the list.

### Project Home

- Title: project label.
- Label: connection kind and summary (e.g. "SQLite · 12 tables").
- Starter prompts (existing patterns).
- Prominent "New chat" action.
- Recent chats scoped to the project as a secondary list.

### Active Chat

- Unchanged from current workspace behavior.
- Chat title from `buildChatTitle`.
- Messages, composer, inspector all work as today.

## New Connection Modal

Trigger:

- "Add project…" row in projects list.
- Project empty state "Add project" action.
- Settings → Connections → "Add connection" (optional, secondary).

Modal content:

- Backdrop overlay (`--shadow-overlay`).
- Header: "New connection".
- Body contains current connection-kind selector and forms from the removed `connections` view.
- Keep existing form logic: SQLite file picker, Elasticsearch, MySQL, PostgreSQL, MongoDB.
- On successful connect, close modal and switch to the new project's detail view.
- On cancel or error, stay in the modal with the form state.

## Settings → Connections

Add a new section inside `settings`:

- Section title: "Connections".
- Flat grouped rows for each saved connection.
- Row anatomy:
  - monochrome db icon
  - label
  - last connected date
  - edit label action.inline rename becomes editable on click/focus and saves on Enter/Blur.
  - delete action
- No inline connect/reconnect here; selecting a project already connects.

## AppView Changes

Change `AppView` from:

```ts
type AppView = 'workspace' | 'connections' | 'history' | 'settings';
```

to:

```ts
type AppView = 'workspace' | 'history' | 'settings';
```

Remove `connections` from the renderer state and routing entirely.

## Data Flow

### Selecting a Project

1. User clicks a project row in the sidebar or project home.
2. If the project is already active, do nothing except switch to project detail/home.
3. Otherwise:
   - Set `busy = true`.
   - Call `api.connect(projectConfig)`.
   - On success:
     - set `connection = projectConfig`
     - set `schema = result`
     - set `activeProject = projectConfig`
     - set `sidebarMode = 'project'`
     - set `activeView = 'workspace'`
     - show project home
   - On failure:
     - report error
     - stay in current state
4. Set `busy = false`.

### New Chat Within a Project

- `resetChat()` keeps current `connection` and `activeProject`, clears `messages`, `query`, `result`, and `activeChatId`.
- Main canvas returns to project home.

### Sending a Message

- Existing `sendChat` unchanged.
- `persistChatSession` already records `connection` when present.

### Opening a Chat

- `openChatSession` already reconnects if the session has a `connection`.
- When opening, set `activeProject` to the session's connection if present and `sidebarMode = 'project'`.

### Deleting a Project

- Use the Settings → Connections list.
- On delete:
  - if the deleted project is the active project, call a `closeActiveProject()` helper that clears `connection`, `schema`, `activeProject`, resets chat, and returns sidebar to projects list.
  - refresh saved connections and sessions.

## State Additions

Renderer state additions in `App.tsx`:

```ts
type SidebarMode = 'projects' | 'project';
const [sidebarMode, setSidebarMode] = useState<SidebarMode>('projects');
const [activeProject, setActiveProject] = useState<ConnectionConfig | null>(null);
const [showNewProjectModal, setShowNewProjectModal] = useState(false);
```

`AppView` is updated to remove `'connections'`.

## Components to Adjust

- `App.tsx`: remove `connections` view; add sidebar modes; add project-home canvas state; wire project selection; wire modal.
- New component (inline or extracted): `NewProjectModal` containing the existing connection kind selector and forms.
- Settings: add Connections section.
- Tests: update navigation tests that assume `connections` view.

## Styling Constraints

- No new components or libraries.
- Use existing `styles.css` tokens and follow `DESIGN-SYSTEM.md`.
- Modal uses `--shadow-overlay`, `--radius-popover`, `--z-panel-overlay`.
- Source dots use existing roles.
- Sidebar rows use documented `--sidebar-width`, `--color-selected`, etc.

## Testing Checklist

- Selecting a project calls `api.connect` and switches sidebar to project mode.
- New chat inside a project does not disconnect or switch projects.
- Saving a chat records `session.connection`.
- Deleting the active project returns to project list with no active connection.
- New project modal opens from "Add project…" and succeeds/closes.
- Settings → Connections lists saved connections and allows deletion.
- `npm test`, `npm run typecheck`, `npm run build` pass.

## Migration Notes

- Existing saved connections become projects automatically — no data migration required.
- Existing chat sessions with `connection` already belong to a project.
- Remove `AppView = 'connections'` from code and any tests referencing the Connections focus view.

## Open Questions

None as of writing. Resolved:
- Project list lives permanently in the sidebar.
- Selecting a project shows the project home, not the most recent chat.
- New connection creation is a modal.
- Connection management moves to Settings.

## Approval

Awaiting user review before proceeding to implementation plan.
