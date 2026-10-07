"""Native-only gnss entry point; run with python -m scripts.native.verify_gnss."""
from .validation import main

if __name__ == '__main__':
    raise SystemExit(main('gnss'))
