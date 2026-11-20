"""Verify the actual standalone district and preserve existing local work."""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from verify_car_quality import ROOT, run_browser, write_report
from verify_vision_egypt import browser_check


TASK = ROOT / ".runtime-proof" / "egypt-district-v1"


def preservation(output):
    baseline = json.loads((TASK / "baseline.json").read_text(encoding="utf-8"))
    changed = [
        name for name, digest in baseline["originalFiles"].items()
        if name not in {"README.md", "ROOT_GOAL.md"}
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
    count = sum(line.startswith("worktree ") for line in worktrees.splitlines())
    report = {
        "preserved": not changed and all(tails.values()) and ancestry
        and marker == baseline["activeMarkerSha256"] and branch == "main" and count == 1,
        "changedUnrelatedFiles": changed, "historicalTailsUnchanged": tails,
        "otherActiveTaskUnchanged": marker == baseline["activeMarkerSha256"],
        "ancestryPreserved": ancestry, "branch": branch, "worktrees": count,
    }
    write_report(output, "preservation.json", report)
    print(json.dumps(report))
    if not report["preserved"]:
        raise AssertionError("District changes modified unrelated work, history or another client's task")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    for name in ("core", "cases", "case-checkpoint", "browser", "checkpoint", "prior-product", "negative-control", "preservation"):
        mode.add_argument("--" + name, action="store_true")
    args = parser.parse_args()
    output = Path(os.environ.get(
        "PROVE_IT_OUTPUT_DIR", str(ROOT / "output" / "egypt-district"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if args.preservation:
        return preservation(output)
    if args.core:
        return subprocess.run(
            ["node", str(ROOT / "tools" / "evaluate-egypt-district.mjs")],
            cwd=ROOT, timeout=850, check=False,
        ).returncode
    if args.prior_product:
        camera = output / "camera-people"
        camera.mkdir(parents=True, exist_ok=True)
        code = run_browser(camera, False, driver="verify-camera-people.mjs", timeout=540)
        if code:
            return code
        prior = output / "car-vision"
        prior.mkdir(parents=True, exist_ok=True)
        os.environ["VISION_SAMPLE_PATH"] = str(output / "camera-sample.json")
        code = browser_check(prior, False)
        if code:
            return code
        a = json.loads((camera / "camera-people-journey.json").read_text(encoding="utf-8"))
        b = json.loads((prior / "vision-journey.json").read_text(encoding="utf-8"))
        passed = a["camera"]["exactFrameVerified"] and a["people"]["publicMotionVerified"] \
            and a["people"]["replayVerified"] and b["carFinishingAndReset"] \
            and b["positiveCrossingsPassed"] >= 2 and b["negativeCasesPassed"] >= 3 \
            and b["predictiveFalseBrakes"] == 0
        original = subprocess.run(["node", str(ROOT / "tools" / "evaluate-core.mjs")], cwd=ROOT,
                                  timeout=600, capture_output=True, text=True, check=False)
        (output / "original-city.stdout.log").write_text(original.stdout, encoding="utf-8")
        (output / "original-city.stderr.log").write_text(original.stderr, encoding="utf-8")
        if original.returncode:
            raise RuntimeError("Original finite city evaluation failed; inspect retained original-city logs")
        city_runs = [json.loads(line) for line in original.stdout.splitlines() if line.strip()]
        passed = passed and len(city_runs) == 4 and all(
            not run["violations"] and run["arrivalTick"] is not None for run in city_runs)
        write_report(output, "prior-product.json", {
            "passed": passed, "cameraPeople": a, "carVision": b, "originalCity": city_runs,
        })
        if not passed:
            raise AssertionError("The complete inherited public product no longer passes")
        return 0
    os.environ["DISTRICT_VERIFY_MODE"] = "cases" if args.cases else "case-checkpoint" if args.case_checkpoint \
        else "negative" if args.negative_control \
        else "checkpoint" if args.checkpoint else "browser"
    full_development = args.case_checkpoint and (
        os.environ.get("DISTRICT_DEVELOPMENT_ALL") == "1"
        or os.environ.get("DISTRICT_DEVELOPMENT_CASES") is not None)
    return run_browser(output, args.negative_control, driver="verify-egypt-district.mjs",
                       timeout=1400 if args.cases or full_development else 820 if args.browser else 320)


if __name__ == "__main__":
    sys.exit(main())
