"""Native-only connection entry point; run with python -m scripts.native.verify_connection."""
from .validation import main

if __name__ == '__main__':
    raise SystemExit(main('connection'))
