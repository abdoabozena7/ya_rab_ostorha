# GTA native bootstrap and owner UAC continuation

**PARTIAL — native bootstrap VERIFIED_WITHIN_SCOPE, migration OPEN.**

The installed Enhanced executable (file version `1.0.1013.20`) actually loads
the project C++ ASI through the official package's XInput loader. Three native
frame/time samples from the owned game PID advance. This is the first verified
native hook result; camera/depth accuracy, controls, the CV/Trajectron++/RL path,
scenario coverage, model acceptance and CARLA retirement still require evidence.

## Owner-directed file permission

The owner explicitly requested restoring/allowing the existing installation and
personally accepting the normal Windows administrator prompt. The helper uses
that normal UAC flow and a fixed list of only `RUNE64.dll`, `PlayGTAV.exe` and
`version.dll` in the named GTA installation. The elevated result records exact
file hashes and checks each exclusion through Microsoft's actual engine command.
It restores missing files only by exact quarantined filepath, not by threat ID.
Unrelated exclusions and protection preferences matched before/after. The three
successful exact-file exclusions remain in place under the owner's instruction.

This is an owner allowance, **not a finding that Defender was wrong**. Its
observed Kepavll/Packunwan classifications remain recorded. No game files were
uploaded, no global protection was disabled, no broad folder exclusion was added,
and neither Windows consent nor credentials were automated. The first failed
attempt rolled back its new exclusions and remains preserved.

## Native result

An ordinary launcher attempt then produced `WinError 740` (elevation required).
Direct ordinary execution still exited `4919 / 0x1337`. The owner-described
normal UAC route was implemented in an independently sealed continuation,
without editing or relaxing either earlier blocked contract.

The first elevated launch opened GTA, but its dinput loader produced no callback.
`dumpbin /dependents` on the actual game lists `XINPUT1_4.dll`, not `dinput8.dll`.
The next attempt used the XInput loader already in the same official ZIP; it
required no extra download, launch-argument/anti-cheat change or trainer.

Actual run: `gta-uac-bootstrap-20261031`,
`runs/native-bootstrap/20261030T230201-a8123c5b51`.

- Owned game PID: **30384**, run `e0aafc04f3b44519b65e380d5e7d5f44`.
- Native frames: **8132, 8137, 8145**; game clock: **44780, 45049, 45306 ms**.
- Script Hook log: successful initialization, `VER_EN_1_0_1013_17`, registering
  `OstorhaBootstrap.asi`. The hook's recognized code build differs from the
  executable's file-version suffix; this does not qualify all natives/sensors.
- Final owned job shutdown, temporary-file restoration and protected-input
  comparison: **passed**. Original game files were not replaced.
- Native interval: **86.484 s**; enclosing UAC/build/guard interval: **101.860 s**.
- Source-bound checks, artifact inspection and `proof.py verify --write-report`:
  **EVIDENCE_GATE_PASSED**, bootstrap scope only. No native Copilot callbacks or
  host-wide Stop enforcement are claimed by this desktop host.

The earlier elevated failed attempt lacked a final cleanup receipt. Its dead
owner PID and absence of all game/simulator processes were checked before removing
only its three manifest/hash-matched temporary files; that separate recovery is
preserved. The supervisor now writes intermediate progress and retains cleanup
errors. No failed receipt was overwritten to make a gate pass.

Same original runtime grant: **642.268 / 10800 seconds charged**, including
conservative charges for the failed attempt. Remaining: **10157.732 seconds**.
Dependency payload remains **11,723,114 / 100,000,000 bytes charged/reserved**.
Neither ledger was reset. CARLA, raw data, project code, weights and previous
research evidence remain retained. No GTA training has started.

The retained evidence subset is under `docs/evidence/gta_bootstrap_20261031/`;
complete local contracts, receipts, security observations and failed attempts
remain under `integrations/gta/.runtime-proof/` and ignored dependency ledgers.

## Next gate

Qualify the real RGB/depth capture, ray geometry, timing and physical actuation
before making a production provider or training policy. The visual prediction
architecture and all original 600–800 m, 60-vehicle/100-pedestrian, three
overtake/return, safety and timing requirements remain unchanged. A successful
hook does not authorize CARLA/raw-data retirement.
