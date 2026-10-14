"""Behavioral acceptance, never inferred from reward or a contract test."""


REQUIRED=('ordinary','recovery','manual','scenario_validity','prediction','freshness','throughput','frozen_test')


def validate(manifest,results):
    """Missing, invalid, incomplete and stationary cases fail their gates."""
    expected=manifest.get('cases',[])
    indexed={r.get('case_id'):r for r in results.get('cases',[])}
    missing=[c['case_id'] for c in expected if c['case_id'] not in indexed]
    invalid=[c['case_id'] for c in expected if not indexed.get(c['case_id'],{}).get('scenario_valid',False)]
    def successful(case):
        r=indexed.get(case['case_id'],{})
        return (r.get('outcome')=='SUCCESS' and r.get('scenario_valid') and r.get('complete_episode') and
                r.get('contacts')==0 and r.get('native_distance_m',0)>=case.get('minimum_movement_m',5.) and
                r.get('maximum_unexplained_stop_s',float('inf'))<=3.)
    ordinary=[c for c in expected if c.get('group')=='ordinary']
    recovery=[c for c in expected if c.get('group')=='recovery' and c.get('independently_verified_feasible')]
    manual=[c for c in expected if c.get('mode')=='MANUAL_PROTECTION']
    rates=results.get('performance',{})
    prediction=results.get('prediction',{})
    gates={'ordinary':len(ordinary)>=10 and all(successful(c) for c in ordinary),
           'recovery':bool(recovery) and sum(successful(c) for c in recovery)/len(recovery)>=.9,
           'manual':bool(manual) and all(successful(c) for c in manual) and results.get('identical_driver_traces_verified') is True,
           'scenario_validity':bool(expected) and not missing and not invalid,
           'prediction':prediction.get('paired_independent_error_improvement',-1)>=.1 and
                prediction.get('hazard_coverage_not_reduced') is True and prediction.get('driving_not_worse') is True,
           'freshness':rates.get('fresh_control_scene_fraction',0)>=.99 and rates.get('long_outages_reported') is True,
           'throughput':rates.get('matched') is True and rates.get('degradation_fraction',1)<=.1,
           'frozen_test':results.get('manifest_hash_verified') is True and results.get('checkpoint_hash_verified') is True}
    return {'accepted':all(gates.values()),'gates':gates,'missing_cases':missing,'invalid_cases':invalid,
            'unfinished_gates':[key for key in REQUIRED if not gates[key]]}
