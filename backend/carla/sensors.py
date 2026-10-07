"""Native sensor ownership/frame contract. Suite activation waits for checkpoint 1.

No sensor data is synthesized. A later validated sensor decoder can register
real CARLA callbacks through this manager without changing the application.
"""
import threading
import time
from collections import deque
from .telemetry import vector, rotation


class CarlaSensorManager:
    def __init__(self, world, ego):
        self.world, self.ego = world, ego
        self.actors = {}
        self.frames = {}
        self.lock = threading.RLock()
        self.cleanup_errors = []
        self.sample_times = {}

    def spawn(self, sensor_id, blueprint_id, transform, attributes, decode):
        if sensor_id in self.actors:
            raise ValueError(f'Duplicate sensor ID: {sensor_id}')
        blueprint = self.world.get_blueprint_library().find(blueprint_id)
        for key, value in attributes.items():
            blueprint.set_attribute(key, str(value))
        actor = self.world.spawn_actor(blueprint, transform, attach_to=self.ego)
        self.actors[sensor_id] = actor
        tick = float(attributes.get('sensor_tick', 0))
        mount = {'positionM': vector(transform.location), 'rotationDeg': rotation(transform.rotation)}
        self.sample_times[sensor_id] = deque(maxlen=40)
        try:
            def receive(data):
                envelope = {'source': 'carla', 'sensorId': sensor_id, 'actorId': actor.id,
                            'frame': data.frame, 'timestamp': data.timestamp,
                            'mountTransform': mount,
                            'worldTransform': {'positionM': vector(data.transform.location),
                                               'rotationDeg': rotation(data.transform.rotation)},
                            'sensorTickSeconds': tick, 'requestedRateHz': 1/tick if tick else None,
                            'receivedMonotonic': time.monotonic(), 'data': decode(data)}
                with self.lock:
                    if self.actors.get(sensor_id) is actor:
                        self.frames[sensor_id] = envelope
                        self.sample_times[sensor_id].append(data.timestamp)
            actor.listen(receive)
        except Exception:
            self.close()
            raise
        return actor

    def latest(self):
        with self.lock:
            return dict(self.frames)

    def rates(self):
        with self.lock:
            return {name: (len(times)-1)/(times[-1]-times[0])
                    if len(times) > 1 and times[-1] > times[0] else None
                    for name, times in self.sample_times.items()}

    def close(self):
        with self.lock:
            actors = list(self.actors.values())
            self.actors.clear(); self.frames.clear(); self.sample_times.clear()
        self.cleanup_errors = []
        for actor in actors:
            try:
                actor.stop()
            except RuntimeError as error:
                self.cleanup_errors.append(str(error))
            try:
                if actor.is_alive and not actor.destroy():
                    self.cleanup_errors.append(f'Could not destroy sensor {actor.id}')
            except RuntimeError as error:
                self.cleanup_errors.append(str(error))
