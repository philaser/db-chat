# Connections Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Connections secondary view so it hides the new-connection form behind a single pop-up selector, simplifies saved-connection rows to a single-line list with monochrome icons, and adds motion.

**Architecture:** Replace the connection-type grid and always-visible forms in `App.tsx` with a single pop-up selector component and a form panel that renders only after selection. Update `styles.css` to remove the grid styles, add selector/menu/form styles, and refactor saved-connection rows to match the design-system sidebar-row spec. Preserve all existing connection logic (functions, state variables, and IPC calls).

**Tech Stack:** React 19, TypeScript 5.9, plain CSS, Lucide icons, simple-icons (monochrome only), Vitest + React Testing Library.

---

## File map

- **`src/renderer/App.tsx`** — Replace `ConnectionLogo` with a monochrome variant, add new pop-up selector state and rendering, update `renderElasticsearchForm`/`renderDbForm` to be wrapped in an animated panel with a Cancel action, rewrite saved-connection rows in `renderFocusedView`, update tests selectors.
- **`src/renderer/styles.css`** — Remove `.connection-type-grid` and `.connection-type-button` styles, add `.connection-kind-select`, `.connection-kind-menu`, `.connection-form-panel` styles, update `.connection-form-row` label color, refactor `.saved-connection-*` styles to single-line rows.
- **`test/App.test.tsx`** — Update selectors affected by markup changes (saved-connection rows no longer contain `.saved-connection-type`; connection-type buttons removed).

---

## Task 1: Add state and helpers for the new connection-type selector

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add selector state**

Locate the component state block (around the existing `dbFormOpen`, `elasticsearchFormOpen` state). Add:

```typescript
const [connectionKindMenuOpen, setConnectionKindMenuOpen] = useState(false);
```

- [ ] **Step 2: Add a monochrome ConnectionLogo helper and kind option list**

Replace the existing `ConnectionLogo` component (around line 298) with a version that accepts an optional `monochrome` flag:

```typescript
function ConnectionLogo({ kind, monochrome = false }: { kind: ConnectionLogoKind; monochrome?: boolean }) {
  const icon = connectionLogos[kind];
  return (
    <svg aria-hidden="true" className="connection-logo" viewBox="0 0 24 24">
      <path
        d={icon.path}
        fill={monochrome ? 'currentColor' : `#${icon.hex}`}
      />
    </svg>
  );
}
```

Add a constant list of selectable kinds near `connectionLogos`:

```typescript
const connectionKindOptions: { kind: ConnectionLogoKind; label: string }[] = [
  { kind: 'sqlite', label: 'SQLite' },
  { kind: 'elasticsearch', label: 'Elasticsearch' },
  { kind: 'mysql', label: 'MySQL' },
  { kind: 'postgres', label: 'PostgreSQL' },
  { kind: 'mongodb', label: 'MongoDB' },
];
```

- [ ] **Step 3: Add a selection handler**

Add a new function near `openDbForm`:

```typescript
function selectConnectionKind(kind: ConnectionLogoKind) {
  setConnectionKindMenuOpen(false);
  if (kind === 'sqlite') {
    setDbFormOpen(false);
    setElasticsearchFormOpen(false);
    void connectSqlite();
    return;
  }
  if (kind === 'elasticsearch') {
    setDbFormOpen(false);
    setElasticsearchHost('');
    setElasticsearchPort('9200');
    setElasticsearchUseSsl(false);
    setElasticsearchVerifyCerts(true);
    setElasticsearchUsername('');
    setElasticsearchPassword('');
    setElasticsearchRememberPassword(false);
    setElasticsearchFormOpen(true);
    return;
  }
  setElasticsearchFormOpen(false);
  openDbForm(kind);
}
```

- [ ] **Step 4: Add a cancel/close handler for the form panel**

Add:

```typescript
function closeConnectionForm() {
  setElasticsearchFormOpen(false);
  setDbFormOpen(false);
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(connections): add selector state and monochrome logo helper"
```

---

## Task 2: Replace connection-type grid with a pop-up selector

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Remove the connection-type grid markup**

In `renderFocusedView`, inside the `activeView === 'connections'` branch, replace the `<div className="connection-type-grid">...</div>` and the two `{renderElasticsearchForm()}` / `{renderDbForm()}` calls with:

```tsx
<div className="connection-kind-select">
  <button
    type="button"
    className={`connection-kind-trigger${connectionKindMenuOpen ? ' open' : ''}`}
    onClick={() => setConnectionKindMenuOpen((current) => !current)}
    aria-expanded={connectionKindMenuOpen}
    aria-haspopup="listbox"
    disabled={busy || !api}
  >
    <Database size={16} />
    <span>Choose connection type…</span>
    <ChevronDown size={14} className={connectionKindMenuOpen ? 'open' : ''} />
  </button>
  {connectionKindMenuOpen && (
    <div className="connection-kind-menu" role="listbox">
      {connectionKindOptions.map((option) => (
        <button
          key={option.kind}
          type="button"
          className="connection-kind-option"
          role="option"
          onClick={() => selectConnectionKind(option.kind)}
        >
          <ConnectionLogo kind={option.kind} monochrome />
          {option.label}
        </button>
      ))}
    </div>
  )}
</div>
<div className={`connection-form-panel${elasticsearchFormOpen || dbFormOpen ? ' open' : ''}`}>
  {renderElasticsearchForm()}
  {renderDbForm()}
</div>
```

- [ ] **Step 2: Close menu on outside click and Escape**

Add an effect inside the component (near other effects):

```typescript
useEffect(() => {
  if (!connectionKindMenuOpen) return;
  function handlePointerDown(event: PointerEvent) {
    const target = event.target as Node;
    if (!target || !(target instanceof Node)) return;
    const root = document.querySelector('.connection-kind-select');
    if (root && !root.contains(target)) {
      setConnectionKindMenuOpen(false);
    }
  }
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      setConnectionKindMenuOpen(false);
    }
  }
  document.addEventListener('pointerdown', handlePointerDown);
  document.addEventListener('keydown', handleKeyDown);
  return () => {
    document.removeEventListener('pointerdown', handlePointerDown);
    document.removeEventListener('keydown', handleKeyDown);
  };
}, [connectionKindMenuOpen]);
```

- [ ] **Step 3: Add form-panel CSS and selector CSS**

In `styles.css`, after the existing `.connection-logo` rule, replace from `.connection-type-grid` through `.connection-form-submit` with:

```css
/* Connection kind selector */

.connection-kind-select {
  position: relative;
}

.connection-kind-trigger {
  align-items: center;
  background: var(--color-control);
  border: 1px solid var(--color-separator);
  border-radius: var(--radius-control);
  color: var(--color-text-secondary);
  cursor: pointer;
  display: flex;
  font-size: 13px;
  font-weight: 500;
  gap: 8px;
  height: 32px;
  line-height: 20px;
  padding: 0 10px;
  text-align: left;
  transition:
    background-color var(--motion-fast) var(--ease-standard),
    border-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
  width: 100%;
}

.connection-kind-trigger:hover:not(:disabled) {
  background: var(--color-control-hover);
  border-color: var(--color-separator-strong);
  color: var(--color-text-primary);
}

.connection-kind-trigger:active:not(:disabled) {
  background: var(--color-control-pressed);
}

.connection-kind-trigger:disabled {
  cursor: not-allowed;
  opacity: var(--color-text-disabled);
}

.connection-kind-trigger.open {
  border-color: var(--color-focus);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}

.connection-kind-trigger > span {
  flex: 1 1 auto;
}

.connection-kind-trigger > svg:last-child {
  flex: 0 0 auto;
  transition: transform var(--motion-fast) var(--ease-standard);
}

.connection-kind-trigger > svg:last-child.open {
  transform: rotate(180deg);
}

.connection-kind-menu {
  animation: menu-enter var(--motion-fast) var(--ease-standard);
  background: var(--color-content);
  border: 1px solid var(--color-separator);
  border-radius: var(--radius-popover);
  box-shadow: var(--shadow-popover);
  left: 0;
  margin-top: 6px;
  min-width: 100%;
  overflow: hidden;
  position: absolute;
  top: 100%;
  z-index: var(--z-popover);
}

@keyframes menu-enter {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.connection-kind-option {
  align-items: center;
  background: transparent;
  border: none;
  color: var(--color-text-primary);
  cursor: pointer;
  display: flex;
  font-size: 13px;
  font-weight: 500;
  gap: 8px;
  height: 32px;
  line-height: 20px;
  padding: 0 10px;
  text-align: left;
  transition: background-color var(--motion-fast) var(--ease-standard);
  width: 100%;
}

.connection-kind-option:hover {
  background: var(--color-control-hover);
}

.connection-kind-option:active {
  background: var(--color-control-pressed);
}

.connection-kind-option svg {
  color: var(--color-text-secondary);
}

/* Connection form — animated panel */

.connection-form-panel {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--motion-panel) var(--ease-panel);
}

.connection-form-panel.open {
  grid-template-rows: 1fr;
}

.connection-form-panel > form {
  min-height: 0;
  opacity: 0;
  overflow: hidden;
  transform: translateY(4px);
  transition:
    opacity var(--motion-panel) var(--ease-panel),
    transform var(--motion-panel) var(--ease-panel);
}

.connection-form-panel.open > form {
  opacity: 1;
  transform: translateY(0);
}

@media (prefers-reduced-motion: reduce) {
  .connection-form-panel,
  .connection-form-panel > form {
    transition: none;
  }
}

.connection-form {
  display: grid;
  gap: 12px;
  margin-top: 16px;
  max-width: 560px;
}

.connection-form-row {
  align-items: center;
  display: grid;
  gap: 12px;
  grid-template-columns: 140px minmax(0, 1fr);
  min-height: 38px;
}

.connection-form-row label {
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}

.connection-form-row input {
  background: var(--color-control);
  border: 1px solid var(--color-separator);
  border-radius: var(--radius-control);
  color: var(--color-text-primary);
  font-size: 13px;
  height: 32px;
  line-height: 20px;
  min-width: 0;
  padding: 0 10px;
  width: 100%;
}

.connection-form-row input:focus {
  border-color: var(--color-focus);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
  outline: none;
}

.connection-form-checkbox {
  align-items: center;
  display: flex;
  gap: 8px;
  min-height: 32px;
}

.connection-form-checkbox input {
  accent-color: var(--color-accent);
  height: 16px;
  margin: 0;
  width: 16px;
}

.connection-form-checkbox label {
  color: var(--color-text-primary);
  font-size: 13px;
  line-height: 20px;
}

.connection-form-actions {
  align-items: center;
  display: flex;
  gap: 12px;
  margin-top: 4px;
}

.connection-form-cancel {
  background: transparent;
  border: none;
  border-radius: var(--radius-control);
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  height: 28px;
  line-height: 20px;
  padding: 0 10px;
  transition:
    background-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}

.connection-form-cancel:hover {
  background: var(--color-control-hover);
  color: var(--color-text-primary);
}

.connection-form-cancel:active {
  background: var(--color-control-pressed);
}
```

- [ ] **Step 4: Remove old `.connection-type-grid` and `.connection-type-button` CSS**

Delete the old CSS block (lines around `.connection-type-grid` and `.connection-type-button`) so it no longer applies.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: some failures because old selectors are gone; that is expected at this stage.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(connections): replace type grid with pop-up selector"
```

---

## Task 3: Add Cancel action and clean up form markup

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Update Elasticsearch form footer**

In `renderElasticsearchForm`, replace the submit button block:

```tsx
<div className="connection-form-actions">
  <button type="submit" className="primary-button connection-form-submit" disabled={busy || !elasticsearchHost.trim() || !elasticsearchPort.trim()}>
    Connect
  </button>
  <button type="button" className="connection-form-cancel" onClick={closeConnectionForm}>
    Cancel
  </button>
</div>
```

- [ ] **Step 2: Update DB form footer**

In `renderDbForm`, replace the submit button block:

```tsx
<div className="connection-form-actions">
  <button type="submit" className="primary-button connection-form-submit" disabled={busy || !dbFormHost.trim() || !dbFormPort.trim()}>
    Connect
  </button>
  <button type="button" className="connection-form-cancel" onClick={closeConnectionForm}>
    Cancel
  </button>
</div>
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(connections): add cancel action to connection forms"
```

---

## Task 4: Refactor saved-connection rows to single-line spec

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Rewrite saved-connection row markup**

In `renderFocusedView`, inside the saved-connections section, replace the `.saved-connection-row` map with:

```tsx
{savedConnections.map((item) => {
  const isActive = connection?.id === item.id;
  return (
    <div className={`saved-connection-row ${isActive ? 'active' : ''}`} key={item.id}>
      <button
        type="button"
        className="saved-connection-main"
        onClick={() => void connectFromHistory(item)}
        disabled={busy}
        aria-current={isActive ? 'true' : undefined}
      >
        <ConnectionLogo kind={item.kind} monochrome />
        <span className="saved-connection-label">{item.label}</span>
        <span className="saved-connection-date">{formatHistoryDate(item.lastConnectedAt)}</span>
      </button>
      <button
        type="button"
        className="saved-connection-delete"
        onClick={() => void deleteConnection(item.id)}
        aria-label={`Delete connection ${item.label}`}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
})}
```

- [ ] **Step 2: Replace saved-connection CSS**

Replace the entire `.saved-connection-*` CSS block (around lines 2300-2380) with:

```css
/* Saved connections — single-line rows */

.saved-connection-row {
  align-items: center;
  border-bottom: 1px solid var(--color-separator);
  display: flex;
  gap: 8px;
  height: 38px;
  padding: 0 10px;
  transition: background-color var(--motion-fast) var(--ease-standard);
}

.saved-connection-row:last-child {
  border-bottom: none;
}

.saved-connection-row:hover {
  background: var(--color-control-hover);
}

.saved-connection-row.active {
  background: var(--color-selected);
  border-radius: var(--radius-row);
}

.saved-connection-main {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-row);
  color: var(--color-text-primary);
  cursor: pointer;
  display: flex;
  flex: 1 1 auto;
  font-size: 13px;
  gap: 8px;
  height: 28px;
  line-height: 20px;
  min-width: 0;
  padding: 0;
  text-align: left;
  transition: background-color var(--motion-fast) var(--ease-standard);
}

.saved-connection-main:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}

.saved-connection-main:disabled {
  cursor: not-allowed;
  opacity: var(--color-text-disabled);
}

.saved-connection-main svg {
  color: var(--color-text-secondary);
  flex: 0 0 auto;
}

.saved-connection-label {
  flex: 1 1 auto;
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.saved-connection-row.active .saved-connection-label {
  font-weight: 500;
}

.saved-connection-date {
  color: var(--color-text-tertiary);
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  margin-left: 8px;
}

.saved-connection-delete {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-control);
  color: var(--color-text-tertiary);
  cursor: pointer;
  display: flex;
  flex: 0 0 auto;
  height: 28px;
  justify-content: center;
  opacity: 0;
  padding: 0;
  transition:
    background-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard),
    opacity var(--motion-fast) var(--ease-standard);
  width: 28px;
}

.saved-connection-delete:hover {
  background: var(--color-control-hover);
  color: var(--color-danger);
}

.saved-connection-delete:active {
  background: var(--color-control-pressed);
}

.saved-connection-row:hover .saved-connection-delete,
.saved-connection-row:focus-within .saved-connection-delete {
  opacity: 1;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(connections): refactor saved-connection rows to single-line spec"
```

---

## Task 5: Make sidebar connection rows monochrome too

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Find sidebar connection row markup**

Search `App.tsx` for the sidebar connections section (around the `renderSidebar` function). Locate where `ConnectionLogo` is used for saved connections in the sidebar. If it exists, add the `monochrome` prop.

- [ ] **Step 2: Add monochrome prop to sidebar logos**

If the sidebar uses `ConnectionLogo`, change the call to:

```tsx
<ConnectionLogo kind={item.kind} monochrome />
```

- [ ] **Step 3: Ensure sidebar logo CSS uses currentColor**

If a sidebar-specific logo style exists, ensure it inherits color rather than using the brand hex. If not, the new `ConnectionLogo` with `monochrome` will already use `currentColor`.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(connections): monochrome vendor icons in sidebar rows"
```

---

## Task 6: Update tests for new markup

**Files:**
- Modify: `test/App.test.tsx`

- [ ] **Step 1: Find broken selectors**

Run: `npm test`
Expected: failures pointing to missing `.connection-type-button` and `.saved-connection-type`.

- [ ] **Step 2: Replace connection-type button tests with selector tests**

Find tests that click `.connection-type-button` or expect buttons named "SQLite", "PostgreSQL", etc. Replace with the new trigger and menu items. Example:

```typescript
// open the selector
await user.click(screen.getByRole('button', { name: /choose connection type/i }));
await user.click(screen.getByRole('button', { name: /sqlite/i }));
```

- [ ] **Step 3: Update saved-connection assertions**

Remove assertions that look for `.saved-connection-type` text. Instead assert the connection label is visible, e.g.:

```typescript
expect(screen.getByText('postgres localhost:5432/esapi')).toBeInTheDocument();
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add test/App.test.tsx
git commit -m "test(connections): update selectors for redesign"
```

---

## Task 7: Add form reveal and menu motion + verify

**Files:**
- Modify: `src/renderer/styles.css`

- [ ] **Step 1: Confirm motion CSS is present**

Ensure `.connection-form-panel` and `.connection-kind-menu` animations from Task 2 are in the stylesheet.

- [ ] **Step 2: Run full verification**

Run:

```bash
npx tsc --noEmit
npm test
npm run build
```

Expected: typecheck passes, tests pass, build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/styles.css
git commit -m "feat(connections): add form reveal and menu motion"
```

---

## Self-review

1. **Spec coverage:**
   - Single selector replacing grid → Task 2.
   - Form appears only after selection → Tasks 1-2 (selector state/handler, animated panel).
   - Flat grouped form rows → Task 2 CSS (existing row structure preserved, labels color corrected).
   - Saved connections single-line rows → Task 4.
   - Monochrome icons → Tasks 1 (helper), 4, 5.
   - Motion → Tasks 2 and 7.
   - Accessibility → Task 2 (`aria-expanded`, `aria-haspopup`, `role="listbox"`, outside/Escape dismissal).

2. **Placeholder scan:** None; all steps contain concrete code and commands.

3. **Type consistency:** `ConnectionLogo` signature updated to include `monochrome?: boolean`; all callers updated in Tasks 2, 4, 5.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-25-connections-redesign.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — I execute tasks in this session using `executing-plans`, with checkpoints for review.

Which approach do you want?
