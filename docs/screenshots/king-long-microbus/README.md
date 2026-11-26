# King Long microbus in Metro City

Twenty-five rendered frames from the live standalone Three.js game. The
microbus is an original procedural model based on the white short-nose vehicle
reference, not copied photography. The player selects it in **Tools → Car**
on the same road, with the original City and population retained. Manual
keyboard inputs drive the real fixed-step simulation between captures; some
shots use a free camera for a closer look. Chase on the microbus is manual.

| Frame | Live view |
| --- | --- |
| 01 · Default vehicle | ![Unchanged Jetour SUV at City startup](01-original-jetour.png) |
| 02 · Vehicle choice | ![The two player vehicle options in the Car panel](02-player-vehicle-selector.png) |
| 03 · Select King Long | ![Microbus equipped in the original City](03-microbus-equipped.png) |
| 04 · Front three-quarter | ![White King Long microbus, short nose and side windows](04-front-quarter.png) |
| 05 · Driver's side | ![Driver-side profile and road tires](05-driver-side.png) |
| 06 · Passenger side | ![Sliding passenger door and dark window bays](06-sliding-door-side.png) |
| 07 · Front detail | ![Raked windshield, grille slats and rectangular lamps](07-short-nose-and-grille.png) |
| 08 · Rear three-quarter | ![Passenger body, high roof and tailgate](08-rear-quarter.png) |
| 09 · Tailgate | ![Rear glass and vertical lamp clusters](09-tailgate.png) |
| 10 · C: cockpit | ![Left-hand microbus cockpit and clear road view](10-c-key-cockpit.png) |
| 11 · C: elevated | ![Elevated driving camera over the microbus](11-c-key-elevated.png) |
| 12 · C: behind | ![Behind-vehicle driving camera](12-c-key-behind.png) |
| 13 · Running gear | ![Microbus wheel, suspension and driveline inspection](13-running-gear.png) |
| 14 · Passenger cabin | ![Cutaway revealing passenger seats and cabin floor](14-cutaway-passenger-cabin.png) |
| 15 · W: accelerating | ![Real manual City acceleration](15-w-accelerating-in-city.png) |
| 16 · Swap guard | ![The Car panel explains why a moving vehicle cannot be changed](16-moving-switch-rejected.png) |
| 17 · Turning | ![Front wheel articulation and microbus body roll](17-steering-and-body-roll.png) |
| 18 · Space: braking | ![Microbus slowing with its brake lights on](18-space-braking.png) |
| 19 · S: reversing | ![Manual reverse motion viewed from the rear](19-s-reversing.png) |
| 20 · Cockpit in motion | ![Windshield, steering wheel and speed reading while driving](20-driving-from-cockpit.png) |
| 21 · Chase setup | ![Manual-only microbus Chase selection](21-manual-chase-ready.png) |
| 22 · Live Chase | ![The microbus in a real City pursuit](22-live-microbus-chase.png) |
| 23 · Compact layout | ![The selector at a narrower browser viewport](23-compact-vehicle-selector.png) |
| 24 · City exterior | ![The microbus back on the same City street after Chase](24-microbus-city-farewell.png) |
| 25 · Back to Jetour | ![Original SUV restored in the same City](25-jetour-restored-same-city.png) |

Reproduce with the standalone server on port 8877, Playwright and Chromium:

```sh
PROVE_IT_OUTPUT_DIR=/path/to/fresh-output node tools/verify-king-long-browser.mjs
```

Set `THREEJS_URL` for another local port and `PLAYWRIGHT_MODULE` if Playwright
is installed outside the project.
