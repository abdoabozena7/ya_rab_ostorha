"""Single SDK worker, cached observations, and expiring control commands."""

import copy
import math
import threading
import time
from collections import deque


class SimulationService:
    CONTROL_TTL = .35
    SENSOR_POLL_HZ = {"frontCamera": 20, "imu": 20, "gps": 10,
                      "lidarRoof": 10, "radarFront": 10, "ultrasonicFront": 10,
                      "powertrain": 10}

    def __init__(self, provider):
        self.provider = provider
        configs = getattr(getattr(provider, "sensor_manager", None), "config", {})
        self.SENSOR_POLL_HZ = {name: min(20, configs[name].rate_hz) if name in configs else rate
                               for name, rate in self.SENSOR_POLL_HZ.items()}
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.thread = None
        self.command = {"throttle": 0, "brake": 1, "steering": 0, "parkingbrake": 0}
        self.command_at = 0.0
        self.actions = deque()
        self.state = None
        self.state_at = 0.0
        self.sensors = {}
        self.frame = None
        self.frame_metadata = None
        self.error = None
        self.sensor_errors = {}
        self.sensor_polls = {name: deque(maxlen=40) for name in self.SENSOR_POLL_HZ}
        self.sequence = 0

    def start(self):
        self.thread = threading.Thread(target=self._run, name="beamng-simulation", daemon=True)
        self.thread.start()

    def set_controls(self, **command):
        if set(command) - {"throttle", "brake", "steering", "parkingbrake", "gear"}:
            raise ValueError("Unknown control field")
        for key, value in command.items():
            if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
                raise ValueError("Controls must be finite numbers")
            if key == "gear":
                if not isinstance(value, int) or not -1 <= value <= 8:
                    raise ValueError("Gear must be an integer from -1 to 8")
            elif not (-1 if key == "steering" else 0) <= value <= 1:
                raise ValueError(f"{key} outside control range")
        with self.lock:
            # Missing pedals mean release, never retain an old throttle value.
            self.command = {"throttle": 0, "brake": 0, "steering": 0, "parkingbrake": 0, **command}
            self.command_at = time.monotonic()

    def effective_controls(self, now=None):
        with self.lock:
            if (time.monotonic() if now is None else now) - self.command_at > self.CONTROL_TTL:
                return {"throttle": 0, "brake": 1, "steering": 0, "parkingbrake": 0}
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
            return copy.deepcopy({"sequence": self.sequence, "connected": self.state is not None and self.error is None and time.monotonic()-self.state_at<1,
                                  "error": self.error, "vehicle": self.state,
                                  "sensors": {name: {key: value for key, value in frame.items() if key != "data"}
                                              for name, frame in self.sensors.items()},
                                  "sensorErrors": self.sensor_errors,
                                  "sensorPollHz": {name: (len(times)-1)/(times[-1]-times[0]) if len(times)>1 and times[-1]>times[0] else None
                                                   for name, times in self.sensor_polls.items()},
                                  "controlExpired": time.monotonic()-self.command_at > self.CONTROL_TTL})

    def get_vehicle_state(self):
        return self.snapshot()

    def get_sensor_frame(self, name):
        with self.lock:
            if name not in self.SENSOR_POLL_HZ:
                raise KeyError(name)
            if name not in self.sensors:
                raise RuntimeError(self.sensor_errors.get(name, "Sensor has not produced a frame"))
            return copy.deepcopy(self.sensors[name])

    def get_camera_jpeg(self):
        with self.lock:
            return self.frame

    def get_camera_frame(self):
        with self.lock:
            return self.frame, copy.deepcopy(self.frame_metadata)

    def _run(self):
        next_due = {name: 0 for name in self.SENSOR_POLL_HZ}
        while not self.stop_event.is_set():
            started = time.monotonic()
            try:
                with self.lock:
                    actions = list(self.actions)
                    self.actions.clear()
                self.provider.set_controls(**self.effective_controls())
                for action, value in actions:
                    if action == "reset":
                        self.provider.reset_vehicle()
                    else:
                        self.provider.set_paused(value)
                state = self.provider.get_vehicle_state()
                with self.lock:
                    self.state = state
                    self.state_at = time.monotonic()
                    self.sequence += 1
                    self.error = None
                for name, rate in self.SENSOR_POLL_HZ.items():
                    if time.monotonic() < next_due[name]:
                        continue
                    poll_started=time.monotonic()
                    try:
                        frame = self.provider.get_sensor_frame(name, state.get("timestamp"))
                        jpeg = self.provider.sensor_manager.last_jpeg if name == "frontCamera" else None
                        with self.lock:
                            self.sensors[name] = frame
                            self.sensor_errors.pop(name, None)
                            self.sensor_polls[name].append(time.monotonic())
                            if name == "frontCamera":
                                self.frame, self.frame_metadata = jpeg, frame if jpeg else None
                    except Exception as error:
                        with self.lock:
                            self.sensor_errors[name] = str(error)
                    next_due[name] = poll_started + 1/rate
                    # Slow sensor requests must not leave throttle held indefinitely.
                    if time.monotonic()-self.command_at > self.CONTROL_TTL:
                        self.provider.set_controls(**self.effective_controls())
            except Exception as error:
                with self.lock:
                    self.error = str(error)
                self.release_controls()
            self.stop_event.wait(max(0, .05 - (time.monotonic()-started)))
        try:
            self.provider.set_controls(throttle=0, brake=1, steering=0)
        finally:
            self.provider.close()

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=5)
