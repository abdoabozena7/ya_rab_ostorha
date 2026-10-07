from dataclasses import FrozenInstanceError, replace
import json
import math
import unittest
from backend.core.contracts import *
from backend.core.config import *
from tests.core_packets import packet, sensor, command, metadata, TRANSFORM


class ContractTests(unittest.TestCase):
    def test_nested_roundtrip_preserves_units_and_provenance(self):
        frame = packet(sensors=(sensor(),), control=command())
        self.assertEqual(from_dict(SimulationFrame, json.loads(json.dumps(to_dict(frame)))), frame)
        self.assertEqual(frame.vehicle.speed_mps, 5.)
        self.assertEqual(frame.sensors[0].units['compass_rad'], 'rad')

    def test_rejects_ambiguous_unknown_fields(self):
        data = to_dict(packet().vehicle)
        data['speed'] = 12
        with self.assertRaises(ValueError):
            from_dict(VehicleState, data)

    def test_nonfinite_bool_types_vectors_and_negative_frames_rejected(self):
        for changes in ({'speed_mps': math.nan}, {'speed_mps': math.inf}, {'speed_mps': True},
                        {'frame_id': -1}, {'frame_id': 1.2}, {'actor_id': -1}, {'speed_mps': 10**400},
                        {'reverse': 1}, {'linear_velocity_mps': (1., 2.)}, {'throttle': 2.}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                replace(packet().vehicle, **changes)

    def test_simulation_frames_never_mix_time_or_frame(self):
        for value in (sensor(frame_id=2), sensor(timestamp_s=.06)):
            with self.assertRaises(ValueError):
                packet(sensors=(value,))
        with self.assertRaises(ValueError):
            packet(sensors=(sensor(), sensor()))

    def test_sensor_data_is_deeply_immutable_and_finite(self):
        original = {'compass_rad': .7, 'nested': [1, 2]}
        observed = replace(sensor(), data=original)
        original['nested'].append(3)
        self.assertEqual(observed.data['nested'], (1, 2))
        with self.assertRaises(TypeError):
            observed.data['compass_rad'] = 1
        with self.assertRaises(ValueError):
            replace(sensor(), data={'value': float('nan')})
        with self.assertRaises(ValueError):
            replace(sensor(), units={})

    def test_large_sensors_are_references_and_cannot_escape_run(self):
        for path in ('../x.png', 'C:/x.png', '/x.png', 'rgb\\x.png', 'https://x/y'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                AssetReference(path, 'image/png')
        with self.assertRaises(ValueError):
            replace(sensor(), kind=SensorKind.LIDAR)
        self.assertEqual(AssetReference('rgb/1.png', 'image/png').path, 'rgb/1.png')

    def test_prediction_cannot_replace_ground_truth(self):
        actor = ActorState(1, .05, 144, 'vehicle', TRANSFORM, (0., 0., 0.))
        truth = SimulatorGroundTruth(1, .05, (GroundTruthObject(actor, 10.),))
        prediction = ModelPrediction(1, .05, 'future-model', 'track-1', 'car', .8, 11.)
        frame = replace(packet(), ground_truth=truth, predictions=(prediction,))
        self.assertEqual(frame.ground_truth.objects[0].distance_m, 10.)
        with self.assertRaises(FrozenInstanceError):
            truth.objects = ()
        data = to_dict(prediction)
        data['actor_id'] = 144
        with self.assertRaises(ValueError):
            from_dict(ModelPrediction, data)

    def test_control_source_enum_is_required(self):
        for source in ('UNKNOWN', 'MANUAL', True):
            with self.assertRaises(ValueError):
                replace(command(), source=source)
        for source in CommandSource:
            self.assertEqual(replace(command(), source=source).source, source)

    def test_experiment_config_has_no_implicit_native_options(self):
        config = from_dict(ExperimentConfig, {'experiment': {'name': 'baseline'}, 'sensors': {'rgb': {'kind': 'RGB'}}})
        self.assertIsNone(config.vehicle.blueprint)
        self.assertFalse(config.sensors['rgb'].enabled)
        self.assertEqual(from_dict(ExperimentConfig, to_dict(config)), config)
        for data in ({'experiment': {'name': 'x'}, 'simulation': {'fps': 20}},
                     {'experiment': {'name': 'x'}, 'simulation': {'fixed_delta_seconds': -1}},
                     {'experiment': {'name': 'x'}, 'simulation': {'required_sensors': ['rgb']}}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                from_dict(ExperimentConfig, data)
