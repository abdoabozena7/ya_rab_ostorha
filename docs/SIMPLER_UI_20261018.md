# Sequential interface — 18 October 2026

The main screen now has one task action and Details. Emergency stop is added
while connected and is replaced by Release emergency stop when latched. The
camera, route, speed, current explanation and presentation progress remain on
the main screen. The presentation summary is compact enough to keep the camera
prominent on mobile.

## Guided Details

Details starts with four choices and Close. Selecting a group replaces the
content inside the same native dialog. Back returns one level; Escape closes
the dialog and returns focus to Details. A connected operation has one emergency
control in the dialog's sticky header, with background actions hidden.

| Group | Flow |
| --- | --- |
| Run setup | Automatic presentation summary; Custom drive reveals destination and existing speed choices. Select a destination explicitly, then start the recorded journey. |
| View | Stage camera/overlay edits, then Apply view. Open fullscreen or continue to Diagnostics. |
| Results | Select latest or saved comparison; view outcomes, replay a presentation pair, or download an available MP4. |
| System | Choose Reset, Free GPU, advanced settings or research. Reset and Free GPU have a description and final explicit action. |

Configuration that could alter an active comparison is read-only. Native action
handlers retain their authority and availability checks. Inspecting a group is
not an apply operation. Back preserves pending edits; closing discards them.
Applying one form does not commit another form's pending edits. Camera rendering
does not overwrite a pending camera selection.

The main action, configuration lock and presentation messaging use shared state.
Resume requires the paused journey's route to match the current route. A previous
failed automatic presentation cannot mask a later ordinary journey's valid
Resume action. Camera/map shortcuts enter the guided drawer. Fullscreen keeps
the same main actions accessible and supports restoring the camera via View.

Saved comparison review is local UI state, separate from the live comparison.
It uses existing static comparison files and exported-video routes, with no new
backend API. Matching conditions are checked from retained setup/audit fields.
Original exceptions, injected-fault labels, collisions and incomplete outcomes
remain attached to their own recordings. Legacy results show their own saved
metrics rather than the current presentation's data.

## Verification

- Dashboard JavaScript/CSS regenerated; **135 JavaScript tests passed**.
- Python suite: **574 discovered, 573 passed, one optional skip**.
- **78 browser checks passed**, covering the main action states, button counts, four root groups,
  single-dialog navigation, draft/Apply boundaries, active-run locks, focus and
  keyboard access, fullscreen, research navigation and legacy results.
- Desktop 1600 px and mobile 390 px layouts were checked, including settings and
  diagnostics. UI text is English; the main screen has two buttons offline and
  at most three during operation. The Details root has five controls offline
  and six when the emergency control is applicable.
- Two actual retained native MP4s were replayed, paused, resumed and allowed to
  finish. Synchronization, original failure text and download were checked. The
  downloaded MP4 checksum is compared with the retained video-status checksum.

The verification uses an isolated HTTP server on port 8010 and an intercepted
WebSocket, with simulated UI states. Inspection emits no native configuration
or driving actions; the existing journey heartbeat continues in active states.
The explicit camera-Apply check captures one settings request in that fixture.
Raw copied state/catalog data and recordings are not committed.

The existing CARLA session on port 8000 was observed read-only during discovery;
it was not restarted or used for a new native acceptance run. This delivery
changes frontend interaction and does not change controller code, budgets or
the [failed driving acceptance](RELIABLE_DRIVING_20261017.md).

Compact check results, source hashes, checksums and screenshots are in
[the verification index](evidence/simpler-ui-20261018/verification.json).
