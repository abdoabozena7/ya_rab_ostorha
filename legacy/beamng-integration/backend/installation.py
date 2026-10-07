"""Local presence checks; BeamNG itself must validate the license."""
from pathlib import Path


class BeamNGBlocker(RuntimeError):
    pass


def require_installation(home):
    root = Path(home).expanduser().resolve()
    binary = root / "Bin64" / "BeamNG.tech.x64.exe"
    key = root / "tech.key"
    missing = []
    if not binary.is_file():
        missing.append(f"BeamNG.tech executable: {binary}")
    if not key.is_file() or key.stat().st_size == 0:
        missing.append(f"Licensed, nonempty key: {key}")
    if missing:
        raise BeamNGBlocker("BEAMNG BLOCKER\nRequired:\n- " + "\n- ".join(missing) +
                           "\nProvide the official BeamNG.tech package and installation path.")
    return root, binary
