# Selectable scenario chooser — 24 October 2026

The old native dropdown disabled Egypt entirely. Its expanded menu covered the
availability explanation and made the option look broken. The backend still
reports `available: false`, `native_accepted: false` and
`validation_window_active: false`, because the twelve required native trips have
not been accepted. GPU or VRAM usage does not control this admission gate.

Two full-width, keyboard-accessible radio rows replace the dropdown. Each shows
its route description, speed ceiling and access status. Both rows can be
selected when the chooser is editable, including the experimental Egypt route.
The validation explanation stays visible below the rows, with the exact backend
reason in **Validation details**.

Selecting Egypt without access creates a page-local draft. It sends no PRELOAD
or START command, changes no prepared world, and survives ordinary telemetry
updates. The primary action says **Validation required**, and its hint identifies
the historical route as the available drive. Switching back to the already
prepared historical route restores Start without rebuilding it.

An availability refresh can grant access in a real existing validation session,
but it cannot automatically prepare or start an inspected draft. The user first
chooses **Prepare selected scenario**, then starts after native readiness. Native
admission remains authoritative. Explicit recovery from a cancelled preparation
discards the inspected draft and prepares the available route instead of getting
stuck. A failed catalog refresh now gives visible feedback.

## Verification

- Dashboard JavaScript and CSS rebuilt; **204 JavaScript tests passed**.
- Python ran **923 tests: 919 passed, four optional skips**.
- Isolated browser fixtures verified locked-route selection without native
  commands, retained selection, historical recovery, native radio keyboard
  navigation, cancellation recovery, explicit preparation after access changes,
  expired access, GPU states, reduced motion, and desktop/mobile containment.
  The passing run had zero browser errors. Every API and control socket was
  intercepted before opening the dashboard.
- The existing Egypt browser workflow also passed with supplied validation
  access: scenario/driver commands, Emergency stop, both fixture videos,
  Finish, disconnected playback, reload, and responsive results. These are
  intercepted software/media checks, not native driving acceptance.

[Verification summary](evidence/scenario-chooser-20261024/verification.json),
[desktop chooser](evidence/scenario-chooser-20261024/desktop.png) and
[mobile chooser](evidence/scenario-chooser-20261024/mobile.png) preserve software
evidence. Backend availability was inspected read-only. No native trip,
acceptance matrix, validation reservation, budget extension or acceptance
promotion was performed. This follow-up supersedes the disabled-dropdown
behavior in the earlier [GPU action report](GPU_ACTION_UI_20261024.md); that
report and its screenshots remain historical evidence.
