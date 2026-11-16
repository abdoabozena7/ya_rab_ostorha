"""Download the pinned Khronos concept car source with a verified checksum."""
from pathlib import Path
import hashlib
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
REVISION = "c6a6bd13ab2b3c685c7903d03561b8a9392f38b8"
SOURCE = ROOT / ".cache/models/car-concept/CarConcept-standard.glb"
SHA256 = "c272098089d78c5cd9fd9f24ff50ee8acf8d932c55f2d55fc10adb6c8998966b"
URL = f"https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/{REVISION}/Models/CarConcept/glTF-Binary/CarConcept.glb"


def main():
    SOURCE.parent.mkdir(parents=True, exist_ok=True)
    if not SOURCE.exists() or hashlib.sha256(SOURCE.read_bytes()).hexdigest() != SHA256:
        with urlopen(Request(URL, headers={"User-Agent": "Ostorha-model-setup/1.0"}), timeout=90) as source:
            data = source.read()
        if hashlib.sha256(data).hexdigest() != SHA256:
            raise ValueError("Concept car checksum mismatch")
        SOURCE.write_bytes(data)
    print(f"Verified {SOURCE}")


if __name__ == "__main__":
    main()
