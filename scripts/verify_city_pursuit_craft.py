"""Verify the public chase and, separately, its mounted camera boundary."""

import argparse
import os
import sys
from pathlib import Path

from verify_car_quality import ROOT, run_browser


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--camera", action="store_true")
    args = parser.parse_args()
    output = Path(os.environ.get("PROVE_IT_OUTPUT_DIR", str(ROOT / "output" / "pursuit-craft")))
    output.mkdir(parents=True, exist_ok=True)
    if not args.camera:
        os.environ["CITY_PURSUIT_CRAFT"] = "1"
        sys.exit(run_browser(output, False, driver="verify-city-pursuit-action.mjs", timeout=115))

    driver = "verify-city-vision-lead.mjs"
    os.environ["CITY_VISION_CHECK"] = "density"
    density = run_browser(output, False, driver=driver, timeout=85)
    if density:
        sys.exit(density)
    lead = output / "lead"
    lead.mkdir(exist_ok=True)
    os.environ["CITY_VISION_CHECK"] = "lead"
    sys.exit(run_browser(lead, False, driver=driver, timeout=105))
