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

## Keep new gameplay in the original City

- Ya Rab Ostorha is a self-driving car game first. New player-facing gameplay,
  including pursuit rules, vehicles, effects and controls, must extend the live
  default Three.js City (`metro`), using its current roads, buildings, SUV,
  traffic and pedestrians. A reference game is inspiration for mechanics,
  not permission to move gameplay to another map, scene or simulation loop.
- For example, implement an arcade pursuit as a City event: add its patrols,
  pickups and effects to the existing `World` and `WorldView`, and optionally
  reframe the camera. Starting, ending or retrying it must not replace the City
  or its ambient population. Do not build a second playable environment unless
  the user explicitly requests one. Existing Lab and legacy replay fixtures
  are for testing and reproduction, not alternative venues for shipping gameplay.

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

<!-- prove-it:begin -->
## Runtime evidence before completion

- For implementation, bug fixes and agent-workflow changes, load the local
  [prove-it skill](.agents/skills/prove-it/SKILL.md) before editing. Create or
  resume a dependency-aware task in `.runtime-proof/`, define observable
  acceptance and negative controls, and seal the contract before implementation.
- Use the actual Copilot SDK session ID with `--session-id` when sharing this checkout.
  Do not overwrite another client's active task. Implemented is not verified:
  execute the relevant real entry point, inspect evidence, and verify each TODO.
- Run `.agents/skills/prove-it/scripts/proof.py verify --task <task-directory>
  --write-report` with the same Python interpreter before claiming completion.
  Preserve failed evidence and record genuine blockers; never weaken a contract
  or deactivate a task to make its gate pass.
- Use the [native Copilot harness](docs/COPILOT_NATIVE_HARNESS.md) and its explicit
  verification gate. Do not assume CLI-specific Stop hooks govern this desktop
  host. Report only actually observed callbacks and verified behavior; keep
  software checks distinct from native simulation acceptance.
<!-- prove-it:end -->

## Native model ownership

- The model selected in Copilot owns primary reasoning and inference. Enhance
  its tools and workflow; do not invoke Codex CLI or another model client as a
  replacement or hidden worker. Do not change model, provider, authentication,
  account or permission settings to implement the harness.
- Reuse the single installed Prove It skill through `copilot_proof` or the native
  terminal. Helpers must be deterministic. Use `copilot_harness_status` for
  read-only session/model observations, not for changing the model picker.
- Keep native terminal, browser, screenshot and authorized simulation tools.
  Use native Copilot sub-agents only when available, appropriate and permitted
  by the task; never fabricate delegation or add another inference layer.
- Plan first, seal the evidence contract, execute real checks, inspect artifacts
  and verify the current-source gate. Preserve failed attempts and record
  blockers. Native simulation permissions and budgets remain unchanged.
- Distinguish observed model routing from billing. Do not claim exact credits,
  zero total cost or universal desktop Stop enforcement without direct evidence.
