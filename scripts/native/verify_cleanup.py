"""Native-only cleanup entry point; run with python -m scripts.native.verify_cleanup."""
from .validation import main

if __name__ == '__main__':
    raise SystemExit(main('cleanup'))
