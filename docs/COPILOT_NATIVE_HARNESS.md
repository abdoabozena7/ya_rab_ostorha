# Native Copilot harness

The selected GitHub Copilot model owns reasoning and inference. Harness helpers
are deterministic tools, not another agent or model provider. The model picker,
Copilot account, permissions and native tools remain owned by the installed host.

## Audit and correction

The earlier implementation solved the wrong problem: it delegated to a separate
Codex CLI agent. Its successful historical test does not certify this architecture.
Exact previous sources and historical evidence are retained locally under
`.runtime-proof/`; they are not active extensions or instructions.

| Previous component | Decision |
| --- | --- |
| `codex-bridge` extension, `codex exec`, login checks and Codex response parser | Remove from active execution and tool registration |
| Project `.codex/config.toml` | Remove the Codex-only hook wiring; do not imply it governs the Copilot desktop host |
| Bounded process runner | Retain as a neutral deterministic utility with timeout, cancellation and owned-process cleanup tests |
| Codex-specific tests | Replace their provider/config assertions; preserve reusable Prove It gate and process regression coverage |
| Generated-code verifier | Retain the independent pure-function oracle as a deterministic fixture verifier, without Codex run/auth dependencies |
| Installed `.agents/skills/prove-it` and `skills-lock.json` | Reuse unchanged; do not install or copy a second skill |
| `.runtime-proof/` ignore rule | Retain for private plans, traces, receipts and failed attempts |
| Repository workflow, application, browser and simulator tooling | Preserve; no simulator authorization or budget change |

## Native workflow

1. Load the installed [Prove It skill](../.agents/skills/prove-it/SKILL.md).
2. Record requirements and a dependency-aware plan before implementation. Use the
   host's TODO tools and the collector's durable contract/step ledger.
3. Keep the primary model selected in Copilot. Use native Copilot orchestration
   only when available and appropriate; the harness does not create agent sessions.
4. Use existing terminal, browser and screenshot tools. Use simulation tools only
   with the project's existing authorization, ownership and budget gates.
5. Execute meaningful checks through the existing collector, inspect real
   evidence, diagnose failures, and retry justified fixes without hiding failures.
6. Require current-source evidence and an explicit passing final acceptance gate.
   `IMPLEMENTED`, a stopped turn, or an agent's success claim is not `VERIFIED`.

The collector is
[proof.py](../.agents/skills/prove-it/scripts/proof.py); its existing planner,
hashing, receipts, reviews and recovery behavior are not reimplemented.
The [collector guide](../.agents/skills/prove-it/references/harness-guide.md)
documents the durable task lifecycle.

## Supported native tools

The workspace [SDK extension](../.github/extensions/prove-it-harness/extension.mjs)
joins the **existing** session. The host resolves the SDK automatically; there
is no additional SDK installation, agent session, provider configuration or login.

- `copilot_harness_status` reads `session.rpc.model.getCurrent()` and reports
  primary `assistant.usage` observations. Its metadata-only trace contains model
  IDs, tool names, session identity and deterministic helper process information,
  not prompts, API keys, token costs or account credentials.
- `copilot_proof` invokes the installed Python collector. Actions are `doctor`,
  `init`, `seal`, `todo`, `step`, `run`, `review`, `verify`, `block` and `resume`.
  Parameters are structured, paths stay within this checkout, and `init` records
  the real SDK session ID automatically. It does not expose a model/provider
  parameter or interpret a prompt with another model.

For example, initialize with `action: "init"`, `taskId`, `goal` and `kind`; edit
the draft contract using native file tools, then call `seal`. Use `step` with
`stepId`, `state` and `note`; execute a declared `checkId` with `run`; use `review`
with a project-relative `reviewFile`; finish with `verify`. A nonzero collector
exit, failed check, missing evidence or stale source is a tool failure, not a
success-shaped fallback. The SDK helper serializes operations in its provider.

The default `project` is this checkout. A checkout-relative project directory can
isolate a representative fixture without another Git branch/worktree. The
Windows adapter uses `.venv-carla` Python when present, otherwise `python.exe`;
this is an interpreter choice, **not** a CARLA launch. The collector uses only
the standard library. The operation timeout is a wall-clock safety bound, never
a grant of native execution budget.
The doctor's executable inventory uses path discovery only. It may list other
CLIs already installed by the user; listing them does not invoke them or make
them dependencies of this harness.

Contracts contain executable checks, so the coordinating Copilot agent must
review and authorize their commands. Do not put model clients or unauthorized
simulation into a contract. Long-lived services stay under the native host's
process-management tools, not an infinite finite-check command.

Native TODO, terminal, browser, screenshot and optional sub-agent tools remain
the host's existing tools. This extension does not duplicate them. The generic
[process utility](../.github/extensions/prove-it-harness/process.mjs) and its
regressions were retained from the rejected bridge without model-specific code.

## Enforcement and observation boundaries

An explicit verification tool can enforce its own result. Instructions guide
when the agent invokes it; they are not an OS sandbox or a guarantee that every
host action is intercepted.

No CLI-specific `agentStop`/`Stop` configuration is assumed to operate in the
desktop application. An SDK callback is reported as observed only after a real
callback in this host. Automatic desktop stop blocking is not claimed without
that separate verification.

Model selection is read from the existing session, never changed by the harness.
Live `assistant.usage` observations, where delivered, identify the model used
by the primary Copilot agent. Historical usage-store access was not authorized
during this correction and is not accessed through another path. Model routing
is not an invoice: no precise credit consumption or account-wide billing total
is inferred.

The harness does not configure another provider, request provider credentials,
forward prompts to a model CLI, or introduce a separate model billing path.
Ordinary Copilot usage still follows the selected model/account's existing terms.
This is not a machine-wide ban on users independently launching other programs.

## Validation scope

Validation includes source/path auditing, deterministic process and Prove It
regressions, live native tool/model observations, and a small Copilot-coordinated
code modification with a failing baseline, runtime tests, inspected evidence and
final verification. Historical Codex results cannot satisfy these new checks.

CARLA and protected simulation budgets are explicitly excluded from this harness
validation. Browser/simulation/native-agent capabilities not exercised must be
reported as available or untested, never as newly verified execution.

```powershell
node --test .\tests\native-harness.test.js .\tests\process-supervisor.test.js
.\.venv-carla\Scripts\python.exe -m unittest discover -s tests -p 'test_prove_it_harness.py' -v
.\.venv-carla\Scripts\python.exe .\scripts\verify_copilot_harness.py --audit
```

The Python hook-decision regressions test the collector protocol only. They are
not evidence that a CLI Stop hook intercepts desktop completion. The native SDK
pre-tool callback is used only for observation; the explicit `verify` action
provides the tested acceptance boundary.

## Observed validation in this host

The existing Copilot SDK session reported `gpt-6-astra` as the selected model;
live primary `assistant.usage` events reported the same model. This is a runtime
observation, not a model pinned by the extension. The model picker remains free
to select another Copilot model normally.

- Both native tools were discovered and called in this chat; the old delegation
  tools disappeared after provider reload.
- Eleven adapter/process tests and seven collector regressions passed, including
  strict admission, cancellation, owned-child cleanup, stale evidence, and
  operation without model CLI access/provider environment credentials.
- A new isolated child task was planned and sealed. Starting integration before
  its dependency was ready was rejected. Its actual Python function failed the
  independent oracle, was edited by this Copilot agent, then passed all nine
  cases and its final current-source gate. The original failure remains recorded.
- Native browser automation loaded only a loopback fixture, observed missing
  output as HTTP 404 rather than success, then displayed `9 cases passed` after
  the repair. The screenshot was saved and inspected. The owned server was
  stopped; the temporary browser page was already unavailable at cleanup.
- The SDK pre-tool observation callback actually fired. It is not a Stop hook
  or global completion blocker. Automatic desktop Stop blocking is neither
  enabled nor claimed.
- Native sub-agent tooling remains available but was not invoked in this
  single-model demonstration. CARLA/simulation and protected budgets were not
  exercised. No precise credit consumption was measured.

Local evidence is retained in `.runtime-proof/copilot-native-harness/` and
`.runtime-proof/copilot-native-demo/.runtime-proof/clamp-repair/`. The parent
gate rechecks the native source identity, model/helper observations, unchanged
skill fingerprints and the child's live collector gate. Historical Codex runs
remain separate and do not support the corrected architecture's acceptance.
