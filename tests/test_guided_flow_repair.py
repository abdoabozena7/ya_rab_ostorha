"""Native lifecycle, immutable forecast selection and retained result regressions."""
import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import Mock,patch
import numpy as np
from PIL import Image
from backend.core.display_prediction import measured_control_view
from backend.core.video_prediction import draw_forecast
from backend.carla.stop_helper import stopped_service
from tests import test_guided_presentation as guided_tests
from tests.test_video_prediction import camera,forecast


class GuidedLifecycleRepairTests(unittest.TestCase):
    setUp=guided_tests.GuidedPresentationTests.setUp
    tick=guided_tests.GuidedPresentationTests.tick
    def test_finish_waits_for_both_annotated_exports_then_shuts_down_once(self):
        self.p.data.update(id='session',status='RESULTS',guided=True,pair_id='pair')
        self.s.stop_simulator=Mock()
        states={'NORMAL':{'status':'READY'},'ROBOSPHERE':{'status':'ENCODING_ANNOTATION'}}
        self.p.video_states=lambda:copy.deepcopy(states)
        self.p.finish('session');self.p.finish('session');self.tick()
        self.assertEqual(self.p.data['status'],'FINISHING');self.s.stop_simulator.assert_not_called()
        self.assertEqual(self.p.snapshot()['progress']['stage'],'FINISHING')
        states['ROBOSPHERE']={'status':'READY','annotation_required':True}
        self.tick();self.s.stop_simulator.assert_not_called()
        states['ROBOSPHERE']['variants']={'annotated':{'status':'READY'}}
        self.tick();self.p.finish('session');self.tick()
        self.assertEqual(self.p.data['status'],'COMPLETE');self.s.stop_simulator.assert_called_once()
        self.assertEqual(self.p.data['completed_pair_id'],'pair')

    def test_export_failure_keeps_results_and_requires_an_explicit_retry(self):
        self.p.data.update(id='session',status='RESULTS',guided=True,pair_id='pair')
        self.s.stop_simulator=Mock()
        self.p.video_states=lambda:{'NORMAL':{'status':'ERROR','error':'encoder failed'}}
        self.s.journey_comparison.data['runs']={'NORMAL':{'recording':'saved-run'}}
        self.p.finish('session');self.tick()
        self.assertEqual(self.p.data['status'],'RESULTS');self.s.stop_simulator.assert_not_called()
        self.assertIn('original recordings',self.p.data['finish_error'])
        with patch('backend.core.driving_video.retry_export') as retry:
            self.p.finish('session');self.p.finish('session')
            retry.assert_called_once_with(Path('saved-run'))

    def test_duplicate_selected_start_does_not_recreate_the_car_or_recording(self):
        self.p.preload('page-first');identity=self.p.data['id'];self.p.data['status']='CHOOSING'
        self.p.choose_preloaded(identity,'NORMAL','page-first')
        self.p.choose_preloaded(identity,'NORMAL','page-first')
        self.assertEqual(len([a for a in self.s.actions if a[0]=='prepare_guided_vehicle']),1)
        self.assertEqual(self.p.data['status'],'SELECTING')

    def test_late_export_read_cannot_close_a_new_presentation(self):
        self.p.data.update(id='old',status='RESULTS',guided=True,pair_id='old-pair')
        self.p.finish('old');self.s.stop_simulator=Mock()
        def states():
            self.p.cancel('operator_stop');self.p.start(120,guided=True,seed=42)
            return {mode:{'status':'READY'} for mode in self.p.MODES}
        self.p.video_states=states
        self.tick();self.s.stop_simulator.assert_not_called()
        self.assertNotEqual(self.p.data['id'],'old');self.assertEqual(self.p.data['status'],'STOPPING')

    def test_completed_result_is_restored_by_the_sdk_free_stopped_host(self):
        data={'id':'session','status':'COMPLETE','guided':True,'pair_id':'pair',
              'completed_pair_id':'pair','finish_requested':True}
        s=stopped_service({'result':{'status':'STOPPED','process_exited':True,'presentation':data}},Mock())
        snapshot=s.snapshot()
        self.assertFalse(snapshot['connected']);self.assertEqual(snapshot['presentation']['pair_id'],'pair')
        self.assertEqual(snapshot['presentation']['status'],'COMPLETE')
        self.assertTrue(snapshot['simulatorStop']['process_exited'])


class FocusedForecastTests(unittest.TestCase):
    def test_crossing_forecast_covers_the_speed_dependent_stopping_horizon(self):
        from dataclasses import replace
        from backend.core.kinematic_prediction import kinematic_modes
        from backend.core.pedestrian_anticipation import crossing_forecast
        from backend.core.motion_geometry import VehicleGeometry
        from tests.test_pedestrian_anticipation import PedestrianAnticipationTests
        from tests.test_normal_navigation import command
        prediction,observation=PedestrianAnticipationTests().case()
        prediction['tracks'][0]['position_m']=[85.,5.]
        prediction['trajectories']=kinematic_modes(prediction['tracks'],grid=np.arange(81)*.1)
        observation.ego.speed_mps=20.
        result=crossing_forecast(prediction,observation,replace(command(.75),steering=0.),VehicleGeometry())
        self.assertIsNotNone(result);self.assertGreater(result['time_s'],3.)

    def test_only_the_actual_person_conflict_is_shared_with_live_and_exported_video(self):
        source=forecast();source['tracks']+=[{'id':2,'class':'person','confirmed':True,'position_m':[5,3]}]
        source['tracks'][0]['position_m']=[10.,2.]
        source['trajectories']*=8
        scene=NS(session_id='native-session',observation=NS(frame_id=2,timestamp_s=.1),prediction=source)
        selected={'track_id':1,'source':'PEDESTRIAN_POSSIBLE_START','trajectory':source['trajectories'][0]['points']}
        original=copy.deepcopy(source)
        focused=measured_control_view(scene,source['render_reference'],focused=True,
            decision={'frame_id':2,'pedestrian_prediction':selected})
        self.assertEqual(len(focused['trajectories']),1);self.assertEqual(len(focused['tracks']),1)
        self.assertEqual(focused['trajectories'][0]['points'],selected['trajectory'])
        self.assertEqual(draw_forecast(Image.new('RGB',(800,450)),focused,camera(),'native-session',predictive=True),1)
        self.assertEqual(source,original)
        empty=measured_control_view(scene,source['render_reference'],focused=True,decision={'frame_id':1,'pedestrian_prediction':selected})
        self.assertEqual(empty['trajectories'],[])

    def test_video_draws_at_most_one_hazard_and_one_actually_selected_ego_path(self):
        source=forecast();source['trajectories']*=20
        source.update(selected_path=[[0.,0.,0.,0.],[1.,12.,0.,0.]],selected_path_reference=source['render_reference'])
        view={**camera(),'timestamp_s':.15,'frame_id':3}
        self.assertEqual(draw_forecast(Image.new('RGB',(800,450)),source,view,'native-session',predictive=True),2)
        self.assertEqual(draw_forecast(Image.new('RGB',(800,450)),source,view,'native-session',predictive=False),0)
        source['selected_path_timestamp_s']=view['timestamp_s']-.2
        self.assertEqual(draw_forecast(Image.new('RGB',(800,450)),source,view,'native-session',predictive=True),1)

    def test_high_speed_grid_extends_coverage_without_claiming_unknown_cells(self):
        from backend.core.maneuver import ObservedSpace
        from backend.core.motion_geometry import VehicleGeometry
        space=ObservedSpace(np.empty((0,3)),VehicleGeometry(),limit_m=95.)
        path=np.asarray([[0.,0.,0.,0.],[1.,70.,0.,0.]])
        self.assertEqual(space.free.shape,(381,381))
        self.assertFalse(space.certificate(path)['verified'])

    def test_forward_fusion_is_cached_only_within_one_frame_and_driving_intent(self):
        from backend.core.active_safety import assess_forward_space,RuntimeSafetyConfig
        from tests.test_active_safety import scene
        from tests.test_safety_teacher import case
        observation,_=case(distance=None,speed=120/3.6)
        observation,reader=scene(observation,clear=True);reader=Mock(wraps=reader)
        config=RuntimeSafetyConfig.load()
        space=NS(forward_assessments={},ground_plane=(0.,0.,0.),continuous_coverage=Mock(return_value=80.))
        first=assess_forward_space(observation,reader,config,measured_space=space)
        calls=reader.call_count
        self.assertIs(assess_forward_space(observation,reader,config,measured_space=space),first)
        self.assertEqual(reader.call_count,calls)
        self.assertGreater(space.continuous_coverage.call_args.args[0][-1,1],45.)
        assess_forward_space(observation,reader,config,measured_space=space,steering=.1)
        self.assertGreater(reader.call_count,calls)


class CrossingFixtureValidityTests(unittest.TestCase):
    def test_partial_motion_at_a_curb_does_not_count_as_a_complete_crossing(self):
        from unittest.mock import MagicMock
        from backend.carla.pilot_world import PilotWorld
        api=NS(Vector3D=MagicMock(),WalkerControl=lambda **value:value)
        point=MagicMock();point.__sub__.return_value.length.return_value=15.
        actor=NS(id=5,type_id='walker.pedestrian.0001',get_location=lambda:point,apply_control=Mock())
        provider=NS(connection=NS(api=api),ego=NS(actor=NS(get_location=lambda:point)))
        fixture=PilotWorld(provider);fixture.actors=[actor];fixture.started=0.
        fixture.forward=NS(x=1.,y=0.);fixture.right=NS(x=0.,y=1.);fixture.origin=NS(x=0.,y=0.)
        fixture.events=[{'actor_id':5,'kind':'PEDESTRIAN_CROSSING','at_s':0.,'duration_s':6.,
            'eligible':False,'realized':False,'start_position':None,'crossing_direction':-1,
            'completion_policy':'CROSS_TO_OPPOSITE_CLEARANCE'}]
        position=[14.,1.8,1.];fixture._actor=lambda _: {'position':list(position)}
        fixture.before_tick(1.)
        position[1]=1.;fixture.before_tick(2.)
        self.assertFalse(fixture.events[0]['realized'])
        position[1]=-2.1;fixture.before_tick(3.)
        self.assertTrue(fixture.events[0]['realized'])
