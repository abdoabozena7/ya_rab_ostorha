"""Verify the restored game through its real server/browser and Git provenance."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]


def git(*arguments):
    return subprocess.check_output(["git", *arguments], cwd=ROOT).decode().strip()


def write_report(output, name, value):
    (output / name).write_text(json.dumps(value, indent=2), encoding="utf-8")


def preservation(baseline_path, output):
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    changed = [
        name for name, expected in baseline["originalFiles"].items()
        if name not in baseline["allowedChanges"]
        and (not (ROOT / name).is_file()
             or hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected)
    ]
    source = baseline["stash"]
    recovered = git("ls-tree", "-r", "--name-only", source, "--",
                    "src/core", "src/signal_processing").splitlines()
    mismatches = []
    line_endings = []
    for name in recovered:
        expected = subprocess.check_output(["git", "show", f"{source}:{name}"], cwd=ROOT)
        if not (ROOT / name).is_file():
            mismatches.append(name)
            continue
        current = (ROOT / name).read_bytes()
        if current.replace(b"\r\n", b"\n") != expected.replace(b"\r\n", b"\n"):
            mismatches.append(name)
        elif current != expected:
            line_endings.append(name)
    history = subprocess.run(
        ["git", "merge-base", "--is-ancestor", baseline["head"], "HEAD"], cwd=ROOT,
        check=False,
    ).returncode == 0
    active = ROOT / ".runtime-proof" / "active.json"
    ownership = hashlib.sha256(active.read_bytes()).hexdigest() == baseline["activeMarkerHash"]
    branches = git("for-each-ref", "--format=%(refname:short)", "refs/heads").splitlines()
    worktrees = git("worktree", "list", "--porcelain").splitlines()
    main = (git("branch", "--show-current") == "main" and branches == ["main"]
            and sum(line.startswith("worktree ") for line in worktrees) == 1)
    before_index = baseline_path.parent / "before" / "index.html"
    archive = ROOT / "legacy" / "carla-dashboard" / "index.html"
    defaults = (
        "backend.threejs.server" in json.loads((ROOT / "package.json").read_text())["scripts"]["start"]
        and "/public/threejs/game.bundle.js" in (ROOT / "index.html").read_text(encoding="utf-8")
        and (ROOT / "AGENTS.md").read_text(encoding="utf-8").startswith("# Active project: standalone Three.js")
        and "standalone Three.js" in (ROOT / "README.md").read_text(encoding="utf-8").splitlines()[0]
        and archive.read_bytes() == before_index.read_bytes()
    )
    report = {
        "unrelatedChangesPreserved": not changed,
        "originalHistoryPreserved": history and git("rev-parse", "refs/stash") == source,
        "otherTaskUnchanged": ownership,
        "mainCheckout": main,
        "canonicalDefaults": defaults,
        "recoveredCoreFiles": len(recovered),
        "coreMatchesSavedTree": bool(recovered) and not mismatches,
        "changedUnrelatedFiles": changed,
        "coreMismatches": mismatches,
        "windowsArchiveLineEndingConversions": line_endings,
        "source": source,
        "head": git("rev-parse", "HEAD"),
    }
    write_report(output, "preservation.json", report)
    print(json.dumps(report, indent=2))
    for field in ("unrelatedChangesPreserved", "originalHistoryPreserved", "otherTaskUnchanged",
                  "mainCheckout", "canonicalDefaults", "coreMatchesSavedTree"):
        if not report[field]:
            raise AssertionError(f"Recovery preservation failed: {field}")
    return 0


def browser(output, negative):
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required for browser acceptance")
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
                raise AssertionError("Browser acceptance reached the wrong server")
            environment["THREEJS_URL"] = url
            command = [node, str(ROOT / "tools" / "verify-threejs.mjs")]
            if negative:
                command.append("--negative-control")
            result = subprocess.run(command, cwd=ROOT, env=environment, timeout=240, check=False)
            return result.returncode
        finally:
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--browser", action="store_true")
    mode.add_argument("--preservation", action="store_true")
    parser.add_argument("--negative-control", action="store_true")
    parser.add_argument("--baseline", type=Path)
    args = parser.parse_args()
    output = Path(os.environ.get("PROVE_IT_OUTPUT_DIR", str(ROOT / "output" / "threejs-verification"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if args.preservation:
        if not args.baseline:
            parser.error("--preservation requires --baseline")
        return preservation(args.baseline.resolve(), output)
    return browser(output, args.negative_control)


if __name__ == "__main__":
    sys.exit(main())
