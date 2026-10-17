import unittest
from scripts.validate_rule_bypass import gates,display_publication_compatible


class RuleBypassAcceptanceTests(unittest.TestCase):
    def test_archive_exception_accepts_only_the_single_display_publication_timestamp(self):
        import hashlib
        name='backend\\core\\display_prediction.py';prior=b"return {\n 'timestamp_s':scene.timestamp,\n}\n"
        current=prior.replace(b"}\n",b" 'published_wall_s':time.monotonic(),\n}\n")
        expected=hashlib.sha256(prior).hexdigest()
        self.assertTrue(display_publication_compatible(name,current,expected))
        self.assertFalse(display_publication_compatible('backend\\core\\service.py',current,expected))
        self.assertFalse(display_publication_compatible(name,current.replace(b'scene.timestamp',b'0'),expected))
        self.assertFalse(display_publication_compatible(name,current+ b"'published_wall_s':time.monotonic(),\n",expected))
        self.assertFalse(display_publication_compatible(name,prior,expected))

    def clear(self,side):
        return {'scenario':'RULE_BYPASS_'+side.upper(),'native_checks_ok':True,'arrived':True,
            'actual_passing_side':side,'maximum_unexplained_stop_s':1.,'ordinary_resumed':True,
            'resumed_maximum_speed_kmh':20.}

    def test_arrival_without_passing_or_resumed_cruise_cannot_accept_the_overlay(self):
        left,right=self.clear('left'),self.clear('right')
        self.assertTrue(gates([left,right])['ordinary_resume'])
        left['ordinary_resumed']=False
        self.assertFalse(gates([left,right])['clear_left'])
        left['ordinary_resumed']=True;left['actual_passing_side']=None
        self.assertFalse(gates([left,right])['ordinary_resume'])

    def test_waiting_at_an_occupied_lane_is_a_hold_case_and_not_a_successful_pass(self):
        case={'scenario':'RULE_BYPASS_OCCUPIED','native_checks_ok':True,'arrived':False,
            'maximum_unexplained_stop_s':12.,'maximum_forward_m':9.,'maximum_lateral_m':.2}
        result=gates([case]);self.assertTrue(result['occupied_lane']);self.assertFalse(result['ordinary_resume'])
        case['maximum_lateral_m']=2.
        self.assertFalse(gates([case])['occupied_lane'])

    def test_current_source_failure_cannot_pass_a_gate(self):
        case=self.clear('right');case['native_checks_ok']=False
        self.assertFalse(gates([case])['clear_right'])

    def test_a_brief_signal_stop_followed_by_departure_cannot_accept_the_red_light_case(self):
        case={'scenario':'RULE_BYPASS_RED_SIGNAL','native_checks_ok':True,'arrived':False,
            'red_signal_stopped_samples':100,'red_signal_held_at_end':False,'actions':{'RULE_FOLLOW':200}}
        self.assertFalse(gates([case])['traffic_stop'])
        case['red_signal_held_at_end']=True
        self.assertTrue(gates([case])['traffic_stop'])

    def test_deployment_requires_current_source_all_gates_and_the_tested_scope(self):
        import json,tempfile
        from pathlib import Path
        from unittest.mock import patch
        from backend.core.route_bypass import availability
        config={'enabled':True,'accepted_sides':['left','right'],'maneuver_speed_mps':2.}
        report={'accepted':True,'source_fingerprint':'current','tested_sides':['left','right'],
            'maximum_maneuver_speed_mps':2.,'gates':dict.fromkeys(
                ['clear_left','clear_right','occupied_lane','traffic_stop','ordinary_resume'],True)}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'report.json'
            with patch('backend.core.route_bypass.configuration',return_value=config),\
                 patch('backend.core.route_bypass.active_ticket',return_value=None),\
                 patch('backend.core.route_bypass.source_fingerprint',return_value='current'),\
                 patch('backend.core.route_bypass.REPORT',path):
                try:
                    for changes,expected in [({},True),({'source_fingerprint':'old'},False),
                            ({'tested_sides':['left']},False),({'maximum_maneuver_speed_mps':1.},False),
                            ({'gates':{**report['gates'],'traffic_stop':False}},False)]:
                        path.write_text(json.dumps({**report,**changes}));availability.cache_clear()
                        self.assertEqual(availability(0)['available'],expected)
                finally:availability.cache_clear()
