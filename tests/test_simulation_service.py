import math
import time
import unittest
from backend.simulation_service import SimulationService
from backend.telemetry import TelemetryMapper


class ServiceTests(unittest.TestCase):
    def test_controls_expire_and_missing_pedals_release(self):
        service = SimulationService(None)
        service.set_controls(throttle=.7, steering=-.2)
        at = service.command_at
        self.assertEqual(service.effective_controls(at+.1)["throttle"], .7)
        self.assertEqual(service.effective_controls(at+.4),
                         {"throttle": 0, "brake": 1, "steering": 0, "parkingbrake": 0})
        service.set_controls(brake=.4)
        self.assertEqual(service.effective_controls()["throttle"], 0)
        service.release_controls()
        self.assertEqual(service.effective_controls()["brake"], 1)

    def test_invalid_controls_cannot_reach_sdk(self):
        service = SimulationService(None)
        for controls in ({"throttle": float('nan')}, {"steering": 2}, {"brake": -1},
                         {"throttle": True}, {"gear": 1.5}, {"unknown": 0}):
            with self.subTest(controls=controls), self.assertRaises(ValueError):
                service.set_controls(**controls)

    def test_stale_cached_state_is_disconnected(self):
        service = SimulationService(None)
        service.state = {"source": "beamng"}
        service.state_at = time.monotonic()-2
        self.assertFalse(service.snapshot()["connected"])
        service.state_at = time.monotonic()
        self.assertTrue(service.snapshot()["connected"])

    def test_camera_bytes_and_metadata_are_copied_as_one_frame(self):
        service = SimulationService(None)
        service.frame = b'jpeg'
        service.frame_metadata = {"sensorTimestamp": 12.5}
        frame, meta = service.get_camera_frame()
        service.frame_metadata["sensorTimestamp"] = 13
        self.assertEqual(frame, b'jpeg')
        self.assertEqual(meta["sensorTimestamp"], 12.5)


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
