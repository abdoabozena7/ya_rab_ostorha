"""Fetch pinned, public local NLP assets; no account, API key or cloud inference.

Windows uses the official llama.cpp Vulkan build. Downloads are checksum checked.
The GGUF is Unsloth's Q4 conversion of Qwen3-4B-Instruct-2507.
"""
from pathlib import Path
import hashlib
import urllib.request
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / '.cache' / 'models' / 'nlp'
RUNTIME_DIR = ROOT / '.runtime' / 'llama'
MODEL_REPO = 'unsloth/Qwen3-4B-Instruct-2507-GGUF'
MODEL_REVISION = 'a06e946bb6b655725eafa393f4a9745d460374c9'
MODEL_NAME = 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'
MODEL_SHA256 = '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597'
RUNTIME_URL = 'https://github.com/ggml-org/llama.cpp/releases/download/b11146/llama-b11146-bin-win-vulkan-x64.zip'
RUNTIME_SHA256 = '55a378aa095b466979d85075234f66d7655c7a7483222af0c006c0e55b4d7bd6'

def checksum(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def download(url, path, expected):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and checksum(path) == expected:
        print(f'Verified {path.name}', flush=True)
        return path
    temporary = path.with_suffix(path.suffix + '.part')
    offset = temporary.stat().st_size if temporary.exists() else 0
    headers = {'User-Agent': 'Ostorha-model-setup/1.0'}
    if offset:
        headers['Range'] = f'bytes={offset}-'
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=90) as response:
        if response.status != 206:
            offset = 0
        total = offset + int(response.headers.get('Content-Length', 0))
        progress = offset
        last_report = offset
        with temporary.open('ab' if offset else 'wb') as stream:
            while chunk := response.read(1024 * 1024):
                stream.write(chunk)
                progress += len(chunk)
                if progress - last_report >= 64 * 1024 * 1024:
                    print(f'{path.name}: {progress // 1048576} / {total // 1048576} MiB', flush=True)
                    last_report = progress
    if checksum(temporary) != expected:
        raise ValueError(f'Checksum mismatch: {path.name}; file was not installed')
    temporary.replace(path)
    print(f'Verified {path.name}', flush=True)
    return path

def main():
    archive = download(RUNTIME_URL, ROOT / '.cache' / 'llama-b11146-vulkan.zip', RUNTIME_SHA256)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as files:
        for entry in files.infolist():
            target = (RUNTIME_DIR / entry.filename).resolve()
            if not target.is_relative_to(RUNTIME_DIR.resolve()):
                raise ValueError('Invalid archive path')
            if target.is_file() and target.stat().st_size == entry.file_size and zlib.crc32(target.read_bytes()) == entry.CRC:
                continue
            files.extract(entry, RUNTIME_DIR)
    model_url = f'https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/{MODEL_NAME}'
    download(model_url, MODEL_DIR / MODEL_NAME, MODEL_SHA256)
    print(f'NLP runtime ready: {RUNTIME_DIR}', flush=True)

if __name__ == '__main__':
    main()
