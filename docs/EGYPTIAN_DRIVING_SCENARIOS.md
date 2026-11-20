# Egyptian City driving scenarios

These are ordinary street events in the unified **City**, not a new map or
a training setup. They turn an existing crowd into specific driving decisions:
what you can see, what may move next, and where you still have room to wait.
The same seed and driving commands reproduce a run. Another seed, street or
arrival time can expose a different combination.

| Order | Encounter | Where it can happen | Physical outcome to verify |
| --- | --- | --- | --- |
| 1 | **Microbus pickup** (`curb-pickup`) | A moving taxi or van already on a neighborhood or avenue approach, outside a conflict zone | The existing vehicle slows, holds briefly and resumes. Cars behind it react to the real stopped body; nobody is despawned or moved to the curb by a script. |
| 2 | **Stop-and-go wave** (`traffic-wave`) | Successive moving vehicles along an avenue | A lead vehicle changes pace, then releases. Following traffic forms or eases the queue through normal headway control. A single car with no follower is not a wave. |
| 3 | **Tuk-tuk from a side street** (`side-street-tuktuk`) | An existing tuk-tuk close to joining a useful junction ahead | It hesitates then continues on its legal street route; other vehicles yield using the ordinary intersection and collision checks. Wrong-way travel and jumping a reservation are not allowed. |
| 4 | **Pedestrian at the curb** (`curb-crossing`) | A real sidewalk pair or marked avenue crossing; a pedestrian already close to one side | After a short hesitation, the person walks the crossing only if the path is available. The neighborhood can use an unmarked crossing. Traffic reacts to actual motion; the camera receives pixels, not the event schedule. |
| 5 | **Street maintenance** (`roadworks`) | A clear lane segment sufficiently far ahead of the driver, outside an intersection | A real, visible temporary barrier occupies part of one lane. Cars react to its footprint. Clearing the work reopens the lane without moving any actors. No barrier is placed on top of a vehicle or pedestrian. |

### Selection and controls

- **Traffic unpredictability** controls how often a contextually eligible
  event can run. At zero, scheduled street events are off; regular traffic,
  yielding and walking still operate.
- **Seconds between scenarios** is the scheduling interval before seeded
  variation, not a promise of an event every exact number of seconds.
  At high settings, different events can overlap where safe. An occupied
  crossing or junction can delay an attempt or rule it out.
- **Scenario difficulty** increases the possible duration and overlap rather
  than dropping safety checks. **Maximum density** does not change the
  configured speed limit, difficulty, interval, or actor physics.
- Events use existing actors wherever possible. Scheduled events are not
  counted until there is an observable effect. A wait or failed attempt is not
  evidence of a crossing, usable detour, or camera prediction.
- No extra ordinary encounters are started during pursuit. Existing events may
  finish; police events still belong to the separate pursuit logic. Lab retains
  its controlled fixtures.

### Evidence

Performance is measured first, at the same native resolution, speed and actor
counts before and after the optimization. Behavior checks then distinguish
scheduled from applied events, track physical movement and cleanup, compare
same-seed and different-seed runs, and exercise an unavailable-event control.
For visual evidence, inspect the real default avenue and narrow lane from the
same City, plus maximum density. Rendering residency must not alter collision
geometry, actor counts, deterministic replay, or camera observations.
