import { Random } from "../core/random.js";
import { CLEARANCE_ROUTE_OBSERVATION_SCHEMA, DISPATCH_OBSERVATION_SCHEMA,
  ROUTE_OBSERVATION_SCHEMA } from "./gta-pursuit-env.js";
import { validatePursuitAction } from "../core/pursuit-controls.js";

const HIDDEN = 24, ACTIONS = 3, HEADS = ACTIONS + 1;
const POLICY_ID = "metro-dispatch-ppo-v2";
const GAUSS_CONSTANT = Math.log(2 * Math.PI) / 2;
const normal = rng => Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next());

const layouts = new Map([DISPATCH_OBSERVATION_SCHEMA, ROUTE_OBSERVATION_SCHEMA, CLEARANCE_ROUTE_OBSERVATION_SCHEMA].map(schema => {
  const INPUT = schema.length, HIDDEN_BIAS = INPUT * HIDDEN, OUTPUT_WEIGHTS = HIDDEN_BIAS + HIDDEN;
  const OUTPUT_BIAS = OUTPUT_WEIGHTS + HIDDEN * HEADS, PARAMETERS = OUTPUT_BIAS + HEADS;
  return [schema.version, Object.freeze({ schema, INPUT, HIDDEN_BIAS, OUTPUT_WEIGHTS, OUTPUT_BIAS, PARAMETERS,
    std: Object.freeze(schema.navigation ? [.07, .27, .20] : [.18, .52, .35]) })];
}));

function logProbability(mean, raw, std) {
  let logp = 0;
  for (let i = 0; i < ACTIONS; i++) {
    const z = (raw[i] - mean[i]) / std[i];
    logp -= .5 * z * z + Math.log(std[i]) + GAUSS_CONSTANT;
  }
  return logp;
}

function actionFor(raw) {
  const effort = Math.tanh(raw[1]);
  const brake = Math.max(0, Math.tanh(raw[2] - .35));
  return { steer: Math.tanh(raw[0]), throttle: brake > 0 ? 0 : Math.abs(effort),
    brake, gear: effort < 0 ? -1 : 1 };
}

function forward(layout, weights, obs) {
  const { INPUT, HIDDEN_BIAS, OUTPUT_WEIGHTS, OUTPUT_BIAS } = layout;
  if (!(obs instanceof Float32Array) || obs.length !== INPUT || !obs.every(Number.isFinite))
    throw new TypeError(`Expected a finite ${layout.schema.version} observation`);
  const hidden = new Float64Array(HIDDEN);
  for (let h = 0; h < HIDDEN; h++) {
    let sum = weights[HIDDEN_BIAS + h], offset = h * INPUT;
    for (let j = 0; j < INPUT; j++) sum += obs[j] * weights[offset + j];
    hidden[h] = Math.tanh(sum);
  }
  const out = new Float64Array(HEADS);
  for (let head = 0; head < HEADS; head++) {
    let sum = weights[OUTPUT_BIAS + head], offset = OUTPUT_WEIGHTS + head * HIDDEN;
    for (let h = 0; h < HIDDEN; h++) sum += hidden[h] * weights[offset + h];
    out[head] = sum;
  }
  return { hidden, out };
}

const validCounter = value => Number.isSafeInteger(value) && value >= 0;
function readCheckpoint(checkpoint, optimizerRequired) {
  const layout = layouts.get(checkpoint?.observation);
  const isParameters = (a, min) => Array.isArray(a) && a.length === layout.PARAMETERS &&
    a.every(x => Number.isFinite(x) && x >= min && x <= 1e4);
  if (checkpoint?.schema !== 1 || checkpoint.algorithm !== POLICY_ID || !layout ||
      typeof checkpoint.seed !== "string" || checkpoint.seed.length < 1 || checkpoint.seed.length > 200 ||
      !validCounter(checkpoint.updates) || !validCounter(checkpoint.transitions) ||
      !validCounter(checkpoint.optimizerSteps) ||
      (checkpoint.demonstrations !== undefined && !validCounter(checkpoint.demonstrations)) ||
      !isParameters(checkpoint.weights, -1e4) ||
      (optimizerRequired && (!isParameters(checkpoint.firstMoment, -1e4) || !isParameters(checkpoint.secondMoment, 0))))
    throw new TypeError("Incompatible or nonfinite Metro PPO checkpoint");
  return checkpoint;
}

export function freezePursuitPolicy(checkpoint) {
  const model = readCheckpoint(checkpoint, false);
  if (!model.updates || !model.transitions || !model.optimizerSteps)
    throw new TypeError("No learning updates are recorded in this Metro checkpoint");
  const weights = Float64Array.from(model.weights);
  const layout = layouts.get(model.observation);
  return Object.freeze({ algorithm: POLICY_ID, observation: model.observation, updates: model.updates, transitions: model.transitions,
    action: obs => actionFor(forward(layout, weights, obs).out) });
}

function accumulate({ INPUT, HIDDEN_BIAS, OUTPUT_WEIGHTS, OUTPUT_BIAS }, weights, grad, obs, hidden, derivatives) {
  const hiddenGrad = new Float64Array(HIDDEN);
  for (let head = 0; head < HEADS; head++) {
    const derivative = derivatives[head], offset = OUTPUT_WEIGHTS + head * HIDDEN;
    grad[OUTPUT_BIAS + head] += derivative;
    for (let h = 0; h < HIDDEN; h++) {
      grad[offset + h] += derivative * hidden[h];
      // The untrained value head must not rewrite a route-trained actor's features.
      if (head < ACTIONS || INPUT === DISPATCH_OBSERVATION_SCHEMA.length)
        hiddenGrad[h] += derivative * weights[offset + h];
    }
  }
  for (let h = 0; h < HIDDEN; h++) {
    const derivative = hiddenGrad[h] * (1 - hidden[h] ** 2), offset = h * INPUT;
    grad[HIDDEN_BIAS + h] += derivative;
    for (let j = 0; j < INPUT; j++) grad[offset + j] += derivative * obs[j];
  }
}

export class PursuitPpo {
  constructor(seed = "pursuit-development", checkpoint = null, observation = DISPATCH_OBSERVATION_SCHEMA.version) {
    const previous = checkpoint === null ? null : readCheckpoint(checkpoint, true);
    this.observation = previous?.observation ?? observation;
    this.layout = layouts.get(this.observation);
    if (!this.layout) throw new RangeError("Unknown Metro PPO observation version");
    const { INPUT, HIDDEN_BIAS, OUTPUT_WEIGHTS, OUTPUT_BIAS, PARAMETERS, schema } = this.layout;
    this.seed = previous ? previous.seed : String(seed);
    if (this.seed.length < 1 || this.seed.length > 200) throw new RangeError("Invalid training seed");
    const rng = new Random(this.seed);
    this.weights = previous ? Float64Array.from(previous.weights) : new Float64Array(PARAMETERS);
    if (!previous) {
      for (let i = 0; i < HIDDEN_BIAS; i++) {
        const scale = schema.navigation ?
          (i % INPUT >= schema.navigation.offset ? .75 : .0025) : Math.sqrt(3 / INPUT);
        this.weights[i] = rng.range(-1, 1) * scale;
      }
      for (let i = OUTPUT_WEIGHTS; i < OUTPUT_BIAS; i++) this.weights[i] = rng.range(-.025, .025);
      this.weights[OUTPUT_BIAS + 1] = .22; // Exploration prior; also applied to the untrained baseline.
    }
    this.firstMoment = new Float64Array(previous?.firstMoment ?? PARAMETERS);
    this.secondMoment = new Float64Array(previous?.secondMoment ?? PARAMETERS);
    this.updates = previous?.updates ?? 0;
    this.transitions = previous?.transitions ?? 0;
    this.optimizerSteps = previous?.optimizerSteps ?? 0;
    this.demonstrations = previous?.demonstrations ?? 0;
  }

  action(obs) { return actionFor(forward(this.layout, this.weights, obs).out); }
  value(obs) { return forward(this.layout, this.weights, obs).out[ACTIONS]; }

  sample(obs, rng) {
    const { out } = forward(this.layout, this.weights, obs), { std } = this.layout;
    const raw = std.map((variance, i) => out[i] + variance * normal(rng));
    return { raw, action: actionFor(raw), value: out[ACTIONS], logp: logProbability(out, raw, std) };
  }

  checkpoint() {
    return {
      schema: 1, algorithm: POLICY_ID, observation: this.observation, seed: this.seed,
      updates: this.updates, transitions: this.transitions, optimizerSteps: this.optimizerSteps,
      ...(this.demonstrations ? { demonstrations: this.demonstrations } : {}),
      weights: Array.from(this.weights), firstMoment: Array.from(this.firstMoment), secondMoment: Array.from(this.secondMoment),
    };
  }

  update(rollout, bootstrap = 0) {
    const { std, PARAMETERS } = this.layout;
    if (!rollout.length || !Number.isFinite(bootstrap) ||
        rollout.some(step => ![step.value, step.reward, step.logp].every(Number.isFinite) ||
          step.raw.length !== ACTIONS || !step.raw.every(Number.isFinite)))
      throw new TypeError("PPO needs a finite on-policy rollout");
    const gamma = .99, lambda = .95, epsilon = .2;
    let next = bootstrap, last = 0;
    const advantages = new Float64Array(rollout.length), targets = new Float64Array(rollout.length);
    for (let i = rollout.length - 1; i >= 0; i--) {
      const { reward, value, episodeBootstrap } = rollout[i];
      if (episodeBootstrap !== undefined) {
        if (!Number.isFinite(episodeBootstrap)) throw new TypeError("Invalid episode bootstrap");
        next = episodeBootstrap;
        last = 0;
      }
      last = reward + gamma * next - value + gamma * lambda * last;
      advantages[i] = last;
      targets[i] = value + last;
      next = value;
    }
    const mean = advantages.reduce((a, x) => a + x, 0) / advantages.length;
    const scale = Math.sqrt(advantages.reduce((v, x) => v + (x - mean) ** 2, 0) / advantages.length + 1e-8);
    for (let i = 0; i < advantages.length; i++) advantages[i] = (advantages[i] - mean) / scale;
    const rng = new Random(`${this.seed}:update:${this.updates}`);
    const order = Array.from(rollout.keys());
    let loss = 0, batches = 0;
    for (let epoch = 0; epoch < 4; epoch++) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (let start = 0; start < order.length; start += 32) {
        const grad = new Float64Array(PARAMETERS);
        const batch = order.slice(start, start + 32);
        for (const i of batch) {
          const { obs, raw, logp } = rollout[i];
          const { hidden, out } = forward(this.layout, this.weights, obs);
          const adv = advantages[i], ratio = Math.exp(Math.min(20, logProbability(out, raw, std) - logp));
          const clipped = Math.min(1 + epsilon, Math.max(1 - epsilon, ratio));
          const delta = ratio !== clipped && ratio * adv > clipped * adv ? 0 : -adv * ratio;
          const error = out[ACTIONS] - targets[i];
          loss += (-Math.min(adv * ratio, adv * clipped) + .25 * error * error) / batch.length;
          const derivatives = new Float64Array(HEADS);
          for (let head = 0; head < HEADS; head++) {
            derivatives[head] = (head === ACTIONS ? .5 * error :
              delta * (raw[head] - out[head]) / std[head] ** 2) / batch.length;
          }
          accumulate(this.layout, this.weights, grad, obs, hidden, derivatives);
        }
        this.applyAdam(grad, this.layout.schema.navigation ? .000025 : .0003);
        batches++;
      }
    }
    this.transitions += rollout.length;
    this.updates++;
    return { loss: loss / batches, transitions: rollout.length, optimizerSteps: this.optimizerSteps };
  }

  warmStart(demonstrations, epochs) {
    if (this.updates || this.demonstrations || !this.layout.schema.navigation || demonstrations.length < 60 ||
        !Number.isInteger(epochs) || epochs < 1 || epochs > 80)
      throw new RangeError("Warm start needs a new route model, demonstrations and 1-80 epochs");
    const inverse = x => Math.atanh(Math.max(-.96, Math.min(.96, x)));
    const samples = demonstrations.map(({ obs, action }) => {
      validatePursuitAction(action);
      return { obs, target: [inverse(action.steer), inverse(action.brake > 0 ? 0 : action.throttle * action.gear),
        action.brake > 0 ? .35 + inverse(action.brake) : -.12] };
    });
    const rng = new Random(`${this.seed}:warm-start`), order = Array.from(samples.keys());
    const losses = [];
    for (let epoch = 0; epoch < epochs; epoch++) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      let loss = 0;
      for (let start = 0; start < order.length; start += 32) {
        const grad = new Float64Array(this.layout.PARAMETERS), batch = order.slice(start, start + 32);
        for (const index of batch) {
          const { obs, target } = samples[index], { hidden, out } = forward(this.layout, this.weights, obs);
          const derivatives = new Float64Array(HEADS);
          for (let head = 0; head < ACTIONS; head++) {
            const error = out[head] - target[head];
            const importance = head === 0 ? 4 : 1;
            loss += importance * error ** 2;
            derivatives[head] = importance * error / batch.length;
          }
          accumulate(this.layout, this.weights, grad, obs, hidden, derivatives);
        }
        this.applyAdam(grad, .001);
      }
      losses.push(loss / order.length);
    }
    this.demonstrations = samples.length;
    return losses;
  }

  applyAdam(grad, rate = .0003) {
    const { PARAMETERS } = this.layout;
    const norm = Math.sqrt(grad.reduce((sum, x) => sum + x * x, 0));
    if (!Number.isFinite(norm)) throw new Error("Nonfinite PPO gradient");
    const scale = Math.min(1, .5 / Math.max(1e-9, norm)), t = ++this.optimizerSteps;
    const mBias = 1 - .9 ** t, vBias = 1 - .999 ** t;
    for (let i = 0; i < PARAMETERS; i++) {
      const x = grad[i] * scale;
      const m = this.firstMoment[i] = .9 * this.firstMoment[i] + .1 * x;
      const v = this.secondMoment[i] = .999 * this.secondMoment[i] + .001 * x * x;
      this.weights[i] -= rate * (m / mBias) / (Math.sqrt(v / vBias) + 1e-8);
    }
  }
}
