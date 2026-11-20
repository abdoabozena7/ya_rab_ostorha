"""Offline safety regressions and explicit SYNTHETIC NOT CARLA native fixtures.

Unit tests never launch ProcDump. The explicit --synthetic-fixtures entry point
launches only owned Python children, including an intentional Win32 fail-fast.
All outputs, including failures, remain in the requested project-local folder.
"""
import ctypes
import hashlib
import itertools
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time
import traceback
import unittest
from unittest import mock
import uuid


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts.native import native_crash_capture as capture


FIXTURE_ROOT = ROOT / "tmp" / "native-crash-capture-20261029-ef402517"
WORKER_BIRTH = (11644473600 + 1700000000) * 10_000_000
CAPTURE_BIRTH = WORKER_BIRTH + 10000000
SYNTHETIC_EXCEPTION = 0xC0000409


class FakeWindows:
    def __init__(self, *, running=False, debugger=(False, True), code=0):
        self.running = running
        self.debugger_states = list(debugger)
        self.debugger_last = self.debugger_states[-1]
        self.code = code
        self.birth = CAPTURE_BIRTH
        self.image = str(capture.PINNED_EXECUTABLE)
        self.opened = []
        self.waited = []
        self.terminated = []
        self.closed = []
        self.vanished = False
        self.termination_stuck = False

    def current_process(self):
        return "self"

    def identity(self, handle):
        if handle == "self":
            return {"creation_filetime": WORKER_BIRTH, "image_path": sys.executable}
        return {"creation_filetime": self.birth, "image_path": self.image}

    def debugger_present(self):
        if self.debugger_states:
            return self.debugger_states.pop(0)
        return self.debugger_last

    def open_process(self, pid):
        self.opened.append(pid)
        return None if self.vanished else "capture"

    def wait(self, handle, milliseconds):
        self.waited.append((handle, milliseconds))
        return capture.WAIT_TIMEOUT if self.running else capture.WAIT_OBJECT_0

    def returncode(self, handle):
        return self.code

    def terminate(self, handle):
        self.terminated.append(handle)
        self.code = capture.OWNED_TIMEOUT_EXIT_CODE
        if not self.termination_stuck:
            self.running = False

    def close(self, handle):
        self.closed.append(handle)


class FakeProcess:
    pid = 123456
    _handle = "capture"


def _dump_bytes(pid, *, created=1700000000, code=SYNTHETIC_EXCEPTION, module=False):
    kinds = [6, 3, 15] + ([4] if module else [])
    cursor = 32 + 12 * len(kinds)
    exception_rva = cursor
    cursor += 168
    thread_rva = cursor
    cursor += 52
    misc_rva = cursor
    cursor += 24
    module_rva = cursor
    if module:
        cursor += 112
    context_rva = cursor
    cursor += 16
    module_name = "C:\\Windows\\System32\\synthetic.dll".encode("utf-16-le")
    name_rva = cursor
    exception = bytearray(168)
    struct.pack_into("<I", exception, 0, 77)
    struct.pack_into("<II", exception, 8, code, 1)
    struct.pack_into("<Q", exception, 24, 0x1005)
    struct.pack_into("<I", exception, 32, 1)
    struct.pack_into("<Q", exception, 40, 7)
    struct.pack_into("<II", exception, 160, 16, context_rva)
    entries = [(6, 168, exception_rva), (3, 52, thread_rva), (15, 24, misc_rva)]
    modules = b""
    if module:
        entries.append((4, 112, module_rva))
        record = bytearray(108)
        struct.pack_into("<QI", record, 0, 0x1000, 0x100)
        struct.pack_into("<I", record, 20, name_rva)
        modules = struct.pack("<I", 1) + record
    return (
        struct.pack("<4sIIIIIQ", b"MDMP", 0xA793, len(kinds), 32, 0, 1700000001, 0)
        + b"".join(struct.pack("<III", *entry) for entry in entries)
        + exception
        + struct.pack("<II", 1, 77) + bytes(44)
        + struct.pack("<IIIIII", 24, 3, pid, created, 0, 0)
        + modules + bytes(16)
        + (struct.pack("<I", len(module_name)) + module_name if module else b"")
    )


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.base = FIXTURE_ROOT / ("unit-" + uuid.uuid4().hex)
        self.base.mkdir(exist_ok=False)
        self.folder = self.base / "capture"

    def _start(self, api=None, **kwargs):
        api = api or FakeWindows(running=True)
        with mock.patch.object(capture, "_windows", return_value=api), mock.patch.object(
            capture.subprocess, "Popen", return_value=FakeProcess()
        ) as spawn:
            evidence = capture.start_capture(
                self.folder, executable=capture.PINNED_EXECUTABLE,
                deadline=time.monotonic() + 10, **kwargs
            )
        return evidence, api, spawn

    def _manifest(self, *, dump=False, log="The process has exited.\n"):
        self.folder.mkdir(exist_ok=False)
        pid = os.getpid() + 100000
        data = {
            "schema": 1, "requested": True, "attached": True, "status": "ARMED",
            "cleanup_confirmed": False, "error": None, "error_type": None,
            "error_winerror": None, "errors": [], "worker_pid": pid,
            "worker_parent_pid": os.getpid(), "parent_pid": os.getpid(),
            "worker_creation_filetime": WORKER_BIRTH,
            "capture_pid": 123456, "capture_creation_filetime": CAPTURE_BIRTH,
            "capture_identity_verified": True, "capture_returncode": None,
            "tool_exit_code": None, "capture_exit_observed": False,
            "capture_process_state": "RUNNING", "termination_requested": False,
            "executable": str(capture.PINNED_EXECUTABLE),
            "tool_sha256": capture.PINNED_SHA256,
            "folder": str(self.folder), "dump_path": str(self.folder / "native-worker.dmp"),
            "log_path": str(self.folder / "native-crash-capture.log"),
            "tool_argv": [
                str(capture.PINNED_EXECUTABLE), "-accepteula", "-e", "-mc", "0",
                "-n", "1", str(pid), str(self.folder / "native-worker.dmp"),
            ],
        }
        capture._atomic_json(self.folder / "native-crash-capture.json", data)
        (self.folder / "native-crash-capture.log").write_text(log, encoding="utf-8")
        if dump:
            (self.folder / "native-worker.dmp").write_bytes(_dump_bytes(pid))
        return data

    def _finish(self, api=None, exit_code=0):
        api = api or FakeWindows()
        with mock.patch.object(capture, "_windows", return_value=api):
            evidence = capture.finish_capture(
                self.folder, deadline=time.monotonic() + 10, worker_exit_code=exit_code
            )
        return evidence, api

    def _write_dump(self, raw):
        path = self.base / "malformed-or-fixture.dmp"
        path.write_bytes(raw)
        return path

    def test_start_arms_actual_worker_not_redirector(self):
        result, api, spawn = self._start()
        self.assertEqual(result["status"], "ARMED")
        self.assertIs(result["requested"], True)
        self.assertIs(result["attached"], True)
        self.assertIs(result["cleanup_confirmed"], False)
        self.assertEqual(result["worker_pid"], os.getpid())
        self.assertEqual(result["worker_parent_pid"], os.getppid())
        self.assertEqual(result["capture_pid"], FakeProcess.pid)
        self.assertEqual(result["capture_creation_filetime"], CAPTURE_BIRTH)
        self.assertEqual(result["tool_argv"][-2], str(os.getpid()))
        self.assertNotEqual(result["tool_argv"][-2], str(FakeProcess.pid))
        self.assertEqual(result["tool_argv"][1:7], ["-accepteula", "-e", "-mc", "0", "-n", "1"])
        self.assertEqual(spawn.call_args.kwargs["creationflags"], subprocess.CREATE_NO_WINDOW)
        self.assertEqual(api.terminated, [])
        self.assertEqual(json.loads((self.folder / "native-crash-capture.json").read_text()), result)

    def test_negative_invalid_relative_folder_rejected(self):
        with mock.patch.object(capture.subprocess, "Popen") as spawn:
            with self.assertRaises(capture.CaptureError) as raised:
                capture.start_capture(
                    Path("relative"), executable=capture.PINNED_EXECUTABLE,
                    deadline=time.monotonic() + 10
                )
        spawn.assert_not_called()
        self.assertEqual(raised.exception.evidence["error_type"], "ValueError")

    def test_negative_outside_checkout_rejected(self):
        with self.assertRaises(ValueError):
            capture._path(ROOT.parent / "unowned-evidence")

    def test_negative_traversal_and_device_paths_rejected(self):
        for path in (str(ROOT / "tmp") + "\\..\\outside", "\\\\?\\C:\\unowned", "\\\\server\\share\\capture"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                capture._path(path)

    def test_negative_existing_evidence_is_never_overwritten(self):
        self.folder.mkdir()
        sentinel = self.folder / "native-crash-capture.json"
        sentinel.write_text("OTHER OWNER", encoding="utf-8")
        with mock.patch.object(capture.subprocess, "Popen") as spawn:
            with self.assertRaises(capture.CaptureError):
                capture.start_capture(
                    self.folder, executable=capture.PINNED_EXECUTABLE,
                    deadline=time.monotonic() + 10
                )
        self.assertEqual(sentinel.read_text(), "OTHER OWNER")
        spawn.assert_not_called()

    def test_negative_source_directory_rejected(self):
        with self.assertRaises(ValueError):
            capture._folder(ROOT / "scripts" / "unowned-new-folder", new=True)

    def test_negative_reparse_path_rejected(self):
        original = Path.lstat

        def metadata(path):
            if path == self.base:
                return mock.Mock(st_file_attributes=0x400, st_mode=0o040755)
            return original(path)

        with mock.patch.object(Path, "lstat", metadata), self.assertRaisesRegex(ValueError, "Reparse"):
            capture._path(self.folder)

    def test_negative_wrong_binary_path_rejected(self):
        other = self.base / "procdump64.exe"
        other.write_bytes(b"not the approved executable")
        with mock.patch.object(capture.subprocess, "Popen") as spawn:
            with self.assertRaises(capture.CaptureError):
                capture.start_capture(self.folder, executable=other, deadline=time.monotonic() + 10)
        spawn.assert_not_called()
        self.assertFalse(self.folder.exists())

    def test_negative_wrong_hash_rejected_before_spawn(self):
        with mock.patch.object(capture, "_sha256", return_value="0" * 64), mock.patch.object(
            capture.subprocess, "Popen"
        ) as spawn:
            with self.assertRaisesRegex(capture.CaptureError, "SHA256 mismatch"):
                capture.start_capture(
                    self.folder, executable=capture.PINNED_EXECUTABLE,
                    deadline=time.monotonic() + 10
                )
        spawn.assert_not_called()
        self.assertFalse(self.folder.exists())

    def test_negative_changed_tool_size_is_rejected_without_hashing_or_spawning(self):
        with mock.patch.object(capture, "PINNED_SIZE_BYTES", 1), mock.patch.object(
            capture, "_sha256"
        ) as hashing, mock.patch.object(capture.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(capture.CaptureError, "size mismatch"):
                capture.start_capture(
                    self.folder, executable=capture.PINNED_EXECUTABLE,
                    deadline=time.monotonic() + 10,
                )
        hashing.assert_not_called()
        spawn.assert_not_called()

    def test_negative_preexisting_debugger_rejected(self):
        api = FakeWindows(debugger=(True,))
        with mock.patch.object(capture, "_windows", return_value=api), mock.patch.object(
            capture.subprocess, "Popen"
        ) as spawn:
            with self.assertRaises(capture.CaptureError) as raised:
                capture.start_capture(
                    self.folder, executable=capture.PINNED_EXECUTABLE,
                    deadline=time.monotonic() + 10
                )
        self.assertIn("already attached", str(raised.exception))
        self.assertIs(raised.exception.evidence["attached"], False)
        spawn.assert_not_called()

    def test_negative_invalid_or_expired_deadlines(self):
        for value in (True, float("nan"), float("inf"), "15", time.monotonic() - 1):
            with self.subTest(value=value), self.assertRaises((ValueError, TimeoutError)):
                capture._deadline(value)

    def test_deadline_is_capped_at_fifteen_seconds(self):
        before = time.monotonic()
        result = capture._deadline(before + 1000)
        self.assertLessEqual(result - before, 15.1)

    def test_negative_spawn_failure_is_surfaced_and_retained(self):
        api = FakeWindows()
        with mock.patch.object(capture, "_windows", return_value=api), mock.patch.object(
            capture.subprocess, "Popen", side_effect=OSError("owned spawn failed")
        ):
            with self.assertRaises(capture.CaptureError) as raised:
                capture.start_capture(
                    self.folder, executable=capture.PINNED_EXECUTABLE,
                    deadline=time.monotonic() + 10
                )
        self.assertEqual(raised.exception.evidence["status"], "SETUP_FAILED")
        self.assertEqual(raised.exception.evidence["error_type"], "OSError")
        saved = json.loads((self.folder / "native-crash-capture.json").read_text())
        self.assertIn("owned spawn failed", saved["error"])
        self.assertTrue((self.folder / "native-crash-capture.log").exists())

    def test_negative_tool_exits_before_attachment(self):
        api = FakeWindows(code=13)
        with self.assertRaises(capture.CaptureError) as raised:
            self._start(api)
        self.assertEqual(raised.exception.evidence["tool_exit_code"], 13)
        self.assertIs(raised.exception.evidence["cleanup_confirmed"], True)
        self.assertIs(raised.exception.evidence["attached"], False)
        self.assertEqual(api.terminated, [])

    def test_negative_attachment_timeout_bounds_only_owned_dumper(self):
        api = FakeWindows(running=True, debugger=(False,))
        clock = itertools.count(1000.0, 0.1)
        with mock.patch.object(capture.time, "monotonic", side_effect=lambda: next(clock)), mock.patch.object(
            capture, "_windows", return_value=api
        ), mock.patch.object(capture.subprocess, "Popen", return_value=FakeProcess()):
            with self.assertRaises(capture.CaptureError) as raised:
                capture.start_capture(self.folder, executable=capture.PINNED_EXECUTABLE, deadline=1003)
        self.assertEqual(raised.exception.evidence["error_type"], "TimeoutError")
        self.assertEqual(api.terminated, ["capture"])
        self.assertIs(raised.exception.evidence["cleanup_confirmed"], True)

    def test_finish_clean_exit_is_not_a_crash_fix(self):
        manifest = self._manifest()
        result, api = self._finish()
        self.assertEqual(result["status"], "NO_EXCEPTION")
        self.assertEqual(result["worker_exit_code"], 0)
        self.assertEqual(result["capture_returncode"], 0)
        self.assertEqual(result["tool_exit_code"], 0)
        self.assertIs(result["cleanup_confirmed"], True)
        self.assertIs(result["dump_exists"], False)
        self.assertEqual(api.opened, [manifest["capture_pid"]])
        self.assertEqual(api.closed, ["capture"])
        self.assertEqual(api.terminated, [])

    def test_finish_captured_exception_preserves_nonzero_worker_exit(self):
        self._manifest(dump=True)
        result, _ = self._finish(exit_code=SYNTHETIC_EXCEPTION)
        self.assertEqual(result["status"], "CAPTURED_EXCEPTION")
        self.assertEqual(result["worker_exit_code"], SYNTHETIC_EXCEPTION)
        self.assertIs(result["worker_clean_exit"], False)
        self.assertEqual(result["exception_code"], SYNTHETIC_EXCEPTION)
        self.assertEqual(result["dump"]["exception_thread_id"], 77)
        self.assertEqual(result["dump"]["exception_address"], 0x1005)
        self.assertTrue(result["dump"]["target_identity_verified"])
        self.assertEqual(
            result["dump"]["sha256"],
            hashlib.sha256((self.folder / "native-worker.dmp").read_bytes()).hexdigest(),
        )

    def test_negative_pid_reuse_never_waits_or_terminates_unowned_process(self):
        self._manifest()
        api = FakeWindows(running=True)
        api.birth += 1
        result, api = self._finish(api)
        self.assertEqual(result["status"], "IDENTITY_MISMATCH")
        self.assertEqual(result["error_type"], "CaptureIdentityError")
        self.assertIs(result["cleanup_confirmed"], False)
        self.assertEqual(api.terminated, [])
        self.assertEqual(api.waited, [])
        self.assertEqual(api.closed, ["capture"])

    def test_negative_wrong_process_image_never_terminated(self):
        self._manifest()
        api = FakeWindows(running=True)
        api.image = sys.executable
        result, api = self._finish(api)
        self.assertEqual(result["status"], "IDENTITY_MISMATCH")
        self.assertEqual(api.terminated, [])

    def test_exited_dumper_requires_birth_identity_without_querying_torn_down_image(self):
        self._manifest()
        api = FakeWindows()
        with mock.patch.object(api, "identity", return_value={
            "creation_filetime": CAPTURE_BIRTH, "image_path": None, "process_exited": True,
            "image_unavailable_reason": "PROCESS_EXITED",
        }):
            result, _ = self._finish(api)
        self.assertEqual(result["status"], "NO_EXCEPTION")
        self.assertTrue(result["capture_identity_verified"])
        self.assertEqual(result["tool_exit_code"], 0)

    def test_negative_exited_image_unavailable_never_bypasses_birth_mismatch(self):
        self._manifest()
        api = FakeWindows()
        with mock.patch.object(api, "identity", return_value={
            "creation_filetime": CAPTURE_BIRTH + 1, "image_path": None, "process_exited": True,
        }):
            result, _ = self._finish(api)
        self.assertEqual(result["status"], "IDENTITY_MISMATCH")
        self.assertFalse(result["capture_identity_verified"])
        self.assertEqual(api.terminated, [])

    def test_negative_finish_timeout_is_failure_even_after_owned_cleanup(self):
        self._manifest()
        result, api = self._finish(FakeWindows(running=True), exit_code=0xC00000FD)
        self.assertEqual(result["status"], "TIMED_OUT")
        self.assertEqual(result["worker_exit_code"], 0xC00000FD)
        self.assertIs(result["cleanup_confirmed"], True)
        self.assertIs(result["capture_succeeded"], False)
        self.assertEqual(result["tool_exit_code"], capture.OWNED_TIMEOUT_EXIT_CODE)
        self.assertEqual(api.terminated, ["capture"])

    def test_negative_timeout_exit_race_is_observed_without_terminating_ended_dumper(self):
        self._manifest()
        api = FakeWindows()
        with mock.patch.object(api, "wait", side_effect=[
            capture.WAIT_TIMEOUT, capture.WAIT_TIMEOUT, capture.WAIT_OBJECT_0,
        ]):
            result, _ = self._finish(api)
        self.assertEqual(result["status"], "TIMED_OUT")
        self.assertTrue(result["cleanup_confirmed"])
        self.assertEqual(result["tool_exit_code"], 0)
        self.assertFalse(result["termination_requested"])
        self.assertEqual(api.terminated, [])

    def test_negative_unbounded_dumper_is_explicit_failure(self):
        self._manifest()
        api = FakeWindows(running=True)
        api.termination_stuck = True
        result, api = self._finish(api)
        self.assertEqual(result["status"], "CAPTURE_FAILED")
        self.assertIs(result["cleanup_confirmed"], False)
        self.assertIn("did not end", result["error"])
        self.assertEqual(api.terminated, ["capture"])

    def test_negative_access_denied_preserves_exact_error_without_bypass(self):
        self._manifest()
        api = FakeWindows()
        denied = PermissionError("WinError 5: Access is denied")
        denied.winerror = 5
        with mock.patch.object(api, "open_process", side_effect=denied) as opened:
            result, _ = self._finish(api)
        opened.assert_called_once_with(123456)
        self.assertEqual(result["error"], str(denied))
        self.assertEqual(result["error_type"], "PermissionError")
        self.assertEqual(result["error_winerror"], 5)
        self.assertIs(result["cleanup_confirmed"], False)
        self.assertEqual(api.terminated, [])

    def test_vanished_dumper_is_honest_about_unobserved_tool_returncode(self):
        self._manifest()
        api = FakeWindows()
        api.vanished = True
        result, _ = self._finish(api)
        self.assertEqual(result["status"], "NO_EXCEPTION")
        self.assertEqual(result["capture_process_state"], "VANISHED")
        self.assertIsNone(result["capture_returncode"])
        self.assertIsNone(result["tool_exit_code"])
        self.assertIs(result["capture_exit_observed"], False)
        self.assertIs(result["cleanup_confirmed"], True)
        self.assertIs(result["capture_identity_verified"], False)

    def test_vanished_dumper_can_retain_a_verified_exception_without_inventing_tool_exit(self):
        self._manifest(dump=True)
        api = FakeWindows()
        api.vanished = True
        result, _ = self._finish(api, exit_code=0xC00000FD)
        self.assertEqual(result["status"], "CAPTURED_EXCEPTION")
        self.assertEqual(result["worker_exit_code"], 0xC00000FD)
        self.assertEqual(result["exception_code"], SYNTHETIC_EXCEPTION)
        self.assertTrue(result["dump"]["target_identity_verified"])
        self.assertTrue(result["cleanup_confirmed"])
        self.assertIsNone(result["tool_exit_code"])

    def test_negative_vanished_dumper_without_exit_evidence_cannot_fake_success(self):
        self._manifest(log="ProcDump starting only.\n")
        api = FakeWindows()
        api.vanished = True
        result, _ = self._finish(api)
        self.assertEqual(result["status"], "CAPTURE_FAILED")
        self.assertIs(result["capture_succeeded"], False)

    def test_negative_nonzero_worker_without_dump_cannot_be_success(self):
        self._manifest()
        result, _ = self._finish(exit_code=0xC00000FD)
        self.assertEqual(result["status"], "CAPTURE_FAILED")
        self.assertEqual(result["worker_exit_code"], 0xC00000FD)

    def test_negative_nonzero_tool_exit_rejects_even_valid_dump(self):
        self._manifest(dump=True)
        result, _ = self._finish(FakeWindows(code=7), exit_code=SYNTHETIC_EXCEPTION)
        self.assertEqual(result["status"], "CAPTURE_FAILED")
        self.assertEqual(result["tool_exit_code"], 7)
        self.assertIsNotNone(result["dump"])

    def test_completed_dump_tool_exit_one_preserved_with_both_real_log_markers(self):
        self._manifest(dump=True, log="Dump 1 complete: 3 MB written\nDump count reached.\n")
        log = self.folder / "native-crash-capture.log"
        log.write_bytes(b"ProcDump v12.02\n" + log.read_text().encode("utf-16-le"))
        result, _ = self._finish(FakeWindows(code=1), exit_code=SYNTHETIC_EXCEPTION)
        self.assertEqual(result["status"], "CAPTURED_EXCEPTION")
        self.assertEqual(result["tool_exit_code"], 1)
        self.assertEqual(result["capture_returncode"], 1)
        self.assertEqual(result["worker_exit_code"], SYNTHETIC_EXCEPTION)
        self.assertEqual(result["tool_exit_interpretation"], "ONE_DUMP_COMPLETED_OBSERVED")

    def test_negative_tool_exit_one_without_complete_dump_log_cannot_fake_success(self):
        self._manifest(dump=True)
        result, _ = self._finish(FakeWindows(code=1), exit_code=SYNTHETIC_EXCEPTION)
        self.assertEqual(result["status"], "CAPTURE_FAILED")
        self.assertEqual(result["tool_exit_code"], 1)

    def test_vanished_clean_target_with_utf16_log_is_recognized_without_inventing_exit_code(self):
        self._manifest()
        (self.folder / "native-crash-capture.log").write_bytes(
            b"ProcDump v12.02\n" + "The process has exited.\n".encode("utf-16-le")
        )
        api = FakeWindows()
        api.vanished = True
        result, _ = self._finish(api)
        self.assertEqual(result["status"], "NO_EXCEPTION")
        self.assertTrue(result["normal_target_exit_observed_in_log"])
        self.assertIsNone(result["tool_exit_code"])

    def test_negative_manifest_target_or_path_tampering_rejected(self):
        manifest = self._manifest()
        manifest["tool_argv"][-2] = "999"
        capture._atomic_json(self.folder / "native-crash-capture.json", manifest)
        with mock.patch.object(capture, "_windows") as windows:
            with self.assertRaisesRegex(capture.CaptureError, "manifest paths/tool/target"):
                capture.finish_capture(self.folder, deadline=time.monotonic() + 10, worker_exit_code=0)
        windows.assert_not_called()

    def test_negative_worker_cannot_finalize_its_own_dumper(self):
        manifest = self._manifest()
        manifest["worker_pid"] = os.getpid()
        manifest["tool_argv"][-2] = str(os.getpid())
        capture._atomic_json(self.folder / "native-crash-capture.json", manifest)
        with self.assertRaisesRegex(capture.CaptureError, "independent parent"):
            capture.finish_capture(self.folder, deadline=time.monotonic() + 10, worker_exit_code=0)

    def test_negative_noninteger_worker_exit_rejected(self):
        for code in (False, None, "0"):
            with self.subTest(code=code), self.assertRaises(capture.CaptureError):
                capture.finish_capture(self.folder, deadline=time.monotonic() + 10, worker_exit_code=code)

    def test_parse_valid_minimal_dump_and_exception_module(self):
        raw = _dump_bytes(1234, module=True)
        result = capture._parse_minidump(
            self._write_dump(raw), expected_pid=1234, expected_creation_filetime=WORKER_BIRTH
        )
        self.assertEqual(result["signature"], "MDMP")
        self.assertEqual(result["exception_code_hex"], "0xc0000409")
        self.assertEqual(result["exception_thread_id"], 77)
        self.assertEqual(result["exception_address_hex"], "0x1005")
        self.assertEqual(result["size_bytes"], len(raw))
        self.assertEqual(result["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(result["exception_module"]["exception_offset"], 5)
        self.assertEqual(result["exception_module"]["path"], "C:\\Windows\\System32\\synthetic.dll")

    def test_negative_malformed_header_version_and_truncation(self):
        good = _dump_bytes(1234)
        cases = [b"", b"MDMP", b"NOPE" + good[4:], good[:4] + bytes(4) + good[8:], good[:-1]]
        for raw in cases:
            with self.subTest(length=len(raw)), self.assertRaises(capture.DumpFormatError):
                capture._parse_minidump(self._write_dump(raw), expected_pid=1234)

    def test_negative_directory_out_of_range_or_unbounded(self):
        for offset, value in ((8, capture.MAX_STREAMS + 1), (12, 0xFFFFFFF0), (12, 4)):
            raw = bytearray(_dump_bytes(1234))
            struct.pack_into("<I", raw, offset, value)
            with self.subTest(offset=offset, value=value), self.assertRaises(capture.DumpFormatError):
                capture._parse_minidump(self._write_dump(raw))

    def test_negative_overlapping_or_duplicate_streams(self):
        for offset, value in ((40, 32), (44, 6), (36, 0xFFFFFFF0)):
            raw = bytearray(_dump_bytes(1234))
            struct.pack_into("<I", raw, offset, value)
            with self.subTest(offset=offset), self.assertRaises(capture.DumpFormatError):
                capture._parse_minidump(self._write_dump(raw))

    def test_negative_missing_exception_or_thread(self):
        for offset, value in ((32, 7), (44, 7), (236 + 4, 88)):
            raw = bytearray(_dump_bytes(1234))
            struct.pack_into("<I", raw, offset, value)
            with self.subTest(offset=offset), self.assertRaises(capture.DumpFormatError):
                capture._parse_minidump(self._write_dump(raw))

    def test_negative_invalid_exception_parameter_and_context(self):
        for offset, value in ((68 + 32, 16), (68 + 160, 0), (68 + 164, 0xFFFFFFF0), (68 + 164, 68)):
            raw = bytearray(_dump_bytes(1234))
            struct.pack_into("<I", raw, offset, value)
            with self.subTest(offset=offset, value=value), self.assertRaises(capture.DumpFormatError):
                capture._parse_minidump(self._write_dump(raw))

    def test_negative_wrong_dump_target_and_creation_time(self):
        path = self._write_dump(_dump_bytes(1234))
        with self.assertRaisesRegex(capture.DumpFormatError, "PID mismatch"):
            capture._parse_minidump(path, expected_pid=1235)
        with self.assertRaisesRegex(capture.DumpFormatError, "creation time"):
            capture._parse_minidump(path, expected_creation_filetime=WORKER_BIRTH + 10_000_000)

    def test_negative_full_memory_and_oversized_dump_rejected(self):
        raw = bytearray(_dump_bytes(1234))
        struct.pack_into("<Q", raw, 24, 2)
        with self.assertRaisesRegex(capture.DumpFormatError, "Full-memory"):
            capture._parse_minidump(self._write_dump(raw))
        with mock.patch.object(capture, "MAX_DUMP_BYTES", 100), self.assertRaisesRegex(
            capture.DumpFormatError, "size outside"
        ):
            capture._parse_minidump(self._write_dump(_dump_bytes(1234)))

    def test_negative_finish_rejects_malformed_dump_and_retains_all_bytes(self):
        self._manifest()
        path = self.folder / "native-worker.dmp"
        broken = b"MDMP" + bytes(100)
        path.write_bytes(broken)
        result, _ = self._finish(exit_code=0xC00000FD)
        self.assertEqual(result["status"], "INVALID_DUMP")
        self.assertEqual(result["error_type"], "DumpFormatError")
        self.assertEqual(result["worker_exit_code"], 0xC00000FD)
        self.assertEqual(path.read_bytes(), broken)
        self.assertTrue((self.folder / "native-crash-capture.log").exists())
        self.assertIs(result["cleanup_confirmed"], True)


def _raise_owned_synthetic_failfast(events_path):
    class ExceptionRecord(ctypes.Structure):
        _fields_ = [
            ("ExceptionCode", ctypes.c_ulong), ("ExceptionFlags", ctypes.c_ulong),
            ("ExceptionRecord", ctypes.c_void_p), ("ExceptionAddress", ctypes.c_void_p),
            ("NumberParameters", ctypes.c_ulong), ("ExceptionInformation", ctypes.c_size_t * 15),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    function = kernel.RaiseFailFastException
    function.argtypes = [ctypes.POINTER(ExceptionRecord), ctypes.c_void_p, ctypes.c_ulong]
    function.restype = None
    record = ExceptionRecord()
    record.ExceptionCode = SYNTHETIC_EXCEPTION
    record.ExceptionFlags = 1
    record.ExceptionAddress = ctypes.cast(function, ctypes.c_void_p).value
    record.NumberParameters = 1
    record.ExceptionInformation[0] = 7  # FAST_FAIL_FATAL_APP_EXIT in this synthetic child only.
    events = []
    api = capture._windows()
    for attempt in (1, 2):
        events.append({
            "attempt": attempt, "action": "Win32 RaiseFailFastException",
            "debugger_present": api.debugger_present(), "exception_code": SYNTHETIC_EXCEPTION,
        })
        capture._atomic_json(events_path, {
            "scope": "SYNTHETIC NOT CARLA", "state": "NATIVE_CALL_IN_PROGRESS", "events": events,
        })
        function(ctypes.byref(record), None, 0)
        events[-1]["returned_after_debugger_handling"] = True
        capture._atomic_json(events_path, {
            "scope": "SYNTHETIC NOT CARLA", "state": "DEBUGGER_ALLOWED_RETURN", "events": events,
        })
        if attempt == 2:
            raise AssertionError("Un-debugged Win32 RaiseFailFastException unexpectedly returned")
        # A debugger can continue this second-chance call. After its one dump,
        # re-raise natively without a debugger; never manufacture a process exit.
        limit = time.monotonic() + 5
        while api.debugger_present():
            if time.monotonic() >= limit:
                raise TimeoutError("Synthetic fail-fast debugger did not detach after its one dump")
            time.sleep(0.01)
    raise AssertionError("Owned synthetic fail-fast did not terminate the worker")


def _owned_synthetic_child(mode, folder, ready, go, executable):
    api = capture._windows()
    identity = api.identity(api.current_process())
    boot = {
        "scope": "SYNTHETIC NOT CARLA", "state": "STARTING",
        "worker_pid": os.getpid(), "worker_parent_pid": os.getppid(),
        "worker_creation_filetime": identity["creation_filetime"],
    }
    capture._atomic_json(ready, boot)
    try:
        armed = capture.start_capture(
            folder, executable=executable, deadline=time.monotonic() + 15
        )
        boot.update(state="ARMED", capture=armed)
        capture._atomic_json(ready, boot)
        limit = time.monotonic() + 20
        while not go.exists():
            if time.monotonic() >= limit:
                raise TimeoutError("Synthetic parent did not authorize this owned child to proceed")
            time.sleep(0.01)
        if mode == "crash":
            _raise_owned_synthetic_failfast(ready.parent / "failfast-events.json")
        elif mode != "clean":
            raise ValueError("Unknown owned synthetic mode")
        return 0
    except Exception as exc:
        boot.update(state="FAILED", error=str(exc), error_type=type(exc).__name__)
        capture._atomic_json(ready, boot)
        raise


def _independent_dump_identity(path):
    with path.open("rb") as stream:
        header = stream.read(32)
        if header[:4] != b"MDMP":
            raise AssertionError("Real fixture lacks MDMP magic")
        count, directory = struct.unpack_from("<II", header, 8)
        if not 1 <= count <= 1024:
            raise AssertionError("Real fixture directory is unbounded")
        stream.seek(directory)
        entries = [struct.unpack("<III", stream.read(12)) for _ in range(count)]
        result = {}
        for kind, size, offset in entries:
            if kind == 6:
                stream.seek(offset)
                raw = stream.read(168)
                result.update(
                    code=struct.unpack_from("<I", raw, 8)[0],
                    thread=struct.unpack_from("<I", raw, 0)[0],
                    address=struct.unpack_from("<Q", raw, 24)[0],
                )
            elif kind == 15:
                stream.seek(offset)
                result["pid"] = struct.unpack("<III", stream.read(12))[2]
        return result


def _run_synthetic_fixture(output, mode):
    case = output / mode
    case.mkdir(exist_ok=False)
    folder, ready, go = case / "capture", case / "ready.json", case / "proceed.json"
    argv = [
        sys.executable, str(Path(__file__).resolve()), "--owned-synthetic-child",
        mode, str(folder), str(ready), str(go), str(capture.PINNED_EXECUTABLE),
    ]
    api = capture._windows()
    process = None
    worker_handle = None
    dumper_handle = None
    worker_identity = None
    capture_identity = None
    worker_pid = None
    result = {"scope": "SYNTHETIC NOT CARLA", "mode": mode, "argv": argv}
    finished = False
    try:
        with (case / "worker.stdout.log").open("xb") as stdout, (
            case / "worker.stderr.log"
        ).open("xb") as stderr:
            process = subprocess.Popen(
                argv, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                close_fds=True, creationflags=subprocess.CREATE_NO_WINDOW,
            )
        result["redirector_pid"] = process.pid
        startup_deadline = time.monotonic() + 20
        boot = None
        while time.monotonic() < startup_deadline:
            if ready.exists():
                boot = json.loads(ready.read_text(encoding="utf-8"))
                if worker_handle is None:
                    worker_pid = boot["worker_pid"]
                    worker_handle = api.open_process(worker_pid)
                    if worker_handle is None:
                        raise AssertionError("Synthetic actual worker vanished before parent identity observation")
                    worker_identity = api.identity(worker_handle)
                    if worker_identity["creation_filetime"] != boot["worker_creation_filetime"]:
                        raise AssertionError("Synthetic worker PID birth mismatch")
                if boot["state"] == "ARMED":
                    break
                if boot["state"] == "FAILED":
                    raise AssertionError("Synthetic worker setup failed: " + json.dumps(boot))
            if process.poll() is not None:
                raise AssertionError("Synthetic venv redirector exited before verified attachment")
            time.sleep(0.02)
        if boot is None or boot["state"] != "ARMED":
            raise TimeoutError("Owned synthetic child never confirmed actual debugger attachment")
        armed = boot["capture"]
        if not (armed["requested"] and armed["attached"] and armed["status"] == "ARMED"):
            raise AssertionError("Synthetic start result did not prove real attachment")
        if armed["worker_pid"] != worker_pid or armed["tool_argv"][-2] != str(worker_pid):
            raise AssertionError("ProcDump was not addressed to the actual worker")
        if process.pid == worker_pid:
            raise AssertionError("Expected the requested Windows venv redirector/actual-worker distinction")
        dumper_handle = api.open_process(armed["capture_pid"])
        if dumper_handle is None:
            raise AssertionError("Dumper disappeared while the live synthetic worker was armed")
        capture_identity = api.identity(dumper_handle)
        if capture_identity["creation_filetime"] != armed["capture_creation_filetime"]:
            raise AssertionError("Parent-observed capture FILETIME mismatch")
        result.update(
            worker_pid=worker_pid, worker_parent_pid=boot["worker_parent_pid"],
            worker_creation_filetime=worker_identity["creation_filetime"],
            capture_pid=armed["capture_pid"],
            capture_creation_filetime=capture_identity["creation_filetime"],
            attachment_verified=True, armed_manifest=armed,
        )
        capture._atomic_json(go, {"scope": "SYNTHETIC NOT CARLA", "mode": mode})
        if api.wait(worker_handle, 20000) != capture.WAIT_OBJECT_0:
            raise TimeoutError("Owned synthetic worker did not end within twenty seconds")
        original_exit = api.returncode(worker_handle)
        redirector_exit = process.wait(timeout=5)
        if original_exit != redirector_exit:
            raise AssertionError("Venv redirector did not preserve the actual worker exit")
        finalized = capture.finish_capture(
            folder, deadline=time.monotonic() + 15, worker_exit_code=original_exit
        )
        finished = True
        result.update(
            status=finalized["status"], worker_exit_code=original_exit,
            redirector_exit_code=redirector_exit, exception_code=finalized["exception_code"],
            target_identity_verified=False, cleanup_confirmed=finalized["cleanup_confirmed"],
            dump_exists=finalized["dump_exists"], finalized_manifest=finalized,
        )
        if finalized["worker_exit_code"] != original_exit:
            raise AssertionError("Helper rewrote the original worker exit")
        if not finalized["cleanup_confirmed"] or api.wait(dumper_handle, 0) != capture.WAIT_OBJECT_0:
            raise AssertionError("Owned dumper cleanup was not independently confirmed")
        if finalized["capture_returncode"] != api.returncode(dumper_handle):
            raise AssertionError("Actual capture return code was not preserved")
        if finalized["tool_exit_code"] != finalized["capture_returncode"]:
            raise AssertionError("Tool return-code aliases disagree")
        if finalized["error"] is not None or finalized["error_type"] is not None:
            raise AssertionError("Real fixture finalization failed: " + json.dumps(finalized))
        dump = folder / "native-worker.dmp"
        if mode == "crash":
            raw = _independent_dump_identity(dump)
            fault_events = json.loads((case / "failfast-events.json").read_text(encoding="utf-8"))
            if not (
                original_exit == SYNTHETIC_EXCEPTION
                and finalized["status"] == "CAPTURED_EXCEPTION"
                and raw["pid"] == worker_pid
                and raw["code"] == SYNTHETIC_EXCEPTION
                and raw["thread"] > 0 and raw["address"] > 0
                and finalized["dump"]["sha256"] == hashlib.sha256(dump.read_bytes()).hexdigest()
            ):
                raise AssertionError("Real fail-fast dump/original-exit/target oracle failed")
            result.update(
                target_identity_verified=True, independent_dump_identity=raw,
                native_fault_events=fault_events,
            )
        else:
            if original_exit != 0 or finalized["status"] != "NO_EXCEPTION" or dump.exists():
                raise AssertionError("Clean-exit control fabricated an exception or dump")
            result["target_identity_verified"] = True
        result.update(worker_cleanup_confirmed=True, redirector_cleanup_confirmed=process.poll() is not None)
        capture._atomic_json(case / "fixture-result.json", result)
        return result
    except BaseException as exc:
        failure = {
            **result, "error": str(exc), "error_type": type(exc).__name__,
            "traceback": traceback.format_exc(),
        }
        capture._atomic_json(case / "fixture-failure.json", failure)
        raise
    finally:
        cleanup_errors = []
        if worker_handle is not None:
            try:
                if api.wait(worker_handle, 0) != capture.WAIT_OBJECT_0:
                    if api.identity(worker_handle) != worker_identity:
                        raise AssertionError("Refusing synthetic worker cleanup after identity mismatch")
                    api.terminate(worker_handle)
                    if api.wait(worker_handle, 2000) != capture.WAIT_OBJECT_0:
                        raise AssertionError("Synthetic actual worker cleanup could not be bounded")
                if not finished and (folder / "native-crash-capture.json").exists():
                    state = json.loads((folder / "native-crash-capture.json").read_text(encoding="utf-8"))
                    if state.get("status") == "ARMED":
                        capture.finish_capture(
                            folder, deadline=time.monotonic() + 15,
                            worker_exit_code=api.returncode(worker_handle),
                        )
            except BaseException as exc:
                cleanup_errors.append({"type": type(exc).__name__, "error": str(exc)})
            finally:
                api.close(worker_handle)
        if dumper_handle is not None:
            api.close(dumper_handle)
        if process is not None:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired as exc:
                cleanup_errors.append({"type": type(exc).__name__, "error": str(exc)})
        if cleanup_errors:
            capture._atomic_json(case / "cleanup-failure.json", {"errors": cleanup_errors})
            raise AssertionError("Owned synthetic cleanup failed; see retained cleanup-failure.json")


def run_synthetic_fixtures(output, *, only_clean=False):
    if os.name != "nt":
        raise OSError("Real owned crash-capture fixtures require Windows")
    output = capture._folder(output, new=False)
    result = {"scope": "SYNTHETIC NOT CARLA", "native_acceptance": False}
    if not only_clean:
        result["crash"] = _run_synthetic_fixture(output, "crash")
    result["clean"] = _run_synthetic_fixture(output, "clean")
    return result


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--owned-synthetic-child":
        raise SystemExit(_owned_synthetic_child(
            sys.argv[2], Path(sys.argv[3]), Path(sys.argv[4]),
            Path(sys.argv[5]), Path(sys.argv[6]),
        ))
    if len(sys.argv) > 1 and sys.argv[1] == "--synthetic-fixtures":
        target = Path(sys.argv[2]).absolute()
        print(json.dumps(run_synthetic_fixtures(target), indent=2))
    else:
        unittest.main()
