"""Native-only lidar entry point; run with python -m scripts.native.verify_lidar."""
from .validation import main

if __name__ == '__main__':
    raise SystemExit(main('lidar'))
