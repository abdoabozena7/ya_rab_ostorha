"""Optional authoritative BeamNG.tech provider. Requires a local BeamNG.tech install.

The browser city's meshes are not exported to BeamNG. This provider runs its own
BeamNG scenario; its physics and sensor observations must not be conflated with
the browser development scene until the two worlds are registered.
"""

from __future__ import annotations

import io
import json
import math
import threading
import time
from dataclasses import dataclass, replace
from typing import Any
from .telemetry import TelemetryMapper


def jsonable(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "tolist"):
        return jsonable(value.tolist())
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items() if not isinstance(item, bytes)}
    if isinstance(value, (tuple, list)):
        return [jsonable(item) for item in value]
    return str(value)


def normalize_lidar(raw: dict) -> dict:
    cloud = jsonable(raw.get("pointCloud")) or []
    points = []
    for point in cloud:
        if isinstance(point, (tuple, list)) and len(point) >= 3:
            points.append({"x": point[0], "y": point[1], "z": point[2],
                           **({"intensity": point[3]} if len(point) > 3 else {})})
    return {"coordinateFrame": "beamng-world", "points": points,
            "pointCount": len(points)}


def normalize_radar(raw: Any) -> dict:
    # SDK 1.34.1 returns seven columns (including weight), without object IDs.
    data = jsonable(raw)
    rows = data.get("data", data.get("pointCloud", [])) if isinstance(data, dict) else data
    returns = []
    for row in rows or []:
        if isinstance(row, (tuple, list)) and len(row) >= 6:
            returns.append({"rangeM": row[0], "relativeVelocityMps": row[1],
                            "azimuthRad": row[2], "elevationRad": row[3],
                            "radarCrossSection": row[4], "signalToNoise": row[5],
                            "weight": row[6] if len(row)>6 else None,
                            "objectId": None})
    return {"returns": returns, "returnCount": len(returns), "raw": data}


def sensor_samples(raw):
    if isinstance(raw, dict):
        if "time" in raw:
            return [raw]
        return sorted([value for value in raw.values() if isinstance(value, dict) and "time" in value],
                      key=lambda value: value["time"])
    return [value for value in raw if isinstance(value, dict)] if isinstance(raw, list) else []


def normalize_motion_sensor(name, raw):
    samples = []
    for sample in sensor_samples(raw):
        if name == "imu":
            samples.append({"timestamp": sample.get("time"),
                            "linearAccelerationMps2": jsonable(sample.get("accRaw")),
                            "angularVelocityRadps": jsonable(sample.get("angVel")),
                            "positionWorldM": jsonable(sample.get("pos")),
                            "orientationAxesWorld": {"forward": jsonable(sample.get("dirX")),
                                                     "up": jsonable(sample.get("dirY")),
                                                     "third": jsonable(sample.get("dirZ"))}})
        else:
            samples.append({"timestamp": sample.get("time"), "xWorldM": sample.get("x"),
                            "yWorldM": sample.get("y"), "longitudeDeg": sample.get("lon"),
                            "latitudeDeg": sample.get("lat"), "headingRad": None, "velocityMps": None})
    return jsonable({"coordinateFrame": "beamng-world-z-up" if name == "gps" else "sensor-axes-forward-up-third",
                     "gravityIncluded": False if name == "imu" else None,
                     "samples": samples, "raw": raw})


@dataclass(frozen=True)
class SensorConfig:
    name: str
    position: tuple[float, float, float]
    direction: tuple[float, float, float]
    up: tuple[float, float, float]
    rate_hz: float
    range_m: float | None = None
    fov_deg: float | None = None
    vertical_fov_deg: float | None = None
    channels: int | None = None

    def metadata(self) -> dict:
        return {"name": self.name, "positionVehicleM": self.position,
                "directionVehicle": self.direction, "upVehicle": self.up,
                "rateHz": self.rate_hz, "rangeM": self.range_m, "fovDeg": self.fov_deg,
                "verticalFovDeg": self.vertical_fov_deg, "channels": self.channels,
                "fovAxis": "vertical" if self.name in {"frontCamera", "ultrasonicFront"} else "horizontal" if self.name in {"lidarRoof", "radarFront"} else None,
                "transformFrame": "vehicle-local-x-right-y-back-z-up"}


def load_sensor_config(path):
    with open(path, encoding="utf-8") as file:
        overrides = json.load(file)
    configs = {}
    for name, fields in overrides.items():
        if name not in SensorManager.CONFIG or "name" in fields:
            raise ValueError(f"Unknown sensor configuration: {name}")
        config = replace(SensorManager.CONFIG[name], **fields)
        if not math.isfinite(config.rate_hz) or not 0 < config.rate_hz <= 1000:
            raise ValueError("Sensor rate must be between 0 and 1000 Hz")
        for vector in (config.position, config.direction, config.up):
            if len(vector) != 3 or not all(math.isfinite(x) for x in vector):
                raise ValueError("Sensor transforms must have three finite coordinates")
        if config.range_m is not None and not 0 < config.range_m <= 1000:
            raise ValueError("Invalid sensor range")
        if config.fov_deg is not None and not 0 < config.fov_deg <= 360:
            raise ValueError("Invalid field of view")
        if config.channels is not None and (not isinstance(config.channels, int) or not 1 <= config.channels <= 256):
            raise ValueError("LiDAR channels must be an integer between 1 and 256")
        configs[name] = config
    return configs


class SensorManager:
    """Owns BeamNG sensors and preserves per-sensor acquisition times."""

    CONFIG = {
        "frontCamera": SensorConfig("frontCamera", (0, -1.2, 1.25), (0, -1, 0), (0, 0, 1), 20, 100, 75),
        "lidarRoof": SensorConfig("lidarRoof", (0, 0, 1.8), (0, -1, 0), (0, 0, 1), 10, 120, 360, 26.9, 32),
        "radarFront": SensorConfig("radarFront", (0, -2.0, 0.6), (0, -1, 0), (0, 0, 1), 10, 100, 60),
        "imu": SensorConfig("imu", (0, 0, 0.8), (0, -1, 0), (0, 0, 1), 100),
        "gps": SensorConfig("gps", (0, 0, 1.55), (0, -1, 0), (0, 0, 1), 10),
        "ultrasonicFront": SensorConfig("ultrasonicFront", (0, -2.2, 0.5), (0, -1, 0), (0, 0, 1), 10, 5, 5.7),
    }

    def __init__(self, bng, vehicle, config=None):
        from beamngpy.sensors import Camera, Lidar, Radar, AdvancedIMU, GPS, Ultrasonic, PowertrainSensor

        self.last_jpeg = None
        self.config = {**self.CONFIG, **(config or {})}
        camera, lidar, radar, imu, gps, ultrasonic = (self.config[name] for name in
            ("frontCamera", "lidarRoof", "radarFront", "imu", "gps", "ultrasonicFront"))

        factories = {
            "frontCamera": lambda: Camera("frontCamera", bng, vehicle, requested_update_time=1/camera.rate_hz,
                                  pos=camera.position, dir=camera.direction, up=camera.up,
                                  resolution=(480, 270), field_of_view_y=camera.fov_deg,
                                  near_far_planes=(.05, camera.range_m), is_render_colours=True,
                                  is_render_depth=True, is_render_annotations=False,
                                  is_using_shared_memory=False, integer_depth=False),
            "lidarRoof": lambda: Lidar("lidarRoof", bng, vehicle, requested_update_time=1/lidar.rate_hz,
                               frequency=lidar.rate_hz, pos=lidar.position, dir=lidar.direction, up=lidar.up,
                               vertical_resolution=lidar.channels,
                               vertical_angle=lidar.vertical_fov_deg, horizontal_angle=lidar.fov_deg, max_distance=lidar.range_m,
                               is_360_mode=lidar.fov_deg>=360,
                               is_using_shared_memory=False, is_visualised=False),
            "radarFront": lambda: Radar("radarFront", bng, vehicle, requested_update_time=1/radar.rate_hz,
                                pos=radar.position, dir=radar.direction, up=radar.up, range_max=radar.range_m,
                                range_direct_max_cutoff=radar.range_m,
                                field_of_view_y=radar.fov_deg, near_far_planes=(.1,radar.range_m),
                                half_angle_deg=radar.fov_deg/2, is_visualised=False),
            "imu": lambda: AdvancedIMU("imu", bng, vehicle, gfx_update_time=1/imu.rate_hz,
                               physics_update_time=1/imu.rate_hz, pos=imu.position, dir=imu.direction, up=imu.up,
                               is_visualised=False, is_using_gravity=False),
            "gps": lambda: GPS("gps", bng, vehicle, gfx_update_time=1/gps.rate_hz,
                       physics_update_time=1/gps.rate_hz, pos=gps.position,
                       is_visualised=False),
            "ultrasonicFront": lambda: Ultrasonic("ultrasonicFront", bng, vehicle,
                                          requested_update_time=1/ultrasonic.rate_hz,
                                          pos=ultrasonic.position, dir=ultrasonic.direction, up=ultrasonic.up,
                                          field_of_view_y=ultrasonic.fov_deg, range_direct_max_cutoff=ultrasonic.range_m,
                                          is_visualised=False),
            "powertrain": lambda: PowertrainSensor("powertrain", bng, vehicle, gfx_update_time=.1,
                                            physics_update_time=.01),
        }
        self.sensors = {}
        try:
            for name, create in factories.items():
                self.sensors[name] = create()
        except Exception:
            self.close()
            raise

    def poll(self, name: str, simulation_time: float | None) -> dict:
        if name not in self.sensors:
            raise KeyError(name)
        raw = self.sensors[name].poll()
        # BeamNG may return a list of samples (IMU/GPS) or a dict. Retain raw
        # fields so a later consumer can verify SDK-specific units and shape.
        samples = sensor_samples(raw)
        timestamp = samples[-1].get("time") if samples else None
        if name == "frontCamera":
            self.last_jpeg = None
            depth = raw.get("depth") if isinstance(raw, dict) else None
            is_array=hasattr(depth,"tolist")
            values = jsonable(depth) if is_array else list(depth.getdata()) if depth is not None else None
            height = depth.shape[0] if hasattr(depth, "shape") else depth.height if depth is not None else None
            width = depth.shape[1] if hasattr(depth, "shape") else depth.width if depth is not None else None
            if depth is not None and not is_array:
                values=[values[row*width:(row+1)*width] for row in range(height)]
            data = {"depth": {"width": width, "height": height, "values": values,
                              "encoding": "beamng-normalized-depth-buffer" if is_array else "visual-depth-image",
                              "units": "0..1" if is_array else "image intensity",
                              "metricCalibrated": False, "nearM": .05,
                              "farM": getattr(self,"config",self.CONFIG)["frontCamera"].range_m}
                    if depth is not None else None,
                    "rgbAvailable": raw.get("colour") is not None}
            rgb = raw.get("colour")
            if rgb is not None:
                output = io.BytesIO()
                rgb.convert("RGB").save(output, format="JPEG", quality=82)
                self.last_jpeg = output.getvalue()
        elif name == "lidarRoof":
            data = normalize_lidar(raw)
        elif name == "radarFront":
            data = normalize_radar(raw)
        elif name in {"imu", "gps"}:
            data = normalize_motion_sensor(name, raw)
        else:
            data = jsonable(raw)
        configurations=getattr(self,"config",self.CONFIG)
        config = configurations[name].metadata() if name in configurations else {"name": name, "rateHz": 100, "positionVehicleM": None}
        return jsonable({"source": "beamng", "config": config,
                "frameAvailable": self.last_jpeg is not None if name == "frontCamera" else None,
                "sensorTimestamp": timestamp, "simulationTimeAtPoll": simulation_time,
                "timestampQuality": "simulator" if timestamp is not None else "acquisition time unavailable",
                "receivedMonotonic": time.monotonic(), "data": data})

    def frame_jpeg(self) -> bytes | None:
        return self.last_jpeg

    def close(self):
        for sensor in self.sensors.values():
            try:
                sensor.remove()
            except Exception:
                pass  # Continue releasing other sensors after a simulator disconnect.


class BeamNGProvider:
    def __init__(self, home: str, user: str | None = None, host: str = "127.0.0.1",
                 port: int = 25252, launch: bool = True, level: str = "west_coast_usa", sensor_config=None, traffic_count=5):
        from beamngpy import BeamNGpy, Scenario, Vehicle
        from beamngpy.sensors import Damage, Electrics, State, Timer

        self.lock = threading.RLock()
        self.mapper = TelemetryMapper()
        self.launch = launch
        self.bng = BeamNGpy(host, port, home=home, user=user)
        self.bng.open(launch=launch)
        self.vehicle = Vehicle("ego_vehicle", model="etk800", license="OSTORHA")
        for name, sensor in {"state": State(), "electrics": Electrics(),
                             "damage": Damage(), "timer": Timer()}.items():
            self.vehicle.sensors.attach(name, sensor)
        self.scenario = Scenario(level, "ostorha_foundation")
        # Known road spawn on West Coast USA. Custom Egyptian map import is pending.
        self.scenario.add_vehicle(self.vehicle, pos=(-717, 101, 118),
                                  rot_quat=(0, 0, .3826834, .9238795))
        self.scenario.make(self.bng)
        self.bng.scenario.load(self.scenario)
        self.bng.scenario.start()
        self.vehicle.set_shift_mode("realistic_automatic")
        try:
            self.sensor_manager = SensorManager(self.bng, self.vehicle, sensor_config)
            if traffic_count:
                self.bng.traffic.spawn(max_amount=traffic_count, extra_amount=0, parked_amount=0)
        except Exception:
            self.bng.close() if self.launch else self.bng.disconnect()
            raise

    def set_controls(self, throttle=0.0, brake=0.0, steering=0.0,
                     parkingbrake=0.0, gear=None):
        values = (throttle, brake, steering, parkingbrake)
        if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in values):
            raise ValueError("Controls must be finite numbers")
        with self.lock:
            self.vehicle.control(throttle=max(0, min(1, throttle)),
                                 brake=max(0, min(1, brake)),
                                 steering=max(-1, min(1, steering)),
                                 parkingbrake=max(0, min(1, parkingbrake)), gear=gear)

    def get_vehicle_state(self) -> dict:
        with self.lock:
            self.vehicle.sensors.poll()
            sensors = self.vehicle.sensors
            state = jsonable(sensors["state"].data or {})
            electrics = jsonable(sensors["electrics"].data or {})
            damage = jsonable(sensors["damage"].data or {})
            timer = jsonable(sensors["timer"].data or {})
            timestamp = timer.get("time", state.get("time"))
            telemetry = self.mapper.map(state, electrics, damage, timestamp)
            telemetry.update({"receivedMonotonic": time.monotonic(), "electricsRaw": electrics})
            return telemetry

    def get_engine_state(self) -> dict:
        return self.get_vehicle_state()

    def get_damage_state(self) -> dict:
        return self.get_vehicle_state()["damageRaw"]

    def get_sensor_frame(self, name: str, simulation_time=None) -> dict:
        with self.lock:
            return self.sensor_manager.poll(name, simulation_time)

    def get_camera_jpeg(self) -> bytes | None:
        with self.lock:
            return self.sensor_manager.frame_jpeg()

    def reset_vehicle(self):
        with self.lock:
            self.vehicle.recover()
            self.mapper = TelemetryMapper()

    def set_paused(self, paused):
        with self.lock:
            self.bng.control.pause() if paused else self.bng.control.resume()

    def spawn_vehicle(self, vehicle_id, model, position, rotation=(0,0,0,1)):
        from beamngpy import Vehicle
        with self.lock:
            vehicle = Vehicle(vehicle_id, model=model)
            if not self.bng.vehicles.spawn(vehicle, pos=position, rot_quat=rotation):
                raise RuntimeError("BeamNG vehicle spawn failed")
            return vehicle

    def close(self):
        with self.lock:
            self.sensor_manager.close()
            self.bng.close() if self.launch else self.bng.disconnect()
