"""Exercise the actual revised low-poly SUV or verify unrelated-work preservation."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError


ROOT = Path(__file__).resolve().parents[1]


def write_report(output, name, value):
    (output / name).write_text(json.dumps(value, indent=2), encoding="utf-8")


def run_browser(output, negative, driver="verify-car.mjs", timeout=300):
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required for real car acceptance")
    environment = os.environ.copy()
    if not environment.get("PLAYWRIGHT_MODULE"):
        installed = (Path.home() / ".cache" / "codex-runtimes" /
                     "codex-primary-runtime" / "dependencies" / "node" /
                     "node_modules" / "playwright")
        if installed.is_dir():
            environment["PLAYWRIGHT_MODULE"] = str(installed)
    environment["PROVE_IT_OUTPUT_DIR"] = str(output)
    log_path = output / "server.log"
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            [sys.executable, "-S", "-u", "-m", "backend.threejs.server", "--port", "0"],
            cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            url = None
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f"Standalone server exited early; inspect {log_path}")
                for line in log_path.read_text(encoding="utf-8").splitlines():
                    if line.startswith("Three.js: "):
                        url = line.removeprefix("Three.js: ")
                if url:
                    break
                time.sleep(0.1)
            if not url:
                raise TimeoutError("Standalone server did not announce readiness")
            with urlopen(url + "api/health", timeout=5) as response:
                health = json.load(response)
            if health.get("mode") != "threejs" or health.get("externalSimulator") is not False:
                raise AssertionError("Car acceptance reached the wrong server")
            environment["THREEJS_URL"] = url
            command = [node, str(ROOT / "tools" / driver)]
            if negative:
                command.append("--negative-control")
            return subprocess.run(command, cwd=ROOT, env=environment,
                                  timeout=timeout, check=False).returncode
        finally:
            if process.poll() is None and url:
                try:
                    with urlopen(Request(url + "api/vision/stop", data=b"", method="POST"), timeout=15):
                        pass
                except URLError as error:
                    print(f"Owned vision worker cleanup request failed: {error}", file=sys.stderr)
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            write_report(output, "server-lifecycle.json", {
                "ownedPid": process.pid, "stopped": process.poll() is not None,
                "sitePackagesDisabled": True,
            })


def preserve(baseline, output):
    original = json.loads(baseline.read_text(encoding="utf-8"))
    changed = [
        name for name, digest in original["originalFiles"].items()
        if name not in original["allowedChanges"]
        and (not (ROOT / name).is_file()
             or hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest)
    ]
    marker = hashlib.sha256((ROOT / ".runtime-proof" / "active.json").read_bytes()).hexdigest()
    ancestry = subprocess.run(
        ["git", "merge-base", "--is-ancestor", original["head"], "HEAD"], cwd=ROOT, check=False,
    ).returncode == 0
    result = {
        "preserved": not changed and marker == original["activeMarkerHash"] and ancestry,
        "unrelatedChanges": changed, "otherSessionMarkerPreserved": marker == original["activeMarkerHash"],
        "originalHistoryPreserved": ancestry,
    }
    write_report(output, "preservation.json", result)
    print(json.dumps(result, indent=2))
    if not result["preserved"]:
        raise AssertionError("Car task modified unrelated work, history or another session's task")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--browser", action="store_true")
    mode.add_argument("--preservation", action="store_true")
    parser.add_argument("--negative-control", action="store_true")
    parser.add_argument("--baseline", type=Path)
    args = parser.parse_args()
    output = Path(os.environ.get("PROVE_IT_OUTPUT_DIR", str(ROOT / "output" / "car-suv"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if args.preservation:
        if not args.baseline:
            parser.error("--preservation requires --baseline")
        return preserve(args.baseline.resolve(), output)
    return run_browser(output, args.negative_control)


if __name__ == "__main__":
    sys.exit(main())
