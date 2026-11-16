# Ya Rab Ostorha

A local 3D simulator for accident prevention in crowded Egyptian streets. The current autonomous driver is a physics and rule based baseline. Computer vision, NLP, virtual range sensors, and an experimental learning policy are separate modules so each subject can be explained and evaluated on its own. The application UI is in English; destination names remain Arabic.

See the [four-subject discussion guide](docs/COURSE_GUIDE.md), [simulation goal and evidence](docs/SIMULATION_GOAL.md), [API contract](docs/API.md), and [model notes](docs/MODELS.md).

## Run

Requires Node.js 18+, Python 3, and a WebGL browser.

```bash
npm ci
python -m backend.server
```

Open `http://127.0.0.1:8000/`. Three.js and the bundled 3D models load locally. The core driving simulator works without the optional AI model processes.

| Control | Action |
| --- | --- |
| W A S D or arrow keys | Drive and steer manually |
| Space | Brake and switch to manual mode |
| C | Switch between driver and chase camera |
| P | Open the side phone to type, speak, or choose a destination |
| I | Toggle autonomous drive |
| Decision lab | Inspect the live decision pipeline, route, CV boxes, range sensors, and measured traffic queues |
| Test lab | Enter a separate seeded environment; returning restores the paused city |
| Settings | Set traffic, pedestrians, chaos, speed, scenario difficulty, and seed |

The phone offers `وسط البلد`, `السوق`, `المحطة`, `المستشفى`, `الجامعة`, and `الكورنيش`. Browser speech recognition transcribes Arabic microphone input, then sends the text through the same local NLP request as typing. Speech recognition may be unavailable in some browsers or use a browser service. Place buttons work while the NLP model is offline.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/core/` | Seeded 60 Hz simulation, vehicle and pedestrian motion, collision checks, roads, A* navigation, signals, parking, replay, and scenario scheduling |
| `src/render/` | Three.js world, GLB models, road textures, wheel and skeletal animation; never owns simulation positions |
| `src/ui/` | Phone, camera detections, Decision lab, settings, and HUD |
| `src/signal_processing/` | Five simulated proximity beams, median and low pass filtering, and browser voice input |
| `src/integration/bridge.js` | Same origin JPEG and telemetry bridge to Python |
| `backend/computer_vision/detector.py` | YOLOX Tiny inference from camera JPEG pixels only |
| `backend/nlp/intent.py` | Local Qwen3 intent parsing with a fixed destination catalog |
| `backend/deep_learning/training.py` | Launch and status of the separate experimental speed policy training job |
| `src/core/policy.js`, `tools/train-policy.mjs` | Tabular Q-learning speed policy and held-out A/B evaluation; this policy is **not** a neural network |
| `assets/models/`, `assets/source/` | Runtime GLBs and editable Blender sources |
| `tests/`, `tools/` | Contract and simulation tests, asset preparation, training, and evaluations |

## What the current system does

`World.step()` is the sole writer of actor positions. Its fixed timestep, seeded random generator, and recorded commands make runs reproducible. Vehicle yaw follows a bicycle model with bounded steering; whole vehicle bodies must stay on road surfaces. Swept collision checks reject a move before it reaches another actor or building. A* follows legal graph directions and charges newly planned trips for queued junctions. One extra unmarked, eight metre, two-way local street is part of the same collision and navigation map. More varied Egyptian streets, a physically correct raised bridge, and recovery from long queues remain work in progress.

The front camera sends JPEG to YOLOX Tiny. Detected boxes, labels, confidence, and latency appear over the camera feed. Those boxes are **experimental display data** and do not control braking. The Decision lab shows the actual pipeline: YOLOX is the pretrained neural detector, A* chooses the route, and simulation state feeds the safety guard. The five virtual range values come from simulation geometry, not the camera or hardware. The optional tabular Q-learning policy only reduces requested speed and stays off by default.

Player destinations end in roadside parking bays so a stopped player does not occupy a traffic lane. Four Rocketbox characters provide animated pedestrians; four distinct CC0 traffic car models and an editable Khronos car concept are included. Road and pavement textures are CC0. Four market produce stalls and the Arabic destination-sign posts have collision footprints outside the traffic lanes; some buildings carry rooftop water tanks. The signs are visible from the camera, but OCR and sign-following navigation are not implemented. Buildings and tuk-tuks are still visually simplified. Asset sources, licenses, and rebuild scripts are documented in [assets/LICENSES.md](assets/LICENSES.md).

## Optional model setup

For camera pixel detection:

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -r backend/requirements.txt
.venv/Scripts/python tools/setup_cv.py
.venv/Scripts/python -m backend.server
```

For local NLP, start the pinned Qwen3 model in another terminal:

```bash
python tools/setup_nlp.py
python tools/start_nlp.py
```

The model files are checked against pinned hashes. The phone maps a validated place ID to a simulator command; the model never supplies coordinates. The latest fresh 14-case Arabic holdout scored **7/14**, so this input is not reliable enough for safety decisions. See [model notes](docs/MODELS.md).

The test lab can train a resumable tabular speed policy and save `output/policy-lab.json`; the A/B report is `output/policy-lab-evaluation.json`. On the earlier eight-seed comparison both sides reached 8/8 with zero audit violations, but the trained speed policy was slower (16.72 s vs 11.86 s). It remains disabled unless explicitly applied in Settings.

## Verify

```bash
npm test
python -m unittest discover -s tests -p "test_*.py"
node tools/evaluate-core.mjs
node tools/fuzz-core.mjs fuzz-e-5
```

The four-case core evaluation checks every simulation step for overlaps and off-road bodies for 120 simulated seconds, including 72 vehicles and 96 pedestrians. In the latest run all four player trips arrived with zero violations. Peak vehicle wait in the densest case was 56.4 s, and four vehicles were still queued over 20 s at the end. The Decision lab reports current queues, longest wait, and closed waiting chains after excluding cars held by a red light. No such chain lasted at least five seconds in these four cases. `tools/trace-queues.mjs` records the actors and junction reservations behind a long wait. The additional `fuzz-e-5` run also had zero violations, with a 22.8 s peak vehicle wait. These finite tests do not prove universal safety. `window.sim.audit()`, `window.sim.snapshot()`, and `window.sim.replay()` are available for live debugging.

Code license: [MIT](LICENSE).
