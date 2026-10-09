"""Run the dashboard's experiment through its existing backend/tick owner."""
import argparse
import json
import time
from scripts.native.verify_urban_world import Session


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode',choices=('WITHOUT','WITH','PAIR','STOP'),default='WITH')
    parser.add_argument('--seed',type=int,default=2589)
    parser.add_argument('--scenario',choices=('URBAN_CHAOS','FRONT_OBSTACLE'),default='URBAN_CHAOS')
    args=parser.parse_args()
    with Session() as session:
        modes=('WITHOUT','WITH') if args.mode=='PAIR' else (args.mode,)
        for mode in modes:
            session.send('comparison',value={'mode':mode,'seed':args.seed,'scenario':args.scenario})
            if mode!='STOP':
                session.wait(lambda st:st['comparisonDemo']['mode']==mode and st['comparisonDemo']['phase'] in ('RESETTING','RUNNING','ERROR'))
            deadline=time.monotonic()+360
            while time.monotonic()<deadline:
                session.wait(lambda state:True)
                demo=session.state['comparisonDemo']
                if demo['phase']=='ERROR':raise RuntimeError(demo['error'])
                if demo['phase']=='FINISHED' or mode=='STOP' and demo['phase']=='IDLE':
                    print(json.dumps(demo,indent=2));break
                session.send('journey_heartbeat',session_id=session.state['sessionId'])
            else:raise TimeoutError('Backend comparison did not finish')

if __name__=='__main__':main()
