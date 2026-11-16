"""Restore four CC0 road cars with checked, self-contained GLB files."""

from pathlib import Path
import hashlib
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
FLEET = {
    "traffic-saloon": (
        15104,
        "fb074cf1344f91e03ed4751766453366de0c6d0515d82f916c321721cfca2b71",
    ),
    "traffic-hatchback": (
        15109,
        "16900fb00c4198c2f2db3c4ec315c9b2bff5224fbc50bab12c03792fa8db5422",
    ),
    "traffic-crossover": (
        15106,
        "77b761cf4605e3fef8b4263d4705e0c70a1a509efc94114031d335dd4e17606c",
    ),
    "traffic-minivan": (
        15114,
        "94279af57d6f48a87476972d3a639b33c92894ab3197570dce26b97325363f8f",
    ),
}


def checksum(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    directory = ROOT / "assets" / "models" / "vehicles"
    directory.mkdir(parents=True, exist_ok=True)
    for name, (asset_id, expected) in FLEET.items():
        destination = directory / f"{name}.glb"
        if destination.exists():
            if checksum(destination) != expected:
                raise ValueError(f"{name} differs from the pinned download; keep your edited GLB")
            print(f"Verified {name}")
            continue
        url = f"https://cdn.3dassets.dev/assets/{asset_id}/v1/model.glb"
        temporary = destination.with_suffix(".glb.part")
        request = urllib.request.Request(url, headers={"User-Agent": "Ostorha-model-setup/1.0"})
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if checksum(temporary) != expected:
            raise ValueError(f"Checksum mismatch: {name}")
        temporary.replace(destination)
        print(f"Verified {name}")


if __name__ == "__main__":
    main()
