"""Observe real foundation phases and score physical outcomes independently."""
import argparse
from collections import deque
import ctypes
from ctypes import wintypes as wt
import hashlib
import io
import json
from pathlib import Path
import sys
import threading
import time
import unittest
import urllib.request
import urllib.error
import numpy as np
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from backend.gta.provider import latest_json,TICK

CAMERA_YAWS={'CAM_FRONT':0.,'CAM_LEFT':90.,'CAM_RIGHT':-90.,'CAM_REAR':180.}


def rows(path):
    try:return [json.loads(x) for x in path.read_text().splitlines() if x]
    except (OSError,ValueError):return []


class LastInput(ctypes.Structure):
    _fields_=[('cbSize',wt.UINT),('dwTime',wt.DWORD)]


class InputProvenance:
    """Observe only input provenance while the owned game is foreground.

    Do not record keys, buttons or pointer coordinates. The low-level hook lets
    the proof distinguish injected computer-use actions from physical input;
    a failed hook or an unexplained last-input tick fails closed.
    """
    def __init__(self):
        self.pid=None;self.events=[];self.recent=deque(maxlen=256);self.ready=threading.Event();self.ok=False
        self.thread=threading.Thread(target=self._run,daemon=True);self.thread.start()
        self.ready.wait(5)

    def _run(self):
        user=ctypes.WinDLL('user32',use_last_error=True)
        pointer=ctypes.c_size_t
        class Mouse(ctypes.Structure):
            _fields_=[('point',wt.POINT),('mouseData',wt.DWORD),('flags',wt.DWORD),('time',wt.DWORD),('extra',pointer)]
        class Key(ctypes.Structure):
            _fields_=[('vk',wt.DWORD),('scan',wt.DWORD),('flags',wt.DWORD),('time',wt.DWORD),('extra',pointer)]
        callback_type=ctypes.WINFUNCTYPE(ctypes.c_ssize_t,ctypes.c_int,wt.WPARAM,wt.LPARAM)
        user.SetWindowsHookExW.argtypes=[ctypes.c_int,callback_type,wt.HINSTANCE,wt.DWORD]
        user.SetWindowsHookExW.restype=wt.HANDLE
        user.CallNextHookEx.argtypes=[wt.HANDLE,ctypes.c_int,wt.WPARAM,wt.LPARAM]
        user.CallNextHookEx.restype=ctypes.c_ssize_t
        user.GetForegroundWindow.restype=wt.HWND
        user.GetWindowThreadProcessId.argtypes=[wt.HWND,ctypes.POINTER(wt.DWORD)]
        user.WindowFromPoint.argtypes=[wt.POINT];user.WindowFromPoint.restype=wt.HWND
        user.GetAncestor.argtypes=[wt.HWND,wt.UINT];user.GetAncestor.restype=wt.HWND
        def make_callback(kind,structure,mask):
            @callback_type
            def hook(code,event,data):
                if code>=0 and self.pid:
                    foreground=wt.DWORD();user.GetWindowThreadProcessId(user.GetForegroundWindow(),ctypes.byref(foreground))
                    value=ctypes.cast(data,ctypes.POINTER(structure)).contents
                    targeted=foreground.value==self.pid
                    # A physical click can focus GTA while a different window is
                    # foreground. Identify only its target process; never store
                    # the click position or the key/button value.
                    if kind=='mouse' and event in (0x201,0x204,0x207,0x20b):
                        window=user.GetAncestor(user.WindowFromPoint(value.point),2)
                        target=wt.DWORD();user.GetWindowThreadProcessId(window,ctypes.byref(target))
                        targeted|=target.value==self.pid
                    entry={'kind':kind,'tick':int(value.time),'injected':bool(value.flags&mask),'targeted_game':targeted}
                    self.recent.append(entry)
                    if targeted:self.events.append(entry)
                return user.CallNextHookEx(None,code,event,data)
            return hook
        mouse=make_callback('mouse',Mouse,1);key=make_callback('keyboard',Key,16)
        hooks=[user.SetWindowsHookExW(14,mouse,None,0),user.SetWindowsHookExW(13,key,None,0)]
        self.ok=all(hooks);self.ready.set()
        if not self.ok:return
        message=wt.MSG()
        while user.GetMessageW(ctypes.byref(message),None,0,0)>0:
            user.TranslateMessage(ctypes.byref(message));user.DispatchMessageW(ctypes.byref(message))

    def classify(self,tick):
        matching=[event for event in self.recent if event['tick']==tick]
        if matching and not any(event['targeted_game'] for event in matching):return 'outside_game'
        return 'injected' if matching and all(event['injected'] for event in matching if event['targeted_game']) else 'physical_or_unknown'


def observe_window(pid):
    user=ctypes.windll.user32
    found=[]
    callback=ctypes.WINFUNCTYPE(wt.BOOL,wt.HWND,wt.LPARAM)
    @callback
    def visit(hwnd,_):
        process=wt.DWORD();user.GetWindowThreadProcessId(hwnd,ctypes.byref(process))
        if process.value==pid and user.IsWindowVisible(hwnd):
            rect=wt.RECT();user.GetWindowRect(hwnd,ctypes.byref(rect))
            found.append({'hwnd':int(hwnd),'rect':[rect.left,rect.top,rect.right,rect.bottom],
                          'style':user.GetWindowLongW(hwnd,-16)&0xffffffff})
        return True
    user.EnumWindows(visit,0)
    process=wt.DWORD();user.GetWindowThreadProcessId(user.GetForegroundWindow(),ctypes.byref(process))
    tick=LastInput(ctypes.sizeof(LastInput),0);user.GetLastInputInfo(ctypes.byref(tick))
    return {'windows':found,'foreground_pid':process.value,'last_input_tick':tick.dwTime,
            'desktop':[user.GetSystemMetrics(0),user.GetSystemMetrics(1)]}


def live(output,url):
    first=None;previous_input=None;previous_foreground=None;startup_input=False;input_changes=[];observed={};saved=set();known_pid=None;next_discovery=0
    provenance=InputProvenance()
    deadline=time.monotonic()+460
    while time.monotonic()<deadline:
        native=latest_json(output/'bridge.jsonl')
        if native is None:
            if known_pid is None and time.monotonic()>=next_discovery:
                from bootstrap import existing_native,process_image
                from preflight import GAME
                entries=existing_native();entries=[entries] if isinstance(entries,dict) else entries
                for entry in entries:
                    pid=entry.get('ProcessId')
                    if pid and process_image(pid)==GAME.resolve():known_pid=pid;break
                next_discovery=time.monotonic()+2
            if known_pid:native={'pid':known_pid}
        if native:
            provenance.pid=native['pid']
            window=observe_window(native['pid'])
            if first is None:
                if previous_input is not None and window['last_input_tick']!=previous_input and window['foreground_pid']==native['pid']:
                    classification=provenance.classify(window['last_input_tick'])
                    input_changes.append({'tick':window['last_input_tick'],'previous_tick':previous_input,
                                          'previous_foreground':previous_foreground,'classification':classification,
                                          'recent':list(provenance.recent)[-8:]})
                    startup_input|=classification not in ('injected','outside_game')
                startup_input|=any(not event['injected'] for event in provenance.events)
                previous_input=window['last_input_tick']
                previous_foreground=window['foreground_pid']
                (output/'input-monitor.json').write_text(json.dumps({'hook_ready':provenance.ok,'events':provenance.events,'changes':input_changes,'invalidated':startup_input}))
            # Keep the last visible native window instead of replacing it with
            # an empty enumeration while the owned process is shutting down.
            # The independently captured screenshot must be contemporaneous.
            if window['windows']:
                window['observed_wall_s']=time.time()
                (output/'window-observed.json').write_text(json.dumps(window))
        try:
            with urllib.request.urlopen(url+'/api/gta/state',timeout=3) as f:state=json.load(f)
            if not state['connected']:
                time.sleep(.1);continue
            if first is None:
                first=TICK();observed.update(first_live_ms=first,startup_input_observed=startup_input,
                    input_hook_ready=provenance.ok,input_provenance=provenance.events.copy(),input_changes=input_changes,
                    unattended_story_observed=provenance.ok and not startup_input)
            phase=state.get('foundation',{}).get('phase')
            if phase and phase.startswith('CAM_') and phase not in saved and state.get('image'):
                try:
                    serial=state['image']['serial']
                    frame=state['image']['native_frame']
                    expected_yaw=CAMERA_YAWS[phase]
                    matching=[v for v in rows(output/'camera-views.jsonl') if v['yaw_offset_deg']==expected_yaw
                              and 0<=frame-v['frame']<=30]
                    if not matching:time.sleep(.08);continue
                    view=max(matching,key=lambda v:v['frame'])
                    for kind in ('rgb','depth'):
                        with urllib.request.urlopen(url+f'/api/gta/image?serial={serial}&kind={kind}',timeout=3) as f:data=f.read()
                        img=Image.open(io.BytesIO(data));img.load()
                        if img.size!=(640,360):raise ValueError('Image resolution')
                        if kind=='rgb':
                            expected=np.fromfile(output/('capture-%06d.rgb'%serial),np.uint8).reshape(360,640,3)
                            if not np.array_equal(np.asarray(img),expected):raise ValueError('RGB bytes mismatch')
                        (output/(phase+'-'+kind+'.png')).write_bytes(data)
                    (output/(phase+'-metadata.json')).write_text(json.dumps({'serial':serial,'native_frame':frame,
                        'view_frame':view['frame'],'yaw_offset_deg':view['yaw_offset_deg'],
                        'capture_end_ms':state['image']['capture_end_ms']}))
                    saved.add(phase)
                except (OSError,ValueError):pass
            elapsed=state.get('foundation',{}).get('elapsed_s',0)
            if phase=='LEASE_LOSS' and elapsed>=68 and 'owner_loss_ms' not in observed:
                observed['owner_loss_ms']=TICK();(output/'drop-goal-commands').touch();time.sleep(2)
                (output/'drop-goal-commands').unlink()
            if phase=='CAPTURE_LOSS' and elapsed>=76 and 'capture_loss_ms' not in observed:
                observed['capture_loss_ms']=TICK();(output/'drop-capture').touch();time.sleep(2)
                (output/'drop-capture').unlink()
            observed['saved_views']=sorted(saved)
            (output/'foundation-observed.json').write_text(json.dumps(observed,indent=2))
            if native and native.get('stage')=='DONE':break
            time.sleep(.08)
        except (OSError,ValueError,KeyError):time.sleep(.1)


def window_screenshot_is_current(window,screenshot):
    dimensions=window.get('desktop',[0,0]);wins=window.get('windows',[])
    windowed=any(w['style']&0x00C00000 and 400<w['rect'][2]-w['rect'][0]<dimensions[0]*.9 for w in wins)
    return bool(windowed and screenshot.exists() and window.get('observed_wall_s') and
                abs(screenshot.stat().st_mtime-window['observed_wall_s'])<=15)


def finalize(output):
    native=[r for r in rows(output/'bridge.jsonl') if r.get('stage') in ('FOUNDATION_CALIBRATION','DONE')]
    controls=rows(output/'foundation-control.jsonl');views=rows(output/'camera-views.jsonl');captures=rows(output/'capture.jsonl')
    obs=latest_json(output/'foundation-observed.json') or {};window=latest_json(output/'window-observed.json') or {}
    outcomes={}
    for phase in ('FORWARD','REVERSE','LEFT','RIGHT'):
        times=[r['host_ms'] for r in controls if r['phase']==phase]
        sample=[r for r in native if times and min(times)<=r['host_ms']<=max(times)]
        dist=max((float(np.linalg.norm(np.asarray(r['position'])-sample[0]['position'])) for r in sample),default=0.)
        heading=max((abs((r['heading_deg']-sample[0]['heading_deg']+180)%360-180) for r in sample),default=0.)
        signed=[float(np.dot(r['velocity'],r['forward'])) for r in sample]
        outcomes[phase]={'displacement_m':dist,'heading_change_deg':heading,'signed_min_mps':min(signed,default=0),'signed_max_mps':max(signed,default=0)}
    physical=bool(outcomes['FORWARD']['displacement_m']>=2 and outcomes['FORWARD']['signed_max_mps']>=.5
                  and outcomes['REVERSE']['displacement_m']>=1 and outcomes['REVERSE']['signed_min_mps']<=-.3
                  and min(outcomes[x]['heading_change_deg'] for x in ('LEFT','RIGHT'))>=3)
    expected_views=CAMERA_YAWS
    view_metadata={name:latest_json(output/(name+'-metadata.json')) or {} for name in expected_views}
    camera=all((output/(name+'-rgb.png')).exists() and (output/(name+'-depth.png')).exists()
               and view_metadata[name].get('yaw_offset_deg')==yaw
               and 0<=view_metadata[name].get('native_frame',-100)-view_metadata[name].get('view_frame',100)<=30
               for name,yaw in expected_views.items())
    if camera:
        camera=len({hashlib.sha256((output/(name+'-rgb.png')).read_bytes()).digest() for name in expected_views})==4
    def stopped(key,field):
        t=obs.get(key)
        return bool(t and any(t+350<=r['host_ms']<=t+2200 and r['speed_mps']<=.2 and r['brake']>=.99 and r.get(field) for r in native))
    screenshot=output/'side-by-side.png'
    return dict(story_world_observed=len(native)>=10 and len(captures)>=20,unattended_story_observed=bool(obs.get('unattended_story_observed')) and not (output/'startup-assisted.json').exists(),
                physical_controls=physical,camera_views=camera,sensor_streams=len(captures)>=100 and len(rows(output/'geometry.jsonl'))>=40,
                fault_stops=stopped('owner_loss_ms','lease_expired') and stopped('capture_loss_ms','sensor_stale'),
                windowed_and_dashboard=window_screenshot_is_current(window,screenshot),physical_measurements=outcomes,
                full_migration_accepted=False,training_started=False,human_recording=False)


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--url');p.add_argument('--offline',action='store_true');a=p.parse_args()
    if a.offline:
        suite=unittest.TestLoader().discover(str(Path(__file__).parent),pattern='test_foundation.py')
        result=unittest.TextTestRunner(verbosity=2).run(suite)
        (a.output/'boundary.json').write_text(json.dumps({'negative_controls_passed':result.wasSuccessful(),'tests':result.testsRun}))
        return int(not result.wasSuccessful())
    live(a.output,a.url);return 0

if __name__=='__main__':raise SystemExit(main())
