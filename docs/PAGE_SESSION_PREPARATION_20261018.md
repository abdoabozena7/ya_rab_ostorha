# One engine, fresh page attempts — 18 October 2026

Opening a new guided page now prepares a new scenario using the existing CARLA
engine. It does not resume another page's halfway pose. A document owns a random
`page_id`; reconnecting that same document is idempotent, while opening/reloading
a document requests a fresh beginning. This supersedes the earlier cross-reload
held-scene behavior documented in the prepared-city report.

The normal mode is selected initially. A ready scene therefore has a usable Start
action without an unexplained extra selection requirement. The protected mode
remains available before starting.

## Shared-engine handoff

`PRELOAD(page_id)` takes the single control lease, stops the old attempt and saves
its recording as `INTERRUPTED / page_replaced`. Its presentation history records
the replacing page. The new presentation stays in STOPPING until the vehicle is
stationary and the previous recording has closed. Only then does it build a new
seeded route/population and capture its held start. Both arms inside that new
comparison still restore the same starting world.

`START_GUIDED` must match both prepared identity and page identity. A superseded
page shows **Prepare a fresh drive here**, explains which action is needed, and
hides its GPU action. It sends no automatic takeover loop. Explicitly preparing
there can take the lease back and create another fresh beginning. A cancelled
attempt also offers preparation rather than displaying an endless loading state.
Errors include the failed command sequence; failed sends have an explanation.
Emergency stop and native cancellation retain their existing behavior.

Engine startup remains idempotent under the service lock. A concurrent HTTP test
sent 24 startup requests from 12 workers and dispatched one engine launch. The
HTTP accept queue also accommodates parallel asset/status loads from several
pages. Page handoff does not call engine launch/stop or change safety thresholds.

## Loading and resources

The disabled Start action has a white shell and an outlined edge. A solid coral
shape grows with the actual connection/preparation/checking stages and gently
changes its outline. Background-color fading and gradient sweeps are removed.
These are stage markers, not a time estimate or numerical percentage. Only a
verified held start completes the fill and exposes Free GPU for that page.
Reduced-motion preferences disable the morph and retain the same readiness gates.

Starting pages no longer fetch hidden live camera frames or inference previews.
Visible live driving keeps its camera; diagnostics request their supplementary
display data only when visible. Native sensors and protection are unaffected.

## Verification and limits

The checked-in frontend bundles were rebuilt. **163 JavaScript tests** passed.
Python discovery ran **631 tests: 629 passed and two optional tests skipped**.
Regression cases cover page ownership, stale start rejection, recording closure,
cancelled-page recovery, startup concurrency and hidden diagnostic requests.

A real native browser check started Normal in one context, then opened a second
context with independent browser storage. The second page automatically saved
and interrupted the first, reached a new held presentation identity with 60
vehicles and 100 pedestrians, and enabled Start. The first page offered explicit
fresh preparation. CARLA's launcher and UE process IDs were identical before
and after. The starting page made zero hidden camera/inference requests. The
successful handoff had no page exceptions; one camera request was intentionally
aborted as its driving view was retired.

Two earlier UI checks caught background-color interpolation immediately after
entering loading; removing that transition fixed it. A transient Windows mapped
bundle-file lock required repeating the build. The successful rebuild and native
probe are distinct from those failed attempts. No new full-route, driving-quality
or sustained-chaos acceptance is claimed. The prior protected-stop and stress
limitations remain documented in the prepared-city report. Separate browser
contexts were tested; this does not claim a separate native Firefox test.

The isolated fixture starts from `about:blank`, reads assets from the local host,
then intercepts API and fake WebSocket traffic before navigating. Its actions do
not reach the native host. Compact evidence and screenshots are retained under
[page-session-20261018](evidence/page-session-20261018/); raw runs remain ignored.
