# UI redesign screenshots — 2026-10-13

`live-stopped-desktop.png` and `live-stopped-mobile.png` show the actual served
dashboard while CARLA is stopped. No simulator launch or drive was performed.

The numbered images come from the isolated Playwright rehearsal in
`scripts/verify_redesign_ui.js`. Every simulation API request and WebSocket was
intercepted within that browser. The road image is a previously recorded CARLA
RGB frame; route, roads, motion predictions, traffic counts and comparison runs
are explicitly labelled synthetic fixtures. These images validate layout and
interaction states, not native driving or safety performance.

| State | Image |
| --- | --- |
| Actual stopped dashboard, desktop | [live-stopped-desktop.png](live-stopped-desktop.png) |
| Actual stopped dashboard, mobile | [live-stopped-mobile.png](live-stopped-mobile.png) |
| Driving before setup | [01-before-setup.png](01-before-setup.png) |
| Exactly two driving mode choices | [02-mode-choices.png](02-mode-choices.png) |
| Active protected mode | [03-active-protected.png](03-active-protected.png) |
| Unified route and measured forecast | [04-unified-map.png](04-unified-map.png) |
| Expanded native-geometry map | [05-expanded-map.png](05-expanded-map.png) |
| One run missing | [06-one-missing.png](06-one-missing.png) |
| Both recorded runs | [07-both-recorded.png](07-both-recorded.png) |
| Expanded simulator with safety controls | [08-expanded-simulator.png](08-expanded-simulator.png) |
| Mobile results | [09-mobile-results.png](09-mobile-results.png) |
| Mobile driving | [10-mobile-driving.png](10-mobile-driving.png) |
| Dark driving | [11-dark-driving.png](11-dark-driving.png) |
| Dark results | [12-dark-results.png](12-dark-results.png) |
| Mobile mode selection sheet | [13-mobile-mode-choices.png](13-mobile-mode-choices.png) |
| Rear approach with close measured front obstacle; live collision episodes | [14-rear-front-blocked.png](14-rear-front-blocked.png) |
| Same rear/front state at mobile width without page scroll | [15-mobile-rear-front-blocked.png](15-mobile-rear-front-blocked.png) |
