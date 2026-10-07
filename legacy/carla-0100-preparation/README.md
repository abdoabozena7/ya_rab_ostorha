# Archived CARLA 0.10.0 installation assumptions

The production target is now CARLA 0.9.16 (UE4). These files retain the previous
UE5 installation script and migration notes for history only. Do not run the old
script for the current application.

The complete prior preparation is preserved on branch
`codex/carla-0100-preparation-archive`, commit `4d5b8ad`.
Generic provider, controls, WebSocket, frame timing, recording and dashboard work
is reused in the current branch; it was not restarted.

The partial old package remains separately named under
`C:\CARLA\downloads\Carla-0.10.0-Win64-Shipping.zip.part`.
The signed Python 3.12 installer can be reused because the newly inspected
0.9.16 package independently proves it needs the same CPython 3.12 x64 ABI.
