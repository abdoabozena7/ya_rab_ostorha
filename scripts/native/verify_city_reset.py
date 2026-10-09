"""Native managed reset/reconnect proof without holding a Windows SDK client."""
import json
from pathlib import Path
import subprocess
import sys
import time
from websockets.sync.client import connect
from .verify_city_settings import NativeDashboard


def inventory():
    result = subprocess.run([sys.executable,'-c',
        'import carla,json; c=carla.Client("localhost",2000);c.set_timeout(20);'
        'assert c.get_client_version()==c.get_server_version()=="0.9.16";'
        'w=c.get_world();w.wait_for_tick(10);a=w.get_actors();'
        'print("INVENTORY="+json.dumps({k:[x.id for x in a.filter(p)] for k,p in '
        '[("vehicle","vehicle.*"),("walker","walker.*"),("controller","controller.*"),("sensor","sensor.*")]}))'],
        capture_output=True,text=True,check=True,timeout=35)
    return json.loads(next(line.removeprefix('INVENTORY=') for line in result.stdout.splitlines() if line.startswith('INVENTORY=')))


def main():
    import argparse
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',default='output/native-validation/gate4-reset.json')
    args=parser.parse_args()
    from backend.carla.population import DEFAULT_POPULATION
    proof={'source':'LIVE_NATIVE','checks':{}}
    with connect('ws://localhost:8001',max_size=2**22) as socket:
        d=NativeDashboard(socket); d.wait(lambda s:s['connected']);d.command('take_control')
        d.command('stop_driving')
        d.action('settings',{'population':{**DEFAULT_POPULATION,'vehicle_count':10,'pedestrian_count':10}})
        before=inventory();session=d.state['sessionId']
        began=time.monotonic()
        d.action('world_reset')
        proof['managed_world_reset_duration_wall_s']=time.monotonic()-began
        after=inventory()
        assert d.state['sessionId']!=session and d.state['mode']=='PAUSED'
        assert len(after['vehicle'])==1 and len(after['sensor'])==7 and not after['walker'] and not after['controller']
        proof['checks']['native_world_reset_empty_population_seven_sensors']=True
        proof['native_reset']=d.state['dashboardResult']['result'];proof['before']=before;proof['after']=after
        d.command('take_control')
        d.action('settings',{'population':{**DEFAULT_POPULATION,'vehicle_count':10,'pedestrian_count':10}})
        d.command('disconnect'); d.wait(lambda s:not s['connected'])
        assert all(not ids for ids in inventory().values())
        proof['checks']['disconnect_zero_owned_actors']=True
        began=time.monotonic()
        d.command('reconnect');d.wait(lambda s:s['connected'],timeout=90)
        proof['reconnect_duration_wall_s']=time.monotonic()-began
        assert d.state['mode']=='PAUSED'
        after=inventory()
        assert len(after['vehicle'])==1 and len(after['sensor'])==7 and not after['walker'] and not after['controller']
        d.command('take_control');d.command('stop_driving')
        proof['checks']['reconnect_one_ego_seven_sensors']=True
        proof['final_inventory']=after
        d.socket.close()
    proof['pass']=all(proof['checks'].values())
    Path(args.output).write_text(json.dumps(proof,indent=2),encoding='utf8')
    print(json.dumps(proof))


if __name__=='__main__': main()
