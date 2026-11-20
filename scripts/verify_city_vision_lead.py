"""Verify the standalone City with its installed local detector."""

import argparse
import os
import sys
from pathlib import Path

from verify_car_quality import ROOT, run_browser


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--density", action="store_true")
    mode.add_argument("--controls", action="store_true")
    args = parser.parse_args()
    os.environ["CITY_VISION_CHECK"] = "density" if args.density else "controls" if args.controls else "lead"
    output = Path(os.environ.get("PROVE_IT_OUTPUT_DIR", str(ROOT / "output" / "city-vision-lead")))
    output.mkdir(parents=True, exist_ok=True)
    sys.exit(run_browser(output, False, driver="verify-city-vision-lead.mjs", timeout=125 if args.density else 185))
