"""Native-only depth entry point; run with python -m scripts.native.verify_depth."""
from .validation import main

if __name__ == '__main__':
    raise SystemExit(main('depth'))
