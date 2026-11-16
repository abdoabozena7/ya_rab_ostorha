"""Verify or restore pinned CC0 Poly Haven road and pavement maps."""

from pathlib import Path
import hashlib
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SURFACES = {
    "asphalt_07_diff_1k.jpg": "ac1dd04834e969f76c63773fd3ce7fba75727e36abd4bddb2fbeb06098e0f810",
    "asphalt_07_nor_gl_1k.jpg": "63543f5c0cee136adfb748622227a11ce53d4de0bf65eb23098a0711de353893",
    "concrete_pavement_02_diff_1k.jpg": "e129ee6b59b6ed7f65b4c4c5ba9eb583d13d040ec26bef5d5d4e0080fe342e7a",
    "concrete_pavement_02_nor_gl_1k.jpg": "26c09320b3373da7f55edb8165562f16d36c07161c9c715787a09daf5910450c",
}


def checksum(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    directory = ROOT / "assets" / "textures" / "roads"
    directory.mkdir(parents=True, exist_ok=True)
    for name, expected in SURFACES.items():
        destination = directory / name
        if destination.exists():
            if checksum(destination) != expected:
                raise ValueError(f"{name} differs from the pinned download; keep your edited texture")
            print(f"Verified {name}")
            continue
        asset = name.split("_diff_")[0].split("_nor_gl_")[0]
        url = f"https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/{asset}/{name}"
        temporary = destination.with_suffix(".jpg.part")
        request = urllib.request.Request(url, headers={"User-Agent": "Ostorha-surface-setup/1.0"})
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        if checksum(temporary) != expected:
            raise ValueError(f"Checksum mismatch: {name}")
        temporary.replace(destination)
        print(f"Verified {name}")


if __name__ == "__main__":
    main()
