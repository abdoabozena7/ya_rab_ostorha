"""Drive the actual local Three.js pursuit through public browser controls."""

import os
import sys
from pathlib import Path

from verify_car_quality import ROOT, run_browser


if __name__ == "__main__":
    output = Path(os.environ.get("PROVE_IT_OUTPUT_DIR", str(ROOT / "output" / "pursuit-public")))
    output.mkdir(parents=True, exist_ok=True)
    sys.exit(run_browser(output, False, driver="verify-pursuit.mjs", timeout=120))
