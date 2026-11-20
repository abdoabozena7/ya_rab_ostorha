"""Verify GTA Chase against the real standalone browser and an owned server."""

import os
from pathlib import Path

from verify_car_quality import ROOT, run_browser


if __name__ == "__main__":
    output = Path(os.environ.get("PROVE_IT_OUTPUT_DIR", str(ROOT / "output" / "gta-browser")))
    output.mkdir(parents=True, exist_ok=True)
    raise SystemExit(run_browser(output, False, driver="verify-gta-browser.mjs", timeout=140))
