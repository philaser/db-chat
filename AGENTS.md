# DB Chat Agent Instructions

- Before beginning work on any git branch, pull the latest changes to avoid merge conflicts.
- Every pull request into `main` must have exactly one semantic version label: `major`, `minor`, or `patch`.
- Before any UI, renderer, window-chrome, layout, styling, or interaction work,
  read `DESIGN.md` and every canonical document it links in the stated order.
  The Scape/macOS redesign pack is authoritative; do not use
  `docs/codex-style-guide.md` as an implementation source.
- UI changes must look native to the existing design system, not pasted on.
  Reuse existing control patterns (`.inspector-back`, ghost text actions, etc.).
  Avoid arbitrary borders, extra backgrounds, and heavy pills inside already-bordered
  surfaces; prefer subtle hover/focus states from `DESIGN-SYSTEM.md`.
- After any visual change, run `npm test`, `npm run typecheck`, and `npm run build`;
  do not claim completion until all three pass.
- Screenshots or DOM/computed-style verification are required for visual claims;
  do not self-certify visual parity without evidence.
