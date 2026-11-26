# City escape: 25 live browser frames

Captured from the standalone Three.js City in headless Chromium. These are
rendered game frames, not external-simulator footage or a claim of universal
collision-free driving. The two prop-impact pairs use explicitly positioned
diagnostic approaches followed by actual City physics ticks.
Frames use 1280-by-800 CSS screenshots (the last is 900-by-650), with render
device scale 0.75. Chase progress uses the real main-loop controller and fixed
simulation steps, not elapsed browser wall time. Frame 23 opens the existing
training Lab; frame 24 returns to the retained original City.

These images do **not** establish a successful escape or traversal of the whole
crowd. The shipped PPO failed the three dense qualified-escape evaluations;
controlled drills improved contacts, but production escape reliability remains
an explicit limitation.
Some software-rendered inspection frames show optional perception HUD warnings
(including a front-camera timeout). They do not verify the pixel detector or
real-time rendering performance.

| Frame | Actual game view |
| --- | --- |
| 01 · Opaque rear glazing | ![City and black rear window](01-city-black-rear-glass.png) |
| 02 · Exterior windshield | ![Black windshield and front-quarter view](02-black-windshield-front-quarter.png) |
| 03 · Left privacy windows | ![Opaque left side windows](03-black-left-side-glass.png) |
| 04 · Right privacy windows | ![Opaque right side windows](04-black-right-side-glass.png) |
| 05 · C: cockpit | ![Unobstructed cockpit after pressing C](05-c-key-cockpit.png) |
| 06 · C: elevated chase | ![Elevated chasing camera after pressing C](06-c-key-elevated-chasing.png) |
| 07 · C: behind car | ![Behind-car camera after completing C cycle](07-c-key-behind-car.png) |
| 08 · Level 1 | ![Pursuit starts in the same City](08-level-one-live-city-chase.png) |
| 09 · Live controller | ![Predictive escape progressing through City](09-predictive-escape-progress.png) |
| 10 · Escape direction | ![Persistent escape route](10-persistent-escape-route.png) |
| 11 · All 20 people | ![Twenty added pedestrians distributed along the road](11-twenty-people-spread-overhead.png) |
| 12 · Crowd gaps | ![Staggered crowd leaves traversable gaps](12-crowd-traversable-gaps.png) |
| 13 · Crowd avoidance | ![Live driver approaching the distributed crowd](13-crowd-predictive-avoidance.png) |
| 14 · Level 2 | ![Level 2 with capped patrol speed](14-level-2-speed-parity.png) |
| 15 · Level 3 | ![Level 3 with capped patrol speed](15-level-3-speed-parity.png) |
| 16 · Level 4 | ![Level 4 with capped patrol speed](16-level-4-speed-parity.png) |
| 17 · Level 5 | ![Level 5 with capped patrol speed](17-level-5-speed-parity.png) |
| 18 · Nitro | ![Real manual Nitro activation](18-manual-nitro-advantage.png) |
| 19 · Solid tree | ![City tree before controlled impact](19-tree-solid-before-impact.png) |
| 20 · Tree reaction | ![Real tree impact with bending and SUV damage](20-tree-physical-impact-response.png) |
| 21 · Solid kiosk | ![City kiosk before controlled impact](21-kiosk-solid-before-impact.png) |
| 22 · Kiosk reaction | ![Real kiosk impact with crumpling and SUV damage](22-kiosk-physical-impact-response.png) |
| 23 · Training | ![Existing training interface with City scenarios](23-training-scenarios.png) |
| 24 · Original City | ![Same City and ambient population after pursuit](24-original-city-retained.png) |
| 25 · Compact view | ![Driving cameras in a compact viewport](25-compact-city-camera.png) |

Reproduce with the documented standalone server, installed Playwright/Chromium,
and a fresh output directory:

```sh
PROVE_IT_OUTPUT_DIR=/path/to/fresh-output \
  node tools/verify-smart-city-browser.mjs
```

Set `THREEJS_URL` if the server is not at `http://127.0.0.1:8876`, and
`PLAYWRIGHT_MODULE` if Playwright is installed outside this checkout.
