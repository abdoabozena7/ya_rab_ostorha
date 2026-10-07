"""Native-only radar entry point; run with python -m scripts.native.verify_radar."""
from .validation import main

if __name__ == '__main__':
    raise SystemExit(main('radar'))
