"""Native-only vehicle_control entry point; run with python -m scripts.native.verify_vehicle_control."""
from .validation import main

if __name__ == '__main__':
    raise SystemExit(main('vehicle_control'))
