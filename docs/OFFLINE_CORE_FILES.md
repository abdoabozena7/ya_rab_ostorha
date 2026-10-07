# Offline preparation file manifest

This checkpoint adds simulator-independent application logic and preserves the
archived simulators. No installation scripts, CSS, legacy driving code or native
CARLA sensor implementation were changed. The files below are relative to the
repository root.

- `.gitignore`
- `backend/carla/contracts.py`
- `backend/carla/provider.py`
- `backend/core/__init__.py`
- `backend/core/agents.py`
- `backend/core/config.py`
- `backend/core/contracts.py`
- `backend/core/control.py`
- `backend/core/dashboard.py`
- `backend/core/evaluation.py`
- `backend/core/events.py`
- `backend/core/lifecycle.py`
- `backend/core/logging.py`
- `backend/core/recording.py`
- `backend/core/replay.py`
- `backend/core/service.py`
- `backend/core/timing.py`
- `backend/provider.py`
- `backend/providers.py`
- `backend/recording.py`
- `backend/replay_service.py`
- `backend/server.py`
- `backend/simulation_service.py`
- `backend/websocket_bridge.py`
- `docs/CARLA_0916_MIGRATION.md`
- `docs/CARLA_MIGRATION.md`
- `docs/OFFLINE_CORE_FILES.md`
- `docs/OFFLINE_CORE.md`
- `experiments/offline-preparation.json`
- `frontend/dashboard.js`
- `frontend/sensor-frame.js`
- `frontend/simulation-client.js`
- `frontend/telemetry.js`
- `index.html`
- `README.md`
- `scripts/__init__.py`
- `scripts/native/__init__.py`
- `scripts/native/validation.py`
- `scripts/native/verify_cleanup.py`
- `scripts/native/verify_collision.py`
- `scripts/native/verify_connection.py`
- `scripts/native/verify_depth.py`
- `scripts/native/verify_gnss.py`
- `scripts/native/verify_imu.py`
- `scripts/native/verify_lidar.py`
- `scripts/native/verify_radar.py`
- `scripts/native/verify_rgb.py`
- `scripts/native/verify_vehicle_control.py`
- `scripts/native/verify_vehicle_spawn.py`
- `tests/__init__.py`
- `tests/core_packets.py`
- `tests/dashboard.test.js`
- `tests/test_api.py`
- `tests/test_carla_provider.py`
- `tests/test_core_contracts.py`
- `tests/test_core_runs_metrics_lifecycle.py`
- `tests/test_core_timing_control.py`
- `tests/test_offline_boundaries.py`
- `tests/test_simulation_service.py`
- `tests/test_websocket_bridge.py`
