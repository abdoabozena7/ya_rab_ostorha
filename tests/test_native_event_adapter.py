"""Contract regression checks, explicitly not native gate evidence."""
import unittest
from types import SimpleNamespace
from backend.core.contracts import CollisionEvent, to_dict
from backend.core.service import SimulationService
from backend.core.events import EventType
from tests.core_packets import packet


class NativeEventAdapterTests(unittest.TestCase):
    def test_delayed_collision_keeps_its_actual_frame_and_time(self):
        collision = CollisionEvent(21, 1.05, 99, 100, (3., 4., 0.), 'carla-world',
                                   other_actor_type='static.prop.container', impulse_magnitude_ns=5.)
        provider = SimpleNamespace(name='test-fixture', drain_collision_events=lambda: (collision,))
        service = SimulationService(provider)
        service._publish(packet(22, 1.1))
        events = []; service.events.subscribe(events.append, EventType.CollisionDetected)
        service._drain_collision_events()
        self.assertEqual((events[0].frame_id, events[0].timestamp_s), (21, 1.05))
        self.assertEqual(to_dict(events[0])['payload']['collision']['other_actor_type'], 'static.prop.container')

    def test_collision_magnitude_cannot_misrepresent_vector(self):
        with self.assertRaises(ValueError):
            CollisionEvent(21, 1.05, 99, 100, (3., 4., 0.), 'carla-world', impulse_magnitude_ns=10.)
