# Project discussion guide

The simulator is one application with separate modules for the four course areas. The interface is in English; place names on the map and phone remain Arabic. Run `python -m backend.server`, then open `http://127.0.0.1:8000/`.

| Area | Start with | What runs now | Evidence and limitations |
| --- | --- | --- | --- |
| Computer vision | `backend/computer_vision/detector.py`, `src/ui/perception-overlay.js` | JPEG from the front camera is resized and normalized for YOLOX Tiny, then decoded with classwise NMS. Pixel detections and confidence appear as boxes over the camera. | `tests/test_cv_contract.py`; boxes can be wrong, no wall or tuk-tuk class, and they do not control braking. |
| NLP | `backend/nlp/intent.py`, `src/ui/phone.js` | A local Qwen3 model interprets typed or recognized Arabic requests into validated actions and place IDs. The simulator makes the actual route. | `tests/test_nlp_contract.py`, `tools/evaluate_nlp.py`; the new untouched 14-case holdout scored **7/14**. NLP may be offline and is not reliable enough for safety decisions. |
| Signal processing | `src/signal_processing/range-sensors.js`, `voice.js` | Five virtual proximity rays sample geometry at 10 Hz. A three-sample median and temporal low-pass filter produce displayed metre values. Browser speech recognition transcribes microphone input before NLP. | `tests/signal_processing.test.js`; the rays are simulated, not hardware, and browser speech recognition may use a browser service. Filtered ranges are diagnostic, not the collision guard. |
| Deep learning / learning | `backend/deep_learning/training.py`, `src/core/policy.js`, `tools/train-policy.mjs` | YOLOX Tiny is the pretrained neural network used for CV. The separate lab trains a **tabular Q-learning** speed policy and saves weights for A/B comparison. | `tests/policy.test.js`, `output/policy-lab-evaluation.json`; the Q-table is **not** a neural network and has not beaten the baseline. No supervised or unsupervised model is trained on this simulator yet. |

## Data flow to explain in a presentation

1. `src/core/world.js` advances the seeded simulation at 60 Hz. Its actors and geometry are ground truth.
2. The front camera produces pixels. Only those pixels enter the YOLOX detector. Bounding boxes are rendered on the camera display.
3. The phone sends text to `/api/intent`; voice first becomes text through the browser's speech API. Only validated place IDs become destination commands.
4. A* in `src/core/navigation.js` selects a legal route and charges congested junctions for newly planned trips. The collision guard in `src/core/traffic-control.js` and `geometry.js` checks simulation objects before applying vehicle motion.
5. The optional Q-table limits requested speed. It does not choose the route. The **Decision lab** draws these separate pipelines and shows live route distance, detections, filtered sensor ranges, wait time, queue counts, and interventions. Queue metrics come from `src/core/queue-metrics.js`; a stopped blocking cycle excludes cars legally held by a red signal.

These labels matter in a discussion: simulation actor positions are **not** computer vision results; the decision diagram is a module graph, **not** a claim that a neural network chose the route; virtual range rays are **not** physical sensors. Arabic destination signs now stand beside the roads on collision mapped posts, but no OCR or map-loss policy reads them yet.

## Reproduce the measurements

```bash
npm ci
npm test
python -m unittest discover -s tests -p "test_*.py"
node tools/evaluate-core.mjs
node tools/fuzz-core.mjs fuzz-e-5
node tools/fuzz-core.mjs fuzz-g-7
node tools/trace-queues.mjs stress-7 72 96 100 1 market
```

`output/core-evaluation.json` records four seeded 120-second runs and audits overlaps and road boundaries every step. `output/fuzz-fuzz-e-5.json` and `output/fuzz-fuzz-g-7.json` record two additional runs. In the latter, 72 vehicles and 96 pedestrians ran for 60 simulated seconds: the player arrived, 39 traffic trips finished, the audit found zero overlaps or road departures, and the longest vehicle wait reached 25.8 seconds. These are scenario tests, not a proof of safety for every possible situation. The remaining work is tracked in [SIMULATION_GOAL.md](SIMULATION_GOAL.md): realistic Egyptian street geometry and building materials, long-queue recovery, more natural pedestrian trip choices, OCR/map-loss, reliable pixel detection of local road objects, and a learned collision-avoidance policy with a convincing held-out evaluation.

For NLP, `python tools/evaluate_nlp.py --cases tests/fixtures/nlp-holdout-2026-09-27.json --report output/nlp-holdout-2026-09-27.json` reproduces the current untouched holdout. It exposed false navigation and missed implied destinations. The earlier 16-case set has been used while refining the English response instruction and is now a development set, not a fresh holdout.
