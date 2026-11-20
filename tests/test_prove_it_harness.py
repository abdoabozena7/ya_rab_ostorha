import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / ".agents" / "skills" / "prove-it"
PROOF = SKILL / "scripts" / "proof.py"
SESSION = "native-copilot-harness-test"


class ProveItHarnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="native proof harness ")
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name)
        (self.project / "nested").mkdir()
        self.task = self.project / ".runtime-proof" / "cli-demo"
        self.payload = {
            "cwd": str(self.project / "nested"),
            "session_id": SESSION,
            "hook_event_name": "Stop",
            "stop_hook_active": False,
        }

    def proof(self, *args):
        result = subprocess.run(
            [sys.executable, str(PROOF), *args],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def initialize_task(self):
        self.proof(
            "init", "--project", str(self.project), "--id", "cli-demo",
            "--goal", "Check the deterministic collector with an arithmetic fixture",
            "--kind", "cli", "--session-id", SESSION,
        )
        shutil.copyfile(SKILL / "examples" / "demo_cli.py", self.project / "demo_cli.py")
        shutil.copyfile(SKILL / "examples" / "cli-contract.json", self.task / "contract.json")
        self.proof("seal", "--task", str(self.task))

    def hook(self, *, raw=None, cwd=None):
        argv = [sys.executable, str(PROOF), "hook", "--host", "copilot"]
        return subprocess.run(
            argv,
            cwd=cwd or ROOT / "tests",
            input=json.dumps(self.payload) if raw is None else raw,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )

    def decision(self, **kwargs):
        result = self.hook(**kwargs)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout)

    def test_collector_does_not_require_model_cli_or_provider_credentials(self):
        self.initialize_task()
        environment = {
            key: value for key, value in os.environ.items()
            if not any(token in key.upper() for token in ("TOKEN", "API_KEY", "CODEX", "OPENAI", "ANTHROPIC"))
        }
        environment["PATH"] = os.environ.get("SystemRoot", r"C:\Windows")
        result = subprocess.run(
            [sys.executable, str(PROOF), "run", "--task", str(self.task), "--check", "addition"],
            cwd=self.project, env=environment, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_no_active_task_allows_stop_from_root_and_subdirectory(self):
        self.assertEqual(self.decision(cwd=ROOT), {})
        self.assertEqual(self.decision(), {})

    def test_invalid_input_blocks_instead_of_returning_success(self):
        for raw in ("[]", "{malformed"):
            with self.subTest(raw=raw):
                result = self.decision(raw=raw)
                self.assertEqual(result["decision"], "block")
                self.assertIn("hook failed", result["reason"])

    def test_incomplete_other_session_and_no_progress(self):
        self.initialize_task()
        self.payload["session_id"] = "another-copilot-session"
        self.assertEqual(self.decision(), {})
        self.assertFalse((self.task / "gate.json").exists())
        self.payload["session_id"] = SESSION
        decision = self.decision()
        self.assertEqual(decision["decision"], "block")
        self.assertIn("evidence is incomplete", decision["reason"])
        self.assertFalse(json.loads((self.task / "gate.json").read_text())["passed"])
        self.payload["stop_hook_active"] = True
        self.assertEqual(self.decision(), {})
        attention = json.loads((self.task / "needs-attention.json").read_text())
        self.assertEqual(attention["status"], "PAUSED_UNVERIFIED")
        self.assertFalse(json.loads((self.task / "gate.json").read_text())["passed"])

    def test_executed_verified_task_allows_stop_but_source_drift_blocks(self):
        self.initialize_task()
        self.proof("run", "--task", str(self.task), "--check", "addition")
        self.assertEqual(self.decision()["decision"], "block")
        self.proof(
            "step", "--task", str(self.task), "--id", "T01", "--status", "VERIFIED",
            "--note", "Executed the real CLI and checked its JSON sum against 12.",
        )
        self.assertEqual(self.decision(), {})
        self.assertTrue(json.loads((self.task / "gate.json").read_text())["passed"])
        (self.project / "demo_cli.py").write_text('print(\'{"sum": 13}\')\n', encoding="utf-8")
        self.assertEqual(self.decision()["decision"], "block")
        self.assertFalse(json.loads((self.task / "gate.json").read_text())["passed"])

    def test_documented_blocker_allows_handoff_without_certification(self):
        self.initialize_task()
        evidence = self.task / "unavailable.txt"
        evidence.write_text("Synthetic control: the required service is unavailable.", encoding="utf-8")
        self.proof(
            "block", "--task", str(self.task),
            "--reason", "The fixture service is unavailable.",
            "--action", "Restore the fixture service before retrying.",
            "--evidence", evidence.name,
        )
        self.assertEqual(self.decision(), {})
        self.assertFalse(json.loads((self.task / "gate.json").read_text())["passed"])

    def test_verified_cannot_be_claimed_before_execution(self):
        self.initialize_task()
        result = subprocess.run(
            [sys.executable, str(PROOF), "step", "--task", str(self.task),
             "--id", "T01", "--status", "VERIFIED", "--note", "Unverified test claim."],
            cwd=self.project, capture_output=True, text=True, timeout=30,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("UNVERIFIED", result.stderr)


if __name__ == "__main__":
    unittest.main()
