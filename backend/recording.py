"""Small JSONL interface; never group unrelated sensor and simulation frames."""
import json


class FrameRecorder:
    def __init__(self, path):
        self.file = open(path, 'a', encoding='utf-8')
        self.last_frame = None

    def record(self, vehicle, world, sensors):
        frame = world['frame']
        if (vehicle.get('source') != 'carla' or world.get('source') != 'carla'
                or vehicle['frame'] != frame):
            raise ValueError('Recording requires CARLA data with matching frame IDs')
        if frame == self.last_frame:
            return
        matched = {name: value for name, value in sensors.items() if value['frame'] == frame}
        record = {'frame': frame, 'timestamp': world['timestamp'], 'vehicle': vehicle,
                  'world': world, 'sensors': matched,
                  'unmatchedSensorFrames': {name: value['frame'] for name, value in sensors.items()
                                            if value['frame'] != frame}}
        self.file.write(json.dumps(record, allow_nan=False) + '\n')
        self.file.flush()
        self.last_frame = frame

    def close(self):
        self.file.close()
