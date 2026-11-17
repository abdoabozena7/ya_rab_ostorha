"""Verify the real local camera/predictor/driver journey and preserved workspace."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from verify_car_quality import ROOT, run_browser, write_report


TASK = ROOT / ".runtime-proof" / "vision-egypt-20261116"


def preservation(output):
    baseline = json.loads((ROOT / ".runtime-proof" / "car-quality-20261116" /
                           "baseline.json").read_text(encoding="utf-8"))
    allowed = {"README.md", "ROOT_GOAL.md"}
    changed = [
        name for name, digest in baseline["originalFiles"].items()
        if name not in allowed
        and (not (ROOT / name).is_file()
             or hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest)
    ]
    marker = hashlib.sha256((ROOT / ".runtime-proof" / "active.json").read_bytes()).hexdigest()
    ancestry = subprocess.run(
        ["git", "merge-base", "--is-ancestor", baseline["head"], "HEAD"], cwd=ROOT, check=False,
    ).returncode == 0
    branch = subprocess.check_output(["git", "branch", "--show-current"], cwd=ROOT).decode().strip()
    historical = "# Historical native ROOT GOAL: OPEN / NOT ACCEPTED"
    saved_root = (TASK / "root-goal-before.txt").read_text(encoding="utf-8")
    current_root = (ROOT / "ROOT_GOAL.md").read_text(encoding="utf-8")
    native_goal_preserved = (
        historical in saved_root and historical in current_root
        and saved_root.split(historical, 1)[1] == current_root.split(historical, 1)[1]
    )
    report = {
        "preserved": not changed and marker == baseline["activeMarkerHash"]
        and ancestry and branch == "main" and native_goal_preserved,
        "changedUnrelatedFiles": changed,
        "otherActiveTaskUnchanged": marker == baseline["activeMarkerHash"],
        "ancestryPreserved": ancestry, "branch": branch,
        "historicalNativeGoalUnchanged": native_goal_preserved,
    }
    write_report(output, "preservation.json", report)
    print(json.dumps(report))
    if not report["preserved"]:
        raise AssertionError("Unrelated local work or another client's task was changed")
    return 0


def model_check(output):
    sample = TASK / "camera-sample.json"
    if not sample.is_file():
        raise RuntimeError("Run the actual public browser journey first; no live camera sample is available.")
    code = """
import json, statistics, sys, time
from pathlib import Path
from backend.threejs.vision import VisionService, capabilities
frame=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
service=VisionService()
try:
    startup=service.start()
    if not startup.get('available'):
        raise RuntimeError(startup.get('error') or 'Vision service unavailable')
    timings=[]
    result=None
    for i in range(7):
        frame['frameId'] += 1
        frame['simulationTimeS'] += .1
        start=time.perf_counter()
        result=service.process_frame(frame)
        if i>=2: timings.append((time.perf_counter()-start)*1000)
    timings.sort()
    print(json.dumps({'executable':True,'downloadsPerformed':False,
        'inputSource':'rendered-camera-pixels','model':result['model'],
        'sampleFrame':frame['frameId'],'detections':result['detections'],
        'latencyMs':{'samples':timings,'p50':statistics.median(timings),
                     'p95':timings[-1]},'capabilities':capabilities()}))
finally:
    service.close()
"""
    result = subprocess.run([sys.executable, "-c", code, str(sample)], cwd=ROOT,
                            capture_output=True, text=True, timeout=180, check=False)
    (output / "model.stdout.log").write_text(result.stdout, encoding="utf-8")
    (output / "model.stderr.log").write_text(result.stderr, encoding="utf-8")
    if result.returncode:
        raise RuntimeError(f"Actual existing-model execution failed: {result.stderr}")
    report = json.loads(result.stdout)
    probe = TASK / "model-probe" / "results.json"
    report["localProbe"] = json.loads(probe.read_text(encoding="utf-8"))["conclusion"]
    trajectory_path = TASK / "model-probe" / "trajectory-runtime-probe.json"
    trajectory = json.loads(trajectory_path.read_text(encoding="utf-8"))
    report["existingLearnedForecastProbe"] = {
        "evidenceClass": "retained synthetic CPU API compatibility, not current camera accuracy",
        "probeSha256": hashlib.sha256(trajectory_path.read_bytes()).hexdigest(),
        "scope": trajectory["scope"], "identity": trajectory["identity"],
        "observed": trajectory["observed"],
        "remainingValidation": trajectory["remaining_validation"],
    }
    report["decision"] = (
        "Existing YOLOX-Tiny416 CPU plus observed-track kinematics/time-conflict decision. "
        "Installed YOLOv8s adapter was materially slower in the retained probe. "
        "Saved Q/GRU are range/state policies, not pixel-native; no RL superiority or new training is claimed."
    )
    report["sampleSha256"] = hashlib.sha256(sample.read_bytes()).hexdigest()
    write_report(output, "model-decision.json", report)
    print(json.dumps(report))
    return 0


def browser_check(output, negative):
    if not negative:
        car = output / "car"
        car.mkdir(parents=True, exist_ok=True)
        code = run_browser(car, False)
        if code:
            return code
        for image in car.glob("*.png"):
            shutil.copy2(image, output / ("car-" + image.name))
    code = run_browser(output, negative, driver="verify-vision.mjs", timeout=650)
    if code == 0 and not negative:
        result = json.loads((output / "vision-journey.json").read_text(encoding="utf-8"))
        car = json.loads((output / "car" / "car-journey.json").read_text(encoding="utf-8"))
        result["carFinishingAndReset"] = all(car.get(name) is True for name in (
            "suvStyleVerified", "cockpitVerified", "sensorsVerified",
            "cameraSwitchVerified", "realImpactVerified", "resetAndCityReturn",
        ))
        result["carEvidenceDirectory"] = "car"
        write_report(output, "vision-journey.json", result)
        if not result["carFinishingAndReset"]:
            raise AssertionError("The complete current car journey did not pass")
    return code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--browser", action="store_true")
    mode.add_argument("--models", action="store_true")
    mode.add_argument("--preservation", action="store_true")
    mode.add_argument("--vision-checkpoint", action="store_true")
    parser.add_argument("--negative-control", action="store_true")
    args = parser.parse_args()
    output = Path(os.environ.get("PROVE_IT_OUTPUT_DIR", str(ROOT / "output" / "vision-egypt"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if args.models:
        return model_check(output)
    if args.preservation:
        return preservation(output)
    if args.vision_checkpoint:
        return run_browser(output, args.negative_control, driver="verify-vision.mjs", timeout=650)
    return browser_check(output, args.negative_control)


if __name__ == "__main__":
    sys.exit(main())
