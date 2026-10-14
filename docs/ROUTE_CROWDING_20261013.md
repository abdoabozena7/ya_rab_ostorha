# Traffic on the selected road

The guided sequence is now **Choose destination → Make your road crowded → Traffic behaviour → Start driving**. The first crowding click opens randomness and seed controls; the next explicit click creates traffic. The button requests a route, not a fixed vehicle count.

Traffic placement uses the native road route from ego to the selected destination. Legal, same-direction parallel driving lanes are included. Slots are approximately 12 m apart along the route, excluding junctions, the immediate 16 m around ego, duplicate road sections and externally occupied spaces. Existing project-owned cars are redistributed; pedestrians, ego and sensors are retained. Traffic Manager receives each admitted car's remaining road path. Initial placement is spread across the route, including near ego. Cars ahead are not recycled merely because they are distant.

The count depends on route length, usable lanes and available spaces. The existing internal 75-car performance bound remains; longer routes retain nearby slots and spread the remaining fleet across their length. `population.route_crowding` reports the target, native count, route length, destination, seed, randomness, capacity limit and completion status. Partial placement is visible and keeps the guided start held. Replanning the same destination preserves readiness; selecting a different destination requires crowding its road again. Advanced manual city controls remain available.

## Verification

- Python: 332 discovered, 331 passed, 1 skipped. JavaScript: 76 passed. Dashboard bundle built.
- Browser flow: destination before crowding, behaviour before native request, no fixed count in the request, partial 22/23 admission held, confirmed 23 admitted, destination changes invalidate readiness, advanced mode retained, no mobile overflow and no page errors. Screenshots: `output/playwright/guided-behaviour.png`, `guided-ready.png`, `guided-mobile.png` (browser fixtures, not autonomous driving evidence).
- UI stability regression: zero layout shift, persistent prediction map and perception image during alternating wait responses, stable numeric DOM nodes, global GPU stop remains available to observers. `output/route-crowding/ui-stability.txt`.
- Live held-ego CARLA checks: **120.7 m → 8 cars** and **649.1 m → 61 cars**, with **43 within 120 m** in the longer case. All admitted cars were within 3.6 m of the route centreline, including parallel lanes. No failed spawns; ego displacement 0 m; PAUSED throughout. `output/route-crowding/native-placement.json`.
- Destination and original camera/graphics/population preferences restored. CARLA was stopped through the real header button after validation; the dashboard remained open. GPU memory reported **0 MiB** afterward.

This verifies environment placement and UI sequencing. It does not certify collision avoidance or learned motion control. No driving trials, training, or changes to old experiment budgets were made.

## Guided transition repair

The road button now opens a distinct **Traffic behaviour** step with **Apply traffic & continue**. Confirmation immediately disables the action, waits for aligned native admission, then advances focus to **Start driving**. Journey speed appears at that final step. Failed spawns keep the selected seed/randomness visible with a retry action.

Setup completion uses the confirmed native admission receipt rather than requiring the circulating fleet to retain exactly the original count forever. Ordinary actor removal/replacement cannot rewind completed setup; a new destination or new crowding request still requires confirmation. Partial initial admission and native failures never enable driving. An applied command whose controllers or telemetry are still in flight remains pending until genuine matching confirmation or timeout.

Transition checks: **83 JavaScript tests passed**; browser fixtures exercised distinct steps, automatic focus, partial-spawn retry with settings preserved, delayed admission without duplicate spawning, live count changes, destination invalidation, and mobile layout. No page errors or native mutations occurred. Evidence: `output/guided-transition/browser-check.txt`, `javascript-tests.txt`, and `output/playwright/guided-behaviour.png` / `guided-ready.png`.
