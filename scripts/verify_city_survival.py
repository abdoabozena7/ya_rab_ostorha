"""Verify the in-place City pursuit on an owned standalone browser/server."""

import argparse
import os
import sys
from pathlib import Path

from verify_car_quality import ROOT, run_browser


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--negative-control", action="store_true")
    args = parser.parse_args()
    output = Path(os.environ.get("PROVE_IT_OUTPUT_DIR", str(ROOT / "output" / "city-survival")))
    output.mkdir(parents=True, exist_ok=True)
    if args.negative_control:
        archive = ROOT / ".runtime-proof" / "city-arcade-pursuit-20261120" / "previous"
        os.environ["CITY_SURVIVAL_PREVIOUS"] = str(archive)
    sys.exit(run_browser(output, args.negative_control, driver="verify-city-survival.mjs", timeout=160))
