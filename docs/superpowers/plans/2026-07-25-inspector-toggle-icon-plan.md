# Inspector Toggle Icon Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `PanelRightOpen`/`PanelRightClose` icons on the conversation-pane inspector toggle with `ChevronRight`/`ChevronLeft`.

**Architecture:** A single icon swap in the renderer's icon import and the two rendered states. No component restructure, no state changes, no CSS changes. The inspector's internal close button stays as `PanelRightClose`.

**Tech Stack:** React 19, TypeScript 5.9, Lucide icons, Vitest, plain CSS.

---

## Task 1: Swap the import

**Files:**
- Modify: `src/renderer/App.tsx:1-30`

- [ ] **Step 1: Remove `PanelRightOpen` and `PanelRightClose` from the Lucide import and add `ChevronLeft` and `ChevronRight`.**

```tsx
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Database,
  Download,
  Loader2,
  MessageSquareText,
  Moon,
  PanelRightClose,
  Pencil,
  Play,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sun,
  Table2,
  Trash2,
  X,
  XCircle
} from 'lucide-react';
```

Note: `PanelRightClose` is intentionally kept for the inspector panel's own close button at line ~1787.

- [ ] **Step 2: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "chore(inspector): change toggle icon import to chevrons"
```

---

## Task 2: Replace the rendered icons

**Files:**
- Modify: `src/renderer/App.tsx:2485-2491`

- [ ] **Step 1: Update the inspector toggle button to use the chevron icons.**

```tsx
<button
  aria-label={inspectorOpen ? 'Hide inspector panel' : 'Show inspector panel'}
  className="inspector-toggle"
  onClick={() => { if (inspectorOpen) closeInspector(); else { setActiveInspector('schema'); setInspectorOpen(true); } }}
  title={inspectorOpen ? 'Hide inspector panel' : 'Show inspector panel'}
  type="button"
>
  {inspectorOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
</button>
```

- [ ] **Step 2: Verify no other `PanelRightOpen` usages remain that should change.**

Run:
```bash
rg 'PanelRightOpen' src/renderer/App.tsx
```

Expected: no results; `PanelRightClose` should still be present for the inspector close button.

- [ ] **Step 3: Run the renderer test suite.**

Run:
```bash
npm test
```

Expected: all tests pass. (Tests do not currently assert these specific icons.)

- [ ] **Step 4: Run TypeScript and production build.**

Run:
```bash
npm run typecheck
npm run build
```

Expected: both pass cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "chore(inspector): use ChevronLeft/ChevronRight for inspector toggle"
```

---

## Task 3: Update the spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-07-25-inspector-toggle-icon-design.md`

- [ ] **Step 1: Mark all acceptance criteria as complete.**

```markdown
## Acceptance Criteria

- [x] Inspector toggle shows `ChevronRight` when the inspector is closed.
- [x] Inspector toggle shows `ChevronLeft` when the inspector is open.
- [x] Existing tests pass after any icon-specific assertions are updated.
- [x] TypeScript and production build remain clean.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-07-25-inspector-toggle-icon-design.md
git commit -m "docs(inspector): mark toggle icon spec acceptance criteria complete"
```

---

## Self-Review

- **Spec coverage:** every requirement has a task — import swap, render swap, test/build verification.
- **Placeholder scan:** no placeholders; code and commands are concrete.
- **Type consistency:** Lucide imports `ChevronLeft` and `ChevronRight` are standard icons with the same `size` prop used elsewhere.
