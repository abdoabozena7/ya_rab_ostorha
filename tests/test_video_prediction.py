"""Derived-video projection uses only current-session, already measured paths."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image
from backend.core.driver_profiles import driver_profile
from backend.core.video_prediction import draw_forecast,forecast_matches,project_prediction,remaining_forecast
from backend.core.driving_video import export_video
from tests import test_driving_video


def camera():
    return {'timestamp_s':.35,'frame_id':7,'world_transform':{'position_m':[0.,0.,1.6]},
            'calibration':{'width':800,'height':450,'fov_deg':90}}


def forecast():
    return {'session_id':'native-session','timestamp_s':.1,'evaluation_frame':2,
            'coordinate_frame':'EGO_AT_EVALUATION','render_reference':{'position_m':[0.,0.,0.]},
            'tracks':[{'id':1,'confirmed':True,'class':'person','semantic_evidence':{'confidence':.9}}],
            'trajectories':[{'track_id':1,'points':[[0.,10.,2.],[.5,10.,0.],[1.,10.,-2.]]}]}


class VideoPredictionTests(unittest.TestCase):
    def test_egypt_profiles_save_both_original_and_annotated_mp4_without_native_claims(self):
        try:import imageio_ffmpeg
        except ImportError:self.skipTest('MP4 encoder unavailable')
        for mode in ('NORMAL', 'ROBOSPHERE'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                test_driving_video.DrivingVideoTests().recording(root)
                (root / 'metadata.json').write_text(json.dumps({'data_origin': 'TEST_FIXTURE', 'provider': 'test',
                    'config': {'driver_profile': driver_profile(mode, 'EGYPT_URBAN_CHAOS_V1'), 'session_id': 'software-fixture'}}))
                status = export_video(root, allow_test_data=True)
                self.assertTrue(status['annotation_required'])
                self.assertEqual(status['preferred_video'], 'driving-annotated.mp4')
                self.assertEqual(status['variants']['annotated']['source'], 'TEST_FIXTURE_WITH_OVERLAY')
                self.assertEqual(status['variants']['annotated']['overlay']['predictive'], mode == 'ROBOSPHERE')
                self.assertGreater((root / 'driving.mp4').stat().st_size, 500)
                self.assertGreater((root / 'driving-annotated.mp4').stat().st_size, 500)

    def test_native_projection_and_elapsed_path_crop(self):
        self.assertAlmostEqual(project_prediction((10.,0.,1.6),forecast()['render_reference'],camera())[0],399.5)
        self.assertIsNone(project_prediction((-1.,0.,0.),forecast()['render_reference'],camera()))
        self.assertEqual(remaining_forecast(forecast()['trajectories'][0]['points'],.25)[0],[.25,10.,1.])

    def test_foreign_future_and_stale_forecasts_cannot_draw(self):
        source=forecast();view=camera()
        self.assertTrue(forecast_matches(source,view,'native-session'))
        for changes in ({'session_id':'other'},{'timestamp_s':.4},{'timestamp_s':-.5},{'evaluation_frame':8}):
            self.assertFalse(forecast_matches({**source,**changes},view,'native-session'))
        self.assertFalse(forecast_matches(source,{**view,'world_transform':{}},'native-session'))

    def test_paths_draw_only_for_predictive_mode(self):
        for predictive,expected in ((False,0),(True,1)):
            image=Image.new('RGB',(800,450))
            self.assertEqual(draw_forecast(image,forecast(),camera(),'native-session',predictive=predictive),expected)

    def test_raw_and_annotated_exports_are_distinct_and_record_actual_overlay_coverage(self):
        try:import imageio_ffmpeg
        except ImportError:self.skipTest('MP4 encoder unavailable')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);rows=test_driving_video.DrivingVideoTests().recording(root)
            for index,row in enumerate(rows):
                row.update(frame_id=index+1,world_transform={'position_m':[0.,0.,1.6]},
                           calibration={'width':160,'height':90,'fov_deg':90})
            (root/'telemetry/video-frames.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in rows))
            metadata={'data_origin':'TEST_FIXTURE','provider':'test','config':{
                'driver_profile':driver_profile('ROBOSPHERE'),'session_id':'native-session'}}
            (root/'metadata.json').write_text(json.dumps(metadata))
            prediction=forecast();prediction.update(timestamp_s=.1,evaluation_frame=2)
            (root/'telemetry/comparison-controls.jsonl').write_text(json.dumps({
                'kind':'VIDEO_PREDICTION','session_id':'native-session','prediction':prediction})+'\n')
            before=hashlib.sha256((root/'0.jpg').read_bytes()).hexdigest()
            status=export_video(root,allow_test_data=True)
            self.assertEqual(status['preferred_video'],'driving-annotated.mp4')
            self.assertTrue(status['annotation_required'])
            self.assertNotEqual(status['sha256'],status['variants']['annotated']['sha256'])
            self.assertEqual(status['variants']['annotated']['overlay']['forecast_frames'],3)
            self.assertEqual(before,hashlib.sha256((root/'0.jpg').read_bytes()).hexdigest())
