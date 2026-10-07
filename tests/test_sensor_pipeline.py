"""Decoder/transport regressions only; these do not establish native gate PASS."""
import hashlib
import unittest
from types import SimpleNamespace

from backend.carla.sensor_decoders import decode_depth
from backend.carla.sensors import CarlaSensorManager
from backend.core.contracts import AssetReference, CollisionEvent, SensorFrame, SensorKind
from backend.core.service import SimulationService
from tests.core_packets import TRANSFORM, packet


class SensorPipelineTests(unittest.TestCase):
    def test_delayed_camera_frame_retains_its_original_mount(self):
        manager = CarlaSensorManager(None, None)
        front, chase, rear = object(), object(), object()
        manager.camera_mount_history = [(0, front), (120, chase), (160, rear)]
        self.assertIs(manager.camera_mount_at(119), front)
        self.assertIs(manager.camera_mount_at(120), chase)
        self.assertIs(manager.camera_mount_at(159), chase)
        self.assertIs(manager.camera_mount_at(170), rear)

    def test_depth_bgra_byte_order_and_endpoints(self):
        # Independently chosen packed values: 0, max, R=255, G=255, B=255.
        raw = bytes((0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 255, 255,
                     0, 255, 0, 255, 255, 0, 0, 255))
        expected = (0., 1000., 255 / 16777215 * 1000,
                    65280 / 16777215 * 1000, 16711680 / 16777215 * 1000)
        actual = decode_depth(raw, 5, 1)
        self.assertEqual(actual.shape, (1, 5))
        for value, reference in zip(actual[0], expected):
            self.assertAlmostEqual(float(value), reference, delta=.0001)

    def test_depth_refuses_incorrect_image_size(self):
        with self.assertRaises(ValueError):
            decode_depth(bytes(7), 2, 1)

    def test_http_asset_selection_keeps_requested_frame(self):
        payloads = {'rgb/one.jpg': b'first', 'rgb/two.jpg': b'second'}
        provider = SimpleNamespace(name='test-fixture',
                                   get_sensor_asset=lambda asset: payloads[asset.path])
        service = SimulationService(provider)
        for frame, path in ((1, 'rgb/one.jpg'), (2, 'rgb/two.jpg')):
            data = payloads[path]
            asset = AssetReference(path, 'image/jpeg', len(data), hashlib.sha256(data).hexdigest())
            sensor = SensorFrame('frontCamera', SensorKind.RGB, frame, frame*.05,
                                 frame*.05, TRANSFORM, 'test-fixture', asset=asset)
            service._publish(packet(frame, frame*.05, sensors=(sensor,)))
        image, metadata = service.get_camera_frame(1)
        self.assertEqual((image, metadata['frame']), (b'first', 1))
        image, metadata = service.get_sensor_asset('frontCamera', 1)
        self.assertEqual((image, metadata['frame']), (b'first', 1))
        self.assertEqual(service.get_camera_frame(99), (None, None))
        with self.assertRaises(KeyError):
            service.get_sensor_asset('frontCamera', 99)

    def test_collision_is_event_json_and_has_no_binary_asset(self):
        service = SimulationService(None)
        service._publish(packet(2, .1))
        service.collision_events.append(CollisionEvent(1, .05, 1, 2, (3., 4., 0.),
                                                     'test-coordinate-frame', impulse_magnitude_ns=5.))
        event = service.get_sensor_frame('collision')
        self.assertEqual(event['collision']['frame_id'], 1)
        self.assertTrue(event['event_driven'])
        with self.assertRaises(KeyError):
            service.get_sensor_asset('collision')
