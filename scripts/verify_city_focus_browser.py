"""Exercise the actual City and installed pixel detector on an owned server."""

import argparse
import os
from pathlib import Path

from verify_car_quality import ROOT, run_browser


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hybrid", action="store_true", help="Check the live PPO/camera decision boundary")
    parser.add_argument("--actor-playback", action="store_true", help="Check recorded actors in Lab playback")
    parser.add_argument("--negative-control", action="store_true", help="Withhold the actor recording from playback")
    args = parser.parse_args()
    if (args.hybrid and args.actor_playback) or (args.negative_control and not args.actor_playback):
        parser.error("Choose one journey; the negative control only applies to actor playback.")
    output = Path(os.environ.get("PROVE_IT_OUTPUT_DIR", str(ROOT / "output" / "city-focus")))
    output.mkdir(parents=True, exist_ok=True)
    driver = "verify-chase-hybrid.mjs" if args.hybrid else "verify-city-focus-browser.mjs"
    if args.actor_playback:
        driver = "verify-pako-actor-playback.mjs"
    raise SystemExit(run_browser(output, args.negative_control, driver=driver, timeout=175 if args.hybrid else 270))
