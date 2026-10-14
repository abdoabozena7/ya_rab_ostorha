"""Animated native RGB evidence with original simulation-time sampling."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
from PIL import Image


def main():
    parser=argparse.ArgumentParser();parser.add_argument('episode',type=Path);parser.add_argument('output',type=Path)
    args=parser.parse_args();root=args.episode/'sensors'
    rows=[json.loads(line) for line in (root/'telemetry/frames.jsonl').read_text().splitlines()]
    frames=[];sources=[];previous=None
    for row in rows:
        stamp=row['timestamp_s']
        if previous is not None and stamp-previous<.2:continue
        channel=next((c for c in row['sensors'] if c['sensor_id']=='frontCamera' and c.get('asset')),None)
        if channel is None:continue
        path=root/channel['asset']['path'];data=path.read_bytes()
        if hashlib.sha256(data).hexdigest()!=channel['asset']['sha256']:raise ValueError('Native image checksum mismatch')
        frames.append(Image.open(path).convert('RGB').copy())
        sources.append({'frame':row['frame_id'],'timestamp_s':stamp,'sha256':channel['asset']['sha256']})
        previous=stamp
    if not frames:raise RuntimeError('No verified native RGB frames for clip')
    duration=[max(1,round((b['timestamp_s']-a['timestamp_s'])*1000)) for a,b in zip(sources,sources[1:])]+[200]
    args.output.parent.mkdir(parents=True,exist_ok=True)
    frames[0].save(args.output,save_all=True,append_images=frames[1:],duration=duration,loop=0,optimize=True)
    metadata={'source':'RECORDED_NATIVE_CARLA_RGB','episode':str(args.episode),'frames':sources,
              'simulation_duration_s':sources[-1]['timestamp_s']-sources[0]['timestamp_s'],
              'outcome':json.loads((args.episode/'outcome.json').read_text())['outcome'],
              'clip_sha256':hashlib.sha256(args.output.read_bytes()).hexdigest()}
    args.output.with_suffix('.json').write_text(json.dumps(metadata,indent=2),encoding='utf8')
    print(json.dumps({'clip':str(args.output),'frames':len(frames),'outcome':metadata['outcome']}));return 0


if __name__=='__main__':sys.exit(main())
