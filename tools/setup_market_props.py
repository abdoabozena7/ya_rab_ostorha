"""Restore the pinned CC0 produce stall and roof tank GLBs."""

from pathlib import Path
import hashlib
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
ASSETS = {
    "market-produce": (
        36547,
        "97a4ea19341acfdf46d4a53919c3cf178a5f4b251f7462437bafee835521ab64",
    ),
    "roof-water-tank": (
        36532,
        "9e17191afd557e060b36230742088a0393ea93945e9179720af5abba373cd1e4",
    ),
}


def checksum(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    folder = ROOT / "assets" / "models" / "props"
    folder.mkdir(parents=True, exist_ok=True)
    for name, (asset_id, expected) in ASSETS.items():
        target = folder / f"{name}.glb"
        if target.exists():
            if checksum(target) != expected:
                raise ValueError(f"{name} has local edits; keep it and use a new filename")
            print(f"Verified {name}")
            continue
        temporary = target.with_suffix(".glb.part")
        request = urllib.request.Request(
            f"https://cdn.3dassets.dev/assets/{asset_id}/v1/model.glb",
            headers={"User-Agent": "Ostorha-model-setup/1.0"},
        )
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if checksum(temporary) != expected:
            temporary.unlink(missing_ok=True)
            raise ValueError(f"Checksum mismatch: {name}")
        temporary.replace(target)
        print(f"Verified {name}")


if __name__ == "__main__":
    main()
