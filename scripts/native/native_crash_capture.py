"""Opt-in, owned-worker Windows exception capture; never starts a simulator.

The admitted caller must invoke ``start_capture`` inside the actual worker,
before importing/starting CARLA, and ``finish_capture`` in an independent parent
after that worker exits. The caller owns diagnostic-ticket admission. Deadlines
are absolute ``time.monotonic()`` values; each operation is capped at 15 seconds.
Only a newly created evidence directory below checkout tmp/output/runs is used.
The portable, pinned ProcDump is not registered as a global debugger.

CAPTURED_EXCEPTION is diagnostic evidence, not a clean worker exit or native
acceptance. NO_EXCEPTION means no exception was captured, not a crash fix.
Setup failures raise CaptureError with JSON-compatible ``evidence``. Finalization
failures are returned explicitly, without translating the original worker exit.
ProcDump 12.02's observed return code 1 is accepted only with an identity-checked
exception dump and both completion log markers. It is never changed to zero.
An already-vanished dumper has a null (unobserved) tool return code, not an
invented success code. Capture attachment itself can affect debugger behavior.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import subprocess
import time
import uuid


PROJECT_ROOT = Path(__file__).resolve().parents[2]
PINNED_EXECUTABLE = (
    PROJECT_ROOT / "tmp" / "native-crash-capture-20261029-ef402517"
    / "bin" / "procdump64.exe"
)
PINNED_SHA256 = "22c2a2b09ade73a342a18dab838354385f73fc98e324b9903fd61fff949c5124"
PINNED_SIZE_BYTES = 743752
MAX_OPERATION_SECONDS = 15.0
MAX_DUMP_BYTES = 128 * 1024 * 1024
MAX_MANIFEST_BYTES = 128 * 1024
MAX_STREAMS = 1024
MAX_THREADS = 16384
MAX_MODULES = 4096
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258
OWNED_TIMEOUT_EXIT_CODE = 0xE0000001
_STARTED = {}


class CaptureError(RuntimeError):
    def __init__(self, message, evidence=None):
        super().__init__(message)
        self.evidence = evidence


class CaptureIdentityError(CaptureError):
    pass


class DumpFormatError(CaptureError):
    pass


class _Windows:
    def __init__(self):
        if os.name != "nt":
            raise OSError("Owned native crash capture requires Windows")
        self.dll = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "GetCurrentProcess": ([], wintypes.HANDLE),
            "CheckRemoteDebuggerPresent": (
                [wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)], wintypes.BOOL
            ),
            "OpenProcess": ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            "GetProcessTimes": (
                [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4, wintypes.BOOL
            ),
            "QueryFullProcessImageNameW": (
                [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                 ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL
            ),
            "WaitForSingleObject": ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
            "GetExitCodeProcess": (
                [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL
            ),
            "TerminateProcess": ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
            "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.dll, name)
            function.argtypes, function.restype = arguments, result

    def current_process(self):
        return self.dll.GetCurrentProcess()

    def debugger_present(self):
        present = wintypes.BOOL()
        if not self.dll.CheckRemoteDebuggerPresent(self.current_process(), ctypes.byref(present)):
            raise ctypes.WinError(ctypes.get_last_error())
        return bool(present.value)

    def identity(self, handle):
        creation, exit_time, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not self.dll.GetProcessTimes(
            handle, ctypes.byref(creation), ctypes.byref(exit_time),
            ctypes.byref(kernel), ctypes.byref(user)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        birth = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
        if self.wait(handle, 0) == WAIT_OBJECT_0:
            return {
                "creation_filetime": birth, "image_path": None,
                "process_exited": True, "image_unavailable_reason": "PROCESS_EXITED",
            }
        length = wintypes.DWORD(32768)
        image = ctypes.create_unicode_buffer(length.value)
        if not self.dll.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(length)):
            error = ctypes.get_last_error()
            # The image is torn down on exit (ERROR_GEN_FAILURE), although
            # GetProcessTimes still identifies the pinned process object.
            if error == 31 and self.wait(handle, 0) == WAIT_OBJECT_0:
                return {
                    "creation_filetime": birth, "image_path": None,
                    "process_exited": True, "image_unavailable_reason": "PROCESS_EXITED",
                    "image_query_winerror": error,
                }
            raise ctypes.WinError(error)
        return {
            "creation_filetime": birth, "image_path": image.value, "process_exited": False,
        }

    def open_process(self, pid):
        # Query, synchronize and terminate only the single recorded owned PID.
        handle = self.dll.OpenProcess(0x1000 | 0x100000 | 0x0001, False, pid)
        if not handle:
            error = ctypes.get_last_error()
            if error == 87:  # ERROR_INVALID_PARAMETER: no process with this PID.
                return None
            raise ctypes.WinError(error)
        return handle

    def wait(self, handle, milliseconds):
        result = self.dll.WaitForSingleObject(handle, milliseconds)
        if result == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())
        if result not in (WAIT_OBJECT_0, WAIT_TIMEOUT):
            raise CaptureError(f"Unexpected process wait result: {result}")
        return result

    def returncode(self, handle):
        code = wintypes.DWORD()
        if not self.dll.GetExitCodeProcess(handle, ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        return code.value

    def terminate(self, handle):
        if not self.dll.TerminateProcess(handle, OWNED_TIMEOUT_EXIT_CODE):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self, handle):
        if not self.dll.CloseHandle(handle):
            raise ctypes.WinError(ctypes.get_last_error())


def _windows():
    return _Windows()


def _utc():
    return datetime.now(timezone.utc).isoformat()


def _deadline(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("deadline must be a finite absolute time.monotonic() value")
    now = time.monotonic()
    if value <= now:
        raise TimeoutError("Capture deadline has already expired")
    return min(float(value), now + MAX_OPERATION_SECONDS)


def _milliseconds(deadline):
    return max(0, int((deadline - time.monotonic()) * 1000))


def _path(value):
    if not isinstance(value, (str, os.PathLike)) or not str(value):
        raise ValueError("An explicit absolute owned path is required")
    path = Path(value)
    if (not path.is_absolute() or path.drive.startswith("\\")
            or ".." in path.parts
            or any(part.endswith((" ", ".")) or ":" in part for part in path.parts[1:])):
        raise ValueError(f"Unsafe or non-absolute capture path: {value}")
    if not path.is_relative_to(PROJECT_ROOT) or path == PROJECT_ROOT:
        raise ValueError(f"Capture path is outside the checkout: {path}")
    cursor = path
    while True:
        try:
            metadata = cursor.lstat()
        except FileNotFoundError:
            pass
        else:
            if cursor.is_symlink() or getattr(metadata, "st_file_attributes", 0) & 0x400:
                raise ValueError(f"Reparse/symlink capture path is forbidden: {cursor}")
        if cursor == PROJECT_ROOT:
            break
        cursor = cursor.parent
    return path


def _folder(value, *, new):
    path = _path(value)
    if path.relative_to(PROJECT_ROOT).parts[0] not in ("tmp", "output", "runs"):
        raise ValueError("Evidence must be a new owned directory below checkout tmp/output/runs")
    if new:
        if path.exists():
            raise FileExistsError(f"Evidence directory must be new: {path}")
        if not path.parent.is_dir():
            raise ValueError(f"Evidence parent must already exist: {path.parent}")
    elif not path.is_dir():
        raise ValueError(f"Missing owned capture directory: {path}")
    return path


def _sha256(path, deadline=None):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f"Deadline while hashing retained evidence: {path}")
            digest.update(block)
    return digest.hexdigest()


def _tool(executable, deadline=None):
    path = _path(executable)
    if path != PINNED_EXECUTABLE or path.name.lower() != "procdump64.exe" or not path.is_file():
        raise ValueError(f"Only the fixed project-local ProcDump is allowed: {PINNED_EXECUTABLE}")
    if path.stat().st_size != PINNED_SIZE_BYTES:
        raise CaptureError("ProcDump size mismatch; refusing unbounded or changed tool bytes")
    digest = _sha256(path, deadline)
    if digest != PINNED_SHA256:
        raise CaptureError(f"ProcDump SHA256 mismatch: expected {PINNED_SHA256}, observed {digest}")
    return path, digest


def _argv(executable, pid, dump):
    return [str(executable), "-accepteula", "-e", "-mc", "0", "-n", "1", str(pid), str(dump)]


def _atomic_json(path, data):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".new")
    with temporary.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(data, stream, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def _error(evidence, exception, status):
    evidence.update(
        status=status, error=str(exception), error_type=type(exception).__name__,
        error_winerror=getattr(exception, "winerror", None),
    )
    evidence.setdefault("errors", []).append({
        "at": _utc(), "type": type(exception).__name__, "message": str(exception),
        "winerror": getattr(exception, "winerror", None),
    })


def _same_image(left, right):
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))


def _check_capture_identity(api, handle, evidence):
    evidence["capture_identity_verified"] = False
    actual = api.identity(handle)
    evidence["capture_identity_observed"] = actual
    image_matches = (
        actual.get("process_exited") is True and actual.get("image_path") is None
    ) or (
        isinstance(actual.get("image_path"), str)
        and _same_image(actual["image_path"], evidence["executable"])
    )
    if (actual["creation_filetime"] != evidence["capture_creation_filetime"]
            or not image_matches):
        raise CaptureIdentityError("Capture PID birth/image mismatch; refusing to wait or terminate a reused/unowned process")
    evidence["capture_identity_verified"] = True


def _observe_end(api, handle, evidence):
    code = api.returncode(handle)
    evidence.update(
        capture_returncode=code, tool_exit_code=code, capture_exit_observed=True,
        capture_process_state="EXITED", cleanup_confirmed=True,
    )


def _bound_dumper(api, handle, evidence, deadline, *, immediate=False):
    _check_capture_identity(api, handle, evidence)
    if api.wait(handle, 0) == WAIT_OBJECT_0:
        _observe_end(api, handle, evidence)
        return False
    wait_ms = 0 if immediate else max(0, _milliseconds(deadline) - 2000)
    if wait_ms and api.wait(handle, wait_ms) == WAIT_OBJECT_0:
        _observe_end(api, handle, evidence)
        return False
    evidence["finalization_wait_timed_out"] = not immediate
    # This still-open process HANDLE cannot be redirected by subsequent PID reuse.
    _check_capture_identity(api, handle, evidence)
    if api.wait(handle, 0) == WAIT_OBJECT_0:
        _observe_end(api, handle, evidence)
        return not immediate
    evidence.update(termination_requested=True, capture_process_state="TERMINATING")
    api.terminate(handle)
    if api.wait(handle, _milliseconds(deadline)) != WAIT_OBJECT_0:
        raise CaptureError("Owned dumper did not end within the cleanup deadline")
    _observe_end(api, handle, evidence)
    return True


def start_capture(folder, *, executable, deadline):
    """Arm only os.getpid(); return ARMED or raise CaptureError (never hide setup failure)."""
    evidence = {
        "schema": 1, "requested": True, "attached": False, "status": "STARTING",
        "cleanup_confirmed": False, "error": None, "error_type": None,
        "error_winerror": None, "errors": [], "worker_pid": os.getpid(),
        "worker_parent_pid": os.getppid(), "parent_pid": os.getppid(),
        "capture_pid": None, "capture_creation_filetime": None,
        "capture_identity_verified": False, "capture_returncode": None,
        "tool_exit_code": None, "capture_exit_observed": False,
        "capture_process_state": "NOT_STARTED", "worker_exit_code": None,
        "termination_requested": False, "started_at": _utc(),
        "claim_scope": "OWNED_PROCESS_DIAGNOSTIC_ONLY_NOT_NATIVE_ACCEPTANCE",
    }
    owned = None
    process = None
    api = None
    limit = None
    try:
        limit = _deadline(deadline)
        tool, digest = _tool(executable, limit)
        owned = _folder(folder, new=True)
        api = _windows()
        identity = api.identity(api.current_process())
        evidence.update(
            worker_creation_filetime=identity["creation_filetime"],
            worker_image_path=identity["image_path"],
            executable=str(tool), tool_sha256=digest, folder=str(owned),
            dump_path=str(owned / "native-worker.dmp"),
            log_path=str(owned / "native-crash-capture.log"),
            deadline_monotonic=limit,
        )
        if api.debugger_present():
            raise CaptureError("A debugger is already attached to this worker; no capture tool was started")
        if _milliseconds(limit) < 250:
            raise TimeoutError("Insufficient deadline to safely spawn the owned dumper")
        owned.mkdir(exist_ok=False)
        evidence["tool_argv"] = _argv(tool, os.getpid(), owned / "native-worker.dmp")
        _atomic_json(owned / "native-crash-capture.json", evidence)
        with (owned / "native-crash-capture.log").open("xb") as log:
            process = subprocess.Popen(
                evidence["tool_argv"], stdin=subprocess.DEVNULL,
                stdout=log, stderr=subprocess.STDOUT, close_fds=True,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        # No worker-owned job: closing worker handles must not kill its dumper.
        _STARTED[str(owned)] = process
        evidence.update(capture_pid=process.pid, capture_process_state="RUNNING")
        capture_identity = api.identity(process._handle)
        evidence["capture_creation_filetime"] = capture_identity["creation_filetime"]
        _check_capture_identity(api, process._handle, evidence)
        _atomic_json(owned / "native-crash-capture.json", evidence)
        attachment_limit = limit - min(2.0, max(0.0, limit - time.monotonic()) / 3)
        while time.monotonic() < attachment_limit:
            if api.wait(process._handle, 0) == WAIT_OBJECT_0:
                _observe_end(api, process._handle, evidence)
                raise CaptureError("ProcDump exited before debugger attachment; inspect native-crash-capture.log")
            if api.debugger_present():
                evidence.update(
                    attached=True, status="ARMED",
                    debugger_attachment_observed_at=_utc(),
                    armed_at=_utc(),
                )
                _atomic_json(owned / "native-crash-capture.json", evidence)
                return evidence
            api.wait(process._handle, min(50, _milliseconds(attachment_limit)))
        raise TimeoutError("ProcDump did not verifiably attach within the bounded setup deadline")
    except Exception as exc:
        _error(evidence, exc, "SETUP_FAILED")
        if process is not None and evidence["capture_creation_filetime"] is not None:
            try:
                _bound_dumper(api, process._handle, evidence, limit, immediate=True)
            except Exception as cleanup_error:
                _error(evidence, cleanup_error, "SETUP_FAILED")
        if owned is not None and owned.is_dir() and process is not None:
            _atomic_json(owned / "native-crash-capture.json", evidence)
        elif owned is not None and owned.is_dir() and evidence.get("tool_argv"):
            _atomic_json(owned / "native-crash-capture.json", evidence)
        raise CaptureError(evidence["error"], evidence) from exc


def _read_manifest(folder):
    path = _path(folder / "native-crash-capture.json")
    if path.stat().st_size > MAX_MANIFEST_BYTES:
        raise CaptureError("Oversized capture manifest")
    with path.open("r", encoding="utf-8") as stream:
        evidence = json.load(
            stream, parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError("Non-finite manifest number: " + value)
            )
        )
    if not isinstance(evidence, dict) or evidence.get("schema") != 1:
        raise CaptureError("Invalid capture manifest schema")
    for key in ("worker_pid", "worker_creation_filetime", "capture_pid", "capture_creation_filetime"):
        if type(evidence.get(key)) is not int or evidence[key] <= 0:
            raise CaptureError("Invalid recorded process identity: " + key)
    if (evidence.get("folder") != str(folder)
            or evidence.get("executable") != str(PINNED_EXECUTABLE)
            or evidence.get("tool_sha256") != PINNED_SHA256
            or evidence.get("dump_path") != str(folder / "native-worker.dmp")
            or evidence.get("log_path") != str(folder / "native-crash-capture.log")
            or evidence.get("tool_argv") != _argv(
                PINNED_EXECUTABLE, evidence["worker_pid"], folder / "native-worker.dmp"
            )):
        raise CaptureError("Capture manifest paths/tool/target argv do not match the owned fixed scope")
    if evidence.get("requested") is not True or evidence.get("attached") is not True:
        raise CaptureError("Capture manifest does not prove a successfully armed worker")
    if evidence.get("status") != "ARMED":
        raise CaptureError("Capture has already been finalized or did not arm")
    return evidence


def _parse_minidump(path, *, expected_pid=None, expected_creation_filetime=None, deadline=None):
    """Read bounded descriptors, not heap contents; reject truncated/ambiguous MDMP."""
    path = _path(path)
    with path.open("rb") as stream:
        initial = os.fstat(stream.fileno())
        size = initial.st_size
        if not 32 <= size <= MAX_DUMP_BYTES:
            raise DumpFormatError(f"MDMP size outside bounded range: {size}")

        def read_at(offset, count):
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError("Deadline while validating the retained MDMP")
            if offset < 0 or count < 0 or offset > size or count > size - offset:
                raise DumpFormatError("MDMP descriptor points outside the file")
            stream.seek(offset)
            data = stream.read(count)
            if len(data) != count:
                raise DumpFormatError("Truncated MDMP data")
            return data

        signature, version, count, directory, checksum, timestamp, flags = struct.unpack(
            "<4sIIIIIQ", read_at(0, 32)
        )
        if signature != b"MDMP" or version & 0xFFFF != 0xA793:
            raise DumpFormatError("Invalid MDMP signature/version")
        if not 1 <= count <= MAX_STREAMS or directory < 32:
            raise DumpFormatError("Invalid bounded MDMP stream directory")
        if flags & (0x2 | 0x40 | 0x200 | 0x10000):
            raise DumpFormatError("Full-memory/heap-expanding dump is forbidden; expected minimal -mc 0")
        table = read_at(directory, count * 12)
        streams = {}
        ranges = [(0, 32), (directory, directory + len(table))]
        for index in range(count):
            kind, length, offset = struct.unpack_from("<III", table, index * 12)
            if kind in streams and kind != 0:
                raise DumpFormatError("Duplicate MDMP stream type")
            if length:
                read_at(offset, min(length, 1))
                if offset + length > size:
                    raise DumpFormatError("Truncated MDMP stream")
                if any(offset < end and start < offset + length for start, end in ranges):
                    raise DumpFormatError("Overlapping MDMP header/directory/stream")
                ranges.append((offset, offset + length))
            streams[kind] = (offset, length)
        if 6 not in streams or streams[6][1] < 168:
            raise DumpFormatError("Missing or short MDMP exception stream")
        exception = read_at(streams[6][0], 168)
        thread_id = struct.unpack_from("<I", exception, 0)[0]
        code, exception_flags = struct.unpack_from("<II", exception, 8)
        address = struct.unpack_from("<Q", exception, 24)[0]
        parameters = struct.unpack_from("<I", exception, 32)[0]
        context_size, context_rva = struct.unpack_from("<II", exception, 160)
        if not thread_id or not code or not address or parameters > 15:
            raise DumpFormatError("Invalid MDMP exception identity/parameters")
        if not 1 <= context_size <= 65536:
            raise DumpFormatError("Invalid MDMP exception context size")
        read_at(context_rva, context_size)
        if any(context_rva < end and start < context_rva + context_size for start, end in ranges):
            raise DumpFormatError("MDMP exception context overlaps stream descriptors")
        if 3 not in streams or streams[3][1] < 4:
            raise DumpFormatError("Missing MDMP thread list")
        thread_rva, thread_size = streams[3]
        thread_count = struct.unpack("<I", read_at(thread_rva, 4))[0]
        if not 1 <= thread_count <= MAX_THREADS or 4 + thread_count * 48 > thread_size:
            raise DumpFormatError("Invalid bounded MDMP thread list")
        threads = read_at(thread_rva + 4, thread_count * 48)
        if thread_id not in {struct.unpack_from("<I", threads, i * 48)[0] for i in range(thread_count)}:
            raise DumpFormatError("Exception thread missing from MDMP thread list")
        target_pid = None
        process_create_time = None
        if 15 in streams:
            misc_rva, misc_length = streams[15]
            if misc_length < 24:
                raise DumpFormatError("Short MDMP process identity stream")
            misc_size, misc_flags, pid, create_time = struct.unpack("<IIII", read_at(misc_rva, 16))
            if not 24 <= misc_size <= misc_length:
                raise DumpFormatError("Invalid MDMP process identity length")
            if misc_flags & 1:
                target_pid = pid
            if misc_flags & 2:
                process_create_time = create_time
        if expected_pid is not None and target_pid != expected_pid:
            raise DumpFormatError(f"MDMP target PID mismatch: expected {expected_pid}, observed {target_pid}")
        if expected_creation_filetime is not None:
            expected_time = expected_creation_filetime // 10_000_000 - 11644473600
            if process_create_time != expected_time:
                raise DumpFormatError("MDMP target creation time does not match the actual worker FILETIME")
        module = None
        if 4 in streams:
            module_rva, module_size = streams[4]
            if module_size < 4:
                raise DumpFormatError("Short MDMP module list")
            module_count = struct.unpack("<I", read_at(module_rva, 4))[0]
            if module_count > MAX_MODULES or 4 + module_count * 108 > module_size:
                raise DumpFormatError("Invalid bounded MDMP module list")
            for index in range(module_count):
                record = read_at(module_rva + 4 + index * 108, 108)
                base, image_size = struct.unpack_from("<QI", record)
                if base <= address < base + image_size:
                    name_rva = struct.unpack_from("<I", record, 20)[0]
                    name_size = struct.unpack("<I", read_at(name_rva, 4))[0]
                    if name_size > 32768 or name_size % 2:
                        raise DumpFormatError("Invalid bounded MDMP module name")
                    try:
                        name = read_at(name_rva + 4, name_size).decode("utf-16-le")
                    except UnicodeError as exc:
                        raise DumpFormatError("Invalid MDMP module UTF-16") from exc
                    module = {
                        "path": name, "base_address": base, "size_bytes": image_size,
                        "exception_offset": address - base,
                        "exception_offset_hex": hex(address - base),
                    }
                    break
        stream.seek(0)
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError("Deadline while hashing the retained MDMP")
            digest.update(block)
        final = os.fstat(stream.fileno())
        if (initial.st_size, initial.st_mtime_ns) != (final.st_size, final.st_mtime_ns):
            raise DumpFormatError("MDMP changed during validation")
    return {
        "path": str(path), "size_bytes": size, "sha256": digest.hexdigest(),
        "signature": "MDMP", "stream_count": count, "flags": flags,
        "timestamp": timestamp, "exception_code": code, "exception_code_hex": f"0x{code:08x}",
        "exception_thread_id": thread_id, "exception_address": address,
        "exception_address_hex": hex(address), "exception_flags": exception_flags,
        "exception_parameter_count": parameters, "thread_context_size": context_size,
        "target_pid": target_pid, "process_create_time": process_create_time,
        "target_identity_verified": expected_pid is not None and target_pid == expected_pid,
        "exception_module": module,
    }


def finish_capture(folder, *, deadline, worker_exit_code):
    """Finalize after worker death; never rewrite its exit or kill an unowned PID."""
    if type(worker_exit_code) is not int:
        raise CaptureError("worker_exit_code must be the unchanged integer observed by the parent")
    limit = _deadline(deadline)
    owned = _folder(folder, new=False)
    evidence = _read_manifest(owned)
    if evidence["worker_pid"] == os.getpid():
        raise CaptureError("finish_capture must run in an independent parent after the worker exits")
    evidence.update(
        worker_exit_code=worker_exit_code,
        worker_exit_code_hex=f"0x{worker_exit_code & 0xFFFFFFFF:08x}",
        worker_clean_exit=worker_exit_code == 0,
        finalizer_pid=os.getpid(), finalizer_parent_pid=os.getppid(),
        finish_started_at=_utc(), finish_deadline_monotonic=limit,
        dump=None, exception_code=None, dump_exists=False,
        capture_identity_verified_before_finalization=evidence["capture_identity_verified"],
        capture_identity_verified=False,
    )
    handle = None
    api = None
    timed_out = False
    try:
        api = _windows()
        handle = api.open_process(evidence["capture_pid"])
        if handle is None:
            evidence.update(
                capture_process_state="VANISHED", cleanup_confirmed=True,
                capture_exit_observed=False, capture_returncode=None, tool_exit_code=None,
                process_observation_note="Recorded PID no longer exists; tool exit code was not observed.",
            )
        else:
            timed_out = _bound_dumper(api, handle, evidence, limit)
        log_path = _path(owned / "native-crash-capture.log")
        evidence["log_size_bytes"] = log_path.stat().st_size
        evidence["log_sha256"] = _sha256(log_path, limit)
        with log_path.open("rb") as log:
            log.seek(max(0, evidence["log_size_bytes"] - 65536))
            # ProcDump 12.02 mixes an ASCII banner with UTF-16LE diagnostics.
            # Extract ASCII markers only; keep and hash every original log byte.
            tail = log.read(65536).replace(b"\x00", b"").decode("ascii", errors="replace")
        evidence["normal_target_exit_observed_in_log"] = bool(re.search(
            r"\b(?:the process has exited|process (?:has )?exited|target process exited)\b",
            tail, re.IGNORECASE,
        ))
        evidence["dump_completion_observed_in_log"] = bool(re.search(
            r"\bDump 1 complete:", tail, re.IGNORECASE,
        ))
        evidence["dump_count_reached_observed_in_log"] = bool(re.search(
            r"\bDump count reached\.", tail, re.IGNORECASE,
        ))
        dump_path = _path(owned / "native-worker.dmp")
        evidence["dump_exists"] = dump_path.exists()
        if evidence["dump_exists"]:
            evidence["dump"] = _parse_minidump(
                dump_path, expected_pid=evidence["worker_pid"],
                expected_creation_filetime=evidence["worker_creation_filetime"], deadline=limit,
            )
            evidence["exception_code"] = evidence["dump"]["exception_code"]
        if timed_out:
            raise TimeoutError("Owned ProcDump exceeded finalization wait; it was explicitly terminated")
        completed_one_dump = (
            evidence["dump"] is not None
            and evidence["dump_completion_observed_in_log"]
            and evidence["dump_count_reached_observed_in_log"]
        )
        if evidence["tool_exit_code"] == 1 and completed_one_dump:
            evidence["tool_exit_interpretation"] = "ONE_DUMP_COMPLETED_OBSERVED"
        elif evidence["tool_exit_code"] not in (None, 0):
            raise CaptureError(f"ProcDump failed with original tool exit code {evidence['tool_exit_code']}")
        if evidence["dump"] is not None:
            evidence["status"] = "CAPTURED_EXCEPTION"
        elif (worker_exit_code == 0 and
              (evidence["capture_exit_observed"] or evidence["normal_target_exit_observed_in_log"])):
            evidence["status"] = "NO_EXCEPTION"
        else:
            raise CaptureError("No verified exception dump and no confirmed normal target/tool exit; inspect retained log")
    except Exception as exc:
        status = "CAPTURE_FAILED"
        if isinstance(exc, CaptureIdentityError):
            status = "IDENTITY_MISMATCH"
        elif isinstance(exc, DumpFormatError):
            status = "INVALID_DUMP"
        elif isinstance(exc, TimeoutError):
            status = "TIMED_OUT"
        _error(evidence, exc, status)
    finally:
        if handle is not None:
            try:
                api.close(handle)
            except Exception as exc:
                _error(evidence, exc, "CAPTURE_FAILED")
        evidence["finished_at"] = _utc()
        evidence["capture_succeeded"] = evidence["status"] in ("NO_EXCEPTION", "CAPTURED_EXCEPTION")
        _atomic_json(owned / "native-crash-capture.json", evidence)
    return evidence
