# DB Chat Scape Redesign

## Status

This directory is the canonical design and implementation specification for the DB Chat visual reboot.

The approved direction is:

- Use the second generated data-panel concept as the canonical screen and interaction model.
- Add the `Copy` and `Export CSV` footer actions from the third generated concept.
- Preserve DB Chat's product capabilities and current Electron/React/TypeScript stack.
- Discard the existing DB Chat visual language completely.
- Do not blend this system with the previous Codex-inspired UI, current card treatments, icon rail, message bubbles, inspector chrome, theme styling, or panel geometry.

The generated images were used to derive this specification, but they are not required inputs for implementation. A text-only coding agent must be able to implement the design from these documents alone.

## Product Posture

DB Chat is a macOS-first operational developer tool:

- calm enough for long analytical sessions;
- dense enough to scan data quickly;
- explicit about database, query, and execution state;
- visually subordinate to the user's data;
- native-feeling without requiring a native Swift rewrite.

The design language is based on the visual discipline of the supplied Scape reference and Apple's macOS conventions: system typography, quiet materials, broad flat hierarchy, restrained color, thin separators, compact controls, and contextual utility panes.

## Canonical Reading Order

A coding agent must read these files completely and in this order before editing:

1. [REFERENCE-ANALYSIS.md](./REFERENCE-ANALYSIS.md)
2. [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md)
3. [LAYOUT-AND-SCREEN-SPEC.md](./LAYOUT-AND-SCREEN-SPEC.md)
4. [COMPONENT-SPEC.md](./COMPONENT-SPEC.md)
5. [OPENCODE-HANDOFF.md](./OPENCODE-HANDOFF.md)

When two rules appear to conflict:

1. `LAYOUT-AND-SCREEN-SPEC.md` controls screen geometry and behavior.
2. `COMPONENT-SPEC.md` controls component anatomy and state.
3. `DESIGN-SYSTEM.md` controls visual tokens.
4. Existing implementation details yield to this pack unless they are required for product behavior, data safety, accessibility, or tests.

## Non-Negotiable Decisions

- The visual reset is not a reskin. Existing CSS values and component geometry are not reference material.
- Chat is an editorial transcript, not a collection of bubbles or cards.
- The data inspector is contextual. It is closed when no useful data context exists.
- At wide widths, opening the inspector creates a third column; it does not float as a card.
- At constrained widths, the same inspector becomes a trailing overlay.
- Internal pane separation uses `1px` hairlines. No pane receives a shadow at wide widths.
- The main content canvas and inspector are opaque. Only the leading sidebar uses a translucent material.
- Color communicates selection, source identity, focus, status, or action. Color is not decoration.
- `Copy` and `Export CSV` live in the inspector footer and remain visible while the inspector body scrolls.
- Do not add Tailwind, a component framework, a CSS-in-JS library, a new icon library, or a new state-management library.
- Preserve React 19, TypeScript, Vite, Electron, plain CSS, `lucide-react`, `simple-icons`, Vitest, and Testing Library.
- Use the system font stack. Do not bundle or download SF Pro.

## Definition Of Done

The redesign is complete only when:

- the shell, sidebar, transcript, composer, and inspector conform to the documented geometry;
- all tokens come from the design-system roles;
- all required states are implemented;
- keyboard navigation and focus visibility are verified;
- result copying and CSV export are implemented and tested;
- inspector collapse, resize, and constrained-width behavior are tested;
- light mode matches the canonical system;
- dark mode maps the same semantic roles without changing geometry;
- existing database, chat, query, schema, SAFE-mode, settings, and persistence behaviors remain operational;
- `npm test`, `npm run typecheck`, and `npm run build` pass;
- a human or vision-capable reviewer performs the final visual comparison.
