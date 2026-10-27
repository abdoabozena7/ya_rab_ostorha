"""Explicit, checksum-bound locations for preserved closed recordings."""
import hashlib
import json
import os
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
RUN_NAME = re.compile(r'run_[a-f0-9]{32}')


def _plain_directory(path):
    path = Path(path).absolute()
    if any(p.is_symlink() or os.path.isjunction(p) for p in (path, *path.parents)):
        raise ValueError('Recording destination uses a link or junction')
    return path.resolve()


def receipt_path(name, workspace=ROOT):
    if not RUN_NAME.fullmatch(name):
        raise ValueError('Invalid native recording identity')
    return Path(workspace) / 'output' / 'recording-relocations' / (name + '.json')


def registered_location(name, workspace=ROOT):
    workspace = Path(workspace).resolve()
    receipt = receipt_path(name, workspace)
    if not receipt.is_file():
        return None
    data = json.loads(receipt.read_text(encoding='utf8'))
    alias = workspace / 'runs' / 'normal_city' / name
    target = _plain_directory(data['target'])
    if (data.get('status') not in ('ACTIVE', 'RELEASED') or data.get('source') != str(alias)
            or target.name != name or target.is_relative_to(workspace)
            or not target.is_dir() or not (alias.is_symlink() or os.path.isjunction(alias))
            or alias.resolve() != target):
        raise ValueError('Recording relocation is not an active verified mapping')
    manifest = receipt.with_suffix('.manifest.json')
    if hashlib.sha256(manifest.read_bytes()).hexdigest() != data.get('manifest_sha256'):
        raise ValueError('Recording relocation manifest changed')
    if hashlib.sha256((target / 'metadata.json').read_bytes()).hexdigest() != data.get('metadata_sha256'):
        raise ValueError('Relocated recording identity changed')
    return target


def recording_location(path, parent, *, workspace=ROOT):
    """Resolve an ordinary direct child or one exact registered relocation."""
    path, parent = Path(path).absolute(), _plain_directory(parent)
    resolved = path.resolve()
    if resolved.parent == parent and not (path.is_symlink() or os.path.isjunction(path)):
        return resolved
    if (parent == (Path(workspace).resolve() / 'runs' / 'normal_city')
            and RUN_NAME.fullmatch(path.name)):
        target = registered_location(path.name, workspace)
        alias = parent / path.name
        if target is not None and path in (alias, target):
            return target
    raise ValueError('Recording escaped its trusted directory')


def relocated_roots(workspace=ROOT):
    directory = Path(workspace) / 'output' / 'recording-relocations'
    if directory.exists():
        for path in sorted(directory.glob('run_*.json')):
            if not RUN_NAME.fullmatch(path.stem):
                continue
            data = json.loads(path.read_text(encoding='utf8'))
            if data.get('status') in ('ACTIVE', 'RELEASED'):
                yield registered_location(path.stem, workspace)
