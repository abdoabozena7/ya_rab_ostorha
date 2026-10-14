# Repository workflow

- Keep project work on `main` in the existing primary checkout. The user requested
  one branch and one worktree. Create additional branches or worktrees only when
  the user explicitly requests them.
- Commit completed changes and their relevant documentation, then push `main`
  to `origin` when the task authorizes delivery. Preserve the existing history;
  do not force-push as part of routine work.
- Follow `docs/CONSOLIDATED_DELIVERY_20261014.md` and the README for the project
  structure, setup, evidence index and recovery archive.
- After editing frontend modules or theme styles, regenerate the checked-in
  JavaScript and CSS with `npm run build:dashboard`.
- Run checks appropriate to the changes. The offline suites are `npm test` and
  `.\.venv-carla\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'`.
- Keep downloaded multi-gigabyte model weights, virtual environments, raw runs,
  local settings and scratch output out of commits. Preserve research evidence
  and accurately distinguish software verification from native acceptance.
