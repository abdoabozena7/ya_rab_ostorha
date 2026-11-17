"""Verify the standalone camera-evidence and embodied-people public journey."""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from verify_car_quality import ROOT, run_browser, write_report
from verify_vision_egypt import browser_check


TASK = ROOT / ".runtime-proof" / "camera-people-20261117"


def preservation(output):
    baseline = json.loads((TASK / "baseline.json").read_text(encoding="utf-8"))
    allowed = set(baseline["permittedActiveDocumentEdits"])
    changed = [
        name for name, digest in baseline["originalFiles"].items()
        if name not in allowed
        and (not (ROOT / name).is_file()
             or hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest)
    ]
    tails = {}
    for name, marker in (
        ("README.md", "# Historical CARLA Collision-Avoidance Prototype"),
        ("ROOT_GOAL.md", "# Historical native ROOT GOAL: OPEN / NOT ACCEPTED"),
    ):
        original = (TASK / (name + ".before.txt")).read_text(encoding="utf-8")
        current = (ROOT / name).read_text(encoding="utf-8")
        tails[name] = marker in original and marker in current and (
            original.split(marker, 1)[1] == current.split(marker, 1)[1])
    marker = hashlib.sha256((ROOT / ".runtime-proof" / "active.json").read_bytes()).hexdigest()
    ancestry = subprocess.run(
        ["git", "merge-base", "--is-ancestor", baseline["head"], "HEAD"], cwd=ROOT, check=False,
    ).returncode == 0
    branch = subprocess.check_output(["git", "branch", "--show-current"], cwd=ROOT).decode().strip()
    worktrees = subprocess.check_output(["git", "worktree", "list", "--porcelain"], cwd=ROOT).decode()
    worktree_count = sum(line.startswith("worktree ") for line in worktrees.splitlines())
    report = {
        "preserved": not changed and all(tails.values()) and ancestry
        and marker == baseline["activeMarkerSha256"] and branch == "main" and worktree_count == 1,
        "changedUnrelatedFiles": changed,
        "historicalTailsUnchanged": tails,
        "otherActiveTaskUnchanged": marker == baseline["activeMarkerSha256"],
        "ancestryPreserved": ancestry, "branch": branch, "worktrees": worktree_count,
    }
    write_report(output, "preservation.json", report)
    print(json.dumps(report))
    if not report["preserved"]:
        raise AssertionError("Camera/people work changed unrelated source, history or another client's task")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--browser", action="store_true")
    mode.add_argument("--prior-product", action="store_true")
    mode.add_argument("--negative-control", action="store_true")
    mode.add_argument("--preservation", action="store_true")
    args = parser.parse_args()
    output = Path(os.environ.get(
        "PROVE_IT_OUTPUT_DIR", str(ROOT / "output" / "camera-people"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if args.preservation:
        return preservation(output)
    if args.prior_product:
        os.environ["VISION_SAMPLE_PATH"] = str(TASK / "camera-sample.json")
        return browser_check(output, False)
    code = run_browser(output, args.negative_control, driver="verify-camera-people.mjs", timeout=540)
    if args.negative_control and code == 3:
        inherited = output / "independent-safety"
        inherited.mkdir(parents=True, exist_ok=True)
        safety_code = run_browser(inherited, True, driver="verify-vision.mjs", timeout=180)
        if safety_code != 3:
            raise AssertionError("Original actual visual-loss/reactive-safety control did not detect the intended failure")
        safety = json.loads((inherited / "negative.json").read_text(encoding="utf-8"))
        result = json.loads((output / "negative.json").read_text(encoding="utf-8"))
        result["independentSafetyFallback"] = safety
        result["detected"] = result["detected"] and safety["detected"]
        write_report(output, "negative.json", result)
    return code


if __name__ == "__main__":
    sys.exit(main())
