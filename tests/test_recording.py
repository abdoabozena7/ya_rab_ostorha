import json
from pathlib import Path
import tempfile
import unittest
from backend.recording import FrameRecorder


class RecordingTests(unittest.TestCase):
    def test_frames_match_and_unmatched_sensors_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'frames.jsonl'
            recorder = FrameRecorder(path)
            vehicle = {'source': 'carla', 'frame': 15}
            world = {'source': 'carla', 'frame': 15, 'timestamp': .75}
            sensors = {'imu': {'frame': 15, 'data': {'compass': 1}}, 'rgb': {'frame': 14, 'data': {'reference': '14.png'}}}
            recorder.record(vehicle, world, sensors)
            recorder.record(vehicle, world, sensors)
            with self.assertRaises(ValueError):
                recorder.record({**vehicle, 'frame': 14}, world, sensors)
            recorder.close()
            lines = path.read_text().splitlines()
            self.assertEqual(len(lines), 1)
            record = json.loads(lines[0])
            self.assertEqual(set(record['sensors']), {'imu'})
            self.assertEqual(record['unmatchedSensorFrames'], {'rgb': 14})
