"""Strict measured acceptance. Missing evidence never becomes a passing gate."""
import numpy as np
from numbers import Real


def finite(value):
    return isinstance(value,Real) and not isinstance(value,bool) and np.isfinite(value)


def evaluate_quality(samples,*,arrived,contacts,stop_audits=(),camera=None):
    running=[s for s in samples if s.get('journey',{}).get('status')=='RUNNING']
    times=np.array([s['timestamp_s'] for s in running],float)
    violations=[];stops=[];delays=[];jerks=[];switches=[];missing=[]
    previous_pedal=previous_steer=0;last_pedal=last_steer=None
    for i,s in enumerate(running):
        required=('longitudinal_acceleration_mps2','yaw_rate_radps','speed_kmh','throttle','brake','steering')
        absent=[k for k in required if not finite(s.get(k))]
        if absent:missing.append({'frame':s['frame_id'],'fields':absent})
        acceleration=s.get('longitudinal_acceleration_mps2') if 'longitudinal_acceleration_mps2' not in absent else None
        emergency=s.get('verified_emergency') is True
        if acceleration is None:violations.append({'frame':s['frame_id'],'reason':'MISSING_ACCELERATION'})
        elif not emergency and not -3.<=acceleration<=2.:violations.append({'frame':s['frame_id'],'reason':'LONGITUDINAL_ACCELERATION','value':acceleration})
        if 'speed_kmh' not in absent and 'yaw_rate_radps' not in absent:
            lateral=abs(s['speed_kmh']/3.6*s['yaw_rate_radps'])
            if not emergency and lateral>2.:violations.append({'frame':s['frame_id'],'reason':'LATERAL_ACCELERATION','value':lateral})
        if i and acceleration is not None and times[i]-times[0]>=.2:
            previous=[r.get('longitudinal_acceleration_mps2') for r in running[:i+1]]
            if all(finite(a) for a in previous):
                jerk=abs(acceleration-np.interp(times[i]-.2,times[:i+1],previous))/.2;jerks.append(jerk)
                if not emergency and jerk>3.:violations.append({'frame':s['frame_id'],'reason':'JERK_0_2S','value':jerk})
        diagnostic=s.get('stop') or {};application=diagnostic.get('application_timing') or {}
        context=(s.get('maneuver') or {}).get('action'),diagnostic.get('reason')
        pedal=1 if 'throttle' not in absent and s['throttle']>.1 else -1 if 'brake' not in absent and s['brake']>.1 else 0
        steer=int(np.sign(s['steering'])) if 'steering' not in absent and abs(s['steering'])>.1 else 0
        for kind,current,previous,last in [('pedal',pedal,previous_pedal,last_pedal),('steering',steer,previous_steer,last_steer)]:
            if current and previous and current!=previous and last and context==last[1] and s['timestamp_s']-last[0]<1.:
                switches.append({'frame':s['frame_id'],'kind':kind,'context':context})
        if pedal and pedal!=previous_pedal:last_pedal=(s['timestamp_s'],context)
        if steer and steer!=previous_steer:last_steer=(s['timestamp_s'],context)
        if pedal:previous_pedal=pedal
        if steer:previous_steer=steer
        if not application.get('fresh_aligned'):delays.append(s['frame_id'])
        if ('speed_kmh' not in absent and s['speed_kmh']<.54) or diagnostic.get('decision_source') in ('EXECUTION_SHIELD','SENSOR_FAILURE','COMMAND_WATCHDOG') and diagnostic.get('braking'):
            stops.append({'frame':s['frame_id'],'reason':diagnostic.get('reason')})
    verified={a['frame'] for a in stop_audits if a.get('verified') is True and a.get('evidence')}
    unresolved=[s for s in stops if s['frame'] not in verified]
    fresh=1-len(delays)/len(running) if running else 0.
    gates={'arrived':bool(arrived),'no_contacts':contacts==0,'complete_measurements':bool(running) and not missing,
        'fresh_fraction':fresh>=.99,'no_control_delays':not delays and bool(running),
        'all_stops_independently_verified':not unresolved and bool(running),'comfort':not violations and bool(running),
        'no_oscillation':not switches and bool(running),
        'cruise_50_verified':any(finite(s.get('speed_kmh')) and s.get('unobstructed_cruise_verified') and s.get('cruise_window_s',0)>=5
            and s.get('applicable_target_kmh')==50 and abs(s['speed_kmh']-50)<=3 for s in running),
        'display':bool(camera and camera.get('passed'))}
    return {'accepted':all(gates.values()),'gates':gates,'fresh_fraction':fresh,'delay_frames':delays,
        'stop_frames':stops,'unresolved_stop_frames':unresolved,'comfort_violations':violations,
        'maximum_jerk_0_2s_mps3':max(jerks,default=None),'oscillations':switches,'camera':camera,'missing_measurements':missing}
