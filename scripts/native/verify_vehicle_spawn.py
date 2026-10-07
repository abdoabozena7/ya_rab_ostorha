"""Native-only vehicle_spawn entry point; run with python -m scripts.native.verify_vehicle_spawn."""
from .validation import main

if __name__ == '__main__':
    raise SystemExit(main('vehicle_spawn'))
