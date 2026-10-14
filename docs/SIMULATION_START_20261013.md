# One-button simulator startup

The old **Connect simulator** action opened or retried the browser connection. A WebSocket connection cannot launch an engine that was stopped to release GPU resources. The separate dashboard and native reconnect buttons also required the operator to know which connection had failed.

**Start the simulation** now performs both operations. It is the guided start action, the advanced driving start action while disconnected, and the single connection-settings action. The browser makes one explicit, same-origin JSON POST to `/api/simulation/start`; page loading and ordinary reconnect retries never launch CARLA automatically. Startup works even before a WebSocket is established.

An independent helper retires the old SDK host, launches the verified local CARLA installation with saved graphics, and starts a fresh sensor backend with ego held in PAUSED. Runtime commands use fixed arguments and managed tickets. Requests from unrelated web origins or remote clients are rejected. Startup does not grant pedal control or start driving. Repeated requests are idempotent. The native host acknowledges readiness before browser actions become available, avoiding a false failure if the operator immediately stops after startup.

While starting, the UI shows **Starting the simulation…** and blocks duplicate actions. A failed launch restores a stopped dashboard with a visible error and retry action. **Stop CARLA · Free GPU** remains available after connection. The command-line launcher is only needed when the dashboard host itself is not running.

## Verification

- Python: **338 discovered; 337 passed, 1 skipped**. JavaScript: **79 passed**. Dashboard bundle built.
- Real browser cold-start check: **one POST** launched real CARLA, reconnected the camera and eight registered sensor feeds, and left ego in **PAUSED**. Immediate GPU stop then returned the same browser to a usable stopped dashboard. No driving began and no page errors occurred.
- Browser fixtures verified both guided and advanced actions, removal of the old two connection buttons, disabled pending actions, visible errors and enabled retries. No native starts in these fixtures.
- Four final state samples remained STOPPED with startup IDLE; GPU memory was **0 MiB**. Preferences were byte-for-byte unchanged.

Evidence: `output/simulation-start/browser-live-check.txt`, `browser-states-check.txt`, `final-state.json`, `python-tests.txt`, `javascript-tests.txt`, and the starting/connected/stopped screenshots in that directory. No learning experiments or old budget ledgers were changed.
