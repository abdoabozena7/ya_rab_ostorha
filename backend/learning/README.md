# Learning

This section contains the existing learning implementations. It separates supervised behavior cloning from experimental reinforcement learning. There is no new training and no unsupervised algorithm added for presentation.

## Supervised Behavior Cloning

`supervised/features.py` builds normalized sequential features from synchronized sensors and the existing base-driver command. `supervised/inference.py` implements the frozen GRU and classification head in NumPy on CPU: **4,611 parameters**. Outputs are learned safety-action proposals, not native vehicle controls. Weights and metadata remain in `artifacts/learned_safety/v1`; the SHA-256 integrity check remains enforced.

The shared safety adapter imports these components through `backend/learned/` compatibility modules. RULE is enabled in the presentation comparison. Standalone LEARNED previously failed progress validation (0/2); HYBRID V2 passed the recorded 3/3 forward-hazard pilots with a mandatory rule release guard. Those small pilots do not establish a learned safety improvement or general collision prevention. See the existing artifact metadata and final guard evidence for actual results.

## Reinforcement Learning

`rl/env.py`, `runtime.py`, `observations.py`, `actions.py` and `reward.py` implement the existing experimental environment and episode lifecycle. `teacher.py`, `demonstrations.py` and `evaluation.py` support its existing experiments. SAC does not start automatically during normal or comparison driving. `backend/rl/` keeps compatibility imports; actual code lives here. Radar signal processing is shared from `backend/signals/`.

## Inputs, outputs and runtime

Inputs: the validated feature vector / recent observations. Outputs: action class and probabilities, or an experimental RL action proposal and episode measurements. Shared arbitration and safety validation decide whether any proposal may be applied. CARLA lifecycle, recording and control ownership remain outside this folder.

## Demonstration and questions

Start the project. In your code editor, inspect `supervised/inference.py` and artifact metadata; research controls remain under Details → Controlled research tools. Do not select experimental learning to claim protection in the comparison. Why NumPy? It avoids Torch/CUDA in the driving loop. How is behavior cloning different from RL? Cloning learns labels from examples; RL optimizes reward over interaction episodes. Why is RULE the default? Its recorded validation and release behavior support the current demo; learned proposals have explicit limitations.
