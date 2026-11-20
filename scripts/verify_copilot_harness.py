"""Audit native-only harness wiring and inspect its actual Copilot runtime evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / ".agents" / "skills" / "prove-it"


def audit():
    obsolete = [
        ".github/extensions/codex-bridge/extension.mjs",
        ".github/extensions/codex-bridge/bridge.mjs",
        ".codex/config.toml",
        "scripts/verify_codex_bridge.py",
        "tests/codex-bridge.test.js",
        "tests/test_codex_harness.py",
    ]
    remaining = [name for name in obsolete if (ROOT / name).exists()]
    if remaining:
        raise ValueError(f"Unwanted architecture remains active: {remaining}")
    extension = ROOT / ".github" / "extensions" / "prove-it-harness"
    text = "\n".join(path.read_text(encoding="utf-8") for path in sorted(extension.glob("*.mjs")))
    if "joinSession" not in text or "model.getCurrent" not in text:
        raise ValueError("Missing supported native session integration.")
    for token in (
        "codex.cmd", "codex.exe", "codex_bridge_run", "getCodexStatus",
        "createSession(", "switchTo(", "setModel(", "session.send(", "sendAndWait(",
        "requestedEnvironmentVariables", "approveAll", "onPermissionRequest:",
    ):
        if token in text:
            raise ValueError(f"Unexpected model/permission execution path: {token}")
    if not (SKILL / "scripts" / "proof.py").is_file():
        raise ValueError("The original installed Prove It collector is missing.")
    if (ROOT / ".github" / "skills" / "prove-it").exists():
        raise ValueError("The correction must not duplicate the installed skill.")
    if "/.runtime-proof/" not in (ROOT / ".gitignore").read_text(encoding="utf-8-sig").splitlines():
        raise ValueError("Private evidence is no longer ignored.")
    return {"obsolete_paths_absent": True, "separate_model_layer": False, "skill_copies": 1}


def verify_runtime(task, output):
    evidence = json.loads((task / "runtime-evidence.json").read_text(encoding="utf-8"))
    trace = ROOT / evidence["trace"]
    records = [json.loads(line) for line in trace.read_text(encoding="utf-8").splitlines() if line.strip()]
    source = hashlib.sha256()
    extension = ROOT / ".github" / "extensions" / "prove-it-harness"
    for name in ("extension.mjs", "harness.mjs", "process.mjs"):
        source.update(name.encode("utf-8") + b"\0")
        source.update((extension / name).read_bytes())
    if not records or any(row["sourceHash"] != source.hexdigest() for row in records):
        raise ValueError("Native observations belong to stale extension source.")
    selections = [row for row in records if row["type"] == "model.selection"]
    usage = [row for row in records if row["type"] == "model.usage" and row.get("agentId") is None]
    helpers = [row for row in records if row["type"] == "helper.completed"]
    if len(selections) < 2 or not usage or not helpers:
        raise ValueError("Missing live model selection, primary inference or deterministic helper observations.")
    selected = evidence["selected_model_id"]
    if any(row["modelId"] != selected for row in selections):
        raise ValueError("The selected Copilot model changed during the measured workflow.")
    if not any(row["model"] == selected for row in usage):
        raise ValueError("Primary inference did not report the selected Copilot model.")
    if any(row["sessionId"] != evidence["sdk_session_id"] for row in selections + usage + helpers):
        raise ValueError("Runtime evidence belongs to another SDK session.")
    expected_script = (SKILL / "scripts" / "proof.py").resolve()
    for row in helpers:
        if Path(row["script"]).resolve() != expected_script or "python" not in Path(row["executable"]).name.lower():
            raise ValueError("A harness helper did not use the installed deterministic Python collector.")
    skill_hashes = json.loads((task / "skill-baseline.json").read_text(encoding="utf-8-sig"))
    for relative, expected in skill_hashes.items():
        if hashlib.sha256((SKILL / relative).read_bytes()).hexdigest() != expected:
            raise ValueError(f"The installed skill was modified: {relative}")
    sys.path.insert(0, str(SKILL / "scripts"))
    import proof
    gate = proof.verify(ROOT / evidence["e2e_task"])
    if not gate["passed"]:
        raise ValueError(f"The representative coding task is not verified: {gate['errors']}")
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(trace, output / "host-trace.jsonl")
    (output / "e2e-gate.json").write_text(json.dumps(gate, indent=2), encoding="utf-8")
    summary = {
        "selected_model": selected,
        "observed_primary_model": selected,
        "sdk_session_id": evidence["sdk_session_id"],
        "helper_count": len(helpers),
        "model_usage_observations": len(usage),
        "separate_model_helper_count": 0,
        "unchanged_skill_files": len(skill_hashes),
        "observed_pre_tool_callbacks": sum(row["type"] == "sdk.pre_tool" for row in records),
        "e2e_verified": True,
        "billing": "No precise credit measurement claimed.",
    }
    (output / "runtime-result.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", action="store_true")
    parser.add_argument("--task", type=Path)
    args = parser.parse_args()
    try:
        result = audit()
        if not args.audit:
            if args.task is None or not os.environ.get("PROVE_IT_OUTPUT_DIR"):
                raise ValueError("--task and PROVE_IT_OUTPUT_DIR are required for runtime inspection.")
            result.update(verify_runtime(args.task, Path(os.environ["PROVE_IT_OUTPUT_DIR"])))
        print(json.dumps(result))
        return 0
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
