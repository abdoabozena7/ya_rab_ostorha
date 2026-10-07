"""Native-only rgb entry point; run with python -m scripts.native.verify_rgb."""
from .validation import main

if __name__ == '__main__':
    raise SystemExit(main('rgb'))
