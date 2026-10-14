"""Remove experimental sensing load; restore the user's held city session."""
import json
from pathlib import Path
import time
from .restart_backend import main as restart
from .validate_motion_reliability import ObservationSession,place,summary
from .validate_congestion_recovery import row,write,ROOT,OUT
from backend.learning.recovery_budget import RecoveryBudget
from backend.learning.motion_budget import MotionBudget


def main():
    budget=RecoveryBudget();reservation=budget.reserve('validation',125.)
    saved=json.loads((OUT/'operator-before.json').read_text())
    report={'scope':'RESTORE_ORDINARY_NATIVE_SESSION_AND_READ_ONLY_UI','native_recovery_accepted':False}
    deadline=reservation[1]+120.
    try:
        (OUT/'validation-ticket.json').unlink(missing_ok=True)
        restart()
        with ObservationSession() as s:
            s.send('stop_driving')
            s.action('settings',{'population':{**saved['population'],'vehicle_count':0,'pedestrian_count':0}})
            place(s,saved['vehicle'])
            if saved['destination']:s.action('destination',{'location':saved['destination']['location'],'name':saved['destination']['name']})
            s.action('settings',{'population':saved['population']})
            (ROOT/'config/dashboard-preferences.json').write_text(saved['preferences'],encoding='utf8')
            rows=[];end=time.monotonic()+8.
            while time.monotonic()<end:s.wait(lambda a:True);rows.append(row(s.state))
            report['ordinary_held_performance']=summary(rows)
            report['final']={'vehicle':s.state['vehicle'],'mode':s.state['mode'],'safety':s.state['safetySystem'],
                'stop':s.state.get('stopDiagnostics'),'route':s.state['route'],'population':s.state['population']['requested'],
                'sensors':list(s.state['sensorRegistry'])}
            assert report['final']['mode']=='PAUSED' and s.state['vehicle']['speedMagnitudeMps']<.15
            assert not {'rearDepth','leftDepth','rightDepth'}&set(report['final']['sensors'])
            assert s.state['safetySystem']['status']=='STANDBY'
            write('final-native-session.json',report)
            print('RESTORED_HELD_UI_READY',flush=True)
            done=OUT/'ui-done.json'
            while time.monotonic()<deadline and not done.exists():time.sleep(.25)
            if done.exists():report['ui']=json.loads(done.read_text())
            else:report['ui']={'status':'NOT_COMPLETED_WITHIN_RESERVATION'}
        report['complete']=True
    finally:
        report['elapsed_s']=budget.finish(reservation);report['budget']=budget.status()
        report['historical_motion_budget']=MotionBudget().status()
        write('final-native-session.json',report)
        print(json.dumps({k:v for k,v in report.items() if k not in ('final','ui')}),flush=True)


if __name__=='__main__':main()
