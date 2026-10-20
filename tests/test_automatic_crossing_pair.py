import copy
import unittest
from unittest.mock import Mock,patch
from tests import test_guided_presentation as guided


class AutomaticPairTests(unittest.TestCase):
    setUp=guided.GuidedPresentationTests.setUp
    tick=guided.GuidedPresentationTests.tick
    first=guided.GuidedPresentationTests.first
    end=guided.GuidedPresentationTests.end

    def test_both_orders_advance_only_after_actual_terminal_event(self):
        for first in ('NORMAL','ROBOSPHERE'):
            with self.subTest(first=first):
                self.first(first);self.p.data['automatic_pair']=True
                with self.assertRaisesRegex(ValueError,'arrival or contact'):self.p.request_next(self.p.data['id'],0,'DRIVING')
                self.assertEqual(self.s.journey['status'],'RUNNING')
                before=copy.deepcopy(self.s.journey_comparison.data)
                self.end('collision' if first=='NORMAL' else 'destination_reached')
                self.assertEqual(self.p.data['status'],'RESTORING')
                self.s.queue_dashboard_action.assert_called_once()
                self.tick();self.s.queue_dashboard_action.assert_called_once()
                self.s.dashboard_result={'action':'prepare_journey_mode','status':'APPLIED'}
                self.tick();self.tick()
                other=self.p.data['modes'][1]
                self.assertEqual(self.s.start_journey.call_args.kwargs['driving_mode'],other)
                self.s.journey_comparison.begin(other,before['manifest'],pair_id=before['pair_id'])
                self.s.journey.update(status='RUNNING');self.tick()
                self.end('collision' if other=='NORMAL' else 'destination_reached')
                self.assertEqual(self.p.data['status'],'RESULTS')
                self.assertNotIn('SHORTENED',[r['status'] for r in self.s.journey_comparison.data['runs'].values()])
                self.p.cancel('next test');self.s.queue_dashboard_action.reset_mock();self.s.dashboard_result=None

    def test_long_recording_has_no_automatic_shortening_deadline(self):
        self.first();self.p.data['automatic_pair']=True
        self.s.journey_comparison.active['duration_s']=190.
        self.time=700.;self.tick()
        self.assertEqual(self.p.data['status'],'DRIVING');self.assertEqual(self.s.journey['status'],'RUNNING')

    def test_real_fault_retains_failure_without_starting_another_drive(self):
        self.first();self.p.data['automatic_pair']=True
        self.s._stop_navigation('runtime_failure',status='ERROR');self.tick();self.tick()
        self.assertEqual(self.p.data['status'],'RESULTS');self.assertEqual(self.p.data['outcome'],'FAILED')
        self.s.queue_dashboard_action.assert_not_called()

    def test_finish_waits_for_third_export_and_is_idempotent(self):
        self.p.data.update(id='session',status='RESULTS',guided=True,automatic_pair=True,pair_id='pair')
        self.s.journey_comparison.data['pair_id']='pair'
        self.s.journey_comparison.data['runs']={m:{} for m in self.p.MODES}
        self.p.video_states=lambda:{m:{'status':'READY'} for m in self.p.MODES}
        self.s.stop_simulator=Mock()
        with patch('backend.core.shared_perception.ensure_shared',return_value={'status':'ENCODING'}) as export:
            self.p.finish('session');self.p.finish('session');self.tick()
            self.s.stop_simulator.assert_not_called();self.assertEqual(self.p.data['status'],'FINISHING')
            export.return_value={'status':'READY','video':'shared-perception.mp4','duration_s':2.}
            self.tick();self.tick()
            self.s.stop_simulator.assert_called_once();self.assertEqual(self.p.data['status'],'COMPLETE')
            self.assertEqual(self.s.journey_comparison.data['shared_perception']['status'],'READY')
