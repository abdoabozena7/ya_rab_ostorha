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
        self.wall_sample_times = {}
        self.pending_collisions = deque()
        self.pending_frames = deque()
        self.assets = OrderedDict()
        self.errors = {}
        self.queue_overflows = 0
        self.configurations = {}
        self.camera_mount_history = []
        self.driving_frames = OrderedDict()

    def spawn(self, sensor_id, blueprint_id, transform, attributes, decode):
        if sensor_id in self.actors:
            raise ValueError(f'Duplicate sensor ID: {sensor_id}')
        blueprint = self.world.get_blueprint_library().find(blueprint_id)
        if blueprint.has_attribute('role_name'):
            blueprint.set_attribute('role_name', 'ostorha_sensor')
        for key, value in attributes.items():
            blueprint.set_attribute(key, str(value))
        actor = self.world.spawn_actor(blueprint, transform, attach_to=self.ego)
        self.actors[sensor_id] = actor
        tick = float(attributes.get('sensor_tick', 0))
        mount = {'positionM': vector(transform.location), 'rotationDeg': rotation(transform.rotation)}
        self.sample_times[sensor_id] = deque(maxlen=40)
        self.wall_sample_times[sensor_id] = deque(maxlen=80)
        self.configurations[sensor_id] = {'blueprint': blueprint_id, 'actorId': actor.id,
                                         'attributes': dict(attributes),
                                         'mountTransform': mount, 'sensorTickSeconds': tick,
                                         'requestedRateHz': 1/tick if tick else None}
        try:
            def receive(data):
                with self.lock:
                    if self.actors.get(sensor_id) is not actor:
                        return
                try:
                    received=time.monotonic()
                    decoded = decode(data)
                    from ..core.contracts import SensorFrame
                    if isinstance(decoded, SensorFrame):
                        from dataclasses import replace
                        decoded=replace(decoded,metadata={**decoded.metadata,
                            'received_monotonic_s':received,'decode_duration_ms':(time.monotonic()-received)*1000})
                    elif not isinstance(decoded, dict):
                        raise TypeError('Unexpected decoded sensor payload: '+sensor_id)
                except Exception as error:
                    with self.lock:
                        self.errors[sensor_id] = str(error)
                    return
                envelope = {'source': 'carla', 'sensorId': sensor_id, 'actorId': actor.id,
                            'frame': data.frame, 'timestamp': data.timestamp,
                            'mountTransform': ({'positionM': vector(self.camera_mount_at(data.frame).location),
                                                'rotationDeg': rotation(self.camera_mount_at(data.frame).rotation)}
                                               if sensor_id == 'drivingCamera' else mount),
                            'worldTransform': {'positionM': vector(data.transform.location),
                                               'rotationDeg': rotation(data.transform.rotation)},
                            'sensorTickSeconds': tick, 'requestedRateHz': 1/tick if tick else None,
                            'receivedMonotonic': time.monotonic(), 'data': decoded}
                with self.lock:
                    if self.actors.get(sensor_id) is actor:
                        self.frames[sensor_id] = envelope
                        self.sample_times[sensor_id].append(data.timestamp)
                        self.wall_sample_times[sensor_id].append(envelope['receivedMonotonic'])
                        from ..core.contracts import SensorFrame
                        if isinstance(decoded, SensorFrame) and sensor_id == 'drivingCamera':
                            self.driving_frames[decoded.frame_id]=decoded
                            while len(self.driving_frames)>32:self.driving_frames.popitem(last=False)
                        elif isinstance(decoded, SensorFrame):
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

    def wall_rates(self):
        with self.lock:
            now=time.monotonic()
            return {name: 0 if times and now-times[-1]>.5 else
                    (len(times)-1)/(times[-1]-times[0]) if len(times)>1 and times[-1]>times[0] else None
                    for name,times in self.wall_sample_times.items()}

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
            # Callbacks replace whole envelopes. Capture their references, then
            # serialize outside the callback lock so display work cannot delay
            # admission of the next complete safety observation.
            frames = dict(self.frames)
            configurations = dict(self.configurations)
        return {name: {**config, 'latestFrame': frames[name]['frame'] if name in frames else None,
                       'latestTimestamp': frames[name]['timestamp'] if name in frames else None,
                       'latestValidData': to_dict(frames[name]['data']) if name in frames else None,
                       'eventDriven': name == 'collision'} for name, config in configurations.items()}

    def enable_suite(self, api, fixed_delta, options=None):
        from ..core.contracts import SensorKind
        from .sensor_decoders import decode_sensor
        from .dashboard_tools import CAMERA_VIEWS
        options = options or {'camera_view':'front', 'camera_resolution':'640x360', 'camera_fov':90}
        x,y,z,pitch,yaw = CAMERA_VIEWS[options['camera_view']]
        driving_mount = api.Transform(api.Location(x=x,y=y,z=z), api.Rotation(pitch=pitch,yaw=yaw))
        fx,fy,fz,fp,fw = CAMERA_VIEWS['front']
        camera_mount=api.Transform(api.Location(x=fx,y=fy,z=fz),api.Rotation(pitch=fp,yaw=fw))
        self.camera_mount_history = [(0, driving_mount)]
        width,height = map(int, options['camera_resolution'].split('x'))
        camera = {'sensor_tick': fixed_delta, 'image_size_x': width, 'image_size_y': height,
                  'fov': options['camera_fov'], 'lens_k': 0, 'lens_kcube': 0}
        rgb = {**camera, 'enable_postprocess_effects': str(options.get('camera_postprocess', False)).lower(),
               'motion_blur_intensity': options.get('camera_motion_blur', 0),
               'motion_blur_max_distortion': 0 if not options.get('camera_motion_blur', 0) else .35,
               'bloom_intensity': options.get('camera_bloom', 0)}
        import json
        from pathlib import Path
        from ..learning.recovery_budget import active_ticket
        recovery=json.loads((Path(__file__).resolve().parents[2]/'config/congestion-recovery.json').read_text())
        from ..learning.hybrid_budget import active_ticket as hybrid_ticket
        hybrid=json.loads((Path(__file__).resolve().parents[2]/'config/hybrid-driving.json').read_text())
        hybrid_surround=bool(hybrid.get('surround_rig_accepted') or hybrid_ticket()) and not options.get('_suppress_pilot_surround',False)
        surround=bool(recovery.get('depth_sensors_accepted') or hybrid.get('surround_rig_accepted') or
                      (active_ticket() or hybrid_ticket()) and not options.get('_suppress_pilot_surround',False))
        depth_mount=camera_mount;depth_attributes={**camera,'image_size_x':320,'image_size_y':180,'fov':90}
        if surround and not hybrid_surround:
            box=self.ego.bounding_box
            # Wide views on the measured body boundary expose the near-body
            # strip needed for a complete turning/reversing footprint. The RGB
            # observer retains its independently calibrated fixed front view.
            depth_mount=api.Transform(api.Location(x=box.extent.x+box.location.x+.1,z=1.),api.Rotation(pitch=-5))
            depth_attributes={**depth_attributes,'fov':170}
        lidar_attributes={'sensor_tick':fixed_delta,'range':100,'channels':16,'points_per_second':32000,
                          'rotation_frequency':1/fixed_delta,'upper_fov':10,'lower_fov':-30}
        if hybrid_surround:
            # Diagnostic rig only: denser measured side returns and downward
            # beams address short-lived surface fragments without declaring
            # them static or dropping their reachable uncertainty. Native
            # timing/occlusion calibration is still required for admission.
            lidar_attributes.update(channels=32,points_per_second=128000,lower_fov=-60)
        plans = (
            ('frontCamera', SensorKind.RGB, 'sensor.camera.rgb', camera_mount,
             {**rgb,'image_size_x':320,'image_size_y':180,'fov':90,'enable_postprocess_effects':'false'}),
            ('drivingCamera', SensorKind.RGB, 'sensor.camera.rgb', driving_mount, rgb),
            ('depth', SensorKind.DEPTH, 'sensor.camera.depth', depth_mount, depth_attributes),
            ('radar', SensorKind.RADAR, 'sensor.other.radar', api.Transform(api.Location(x=2.5, z=.65)),
             {'sensor_tick': fixed_delta, 'range': 100, 'horizontal_fov': 30, 'vertical_fov': 20, 'points_per_second': 1500}),
            ('lidar', SensorKind.LIDAR, 'sensor.lidar.ray_cast', api.Transform(api.Location(z=1.9)),
             lidar_attributes),
            ('imu', SensorKind.IMU, 'sensor.other.imu', api.Transform(), {'sensor_tick': fixed_delta}),
            ('gnss', SensorKind.GNSS, 'sensor.other.gnss', api.Transform(api.Location(z=1.6)), {'sensor_tick': fixed_delta}),
        )
        if hybrid_surround:
            box=self.ego.bounding_box
            front=box.location.x+box.extent.x+.1;rear=box.location.x-box.extent.x-.1
            half=box.extent.y+abs(box.location.y)+.1
            attrs={**camera,'image_size_x':240,'image_size_y':135,'fov':120}
            plans+=tuple((name,SensorKind.DEPTH,'sensor.camera.depth',
                api.Transform(api.Location(x=x,y=y,z=1.),api.Rotation(pitch=-5,yaw=yaw)),attrs)
                for name,x,y,yaw in (('frontLeftDepth',front,-half,-45),('frontRightDepth',front,half,45),
                                    ('rearLeftDepth',rear,-half,-135),('rearRightDepth',rear,half,135)))
            radar_attrs={'sensor_tick':fixed_delta,'range':60,'horizontal_fov':100,
                         'vertical_fov':10,'points_per_second':2000}
            plans+=tuple((name,SensorKind.RADAR,'sensor.other.radar',
                api.Transform(api.Location(x=x,y=y,z=.65),api.Rotation(yaw=yaw)),radar_attrs)
                for name,x,y,yaw in (('frontLeftRadar',front,-half,-45),('frontRightRadar',front,half,45),
                                    ('rearLeftRadar',rear,-half,-135),('rearRightRadar',rear,half,135)))
        elif surround:
            # Low resolution native depth, mounted outside our own body. No
            # display camera movement changes these calibrated observations.
            box=self.ego.bounding_box
            rear=-box.location.x+box.extent.x+.1
            half=box.extent.y+abs(box.location.y)+.1
            attrs={**camera,'image_size_x':160,'image_size_y':90,'fov':170}
            plans+=tuple((name,SensorKind.DEPTH,'sensor.camera.depth',
                api.Transform(api.Location(x=x,y=y,z=1.),api.Rotation(pitch=-5,yaw=yaw)),attrs)
                for name,x,y,yaw in (('rearDepth',-rear,0.,180),('leftDepth',0.,-half,-90),('rightDepth',0.,half,90)))
        for name, kind, blueprint, mount, attrs in plans:
            self.spawn(name, blueprint, mount, attrs,
                       lambda data, n=name, k=kind, m=mount, a=attrs: decode_sensor(self, n, k, data,
                           self.camera_mount_at(data.frame) if n == 'drivingCamera' else m, a))
        if 'collision' not in self.actors:
            self.enable_collision(api)

    def camera_mount_at(self, frame_id):
        with self.lock:
            return next(mount for frame, mount in reversed(self.camera_mount_history) if frame <= frame_id)

    def change_camera_view(self, api, view):
        from .dashboard_tools import CAMERA_VIEWS
        x,y,z,pitch,yaw = CAMERA_VIEWS[view]
        mount = api.Transform(api.Location(x=x,y=y,z=z), api.Rotation(pitch=pitch,yaw=yaw))
        # Changing presentation does not change perception or depth calibration.
        effective_frame = self.world.get_snapshot().frame+1
        for name in ('drivingCamera',):
            self.actors[name].set_transform(mount)
        with self.lock:
            self.camera_mount_history.append((effective_frame,mount))
            self.camera_mount_history = self.camera_mount_history[-32:]
            for name in ('drivingCamera',):
                self.configurations[name]['mountTransform'] = {'positionM':vector(mount.location), 'rotationDeg':rotation(mount.rotation)}

    def close(self):
        with self.lock:
            actors = list(self.actors.values())
            self.actors.clear(); self.frames.clear(); self.sample_times.clear()
            self.wall_sample_times.clear()
            self.pending_frames.clear(); self.assets.clear(); self.configurations.clear()
            self.driving_frames.clear()
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
