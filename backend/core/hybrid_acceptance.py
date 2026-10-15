"""Behavioral admission for the deterministic hybrid, distinct from RL admission."""


def validate(config, results):
    required = config['acceptance']
    cases = results.get('cases', [])
    def eligible(c):
        return (c.get('scenario_valid') is True and c.get('complete_episode') is True
                and c.get('source')=='LIVE_NATIVE_CARLA' and c.get('driver_id')==config['driver_id'])
    def success(c):
        return (eligible(c) and c.get('outcome') == 'SUCCESS' and c.get('contacts') == 0
                and c.get('destination_reached') is True
                and c.get('maximum_unexplained_stop_s', float('inf')) <= required['maximum_unexplained_stop_s']
                and c.get('native_planar_distance_m', 0) >= c.get('minimum_movement_m', 5.))
    ordinary = [c for c in cases if c.get('group') == 'ordinary']
    recovery = [c for c in cases if c.get('group') == 'recovery' and c.get('independently_verified_feasible')]
    hazard_ids = set(required['required_hazards'])
    hazards = {name: [c for c in cases if c.get('scenario') == name] for name in hazard_ids}
    seeds=results.get('frozen_seeds',[])
    frozen_seeds=set(seeds) if isinstance(seeds,list) and all(type(s) is int for s in seeds) else set()
    ids=[c.get('case_id') for c in cases];expected=results.get('expected_case_ids',[])
    complete_identity=bool(expected and all(isinstance(k,str) and k for k in ids)
                           and len(set(ids))==len(ids) and set(ids)==set(expected))
    maneuvers = {name: [c for c in recovery if name in c.get('completed_maneuvers', [])]
                 for name in required['required_maneuvers']}
    perf = results.get('performance', {})
    gates = {
        'ordinary': len(ordinary) >= required['ordinary_required'] and all(success(c) for c in ordinary),
        'speed': all(any(success(c) and abs(c.get('verified_cruise_kmh', 0)-speed) <= 3
                         and c.get('verified_cruise_duration_s',0)>=5.
                         for c in ordinary) for speed in required['required_speeds_kmh']),
        'recovery': bool(recovery) and sum(success(c) for c in recovery)/len(recovery) >= required['recovery_fraction'],
        'all_maneuvers': all(any(success(c) for c in rows) for rows in maneuvers.values()),
        'hazards': len(frozen_seeds)==3 and all(frozen_seeds.issubset({c.get('seed') for c in rows}) and all(success(c) for c in rows)
                       for rows in hazards.values()),
        'surround': results.get('surround_rig_calibrated') is True,
        'freshness': perf.get('fresh_scene_fraction', 0) >= required['fresh_scene_fraction']
                     and perf.get('outages_reported') is True,
        'comfort': results.get('measured_comfort_passed') is True,
        'throughput': perf.get('matched') is True and perf.get('degradation_fraction', 1) <= required['maximum_throughput_degradation'],
        'comparison': results.get('initial_conditions_verified') is True and results.get('baseline_hazards_enabled') is True,
        'identity': complete_identity and results.get('source_hash_verified') is True and results.get('frozen_manifest_verified') is True,
    }
    return {'accepted': all(gates.values()), 'gates': gates,
            'provided_cases':len(cases),'invalid_case_ids':[c.get('case_id') for c in cases if not eligible(c)],
            'failed_case_ids':[c.get('case_id') for c in cases if not success(c)],
            'missing_case_ids':sorted(set(expected)-set(ids)),
            'unfinished_gates': [k for k, v in gates.items() if not v],
            'missing_hazards': [k for k, v in hazards.items() if len({c.get('seed') for c in v}) < 3],
            'missing_maneuvers': [k for k, v in maneuvers.items() if not any(success(c) for c in v)]}
