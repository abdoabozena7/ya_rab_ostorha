"""Provider-neutral SI telemetry. Unknown values stay null; raw evidence is retained."""

import math

WHEEL_NAMES = ("rearLeft", "frontLeft", "rearRight", "frontRight")
DAMAGE_NAMES = ("body", "front", "rear", "engine", "cooling", "transmission", *WHEEL_NAMES)


def number(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return None


class TelemetryMapper:
    def __init__(self):
        self.previous = None
        self.distance = 0.0
        self.fuel_used = 0.0

    def map(self, state, electrics, damage, timestamp):
        velocity = state.get("vel")
        direction = state.get("dir")
        speed = None
        if velocity and direction and len(velocity)==len(direction)==3 and all(number(x) is not None for x in [*velocity,*direction]):
            magnitude = math.sqrt(sum(x * x for x in direction))
            if magnitude:
                speed = sum(x * y for x, y in zip(velocity, direction)) / magnitude
        litres = number(electrics.get("fuel_volume"))
        capacity = number(electrics.get("fuel_capacity"))
        # The supported SDK supplies actual volume/capacity; don't guess a
        # percentage convention when fuel_volume is absent on another model.
        acceleration = flow = None
        if self.previous and timestamp is not None:
            dt = timestamp - self.previous["timestamp"]
            if 0 < dt <= 1:
                if speed is not None and self.previous["speed"] is not None:
                    acceleration = (speed - self.previous["speed"]) / dt
                    self.distance += (abs(speed) + abs(self.previous["speed"])) * .5 * dt
                if litres is not None and self.previous["litres"] is not None:
                    used = self.previous["litres"] - litres
                    # Refills don't count as negative fuel consumption.
                    if used >= 0:
                        self.fuel_used += used
                        flow = used / dt * 3600
            elif dt < 0:
                self.distance = self.fuel_used = 0.0
        if timestamp is not None:
            self.previous = {"timestamp": timestamp, "speed": speed, "litres": litres}
        average = self.fuel_used / self.distance * 100000 if self.distance > 100 and self.fuel_used > 0 else None
        gear = electrics.get("gear_index")
        wheel_av = number(electrics.get("avg_wheel_av"))
        return {
            "schemaVersion": 1, "source": "beamng", "timestamp": timestamp,
            "physicsTick": None, "massKg": None, "centerOfMassM": None,
            "positionWorldM": state.get("pos"), "velocityWorldMps": velocity,
            "forwardWorld": direction, "upWorld": state.get("up"),
            "headingRad": math.atan2(direction[0], direction[1]) if speed is not None else None,
            "headingConvention": "clockwise from world +Y, Z up",
            "orientationQuaternion": state.get("rotation"), "coordinateFrame": "beamng-world-z-up",
            "speedMps": speed, "accelerationMps2": acceleration,
            "accelerationSource": "velocity derivative" if acceleration is not None else None,
            "lateralAccelerationMps2": None, "steeringAngleRad": None,
            "steeringWheelAngleRad": math.radians(electrics["steering"]) if number(electrics.get("steering")) is not None else None,
            "throttle": number(electrics.get("throttle")), "brake": number(electrics.get("brake")),
            "gear": "R" if gear is not None and gear < 0 else "N" if gear == 0 else str(gear) if gear is not None else None,
            "engineRunning": bool(electrics["running"]) if "running" in electrics else None,
            "engineRPM": number(electrics.get("rpm")), "idleRPM": None,
            "engineLoad": number(electrics.get("engine_load")),
            "engineTemperatureC": number(electrics.get("water_temperature")),
            "engineDamage": None, "transmissionDamage": None,
            "fuelLevelL": litres, "fuelCapacityL": capacity,
            "instantConsumptionLph": flow, "fuelConsumptionRateLph": flow,
            "averageConsumptionLPer100Km": average,
            "estimatedRangeKm": litres / average * 100 if average and litres is not None else None,
            "averageWheelAngularVelocityRadps": wheel_av,
            "wheels": [{"name": name, "radiusM": None, "angularVelocityRadps": None,
                        "angleRad": None, "rpm": None, "steeringAngleRad": None,
                        "suspensionCompressionM": None, "slip": None} for name in WHEEL_NAMES],
            "damage": {name: None for name in DAMAGE_NAMES},
            "damageTotal": number(damage.get("damage")), "damageRaw": damage,
            "lastCollision": None,
            "capabilities": {"vehiclePhysics": True, "softBodyDamage": True,
                             "perWheelTelemetry": False, "collisionImpulse": False},
        }
