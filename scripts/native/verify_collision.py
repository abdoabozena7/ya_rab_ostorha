"""Native-only collision entry point; run with python -m scripts.native.verify_collision."""
from .validation import main

if __name__ == '__main__':
    raise SystemExit(main('collision'))
