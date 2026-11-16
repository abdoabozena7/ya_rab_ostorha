# Active project: standalone Three.js

- The canonical `main` project is the recovered browser-native Three.js game.
  Continue its `src/core/`, `src/render/`, `src/ui/` and `src/signal_processing/`
  modules. Do not migrate back to CARLA, GTA, BeamNG or another external simulator
  unless the user explicitly requests it.
- Read the current Three.js section of `README.md` first. The default server is
  `python -m backend.threejs.server` or `npm start`; the Windows launchers use it
  too. It needs standard Python, not `.venv-carla` or a simulator installation.
- Build checked-in browser assets with `npm run build:dashboard` after changing
  `src/`, frontend modules or styles. Run `npm test` and the focused standalone
  API suite: `python -S -m unittest discover -s tests -p 'test_threejs_*.py'`.
- CARLA/GTA source, local edits, old proof tasks and failed native acceptance
  records are preserved legacy work, not the current development objective.
  Do not launch those engines, spend their budgets or claim their gates passed.

# Repository workflow

- Keep project work on `main` in the existing primary checkout. The user requested
  one branch and one worktree. Create additional branches or worktrees only when
  the user explicitly requests them.
- Commit completed changes and their relevant documentation, then push `main`
  to `origin` when the task authorizes delivery. Preserve the existing history;
  do not force-push as part of routine work.
- Follow the active Three.js README for setup and project structure.
  `docs/CONSOLIDATED_DELIVERY_20261014.md` retains historical consolidation and
  recovery information; its native launch instructions are not the default.
- After editing frontend modules or theme styles, regenerate the checked-in
  JavaScript and CSS with `npm run build:dashboard`.
- Run checks appropriate to the changes. The offline suites are `npm test` and
  `.\.venv-carla\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'`.
- Keep downloaded multi-gigabyte model weights, virtual environments, raw runs,
  local settings and scratch output out of commits. Preserve research evidence
  and accurately distinguish software verification from native acceptance.
