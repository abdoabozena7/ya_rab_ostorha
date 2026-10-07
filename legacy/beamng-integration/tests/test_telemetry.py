import math
import unittest
from backend.telemetry import TelemetryMapper


class TelemetryTests(unittest.TestCase):
    def test_actual_electrics_and_state_are_authoritative(self):
        mapper = TelemetryMapper()
        state = {"vel": [0, -10, 0], "dir": [0, -1, 0], "pos": [10, 20, 2]}
        electrics = {"fuel_volume": 30, "fuel_capacity": 60, "rpm": 2500,
                     "running": True, "gear_index": 3, "steering": 180}
        first = mapper.map(state, electrics, {"damage": 5000}, 1)
        self.assertEqual(first["speedMps"], 10)
        self.assertEqual(first["fuelLevelL"], 30)
        self.assertAlmostEqual(first["steeringWheelAngleRad"], math.pi)
        self.assertIsNone(first["steeringAngleRad"])
        self.assertEqual(first["damageTotal"], 5000)
        self.assertIsNone(first["damage"]["engine"])
        state["vel"] = [0, -8, 0]
        electrics["fuel_volume"] = 29.999
        second = mapper.map(state, electrics, {}, 1.5)
        self.assertAlmostEqual(second["accelerationMps2"], -4)
        self.assertAlmostEqual(second["instantConsumptionLph"], 7.2)

    def test_missing_measurements_are_not_decorative_defaults(self):
        t = TelemetryMapper().map({}, {}, {}, None)
        for field in ("speedMps", "engineRPM", "engineRunning", "fuelLevelL", "physicsTick"):
            self.assertIsNone(t[field])
        self.assertTrue(all(w["rpm"] is None for w in t["wheels"]))

    def test_refills_and_clock_resets_do_not_create_negative_consumption(self):
        mapper = TelemetryMapper()
        mapper.map({}, {"fuel_volume": 10}, {}, 1)
        t = mapper.map({}, {"fuel_volume": 20}, {}, 2)
        self.assertIsNone(t["instantConsumptionLph"])
        mapper.map({}, {"fuel_volume": 20}, {}, .1)
        self.assertEqual(mapper.fuel_used, 0)
