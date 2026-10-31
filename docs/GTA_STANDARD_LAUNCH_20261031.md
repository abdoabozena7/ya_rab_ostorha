# Ordinary GTA launches without repeated administrator prompts

The owner's exact per-game HKCU compatibility entry forced `RUNASADMIN` on
`D:\games\Grand Theft Auto V Enhanced\PlayGTAV.exe`. Its embedded manifest
requests `asInvoker`. Only that application entry was removed. No UAC policy,
Defender preference, other application's compatibility setting, scheduled task,
service, credential or persistent privileged broker was added or changed.

Two consecutive real launches passed the separately sealed
`gta-standard-owner-20261031` task at current source `7f7c0248`, run
`20261031T115223-560789828c`. Actual owned gamePIDs35852 and36460 each returned
`TokenElevation=false`. CUA selected Story and clicked Resume Story in each
ordinary window; matching advancing native frame/time callbacks were collected.
Both owned jobs closed, temporary modules were removed, and protected project,
game, existing model and CARLA inputs retained their hashes. Global UAC keys and
other compatibility values matched before/after.

The earlier ordinary attempt reached the menu with a normal token but timed out
before valid advancing world callbacks. It remains failed; the original flag
was restored on that failure. The successful two-run attempt removed it again
and retains its removal as requested. The correction CLI is a one-time
state-changing proof helper, not the routine launch command after correction.
Future project launches should use an ordinary process, not the historical
UAC wrappers. Story selection can now be automated with CUA; automatic startup
into Story via a saved game preference has not yet been established.

[Microsoft documents](https://learn.microsoft.com/en-us/windows/win32/secbp/running-with-administrator-privileges)
that `asInvoker` inherits the parent token. The practical conclusion here comes
from the two observed game-token/callback/cleanup results, not the manifest alone.

Retained [summary](evidence/gta_standard_launch_20261031/standard-result.json),
[original exact preference](evidence/gta_standard_launch_20261031/compatibility-before.json),
[first callbacks](evidence/gta_standard_launch_20261031/launch-1/native-frames.jsonl),
and [second callbacks](evidence/gta_standard_launch_20261031/launch-2/native-frames.jsonl)
document launch iteration only. No sensor, driving model, training or CARLA
retirement acceptance follows.

The owner's final scenario is now a narrow urban street with many pedestrians
and vehicles, ordinary flow away from a locally congested junction, and scripted
bad NPC choices creating the queue. The airport remains historical calibration
data. The urban scene and production provider still require actual verification.
