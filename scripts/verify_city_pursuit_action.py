"""Exercise the moving street pursuit through the public standalone game."""

import os
import sys
from pathlib import Path

from verify_car_quality import ROOT, run_browser


if __name__ == "__main__":
    output = Path(os.environ.get("PROVE_IT_OUTPUT_DIR", str(ROOT / "output" / "city-pursuit-action")))
    output.mkdir(parents=True, exist_ok=True)
    sys.exit(run_browser(output, False, driver="verify-city-pursuit-action.mjs", timeout=125))
