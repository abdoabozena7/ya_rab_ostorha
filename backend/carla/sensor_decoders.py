"""Native CARLA 0.9.16 decoders. No sensor generation or substitute rendering."""
import io
import math
from ..core.contracts import SensorFrame, SensorKind, Transform, RotationRad
from .contracts import CARLA_WORLD


def canonical_transform(native):
    p, r = native.location, native.rotation
    return Transform((p.x, p.y, p.z), RotationRad(*(math.radians(v) for v in (r.roll, r.pitch, r.yaw))), CARLA_WORLD)


def decode_depth(raw_data, width, height):
    import numpy as np
    bgra = np.frombuffer(raw_data, dtype=np.uint8).reshape(height, width, 4)
    packed = bgra[:, :, 2].astype(np.uint32)+bgra[:, :, 1].astype(np.uint32)*256+bgra[:, :, 0].astype(np.uint32)*65536
    return (packed.astype(np.float64)*(1000./16777215.)).astype(np.float32)


def decode_sensor(manager, sensor_id, kind, native, mount, attributes):
    import numpy as np
    metadata = {'mount_transform': {'position_m': [mount.location.x, mount.location.y, mount.location.z],
                 'rotation_deg': {'pitch': mount.rotation.pitch, 'yaw': mount.rotation.yaw, 'roll': mount.rotation.roll}},
                 'sensor_tick_s': float(attributes['sensor_tick']), 'attributes': dict(attributes)}
    data, units, asset = {}, {}, None
    if kind in (SensorKind.RGB, SensorKind.DEPTH):
        metadata.update(width=native.width, height=native.height, fov_deg=native.fov,
                        source_encoding='CARLA BGRA8')
    if kind == SensorKind.RGB:
        from PIL import Image
        bgra = np.frombuffer(native.raw_data, np.uint8).reshape(native.height, native.width, 4)
        rgb = bgra[:, :, [2, 1, 0]]
        encoded = io.BytesIO(); Image.fromarray(rgb).save(encoded, format='JPEG', quality=85)
        asset = manager.cache_asset('rgb', f'{sensor_id}-{manager.actors[sensor_id].id}-{native.frame}.jpg', encoded.getvalue(), 'image/jpeg')
        metadata['encoding'] = 'JPEG RGB (compressed native image)'
    elif kind == SensorKind.DEPTH:
        depth = decode_depth(native.raw_data, native.width, native.height)
        encoded = io.BytesIO(); np.save(encoded, depth, allow_pickle=False)
        asset = manager.cache_asset('depth', f'{sensor_id}-{manager.actors[sensor_id].id}-{native.frame}.npy', encoded.getvalue(), 'application/x-npy')
        units = {'depth': 'm'}; metadata.update(dtype='float32', shape=list(depth.shape), encoding='linear depth metres')
    elif kind == SensorKind.LIDAR:
        points = np.frombuffer(native.raw_data, dtype='<f4').reshape(-1, 4)
        asset = manager.cache_asset('lidar', f'{sensor_id}-{manager.actors[sensor_id].id}-{native.frame}.bin', bytes(native.raw_data), 'application/octet-stream')
        units = {'x': 'm', 'y': 'm', 'z': 'm', 'intensity': 'unitless'}
        metadata.update(point_count=len(points), channels=native.channels, horizontal_angle_rad=native.horizontal_angle,
                        dtype='little-endian float32', columns=['x', 'y', 'z', 'intensity'], coordinate_frame='sensor-local-x-forward-y-right-z-up')
    elif kind == SensorKind.RADAR:
        data = {'detections': [{'depth_m': d.depth, 'azimuth_rad': d.azimuth, 'altitude_rad': d.altitude,
                               'velocity_mps': d.velocity} for d in native]}
        units = {'depth_m': 'm', 'azimuth_rad': 'rad', 'altitude_rad': 'rad', 'velocity_mps': 'm/s'}
    elif kind == SensorKind.IMU:
        data = {'accelerometer_mps2': [native.accelerometer.x, native.accelerometer.y, native.accelerometer.z],
                'gyroscope_radps': [native.gyroscope.x, native.gyroscope.y, native.gyroscope.z], 'compass_rad': native.compass}
        units = {'accelerometer_mps2': 'm/s^2', 'gyroscope_radps': 'rad/s', 'compass_rad': 'rad'}
    elif kind == SensorKind.GNSS:
        data = {'latitude_deg': native.latitude, 'longitude_deg': native.longitude, 'altitude_m': native.altitude}
        units = {'latitude_deg': 'deg', 'longitude_deg': 'deg', 'altitude_m': 'm'}
    else:
        raise ValueError(f'Unregistered native decoder: {kind}')
    return SensorFrame(sensor_id, kind, native.frame, native.timestamp, native.timestamp,
                       canonical_transform(native.transform), 'carla', manager.actors[sensor_id].id,
                       1/float(attributes['sensor_tick']), data, units, asset, metadata)
