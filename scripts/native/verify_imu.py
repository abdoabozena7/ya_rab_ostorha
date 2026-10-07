"""Native-only imu entry point; run with python -m scripts.native.verify_imu."""
from .validation import main

if __name__ == '__main__':
    raise SystemExit(main('imu'))
