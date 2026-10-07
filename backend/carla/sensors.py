"""Own native CARLA sensors and decode callbacks into canonical frame contracts."""
import threading
import time
from collections import deque, OrderedDict
from .telemetry import vector, rotation


class CarlaSensorManager:
    def __init__(self, world, ego):
        self.world, self.ego = world, ego
        self.actors = {}
        self.frames = {}
        self.lock = threading.RLock()
        self.cleanup_errors = []
        self.sample_times = {}
        self.pending_collisions = deque()
        self.pending_frames = deque()
        self.assets = OrderedDict()
        self.errors = {}
        self.queue_overflows = 0
        self.configurations = {}
        self.camera_mount_history = []

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
        self.configurations[sensor_id] = {'blueprint': blueprint_id, 'actorId': actor.id,
                                         'mountTransform': mount, 'sensorTickSeconds': tick,
                                         'requestedRateHz': 1/tick if tick else None}
        try:
            def receive(data):
                with self.lock:
                    if self.actors.get(sensor_id) is not actor:
                        return
                try:
                    decoded = decode(data)
                except Exception as error:
                    with self.lock:
                        self.errors[sensor_id] = str(error)
                    return
                envelope = {'source': 'carla', 'sensorId': sensor_id, 'actorId': actor.id,
                            'frame': data.frame, 'timestamp': data.timestamp,
                            'mountTransform': ({'positionM': vector(self.camera_mount_at(data.frame).location),
                                                'rotationDeg': rotation(self.camera_mount_at(data.frame).rotation)}
                                               if sensor_id in ('frontCamera', 'depth') else mount),
                            'worldTransform': {'positionM': vector(data.transform.location),
                                               'rotationDeg': rotation(data.transform.rotation)},
                            'sensorTickSeconds': tick, 'requestedRateHz': 1/tick if tick else None,
                            'receivedMonotonic': time.monotonic(), 'data': decoded}
                with self.lock:
                    if self.actors.get(sensor_id) is actor:
                        self.frames[sensor_id] = envelope
                        self.sample_times[sensor_id].append(data.timestamp)
                        from ..core.contracts import SensorFrame
                        if isinstance(decoded, SensorFrame):
                            if len(self.pending_frames) >= 512:
                                self.pending_frames.popleft()
                                self.queue_overflows += 1
                                self.errors['queue'] = f'Sensor callback queue overflow: {self.queue_overflows} dropped samples'
                            self.pending_frames.append(decoded)
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

    def enable_collision(self, api):
        from ..core.contracts import CollisionEvent
        import math
        def decode(event):
            from .sensor_decoders import canonical_transform
            impulse = tuple(vector(event.normal_impulse))
            collision = CollisionEvent(event.frame, event.timestamp, self.ego.id,
                                       event.other_actor.id, impulse,
                                       'left-handed-x-forward-y-right-z-up',
                                       ego_transform=canonical_transform(event.transform),
                                       other_actor_type=event.other_actor.type_id,
                                       impulse_magnitude_ns=math.sqrt(sum(v*v for v in impulse)))
            with self.lock:
                if 'collision' in self.actors:
                    self.pending_collisions.append(collision)
            from ..core.contracts import to_dict
            return to_dict(collision)
        return self.spawn('collision', 'sensor.other.collision', api.Transform(), {}, decode)

    def drain_collisions(self):
        with self.lock:
            events = tuple(self.pending_collisions)
            self.pending_collisions.clear()
            return events

    def cache_asset(self, folder, filename, payload, media_type):
        import hashlib
        from ..core.contracts import AssetReference
        asset = AssetReference(f'{folder}/{filename}', media_type, len(payload), hashlib.sha256(payload).hexdigest())
        with self.lock:
            self.assets[asset.path] = payload
            while len(self.assets)>256:
                self.assets.popitem(last=False)
        return asset

    def asset_bytes(self, asset):
        with self.lock:
            return self.assets[asset.path]

    def drain_frames(self):
        with self.lock:
            frames = tuple(self.pending_frames); self.pending_frames.clear()
            return frames

    def registry(self):
        from ..core.contracts import to_dict
        with self.lock:
            return {name: {**config, 'latestFrame': self.frames[name]['frame'] if name in self.frames else None,
                           'latestTimestamp': self.frames[name]['timestamp'] if name in self.frames else None,
                           'latestValidData': to_dict(self.frames[name]['data']) if name in self.frames else None,
                           'eventDriven': name == 'collision'} for name, config in self.configurations.items()}

    def enable_suite(self, api, fixed_delta, options=None):
        from ..core.contracts import SensorKind
        from .sensor_decoders import decode_sensor
        from .dashboard_tools import CAMERA_VIEWS
        options = options or {'camera_view':'front', 'camera_resolution':'640x360', 'camera_fov':90}
        x,y,z,pitch,yaw = CAMERA_VIEWS[options['camera_view']]
        camera_mount = api.Transform(api.Location(x=x,y=y,z=z), api.Rotation(pitch=pitch,yaw=yaw))
        self.camera_mount_history = [(0, camera_mount)]
        width,height = map(int, options['camera_resolution'].split('x'))
        camera = {'sensor_tick': fixed_delta, 'image_size_x': width, 'image_size_y': height,
                  'fov': options['camera_fov'], 'lens_k': 0, 'lens_kcube': 0}
        plans = (
            ('frontCamera', SensorKind.RGB, 'sensor.camera.rgb', camera_mount, camera),
            ('depth', SensorKind.DEPTH, 'sensor.camera.depth', camera_mount, camera),
            ('radar', SensorKind.RADAR, 'sensor.other.radar', api.Transform(api.Location(x=2.5, z=.65)),
             {'sensor_tick': fixed_delta, 'range': 50, 'horizontal_fov': 30, 'vertical_fov': 20, 'points_per_second': 1500}),
            ('lidar', SensorKind.LIDAR, 'sensor.lidar.ray_cast', api.Transform(api.Location(z=1.9)),
             {'sensor_tick': fixed_delta, 'range': 50, 'channels': 16, 'points_per_second': 32000,
              'rotation_frequency': 1/fixed_delta, 'upper_fov': 10, 'lower_fov': -30}),
            ('imu', SensorKind.IMU, 'sensor.other.imu', api.Transform(), {'sensor_tick': fixed_delta}),
            ('gnss', SensorKind.GNSS, 'sensor.other.gnss', api.Transform(api.Location(z=1.6)), {'sensor_tick': fixed_delta}),
        )
        for name, kind, blueprint, mount, attrs in plans:
            self.spawn(name, blueprint, mount, attrs,
                       lambda data, n=name, k=kind, m=mount, a=attrs: decode_sensor(self, n, k, data,
                           self.camera_mount_at(data.frame) if n in ('frontCamera','depth') else m, a))
        if 'collision' not in self.actors:
            self.enable_collision(api)

    def camera_mount_at(self, frame_id):
        with self.lock:
            return next(mount for frame, mount in reversed(self.camera_mount_history) if frame <= frame_id)

    def change_camera_view(self, api, view):
        from .dashboard_tools import CAMERA_VIEWS
        x,y,z,pitch,yaw = CAMERA_VIEWS[view]
        mount = api.Transform(api.Location(x=x,y=y,z=z), api.Rotation(pitch=pitch,yaw=yaw))
        # No intervening simulation tick: both cameras adopt this mount at N+1.
        effective_frame = self.world.get_snapshot().frame+1
        for name in ('frontCamera','depth'):
            self.actors[name].set_transform(mount)
        with self.lock:
            self.camera_mount_history.append((effective_frame,mount))
            self.camera_mount_history = self.camera_mount_history[-32:]
            for name in ('frontCamera','depth'):
                self.configurations[name]['mountTransform'] = {'positionM':vector(mount.location), 'rotationDeg':rotation(mount.rotation)}

    def close(self):
        with self.lock:
            actors = list(self.actors.values())
            self.actors.clear(); self.frames.clear(); self.sample_times.clear()
            self.pending_frames.clear(); self.assets.clear(); self.configurations.clear()
            self.pending_collisions.clear()
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
