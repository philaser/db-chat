# OpenCode Implementation Handoff

## Intended Agent

This handoff is written for a text-only OpenCode agent. Do not assume the agent can see, compare, or reason from screenshots.

The Markdown documents in this directory are the complete source of truth. Generated images are contextual history only.

## Required Startup Instruction

Give the OpenCode agent this exact startup message:

> Work in this DB Chat repository. Before changing anything, pull the latest branch changes as required by AGENTS.md, then read every file under `docs/scape-redesign/` in the reading order defined by `docs/scape-redesign/README.md`. Treat those documents as authoritative. The redesign is a complete visual replacement, not a reskin of the existing Codex-inspired UI. Preserve product behavior and the current stack. Implement in the dependency order in `OPENCODE-HANDOFF.md`, keep tests updated, and do not claim visual parity because you are a text-only model. Stop and report any conflict that would require violating the design documents, data safety, accessibility, or existing behavior.

## Stack Invariants

Keep:

- Electron `39`;
- React `19`;
- TypeScript `5.9`;
- Vite `7`;
- plain CSS;
- `lucide-react`;
- `simple-icons`;
- `react-markdown`;
- Vitest and Testing Library;
- current IPC/preload isolation model;
- current database connectors and SAFE-mode behavior.

Do not add:

- Tailwind;
- Sass;
- CSS-in-JS;
- styled-components;
- a component framework;
- a design-system package;
- Redux/Zustand/MobX;
- a second icon library;
- a CSV package for simple CSV serialization;
- a new router unless a separate requirement demands one.

## Current Repository Map

Primary implementation locations:

- `src/main/main.ts`: Electron window construction.
- `src/main/ipc.ts`: main-process IPC controller.
- `src/preload/preload.cts`: secure renderer API exposure.
- `src/shared/types.ts`: shared renderer/main contracts.
- `src/renderer/App.tsx`: current monolithic application UI and state.
- `src/renderer/styles.css`: current global tokens and component styling.
- `test/App.test.tsx`: UI behavior and inspector tests.
- connector and IPC tests: must remain green.

The current layout is:

- `74px` icon rail;
- main chat pane;
- `300–520px` inspector;
- card/bubble-oriented message, activity, schema, and settings styles.

The target layout is:

- `240px` translucent full sidebar;
- flat editorial conversation;
- contextual `384px` inspector;
- flat table/query/schema content;
- fixed inspector footer.

Do not preserve the current icon-rail geometry, bubbles, card shells, large activity panel, card-based schema browser, composer footer strip, or inspector metric cards.

## Existing Behavior That Must Survive

- new chat;
- recent chats and persistence;
- saved connections;
- SQLite, Elasticsearch, MySQL, PostgreSQL, and MongoDB paths currently present in code;
- schema inspection;
- query generation and editing;
- SAFE/read-only validation;
- manual validated query path where supported;
- streamed query activity;
- results rendering;
- provider/model/API-key settings;
- application logs;
- light/dark and existing theme persistence unless separately removed;
- inspector collapse and keyboard resizing;
- keyboard and accessibility behaviors already covered by tests.

Visual replacement does not authorize backend or safety regressions.

## Implementation Dependency Order

Do not attempt a one-pass rewrite.

### Phase 0: Inventory And Baseline

1. Pull latest changes.
2. Confirm worktree status.
3. Run:

   ```sh
   npm test
   npm run typecheck
   npm run build
   ```

4. Record existing failures before editing.
5. Read the renderer tests that constrain inspector, connection, settings, recent chat, and activity behavior.

### Phase 1: Semantic Tokens

1. Replace visual-role tokens in `styles.css` with those in `DESIGN-SYSTEM.md`.
2. Keep legacy theme IDs working through semantic mappings.
3. Add spacing, radius, motion, z-index, typography, and geometry variables.
4. Do not restyle components through scattered literals.
5. Add a short comment above the token block pointing to this design pack.

Exit condition:

- all new visual values can be traced to named tokens;
- existing behavior still compiles;
- tests remain runnable.

### Phase 2: Native Window Shell

1. Update `BrowserWindow` options for macOS hidden-inset titlebar behavior.
2. Keep platform guards for Windows/Linux.
3. Set background colors to prevent resize flashes.
4. Add drag/no-drag regions correctly.
5. Do not fake traffic lights.

Exit condition:

- window opens on all supported platforms;
- native controls remain operable;
- toolbar is `52px`;
- no renderer control sits under traffic lights.

### Phase 3: Shell And Sidebar

1. Replace the icon rail with the documented full sidebar.
2. Reuse current navigation handlers.
3. Render grouped Connections and Chats as flat rows.
4. Preserve recent-chat, connection, settings, and new-chat behavior.
5. Implement source dots through semantic source roles.
6. Add constrained-width collapse behavior.

Exit condition:

- all destinations remain keyboard reachable;
- selected/current state is correct;
- sidebar geometry matches the acceptance table;
- no old rail classes remain in active markup.

### Phase 4: Toolbar And Conversation

1. Move global search/navigation/connection context into the integrated toolbar.
2. Convert transcript messages to actor/content/time rows.
3. Normalize Markdown so it cannot reintroduce card/bubble geometry.
4. Replace the bordered activity card with inline activity.
5. Add `View N rows` activation for result-bearing answers.
6. Rebuild the composer as one `62px` surface.

Exit condition:

- chat behavior and streaming remain intact;
- no bubbles or message cards remain;
- transcript and composer use documented geometry;
- send shortcuts and disabled/busy states work.

### Phase 5: Contextual Inspector

1. Preserve Results/Query/Schema behavior.
2. Make the inspector closed when no context exists.
3. Open Results after successful query results.
4. Implement wide third-column and constrained overlay modes.
5. Preserve resize and keyboard resize within `320–480px`.
6. Replace metric cards and segmented pills with flat metadata and underlined tabs.
7. Convert schema cards into disclosures.

Exit condition:

- each tab retains current product behavior;
- collapse/open returns focus correctly;
- responsive behavior follows the screen spec;
- inspector body scroll does not move header or footer.

### Phase 6: Copy And Export CSV

#### Copy

1. Add a pure serialization helper that turns `QueryResult` into TSV.
2. Preserve column order.
3. Test quotes, commas, tabs, newlines, nulls, numbers, booleans, and empty results.
4. Use `navigator.clipboard.writeText`.
5. Implement `Copied` feedback and live announcement.

#### Export CSV

1. Add a pure CSV serialization helper with RFC-style quoting rules described in the screen spec.
2. Add a secure preload/main-process method for saving the CSV through Electron's native save dialog.
3. Use `dialog.showSaveDialog` in the main process.
4. Write the selected file in the main process with Node filesystem APIs.
5. Do not expose arbitrary filesystem write APIs to the renderer.
6. Update:
   - `src/shared/types.ts`;
   - `src/preload/preload.cts`;
   - main-process IPC registration/controller;
   - renderer call site;
   - unit tests.
7. Sanitize filename and handle cancellation.

Security boundary:

- renderer provides suggested filename and serialized CSV content;
- main process owns the user-approved path and write;
- no arbitrary path is accepted from untrusted renderer input.

Exit condition:

- footer actions remain fixed;
- copy/export use complete results;
- cancel is silent;
- success/error is announced;
- no new dependency is added.

### Phase 7: Secondary Views

Restyle without changing their behavior:

- Connections;
- History;
- Settings;
- Logs;
- connection forms;
- empty states;
- validation and errors.

Use flat grouped rows and the same token system. Do not leave old cards visible in secondary views.

### Phase 8: State And Accessibility Pass

Explicitly test:

- default;
- hover;
- focus-visible;
- pressed;
- selected;
- disabled;
- busy;
- empty;
- success;
- warning;
- error;
- reduced motion;
- dark mode;
- high data width and horizontal table scroll;
- long connection and chat names;
- no result;
- zero-row result;
- large result;
- query validation failure;
- export cancel and failure.

### Phase 9: Deterministic Geometry QA

Because the implementing agent is text-only:

1. Add or use development-only DOM/computed-style checks for documented dimensions.
2. Verify at `1440×920`, `1180×800`, and `980×680`.
3. Check:
   - no overlap;
   - no unexpected wrapping;
   - pane widths;
   - toolbar and footer heights;
   - sticky header/footer;
   - scroll containment;
   - focus order;
   - truncation.
4. Capture screenshots for a human or vision-capable reviewer.
5. Do not self-certify visual parity.

### Phase 10: Final Verification

Run:

```sh
npm test
npm run typecheck
npm run build
```

Document:

- files changed;
- behaviors preserved;
- tests added;
- screenshots produced;
- known visual differences;
- items requiring human review.

## Required Tests

Keep existing tests and add coverage for:

- sidebar destinations and current state;
- inspector closed on empty chat;
- inspector opens Results after returned data;
- `View N rows` opens Results;
- close returns focus;
- tabs use proper semantics and keyboard navigation;
- inspector keyboard resize clamps to `320–480px`;
- overlay breakpoint behavior;
- transcript row structure;
- composer Enter and Shift+Enter;
- Copy TSV serialization and clipboard call;
- Copied feedback reset;
- CSV serialization rules;
- export IPC success, cancellation, and failure;
- footer disabled without results;
- zero rows;
- large/long values;
- reduced motion rule presence where practical;
- light/dark semantic token application.

Do not delete an existing test merely because the markup changes. Rewrite queries toward stable roles and accessible names.

## CSS Enforcement Rules

- No raw hex/rgb color outside the semantic token declarations.
- No component-specific shadow outside allowed overlay/popover/tooltip levels.
- No component border radius outside radius tokens.
- No pane border wider than `1px`.
- No arbitrary `z-index`.
- No viewport-scaled font size.
- No nested card surfaces.
- No gradients inside application surfaces.
- No `!important` except the reduced-motion safety block.
- Hover styles must be guarded appropriately for hover-capable devices where relevant.
- Every transition uses documented duration and easing tokens.

## Behavior Enforcement Rules

- Preserve SAFE-mode validation.
- Preserve preload isolation and no renderer Node integration.
- Do not expose filesystem paths broadly.
- Do not truncate data during Copy or Export.
- UI tables may virtualize or display a bounded subset only if the full current result remains available for Copy/Export.
- Do not silently change current result limits in the backend.
- Do not auto-open the inspector for purely conversational answers.
- Do not keep an empty inspector open on a fresh chat.

## Text-Only Agent Rules

- Use the numeric specification, not aesthetic guesses.
- When a value is not specified, derive it from the nearest token and document the decision.
- Do not recreate the generated image from memory.
- Do not use the superseded `docs/codex-style-guide.md`.
- Do not say "looks right" or "matches the mock."
- Say which measurable constraints were verified.
- Leave final visual approval to a human or vision-capable reviewer.

## Stop Conditions

Stop and ask the user if:

- preserving a documented behavior requires changing a safety boundary;
- the chosen Electron window treatment breaks a supported platform;
- a new dependency appears necessary;
- a product decision is needed about removing legacy theme modes;
- CSV export needs a destination or privacy policy not covered here;
- current upstream changes overlap the same renderer architecture and cannot be reconciled safely.

## Completion Checklist

- [ ] Latest branch pulled before work.
- [ ] Baseline tests recorded.
- [ ] Stack unchanged.
- [ ] Design tokens centralized.
- [ ] Native window shell implemented.
- [ ] Full sidebar implemented.
- [ ] Editorial transcript implemented.
- [ ] Compact composer implemented.
- [ ] Contextual inspector implemented.
- [ ] Results/Query/Schema preserved.
- [ ] Fixed Copy/Export footer implemented.
- [ ] Copy complete result tested.
- [ ] Export complete result tested.
- [ ] Secondary views restyled.
- [ ] All interaction states implemented.
- [ ] Accessibility semantics verified.
- [ ] Wide/medium/minimum geometry verified.
- [ ] Light and dark semantic mappings verified.
- [ ] Existing tests retained or intentionally updated.
- [ ] New tests added.
- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] Screenshots captured for visual review.
- [ ] No claim of visual parity without human/vision review.

