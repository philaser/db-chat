# Composer Footer Dropdown Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inline reasoning chips and safety badge with two compact dropdowns anchored at the bottom of the composer surface, showing the current selection label with a chevron, matching the Codex-style footer layout.

**Architecture:** Move the composer controls from a top toolbar to a bottom toolbar inside the same `.composer` form. Each control becomes a `<select>`-styled custom dropdown with a current-value label and a chevron icon. Selecting an option updates the existing state and persists via the existing IPC calls. No new dependencies or state libraries are added.

**Tech Stack:** React (TypeScript), Electron, Vite, plain CSS, `lucide-react` (`ChevronDown`, `ShieldCheck`), native `<select>` element styled to match the design system.

---

## Files

- `src/renderer/App.tsx` — replace the top `.composer-toolbar` with a bottom `.composer-footer` containing two native-styled `<select>` controls.
- `src/renderer/styles.css` — replace the chip/badge styles with compact composer footer styles; add a hidden-native-select pattern with visible trigger.
- `test/App.test.tsx` — update existing tests and add assertions for the bottom dropdowns.

---

## Task 1: Refactor App.tsx composer footer

**Files:**
- Modify: `src/renderer/App.tsx:2713-2788`

- [ ] **Step 1: Inspect current composer block**

Read lines 2713–2788 of `src/renderer/App.tsx` to see the existing `.composer-toolbar`.

- [ ] **Step 2: Remove the composer-toolbar**

Remove the entire `.composer-toolbar` block and its children. Keep the form and textarea/send button as-is.

Before:
```tsx
            <div className="composer-wrapper">
              <form className="composer" onSubmit={(event) => void sendChat(event)}>
                <div className="composer-toolbar">...</div>
                <textarea ... />
                <button ... />
              </form>
            </div>
```

- [ ] **Step 3: Add bottom composer-footer**

Add a `.composer-footer` as the last child of the form (after the send button) containing two dropdowns:
1. Reasoning effort dropdown (always visible).
2. Safety level dropdown (only when `connection` exists).

Replace the form block with:

```tsx
            <div className="composer-wrapper">
              <form className="composer" onSubmit={(event) => void sendChat(event)}>
                <textarea
                  ref={composerRef}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      const form = event.currentTarget.closest('form');
                      if (form) form.requestSubmit();
                    }
                  }}
                  placeholder="Ask a follow-up"
                  aria-label="Message input"
                />
                <button
                  type="submit"
                  className="composer-send"
                  disabled={busy || !prompt.trim()}
                  aria-label="Send message"
                  title="Send message"
                >
                  {answerGenerating ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
                </button>
                <div className="composer-footer">
                  <div className="composer-footer-group">
                    <label htmlFor="reasoning-select" className="composer-footer-label">Reasoning</label>
                    <div className="composer-select">
                      <select
                        id="reasoning-select"
                        value={effortLevel}
                        onChange={(event) => {
                          const level = event.target.value as EffortLevel;
                          setEffortLevel(level);
                          setSettings((current) => ({ ...current, effortLevel: level }));
                          void api?.saveSettings({ ...settings, effortLevel: level });
                        }}
                        aria-label="Reasoning effort"
                      >
                        <option value="none">Fast</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="max">Max</option>
                      </select>
                      <ChevronDown size={12} aria-hidden="true" />
                    </div>
                  </div>
                  {connection && (
                    <div className="composer-footer-group">
                      <label htmlFor="safety-select" className="composer-footer-label">Safety</label>
                      <div className="composer-select composer-select--safety">
                        <ShieldCheck size={13} aria-hidden="true" />
                        <select
                          id="safety-select"
                          value={safetyLevel}
                          onChange={async (event) => {
                            const next = event.target.value as SafetyLevel;
                            setSafetyLevelState(next);
                            if (api && connection) {
                              await api.setSafetyLevel(connection.id, next);
                              await refreshHistories();
                            }
                          }}
                          aria-label="Safety level"
                        >
                          <option value="safe">Safe</option>
                          <option value="standard">Standard</option>
                          <option value="unrestricted">Unrestricted</option>
                        </select>
                        <ChevronDown size={12} aria-hidden="true" />
                      </div>
                    </div>
                  )}
                </div>
              </form>
            </div>
```

- [ ] **Step 4: Verify imports**

Confirm `ChevronDown`, `ShieldCheck`, `Send`, and `Loader2` are imported from `lucide-react`. They all already exist at the top of `App.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "refactor(ui): move reasoning/safety controls to composer footer dropdowns"
```

---

## Task 2: Replace composer toolbar styles with footer styles

**Files:**
- Modify: `src/renderer/styles.css:1493-1605`

- [ ] **Step 1: Read current composer toolbar styles**

Read lines 1493–1605 of `src/renderer/styles.css`. These will be replaced.

- [ ] **Step 2: Remove toolbar styles**

Delete `.composer-toolbar`, `.composer-toolbar-group`, `.composer-toolbar-label`, `.composer-toolbar-chips`, `.composer-chip`, and `.composer-safety-badge`.

- [ ] **Step 3: Add composer footer styles**

Insert after `.composer:focus-within`:

```css
.composer-footer {
  align-items: center;
  display: flex;
  gap: var(--space-4);
  min-height: 28px;
  padding: 0 10px 6px;
}

.composer-footer-group {
  align-items: center;
  display: flex;
  gap: var(--space-1-5);
}

.composer-footer-group:last-child {
  margin-left: auto;
}

.composer-footer-label {
  color: var(--color-text-tertiary);
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
}

.composer-select {
  align-items: center;
  background: var(--color-control);
  border: 1px solid var(--color-separator);
  border-radius: var(--radius-control);
  color: var(--color-text-secondary);
  cursor: pointer;
  display: inline-flex;
  font-size: 11px;
  font-weight: 500;
  gap: 4px;
  height: 22px;
  line-height: 14px;
  padding: 0 6px 0 8px;
  position: relative;
  transition:
    background-color var(--motion-fast) var(--ease-standard),
    border-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}

.composer-select:hover {
  background: var(--color-control-hover);
  border-color: var(--color-separator-strong);
  color: var(--color-text-primary);
}

.composer-select select {
  appearance: none;
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-family: inherit;
  font-size: inherit;
  font-weight: inherit;
  line-height: inherit;
  margin: 0;
  outline: none;
  padding: 0 14px 0 0;
}

.composer-select select:focus-visible {
  outline: none;
}

.composer-select:focus-within {
  border-color: var(--color-focus);
  box-shadow: 0 0 0 2px var(--color-focus-ring);
}

.composer-select svg {
  color: inherit;
  flex: 0 0 auto;
  pointer-events: none;
  position: absolute;
  right: 4px;
}

.composer-select--safety[data-level="safe"] {
  color: var(--color-success);
}

.composer-select--safety[data-level="unrestricted"] {
  color: var(--color-warning);
}
```

- [ ] **Step 4: Restore textarea top padding**

The toolbar above the textarea no longer exists. Revert top padding toward the original value so the field still looks centered. Keep some small top padding to avoid the text sitting flush against the border.

Change `.composer textarea` to:
```css
.composer textarea {
  ...
  padding: 12px 48px 8px 14px;
  ...
}
```

The bottom padding is reduced because the footer now occupies that space.

- [ ] **Step 5: Wire data-level attribute on safety select wrapper**

Ensure the safety `.composer-select` wrapper has `data-level={safetyLevel}` so the color tokens apply.

In `src/renderer/App.tsx`:
```tsx
<div className="composer-select composer-select--safety" data-level={safetyLevel}>
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer/styles.css src/renderer/App.tsx
git commit -m "style(ui): composer footer dropdown styles with native selects"
```

---

## Task 3: Update renderer tests

**Files:**
- Modify: `test/App.test.tsx`

- [ ] **Step 1: Read existing App tests**

Read the bottom of `test/App.test.tsx` and note the existing test helper patterns. No new imports are needed — `screen`, `fireEvent`, and `waitFor` already exist.

- [ ] **Step 2: Replace the existing reasoning toolbar test (if committed) or add new footer tests**

If the previous plan introduced reasoning tests, replace them. Otherwise add these new tests inside `describe('App', () => { ... })` before the closing brace.

```tsx
  it('renders reasoning and safety dropdowns in the composer footer', async () => {
    const api = makeApi();
    vi.mocked(api.listConnections).mockResolvedValueOnce([
      {
        id: 'local-sqlite',
        kind: 'sqlite',
        label: 'Local SQLite',
        safetyLevel: 'standard',
        databasePath: ':memory:',
        createdAt: new Date().toISOString()
      }
    ]);
    render(<App api={api} />);

    const textarea = await screen.findByPlaceholderText('Ask a follow-up');
    const composer = textarea.closest('.composer');
    expect(composer).toBeInTheDocument();

    const footer = composer?.querySelector('.composer-footer');
    expect(footer).toBeInTheDocument();

    const reasoningSelect = await within(composer as HTMLElement).findByLabelText('Reasoning effort');
    expect(reasoningSelect).toHaveValue('medium');

    const safetySelect = await within(composer as HTMLElement).findByLabelText('Safety level');
    expect(safetySelect).toHaveValue('standard');
  });

  it('saves reasoning effort when the dropdown changes', async () => {
    const api = makeApi();
    render(<App api={api} />);

    const reasoningSelect = await screen.findByLabelText('Reasoning effort');
    fireEvent.change(reasoningSelect, { target: { value: 'high' } });

    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ effortLevel: 'high' }));
    });
  });

  it('updates safety level when the dropdown changes', async () => {
    const api = makeApi();
    vi.mocked(api.listConnections).mockResolvedValueOnce([
      {
        id: 'local-sqlite',
        kind: 'sqlite',
        label: 'Local SQLite',
        safetyLevel: 'standard',
        databasePath: ':memory:',
        createdAt: new Date().toISOString()
      }
    ]);
    render(<App api={api} />);

    const safetySelect = await screen.findByLabelText('Safety level');
    fireEvent.change(safetySelect, { target: { value: 'unrestricted' } });

    await waitFor(() => {
      expect(api.setSafetyLevel).toHaveBeenCalledWith('local-sqlite', 'unrestricted');
    });
  });
```

If `ConnectionConfig` has additional required fields (e.g., `connectionString`), add them.

- [ ] **Step 3: Run new tests**

```bash
npm test -- test/App.test.tsx -t "dropdowns|safety level|reasoning effort"
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/App.test.tsx
git commit -m "test(ui): add composer footer reasoning/safety dropdown tests"
```

---

## Task 4: Verification

- [ ] **Step 1: Run full test suite**

```bash
npm test -- --run
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Run build**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 4: Manual smoke checks**

Run the app and verify:
- Dropdowns appear at the bottom of the composer surface, not above the textarea.
- Reasoning dropdown shows "Medium" by default with a chevron.
- Safety dropdown shows "Standard" by default with a chevron and shield icon.
- Changing a selection updates state and persists via the correct IPC call.
- The dropdowns do not overlap the textarea or send button.
- Focus ring wraps the visible trigger when the select has focus.

- [ ] **Step 5: Final commit if needed**

```bash
git add -A
git commit -m "fix: corrections after composer footer dropdown verification" || echo "No changes to commit"
```

---

## Spec Coverage Check

| Requirement | Covered by |
|-------------|------------|
| Reasoning control is a dropdown | Task 1: native `<select>` for reasoning |
| Safety control is a dropdown | Task 1: native `<select>` for safety |
| Both controls sit at the bottom of the composer | Task 1: `.composer-footer` inside `.composer`; Task 2: footer styles |
| Current value + chevron trigger | Task 1: custom `.composer-select` wrapper with `ChevronDown` |
| Persistent on change | Task 1: onChange handlers call saveSettings/setSafetyLevel |
| Compact styling matching design system | Task 2: semantic tokens, 22px height, 8px radius, 11/14 typography |

## Placeholder Scan

No placeholders remain. Every step includes exact file paths, line-number ranges, complete code snippets, and expected verification output.
