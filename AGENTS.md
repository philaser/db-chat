# DB Chat Agent Instructions

- Before beginning work on any git branch, check upstream and pull when new changes are available.
- Every pull request into `main` must have exactly one semantic version label: `major`, `minor`, or `patch`.
- Before any UI, renderer, window-chrome, layout, styling, or interaction work,
  read `DESIGN.md` and every canonical document it links in the stated order.
  The hosted web documents are authoritative for the single product interface.
- UI changes must look native to the existing design system, not pasted on.
  Reuse existing control patterns (`.inspector-back`, ghost text actions, etc.).
  Avoid arbitrary borders, extra backgrounds, and heavy pills inside already-bordered
  surfaces; use the semantic roles and states in `docs/WEB-STYLE-GUIDE.md`.
- After any visual change, run `npm test`, `npm run typecheck`, and `npm run build`;
  do not claim completion until all three pass.
- Screenshots or DOM/computed-style verification are required for visual claims;
  do not self-certify visual parity without evidence.
