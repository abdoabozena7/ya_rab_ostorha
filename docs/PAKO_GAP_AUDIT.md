# PAKO convergence: current-source gap audit

The corrective mission remains **OPEN**. Starting commit:
`14cca6c7235295b873d79f0a212342612a10c42a` on the existing `main` checkout.
The original pursuit specification, [rejected trials](PURSUIT_RL_AUDIT.md),
[L01–L20 acceptance](PURSUIT_RL_ACCEPTANCE.md), replays, asset ownership, and
independent seed custody are unchanged. The exact corrective request is
preserved in `.runtime-proof/root-goals/pako-convergence-20261121/original-request.txt`
(SHA-256 `3d2a5ef51352b2485051ac13860a27d32d6cc105266c694817a8fbfdf86d8513`).

| Gap | Confirmed behavior, source and next discriminating check |
| --- | --- |
| Stationary City SUV | The same visible outcome can be a policy request, projected stop, pavement reject, contact impulse, or terminal cleanup. [Isolated physical reproductions](PAKO_STOP_DIAGNOSTICS.md) separate those causes. They do not certify every corridor. |
| Frozen inference failure | The driver formerly failed closed and showed its message only in the pursuit panel. The driving HUD and trace now expose the actual error and attempted action, without installing a replacement driver. |
| Manual steering | `A` moved the original ordinary City and Dispatch SUV to camera-right; the Arcade branch was already correct. This was an input-coordinate convention, not a corrupt checkpoint. Keep action semantics, physics and recorded signs unchanged. |
| Training | Previously, a Worker collected and updated once; only another click continued. The new session is a separate owner of episode resets and controls, sharing the same plant, PPO and legacy one-update boundary. |
| Perception | The 48 m, 72-ray 10 Hz first-return scan also refines pedestrians at 0.5°. It matches same-class observed surfaces against up to five scans of history using mutual nearest neighbors with a 0.5 m ambiguity margin. Surface shape and quantization can change the point on the same body. TTC is radial closing extrapolation, capped at 6 s—not a probability or a swept collision time. The fixed-size PPO observation keeps leading tracks, prioritizing currently observed surfaces; the full scanner has TTL/angular bounds, not an explicit fixed number of traces. Do not equate retained tracks with actors. |
| Terrain | The staged `curb-bypass-and-return` uses explicit shoulder/support geometry; its real raised/occupied controls still pass in the suite. Regular Dispatch's `motionPlan` checks `world.drivingRoads`, and City acceptance does not use the staged `heightOnSupport` branch. The University Avenue check reached a physical pavement-boundary brake without a contact. A sidewalk visible in Three.js does not make it a safe drivable shoulder. Do not loosen the road guard globally to make a bypass appear to work. |
| City size | `node tools/audit-pako-city.mjs`: 15 roads, 220 nodes in one component, 19 junctions, one degree-one endpoint and 103 nodes outside the surveillance rectangles. Removing junction `-46.0000,-42.0000` cuts off two nodes. 508 aligned centerline footprint samples passed static overlap and road support. This does **not** establish turning clearance or safe routes under congestion, so it does not justify a map expansion. |
| Dispatch | Existing qualified tracking and separation already reject empty/idle escape. Prior L17 found physical flank/interception but not simultaneous closure from multiple sectors. Record actual reinforcement, route obstruction and recovery in dense City before changing rules. |
| Learning | Old P09, P11, P13 and P15 are still open. Independent L13 rear impact and L19 open-branch stop, the 4/16 → 2/16 learning regression, and the 3/4 City development witness remain distinct. Local training progress is not a held-out collision-free escape result. |

Development remains on the browser Three.js City. Preserve standard 36/80 and
dense 96/144 populations, normal navigation and camera/People, the original SUV,
Arcade powers, Tactical drills, legacy GTA/Dispatch rules, and saved replay
actions. No native simulator or protected experiment was started.

Installed versions: Prove It **1.0.0** and HarrTest **4.1.0 Gold**.
No `hardest` skill was available from the installed resolver. Prove It activation
was denied because the existing Egypt proof is owned by another session; the
new scoped collector was sealed and run with an explicit task path. Its result
does not change the old activation or the unsealed parent root.
