"""Compact read-only audit of recorded driving, visual identity and every stop."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
from scripts.audit_reliable_driving import recorded_samples
from backend.core.driving_quality import evaluate_quality
from backend.core.recording import read_trace_row


def rows(path):
    if path.exists():
        with path.open(encoding='utf8') as stream:
            for line in stream:
                if line.strip():yield json.loads(line)


def audit(pair):
    data=json.loads(Path(pair).read_text(encoding='utf8'))
    report={'pair_id':data['pair_id'],'seed':data['manifest']['population']['seed'],'arms':{},
        'qualification':'Recorded software evidence; strict quality requires independent stop and display audits.'}
    for mode,run in data['runs'].items():
        root=Path(run['recording']);samples=recorded_samples(root)
        decisions=list(rows(root/'telemetry/safety-v2.jsonl'))
        quality=evaluate_quality(samples,arrived=run['status']=='ARRIVED',contacts=run['collisions'])
        images={}
        for frame in rows(root/'telemetry/frames.jsonl'):
            for sensor in frame['sensors']:
                if sensor['sensor_id']=='frontCamera':images[frame['frame_id']]=sensor['asset']['sha256']
        counts=Counter();matched=outside=invalid=0
        for wire in rows(root/'telemetry/comparison-controls.jsonl'):
            kind=wire.get('kind');counts[kind]+=1
            if kind=='CAMERA_DETECTIONS':
                result=wire['result'];frame=result['frame_id']
                if frame not in images:outside+=1
                elif images[frame]==result.get('source_image_sha256'):matched+=1
                else:invalid+=1
            elif kind=='DISPLAY_PREDICTION':
                row=read_trace_row(root,wire);prediction=row['prediction']
                invalid+=int(prediction['evaluation_frame']!=row['evaluation_frame'] or
                    prediction['session_id']!=row['session_id'] or prediction['timestamp_s']!=row['timestamp_s'])
        stops=[];start=None
        for index,sample in enumerate(samples):
            stopped=sample['speed_kmh']<.72
            if stopped and start is None:start=index
            if start is not None and (not stopped or index==len(samples)-1):
                end=index if stopped else index-1
                duration=samples[end]['timestamp_s']-samples[start]['timestamp_s']
                if duration>=.5:
                    reasons=Counter((item.get('stop') or {}).get('reason') for item in samples[max(0,start-2):end+1])
                    stops.append({'start_frame':samples[start]['frame_id'],'end_frame':samples[end]['frame_id'],
                        'duration_s':duration,'reason_counts':dict(reasons),'independently_verified':False})
                start=None
        status=json.loads((root/'recording-status.json').read_text())
        video=json.loads((root/'video-status.json').read_text())
        with (root/'driving.mp4').open('rb') as stream:video_hash=hashlib.file_digest(stream,'sha256').hexdigest()
        report['arms'][mode]={'run':{key:run.get(key) for key in ('status','reason','recording','distance_m','duration_s',
            'maximum_speed_kmh','collisions','harsh_braking_events')},'frames':len(samples),
            'applied_decisions':len(decisions),
            'fresh_applied_decisions':sum(row.get('application_timing',{}).get('fresh_aligned') is True for row in decisions),
            'recorded_frames_without_fresh_decisions':quality['delay_frames'],
            'deadline_brake_frames':[row['evaluation_frame'] for row in decisions if row['reason']=='CONTROL_PROCESSING_DEADLINE'],
            'braking_reasons':dict(Counter(row['reason'] for row in decisions if row['braking'])),
            'fresh_fraction':quality['fresh_fraction'],'strict_quality_gates':quality['gates'],'accepted':quality['accepted'],
            'comfort_violations':len(quality['comfort_violations']),'unresolved_stop_frames':len(quality['unresolved_stop_frames']),
            'all_stop_segments':stops,'recording_status':status,
            'video_checksum_matches':video_hash==video.get('sha256'),'video_sha256':video_hash,
            'trace_counts':dict(counts),'visual_identity':{'matched_camera_sources':matched,
                'sources_outside_recording':outside,'invalid_identities':invalid}}
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('pair');parser.add_argument('--output',required=True)
    args=parser.parse_args();report=audit(args.pair)
    Path(args.output).write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps({'pair_id':report['pair_id'],'arms':{mode:{'run':arm['run'],
        'deadline_brakes':len(arm['deadline_brake_frames']),'fresh_fraction':arm['fresh_fraction'],
        'accepted':arm['accepted'],'visual_identity':arm['visual_identity']} for mode,arm in report['arms'].items()}}))
