"""Install the official YOLOX-Tiny ONNX release with a pinned checksum."""

from pathlib import Path
import hashlib
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / ".cache" / "models" / "cv" / "yolox_tiny.onnx"
URL = "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx"
SHA256 = "427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7"


def checksum(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    if MODEL.exists() and checksum(MODEL) == SHA256:
        print(f"Verified {MODEL}")
        return
    temporary = MODEL.with_suffix(".onnx.part")
    request = urllib.request.Request(URL, headers={"User-Agent": "Ostorha-CV-setup/1.0"})
    with urllib.request.urlopen(request, timeout=90) as response, temporary.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    if checksum(temporary) != SHA256:
        raise ValueError("YOLOX-Tiny checksum mismatch; model was not installed")
    temporary.replace(MODEL)
    print(f"Verified {MODEL}")


if __name__ == "__main__":
    main()
