"""Disposable native recovery process, exited before the dashboard starts."""
import argparse
import json
from pathlib import Path
from backend.carla.runtime import NativeRuntime


def main():
    parser=argparse.ArgumentParser();parser.add_argument('settings');args=parser.parse_args()
    config=json.loads(Path(args.settings).read_text(encoding='utf8'))
    runtime=NativeRuntime();runtime.stop()
    import carla
    runtime.launch(config,'127.0.0.1',2000,carla)
    print(json.dumps({'restored_native_graphics':runtime.active}))


if __name__=='__main__':main()
