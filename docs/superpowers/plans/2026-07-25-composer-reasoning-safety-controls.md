# Composer-Integrated Reasoning & Safety Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the reasoning-effort selector and connection safety-level control from a separate bar above the composer into a single compact footer row inside the composer surface, matching the Codex-style reference.

**Architecture:** Replace the existing `effort-bar` block above the `composer` form with a `composer-toolbar` that lives inside the same bordered composer surface. The toolbar renders the reasoning chips on the left and the safety selector on the right, reusing the existing state/setters/handlers. All tests continue to run.

**Tech Stack:** React (TypeScript), Electron, Vite, plain CSS, `lucide-react`, Vitest + Testing Library.

---

## Files

- `src/renderer/App.tsx` — remove the external `effort-bar`, add inline `composer-toolbar` inside the composer form.
- `src/renderer/styles.css` — add/replace styles for compact composer toolbar, chips, and safety selector.
- `test/App.test.tsx` — add/update assertions for toolbar presence and safety-level cycling.

---

## Task 1: Refactor App.tsx composer markup

**Files:**
- Modify: `src/renderer/App.tsx:2714-2782`

- [ ] **Step 1: Inspect current composer block**

Read lines 2714–2782 of `src/renderer/App.tsx` to locate the `effort-bar` and the `composer` form. Note the `effortLevel` and `safetyLevel` state and the click handlers defined there.

- [ ] **Step 2: Remove the external `.effort-bar`**

Delete the entire `<div className="effort-bar">...</div>` block. Its children (the `Reasoning` label, chips, and safety badge) will be moved inside the composer form.

Before:
```tsx
            <div className="composer-wrapper">
              <div className="effort-bar">
                <span className="effort-bar-label">Reasoning</span>
                {(['none', 'low', 'medium', 'high', 'max'] as EffortLevel[]).map((level) => (
                  <button ... />
                ))}
                {connection && (
                  <button className="safety-badge" ... />
                )}
              </div>
              <form className="composer" ...>
                ...
              </form>
            </div>
```

- [ ] **Step 3: Add toolbar wrapper inside the composer form**

Inside the `.composer` form, add a new `<div className="composer-toolbar">` as the first child. The toolbar has two regions:
1. Left: reasoning chips.
2. Right: safety-level button when an active connection exists.

Because existing tallies depend on seeing these controls, preserve the same `aria-label`/`title` text and keep the chips represented by exposed labels.

Replace the entire block with:
```tsx
            <div className="composer-wrapper">
              <form className="composer" onSubmit={(event) => void sendChat(event)}>
                <div className="composer-toolbar">
                  <div className="composer-toolbar-group">
                    <span className="composer-toolbar-label">Reasoning</span>
                    <div className="composer-toolbar-chips" role="radiogroup" aria-label="Reasoning effort">
                      {(['none', 'low', 'medium', 'high', 'max'] as EffortLevel[]).map((level) => (
                        <button
                          key={level}
                          type="button"
                          role="radio"
                          aria-checked={effortLevel === level}
                          className={`composer-chip ${effortLevel === level ? 'active' : ''}`}
                          onClick={() => {
                            setEffortLevel(level);
                            setSettings((current) => ({ ...current, effortLevel: level }));
                            void api?.saveSettings({ ...settings, effortLevel: level });
                          }}
                          title={`${level === 'none' ? 'No reasoning' : level === 'low' ? 'Minimal' : level === 'medium' ? 'Balanced' : level === 'high' ? 'Deep' : 'Maximum'} reasoning effort`}
                        >
                          {level === 'none' ? 'Fast' : level.charAt(0).toUpperCase() + level.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                  {connection && (
                    <div className="composer-toolbar-group">
                      <button
                        type="button"
                        className="composer-safety-badge"
                        onClick={async () => {
                          const levels: SafetyLevel[] = ['safe', 'standard', 'unrestricted'];
                          const current = safetyLevel;
                          const idx = levels.indexOf(current);
                          const next = levels[(idx + 1) % levels.length];
                          setSafetyLevelState(next);
                          if (api && connection) {
                            await api.setSafetyLevel(connection.id, next);
                            await refreshHistories();
                          }
                        }}
                        title={`Safety level: ${safetyLevel === 'safe' ? 'Read-only' : safetyLevel === 'standard' ? 'Standard (writes need approval)' : 'Unrestricted'}. Click to change.`}
                      >
                        <ShieldCheck size={13} />
                        <span>{safetyLevel === 'safe' ? 'Safe' : safetyLevel === 'unrestricted' ? 'Unrestricted' : 'Standard'}</span>
                      </button>
                    </div>
                  )}
                </div>
                <textarea ... />
                <button type="submit" className="composer-send" ...>
                  ...
                </button>
              </form>
            </div>
```

- [ ] **Step 4: Verify imports**

Inspect the top of `src/renderer/App.tsx`. `EffortLevel`, `SafetyLevel`, and `ShieldCheck` should already be imported. If `ShieldCheck` is imported, leave it. If `Zap` or other icons are unused, do not change unrelated imports.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "refactor(ui): move reasoning/safety controls into composer toolbar"
```

---

## Task 2: Add compact composer toolbar styles

**Files:**
- Modify: `src/renderer/styles.css:1456-1610`

- [ ] **Step 1: Read current composer styles**

Read lines 1456–1610 of `src/renderer/styles.css`. Note `.effort-bar`, `.effort-chip`, `.safety-badge`, `.composer`, `.composer textarea`, and `.composer-send`.

- [ ] **Step 2: Replace old effort-bar styles with toolbar styles**

Remove `.effort-bar`, `.effort-bar-label`, `.effort-chip`, and `.safety-badge` blocks (lines 1458–1531). Add new `.composer-toolbar` and child classes immediately after the `.composer-wrapper` rule.

New CSS:
```css
.composer-toolbar {
  align-items: center;
  display: flex;
  gap: var(--space-2);
  min-height: 28px;
  padding: 6px 10px 0;
}

.composer-toolbar-group {
  align-items: center;
  display: flex;
  gap: var(--space-1-5);
  min-width: 0;
}

.composer-toolbar-group:last-child {
  flex-shrink: 0;
  margin-left: auto;
}

.composer-toolbar-label {
  color: var(--color-text-tertiary);
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
}

.composer-toolbar-chips {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.composer-chip {
  align-items: center;
  background: var(--color-control);
  border: 1px solid var(--color-separator);
  border-radius: var(--radius-round);
  color: var(--color-text-secondary);
  cursor: pointer;
  display: inline-flex;
  font-size: 11px;
  font-weight: 500;
  height: 22px;
  justify-content: center;
  line-height: 14px;
  padding: 0 8px;
  transition:
    background-color var(--motion-fast) var(--ease-standard),
    border-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}

.composer-chip:hover:not(:disabled) {
  background: var(--color-control-hover);
  border-color: var(--color-separator-strong);
  color: var(--color-text-primary);
}

.composer-chip.active {
  background: var(--color-selected);
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.composer-safety-badge {
  align-items: center;
  background: transparent;
  border: 1px solid var(--color-separator);
  border-radius: var(--radius-round);
  color: var(--color-text-secondary);
  cursor: pointer;
  display: inline-flex;
  font-size: 11px;
  font-weight: 500;
  gap: 4px;
  height: 22px;
  justify-content: center;
  line-height: 14px;
  padding: 0 8px;
  transition:
    background-color var(--motion-fast) var(--ease-standard),
    border-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}

.composer-safety-badge:hover {
  background: var(--color-control-hover);
  border-color: var(--color-separator-strong);
  color: var(--color-text-primary);
}

.composer-safety-badge[data-level="safe"] {
  color: var(--color-success);
}

.composer-safety-badge[data-level="unrestricted"] {
  color: var(--color-warning);
}
```

- [ ] **Step 3: Adjust composer textarea padding**

The textarea previously had generous top padding to sit visually below the old external bar. Reduce top padding so text begins neatly below the toolbar.

Change `.composer textarea` top padding from `12px` to `8px`:
```css
.composer textarea {
  ...
  padding: 8px 48px 12px 14px;
  ...
}
```

- [ ] **Step 4: Keep the safety color indicator visible**

The safety button now uses `data-level` for color. Verify `.composer-safety-badge` default is `--color-text-secondary`; hover changes to `--color-text-primary`; success tint applies for `safe`; warning tint applies for `unrestricted`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/styles.css
git commit -m "style(ui): compact composer toolbar for reasoning/safety controls"
```

---

## Task 3: Wire data-level attribute on safety badge

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add `data-level` attribute**

On the new `.composer-safety-badge` button add:
```tsx
data-level={safetyLevel}
```

so the token-based `.composer-safety-badge[data-level="safe"]` and `[data-level="unrestricted"]` styles apply.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "refactor(ui): attach safety-level data attribute for token styling"
```

---

## Task 4: Add/update renderer tests

**Files:**
- Modify: `test/App.test.tsx`

- [ ] **Step 1: Re-use existing render helper**

The existing tests already render `<App api={api} />` and interact with the composer. Add tests after the existing ones, inside the `describe('App', () => { ... })` block.

- [ ] **Step 2: Write test: toolbar renders inside composer**

```tsx
  it('renders reasoning controls inside the composer', async () => {
    const api = makeApi();
    render(<App api={api} />);
    const textarea = await screen.findByPlaceholderText('Ask a follow-up');
    const composer = textarea.closest('.composer');
    expect(composer).toBeInTheDocument();
    const toolbar = composer?.querySelector('.composer-toolbar');
    expect(toolbar).toBeInTheDocument();
    expect(toolbar).toHaveTextContent('Reasoning');
    expect(toolbar).toHaveTextContent('Medium');
  });
```

- [ ] **Step 3: Write test: reasoning selection persists via saveSettings**

```tsx
  it('saves reasoning effort when a chip is selected', async () => {
    const api = makeApi();
    render(<App api={api} />);
    const textarea = await screen.findByPlaceholderText('Ask a follow-up');
    const composer = textarea.closest('.composer');
    const highChip = within(composer as HTMLElement).getByRole('radio', { name: 'High' });
    fireEvent.click(highChip);
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ effortLevel: 'high' }));
    });
  });
```

- [ ] **Step 4: Write test: safety-level cycles**

The mock `listConnections` returns an empty array, so no connection exists in this test. Either:
1. Mock `listConnections` to return one connection inline, or
2. Change the default test API to include a connection.

Prefer narrow local override:

```tsx
  it('cycles safety level when the safety badge is clicked', async () => {
    const api = makeApi();
    vi.mocked(api.listConnections).mockResolvedValueOnce([
      {
        id: 'local-sqlite',
        kind: 'sqlite',
        displayName: 'Local SQLite',
        safetyLevel: 'standard',
        path: ':memory:'
      }
    ]);
    vi.mocked(api.loadSettings).mockResolvedValueOnce({
      provider: 'openrouter',
      model: 'openai/gpt-4.1-mini',
      hasApiKey: false
    });
    render(<App api={api} />);
    const textarea = await screen.findByPlaceholderText('Ask a follow-up');
    const composer = textarea.closest('.composer');
    const safetyBadge = await within(composer as HTMLElement).findByRole('button', { name: /Standard/i });
    expect(safetyBadge).toBeInTheDocument();
    fireEvent.click(safetyBadge);
    await waitFor(() => {
      expect(api.setSafetyLevel).toHaveBeenCalledWith('local-sqlite', 'unrestricted');
    });
  });
```

If the connection schema does not match the actual `ConnectionConfig` type, adjust fields (e.g., `connectionString`, `database`, `createdAt`). Check `src/shared/types.ts` for the exact `ConnectionConfig` shape.

- [ ] **Step 5: Run new tests**

```bash
npm test -- test/App.test.tsx -t "reasoning controls|safety badge|safety level"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/App.test.tsx
git commit -m "test(ui): add composer toolbar tests for reasoning and safety controls"
```

---

## Task 5: Verification

- [ ] **Step 1: Run full renderer test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: zero TypeScript errors.

- [ ] **Step 3: Run build**

```bash
npm run build
```

Expected: build completes without errors.

- [ ] **Step 4: Manual UI smoke checks**

Run the app and verify:
- Reasoning chips appear inside the composer surface, not above it.
- Selected chip uses accent color.
- Safety badge sits on the right of the toolbar.
- With a connection active, clicking the safety badge cycles Safe → Unrestricted → Standard → Safe (matching existing behavior).
- Composer focus ring still wraps only the bordered surface.
- Textarea does not overlap the toolbar.

- [ ] **Step 5: Final commit if any fixes were needed**

If verification surfaced fixes, commit them. Otherwise, proceed.

---

## Spec Coverage Check

| Requirement in spec/design | Covered by |
|----------------------------|------------|
| Composer is a single bordered surface | Task 1 removes external bar, Task 2 keeps `.composer` border |
| No nested footer surface | Toolbar lives inside the same `.composer` form |
| Reasoning selector labels Fast/Low/Medium/High/Max | Task 1 reuses the same labels |
| Safety level visible alongside reasoning | Task 1 places badge in toolbar group |
| Connection context affects safety visibility | Task 1 keeps `{connection && (...)}` guard |
| Persist effort level on change | Task 1 preserves `api.saveSettings` call |
| Persist safety level via IPC | Task 1 preserves `api.setSafetyLevel` call |
| Visual tokens from design system | Task 2 uses `--color-control`, `--color-selected`, `--color-accent`, etc. |

## Placeholder Scan

No "TBD", "TODO", or vague steps remain. Exact file paths, line numbers, and code blocks are included. Commands include expected outcomes. Tests require passing `npm test`, `npm run typecheck`, and `npm run build`.
