"""One SDK worker; native frame cache and expiring, exclusive control commands."""

import copy
import math
import threading
import time
from collections import deque


class SimulationService:
    CONTROL_TTL = .35

    def __init__(self, provider, recorder=None):
        self.provider, self.recorder = provider, recorder
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.thread = None
        self.command = self.safe_controls()
        self.command_at = 0.0
        self.actions = deque()
        self.state = self.world = None
        self.state_at = 0.0
        self.sensors = {}
        self.frame = self.frame_metadata = None
        self.error = None
        self.sensor_rates = {}
        self.sequence = 0
        self.paused = False
        self.backend_step_ms = None

    @staticmethod
    def safe_controls():
        return {"throttle": 0, "brake": 1, "steering": 0, "parkingbrake": 0}

    def start(self):
        if self.thread is not None or self.provider is None:
            raise RuntimeError('A provider and an unstarted worker are required')
        self.thread = threading.Thread(target=self._run, name="simulation-worker", daemon=True)
        self.thread.start()

    def set_controls(self, **command):
        if set(command) - {"throttle", "brake", "steering", "parkingbrake", "gear"}:
            raise ValueError("Unknown control field")
        for key, value in command.items():
            if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
                raise ValueError("Controls must be finite numbers")
            if key == "gear":
                if not isinstance(value, int) or value not in (-1, 0, 1):
                    raise ValueError("Select reverse (-1), neutral (0), or automatic drive (1)")
            elif not (-1 if key == "steering" else 0) <= value <= 1:
                raise ValueError(f"{key} outside control range")
        with self.lock:
            self.command = {"throttle": 0, "brake": 0, "steering": 0, "parkingbrake": 0, **command}
            self.command_at = time.monotonic()

    def effective_controls(self, now=None):
        with self.lock:
            if (time.monotonic() if now is None else now) - self.command_at > self.CONTROL_TTL:
                return self.safe_controls()
            return self.command.copy()

    def release_controls(self):
        with self.lock:
            self.command_at = 0.0

    def reset_vehicle(self):
        self.release_controls()
        with self.lock:
            self.actions.append(("reset", None))

    def set_paused(self, paused):
        if not isinstance(paused, bool):
            raise ValueError("paused must be boolean")
        self.release_controls()
        with self.lock:
            self.actions.append(("pause", paused))

    def snapshot(self):
        with self.lock:
            live = (self.state is not None and self.state.get('source') == 'carla'
                    and self.error is None and time.monotonic() - self.state_at < 1)
            return copy.deepcopy({
                "sequence": self.sequence, "connected": live, "provider": "carla", "error": self.error,
                "vehicle": self.state if live else None, "world": self.world if live else None,
                "sensors": {name: {**{key: value for key, value in frame.items() if key != "data"},
                                   'matchesVehicleFrame': frame.get('frame') == self.state.get('frame')}
                            for name, frame in self.sensors.items()} if live else {},
                "sensorErrors": {}, "sensorRatesHz": self.sensor_rates if live else {},
                "backendStepMs": self.backend_step_ms,
                "controlExpired": time.monotonic() - self.command_at > self.CONTROL_TTL})

    def require_connected(self):
        if not self.snapshot()["connected"]:
            self.release_controls()
            raise RuntimeError("CARLA telemetry unavailable; commands suspended")

    def get_vehicle_state(self):
        return self.snapshot()

    def get_sensor_frame(self, name):
        with self.lock:
            self.require_connected()
            if name not in self.sensors:
                raise KeyError(name)
            return copy.deepcopy(self.sensors[name])

    def get_camera_frame(self):
        with self.lock:
            self.require_connected()
            return self.frame, copy.deepcopy(self.frame_metadata)

    def _iteration(self):
        started = time.monotonic()
        with self.lock:
            actions = list(self.actions)
            self.actions.clear()
        for action, value in actions:
            if action == "reset":
                self.provider.reset_vehicle()
            else:
                self.provider.set_paused(value)
                self.paused = value
        if not self.paused:
            self.provider.set_controls(**self.effective_controls())
        self.provider.step()
        state = self.provider.get_vehicle_state()
        world = self.provider.get_world_state()
        if (state.get('source') != 'carla' or world.get('source') != 'carla'
                or state.get('frame') != world.get('frame')):
            raise RuntimeError('Expected CARLA vehicle and world observations from one native frame')
        sensors = self.provider.get_sensor_state()
        manager = getattr(self.provider, 'sensor_manager', None)
        frame, metadata = self.provider.get_camera_frame()
        with self.lock:
            self.state, self.world, self.sensors = state, world, sensors
            self.sensor_rates = manager.rates() if manager else {}
            self.frame, self.frame_metadata = frame, metadata
            self.state_at = time.monotonic()
            self.sequence += 1
            self.error = None
            self.backend_step_ms = (self.state_at - started) * 1000
        if self.recorder:
            self.recorder.record(state, world, sensors)

    def _run(self):
        try:
            while not self.stop_event.is_set():
                started = time.monotonic()
                try:
                    self._iteration()
                except Exception as error:
                    self.release_controls()
                    with self.lock:
                        self.error = str(error)
                        self.state = self.world = self.frame = self.frame_metadata = None
                        self.sensors = {}
                    break  # No more synchronous ticks or replayed controls after failure.
                interval = getattr(self.provider, 'fixed_delta', .05)
                self.stop_event.wait(max(0, interval - (time.monotonic() - started)))
        finally:
            self._close_provider()

    def _close_provider(self):
        try:
            if self.provider:
                if self.provider.is_connected():
                    self.provider.set_controls(**self.safe_controls())
        except Exception as error:
            with self.lock:
                self.error = '; '.join(filter(None, [self.error, str(error)]))
        finally:
            try:
                if self.provider:
                    self.provider.close()
                    errors = getattr(self.provider, 'cleanup_errors', [])
                    if errors:
                        with self.lock:
                            self.error = '; '.join(filter(None, [self.error, *errors]))
            except Exception as error:
                with self.lock:
                    self.error = '; '.join(filter(None, [self.error, 'Actor cleanup unconfirmed: ' + str(error)]))
            finally:
                if self.recorder:
                    self.recorder.close()
                with self.lock:
                    self.state = self.world = self.frame = self.frame_metadata = None
                    self.sensors = {}

    def close(self):
        self.release_controls()
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=15)
            if self.thread.is_alive():
                raise RuntimeError('CARLA worker did not stop; actor cleanup is not confirmed')
        else:
            self._close_provider()
