# Verified closed-recording relocation

This maintenance operation preserves recording bytes and original paths; it is
not raw retirement or native acceptance. It never relocates an active run or
the protected recovery/native-evidence archives.

## Trust and lifecycle

`backend\core\recording_relocation.py` copies one finalized
`runs\normal_city\run_<32 hexadecimal digits>` to an explicitly supplied,
plain external directory. The destination must not use a symlink/junction.
Admission requires the copy size, a 50% margin and an independent 4 GiB reserve
on its volume. For batches, reserve those amounts for the **whole selected
batch**, not just each individual run.

Every file is flushed/fsynced and compared against a complete SHA-256/length
inventory; the original is independently checked again. Empty directories are
preserved too. Only then is the original physical directory renamed to the
project's named staging directory and replaced with a Windows junction (or a
directory symlink on non-Windows systems). No historical report, metadata,
logical sensor hash or video URL is rewritten.

The explicit registry under ignored `output\recording-relocations` binds the
original path, exact target, metadata hash and full inventory hash. Ordinary
junctions remain unsupported: recording discovery, compression, video HTTP,
native video verification and shared-camera export trust only an exact active
registration. Generic `storage_retention.contained` is **not relaxed**.
Automatic guided raw retirement skips relocated evidence.

The original staged copy remains until a separate release operation rechecks
both full inventories, original-path resolution, replay endpoint assets for
complete non-retired recordings, video endpoint decoding and the original
HTTP route's provenance/checksum checks. Previously retired or incomplete
recordings keep their original limitations; relocation does not restore lost
sensor bytes or certify an incomplete replay.
Drained failed-export intermediates and originally unavailable video variants
are preserved byte-for-byte and explicitly labelled, not decoded/served as
READY exports. READY variants still require all decode and route checks.

Release removes **only the named verified staged duplicate**, retaining every
file in the external recording and leaving the original path usable. It does
not remove an archive or discard evidence.

CARLA must be stopped, exports drained and native ownership absent. A storage
lease serializes maintenance and blocks native starts/reservations. A crash
can leave that lease or a staged copy; no automatic recovery deletes either.

## Commands

Use the existing project environment. Specify a dedicated destination and
measure both physical volumes first; C and D are never implicitly pooled.

```powershell
# Verified copy + reversible activation; original bytes remain staged on D:
.\.venv-carla\Scripts\python.exe -m scripts.relocate_recording runs\normal_city\run_<id> --destination C:\verified-recordings
# Recheck consumers and equality, then release only that staged duplicate:
.\.venv-carla\Scripts\python.exe -m scripts.relocate_recording runs\normal_city\run_<id> --release-verified-source
# Rollback: restore physical original, retain the external evidence copy:
.\.venv-carla\Scripts\python.exe -m scripts.relocate_recording runs\normal_city\run_<id> --restore-original
```

Replace `<id>` with the actual 32-digit run identity. Rollback uses an existing
verified staged original or makes and verifies a new copy with independent
original-volume capacity/margin/reserve. A failed activation restores the
original physical directory immediately. A failed copy/check never releases
the original.

## Recovery and limits

Preserve the registry, manifests and external directory with the evidence;
they are local, not included in an ordinary clone. A missing or mismatched
mapping is rejected, not silently trusted. Historical reports still bind their
original bytes and original paths.

After an interrupted operation, inspect the receipt, source alias, target,
staging path and any lease before explicit recovery. A `COPY_VERIFIED` receipt
has not established a trusted external mapping. An `ACTIVE` receipt retains a
staged original; `RELEASED` retains the target and original alias; `RESTORED`
uses the original physical directory and retains the external copy. Never
recursively delete a junction or assume both locations are disposable copies.

Rollback intentionally refuses if files differ from the preserved inventory.
Later intentional recording mutations (for example a new compression or
export) need their own evidence/rollback plan; the initial snapshot is not a
claim that files can never change. Removing a destination volume makes its
relocated evidence unavailable.

New recordings, exports and the native storage preflight remain on D.
Only measured **actual D free space after verified release** can satisfy the
unchanged native gate. Full successful DEVELOPMENT must still determine final
ACCEPTANCE sizing. Relocation grants no budget extension, failed-source retry
or acceptance.
