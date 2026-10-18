# Sequential interface — 18 October 2026

The main screen now has one task action and Details. Emergency stop is added
while connected and is replaced by Release emergency stop when latched. The
camera, route, speed, current explanation and presentation progress remain on
the main screen. The presentation summary is compact enough to keep the camera
prominent on mobile.

## Start and scrolling follow-up

The main action now says **Start** in a fresh session, whether CARLA is already
connected or stopped. It says **Restart** after an actual attempted journey or
presentation, including retained failures. Merely connecting or selecting a
destination does not count as a previous attempt. The shared state supplies both
the button and its guidance text; existing Stop, Resume and emergency actions
retain their meaning. Both labels use the existing supported presentation
operation; this is not a new controller or automatic driving trigger.

The user screenshot exposed a missed desktop regression: the camera's restored
16:9 height exceeded the viewport while `html`, the body and workspace still
enforced the old fixed-height, hidden-overflow layout. The earlier checks verified
camera/map dimensions but did not try scrolling to the camera's bottom.
Sequential mode now allows document scrolling and natural-height ancestor
containers. The header remains sticky so the main action and emergency stop stay
reachable. The camera retains `object-fit: contain`; it does not crop the image
to hide the height problem. Results use the same document flow.

Follow-up verification:

- Dashboard JavaScript/CSS rebuilt; **143 JavaScript tests passed**.
- Nine real-browser action-label/transition checks passed using simulated state.
- Real mouse-wheel scrolling reaches the camera bottom at 1920×911, 1536×728,
  1280×720 and 390×740 CSS viewports, with no horizontal overflow. The reduced
  desktop viewport covers the layout effect of browser zoom without claiming
  that native Chrome zoom was changed.
- At 1920×911 the page scrolls 346 px; the camera bottom becomes reachable at
  approximately 875 px. The main action remains inside the viewport.
- Fullscreen stays inside the viewport, and Escape restores normal camera size.
- An initial test fixture omitted its route destination; that fixture was fixed.
  The final action run has no page errors.

These checks use isolated static HTTP 8016, an intercepted WebSocket on 8017 and
a retained chase-camera JPEG. No actions are sent to the user's live CARLA
session on 8000/8001, which was only inspected read-only. Backend/controller code
and native acceptance are unchanged; Python tests were not rerun for this
frontend-only patch while the user's native session was active.

The [follow-up evidence](evidence/start-scroll-ui-20261018/verification.json)
retains scope, final action/scroll measurements, screenshots and source hashes.
Raw fixture data and logs remain under ignored
`output/start-scroll-ui-20261018/` and `output/playwright/`.

Refresh the dashboard after an active presentation or journey finishes to load the rebuilt UI;
do not refresh the owning page mid-journey merely to apply this visual patch.

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
