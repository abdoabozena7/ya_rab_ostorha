"""Exercise the public PAKO correction on an owned standalone server."""

import os
from pathlib import Path

from verify_car_quality import ROOT, run_browser


if __name__ == "__main__":
    output = Path(os.environ.get("PROVE_IT_OUTPUT_DIR", str(ROOT / "output" / "pako-browser")))
    output.mkdir(parents=True, exist_ok=True)
    timeout = 175 if os.environ.get("PAKO_FLEET_CAPACITY") == "1" else 128
    raise SystemExit(run_browser(output, False, driver="verify-pako-browser.mjs", timeout=timeout))
