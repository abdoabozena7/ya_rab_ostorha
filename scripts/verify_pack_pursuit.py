"""Play the real Lab drills and City pack chase on an owned standalone server."""

import argparse
import os
import sys
from pathlib import Path

from verify_car_quality import ROOT, run_browser


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hunt", action="store_true", help="Exercise recovery, cooldown and seeded City training.")
    args = parser.parse_args()
    name = "pursuit-hunt" if args.hunt else "pack-pursuit"
    output = Path(os.environ.get("PROVE_IT_OUTPUT_DIR", str(ROOT / "output" / name)))
    output.mkdir(parents=True, exist_ok=True)
    sys.exit(run_browser(output, False, driver=f"verify-{name}.mjs", timeout=150 if args.hunt else 210))
