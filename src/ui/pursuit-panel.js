const PHASES = {
  ready: "Ready",
  running: "In pursuit",
  escaped: "Escaped",
  captured: "Captured",
  crashed: "Crashed",
  busted: "Busted",
  wrecked: "Wrecked",
  timeout: "Time expired",
  stopped: "Ended",
};
const RESPONSE_STAGES = { contact: "In contact", search: "Searching", clearing: "Clearing" };
const DISPATCH_STAGES = {
  ZONE_TRACKED: "Zone tracked", VISUALLY_SPOTTED: "Spotted", LAST_KNOWN: "Last known",
  SEARCHING: "Searching", COOLING_DOWN: "Losing stars", LOST: "Signal lost", ESCAPED: "Escaped",
};
const POWERS = { giant: "Giant", ghost: "Ghost", mine: "Mine", pulse: "Pulse" };
const IMPACT_CAUSES = {
  "police-touch": "Patrol contact", "police-wreck": "Hit a patrol wreck",
  "street-obstacle": "Hit a street obstacle", "traffic-contact": "Traffic contact",
};

const EVENT_NAMES = {
  closure: "Road closed",
  roadblock: "Roadblock",
  congestion: "Traffic queue",
  reopen: "Road reopened",
  reinforcement: "Backup joined",
  near: "Near miss",
  impact: "Contact",
};

const GUARD_STATES = {
  clear: "No intervention",
  "road-boundary": "Road boundary",
  contact: "Contact stopped movement",
};

const finite = Number.isFinite;
const NO_CASES = Object.freeze([]);
const score = new Intl.NumberFormat("en", { maximumFractionDigits: 1, signDisplay: "exceptZero" });
const words = (value) => typeof value === "string" && value.trim()
  ? value.trim().replaceAll("-", " ").slice(0, 80) : "";
const sentence = (value) => {
  const text = words(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const count = (value) => Number.isInteger(value) && value >= 0 ? String(value) : "—";
const pct = (value) => Math.round(value * 100);
const boundedPercent = (value) => pct(Math.max(0, Math.min(1, value)));

function formatStarDropS(value) {
  if (!finite(value)) return "";
  const clamped = Math.max(0, value);
  return Number.isInteger(clamped) ? String(clamped) : clamped.toFixed(1);
}

function formatEscapeGoal(escapeGoal) {
  const label = typeof escapeGoal?.label === "string" ? escapeGoal.label.trim() : "";
  if (!label) return "";
  const rawDistance = finite(escapeGoal.distanceM) ? escapeGoal.distanceM : escapeGoal.remainingM;
  const distanceText = finite(rawDistance) && rawDistance >= 0
    ? `${Math.round(rawDistance)} m`
    : "";
  return distanceText
    ? `Escape sector: ${label} · ${distanceText}`
    : `Escape sector: ${label}`;
}

function isCoolingDownState(running, response) {
  if (!running || !response) return false;
  const dispatch = response.dispatch;
  return Boolean(
    dispatch?.coolingDown === true ||
    dispatch?.state === "COOLING_DOWN" ||
    response.stage === "clearing",
  );
}

function dispatchEscapeGuidance(response, coolingDown) {
  const dispatch = response?.dispatch;
  if (!dispatch) return "";
  if (coolingDown) {
    const coverText = dispatch.hiddenInCover === true ? "Hidden in cover" : "Out of sight";
    const dropS = formatStarDropS(dispatch.nextStarDropS);
    if (dropS) return `${coverText} · -1★ in ${dropS}s`;
    if (finite(response.clearProgress)) return `${coverText} · Escape progress: ${boundedPercent(response.clearProgress)}%`;
    return `${coverText} · Losing stars`;
  }
  const unitsInContact = response?.unitsInContact ?? (dispatch.state === "VISUALLY_SPOTTED" ? 1 : 0);
  if (unitsInContact === 0 && (dispatch.state === "SEARCHING" || dispatch.state === "LAST_KNOWN")) {
    const minDist = finite(dispatch.minEscapeDistanceM) ? dispatch.minEscapeDistanceM : 95;
    return `Out of sight · Need >${minDist} m or alley cover`;
  }
  return "";
}

function responseNote(stage, response) {
  const dispatch = response?.dispatch;
  const cooling = Boolean(dispatch?.coolingDown === true || dispatch?.state === "COOLING_DOWN" || stage === "clearing");
  const guidance = dispatchEscapeGuidance(response, cooling);
  if (guidance) return guidance;
  if (dispatch?.state === "ZONE_TRACKED") return "Dispatch shares your position inside the surveillance zone.";
  if (dispatch?.state === "LOST" && !response.clearProgress) return "Signal lost. Put more distance between you and the patrols.";
  if (stage === "contact" || dispatch?.state === "VISUALLY_SPOTTED") {
    if (response?.unitsInContact === 1) return "One patrol has you in sight.";
    if (response?.unitsInContact > 1) return `${response.unitsInContact} patrols have you in sight.`;
    return "Patrols responding.";
  }
  if (stage === "search") return "Patrols have lost sight of you.";
  if (stage === "clearing" && finite(response?.clearProgress))
    return `Escape progress: ${boundedPercent(response.clearProgress)}%`;
  return "";
}

function appliedAction(action) {
  if (![action?.steer, action?.throttle, action?.brake].every(finite) ||
      (action.gear !== 1 && action.gear !== -1)) return "";
  const steer = pct(action.steer);
  const signed = steer < 0 ? `−${Math.abs(steer)}` : steer > 0 ? `+${steer}` : "0";
  return `${action.gear < 0 ? "Reverse" : "Forward"} gear · Throttle ${pct(action.throttle)}% · Brake ${pct(action.brake)}% · Steer ${signed}%`;
}

function describeEvent(event) {
  if (!event?.kind) return "";
  const label = Object.hasOwn(EVENT_NAMES, event.kind) ? EVENT_NAMES[event.kind] : sentence(event.kind);
  return [label, words(event.actorId)]
    .filter(Boolean).join(" · ");
}

function describeImpact(impact) {
  if (!impact) return "";
  return [sentence(impact.side), words(impact.actorId),
    finite(impact.closingSpeedMps) ? `${impact.closingSpeedMps.toFixed(1)} m/s closing` : "",
    finite(impact.severity) ? `severity ${pct(impact.severity)}%` : "",
  ].filter(Boolean).join(" · ");
}

function describeDecision(decision) {
  const source = decision?.source === "learned-tactical" ? "Learned ranking"
    : decision?.source === "escape-search" ? "Checked reverse and turn"
    : decision?.source === "checked-prefix" ? "Short checked movement"
    : decision?.source === "rollout" ? "Rollout" : "";
  const noPass = decision?.availableActions?.length === 0;
  return [sentence(decision?.name ?? decision?.maneuver ?? decision?.reason),
    noPass ? "No checked maneuver passed" : source,
  ].filter(Boolean).join(" · ");
}

function packNotice(metrics, terminal) {
  const cause = metrics?.terminalCause;
  const police = metrics?.policeContacts > 0 || cause === "police-contact";
  const person = metrics?.pedestrianCollisions > 0 || metrics?.pedestrianStatus === "impact" ||
    cause === "pedestrian-contact" || cause === "pedestrian-impact";
  if (police && person) return ["impact", terminal ? "Police and pedestrian contact · Run ended" : "Police and pedestrian contact"];
  if (person) return ["impact", terminal ? "Pedestrian contact · Run ended" : "Pedestrian contact"];
  if (police) return ["impact", terminal ? "Police contact · One touch ended the chase" : "Police contact"];
  if (metrics?.pedestrianStatus === "yielding") return ["yielding", "Yielding to pedestrian"];
  if (metrics?.pedestrianStatus === "clear") return ["clear", "Crossing clear"];
  return ["", ""];
}

function packDriverText(state, running, paused) {
  const { driver, learning } = state;
  if (driver === "training") {
    const note = running && (paused || state.mode === "manual") ? "Training on hold" : "Training";
    return finite(learning?.updates) ? `${note} · ${learning.updates} updates` : note;
  }
  if (driver === "lab-policy") return "Lab policy · Frozen weights";
  if (driver === "starter") return "Starter policy";
  if (driver === "local-policy") return "Saved City policy";
  return driver === "planner" && state.phase !== "ready" ? "Planner" : "";
}

function pakoActiveLearningText(state, driver, terrain, escapeGuidance = "") {
  const prefix = state.pakoAvailable ? "Verified PPO" : state.customCheckpoint ? "PPO test" : "RL PPO";
  const reason = driver.lastDecision?.planner?.reason;
  const maneuver = driver.lastDecision?.planner?.maneuver;
  const submitted = driver.lastDecision?.submitted;
  const detail = driver.cameraBrake
    ? "Camera forecast: braking for person"
    : reason === "PREDICTIVE_REVERSE_ESCAPE" || submitted?.gear === -1
      ? "Reversing & turning out"
      : driver.shieldReason && submitted?.brake === 1
        ? `Range safety yield: ${driver.shieldReason}`
        : maneuver === "alley-shortcut"
          ? "Cutting through alley"
          : terrain?.active || reason === "PREDICTIVE_CURB_BYPASS"
            ? "Climbing clear curb to evade"
            : ["PREDICTIVE_EVADE_LANE", "PREDICTIVE_RECOVERY", "PREDICTIVE_QUEUE"].includes(reason)
              ? "Changing path around obstacle"
              : driver.shieldReason
                ? `Range safety yield: ${driver.shieldReason}`
                : escapeGuidance || "Escaping police · I takes over";
  return `${prefix} · ${detail}`;
}

export function mountPursuitPanel({ container, onRun, onRestart, onLevel, onCase, onStyle, onCheckpoint, onUse, onSound,
  onExportTrace, onOpenLab, onEvasion, onCurbSupport, onDriverMode, onCameraStyle }) {
  if (!container?.ownerDocument || ![onRun, onRestart, onLevel].every((fn) => typeof fn === "function"))
    throw new TypeError("Pursuit controls need a container and action callbacks.");
  const doc = container.ownerDocument;
  const node = (tag, id, label) => {
    const element = doc.createElement(tag);
    if (id) element.id = id;
    if (label !== undefined) element.textContent = label;
    return element;
  };
  const text = (element, value) => {
    if (element.textContent !== value) element.textContent = value;
  };

  const panel = node("section", "pursuitPanel");
  panel.className = "pursuit-panel";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", "pursuitTitle");
  const header = node("header");
  const titles = node("div");
  const title = node("h2", "pursuitTitle", "Pursuit");
  const scene = node("p", "pursuitScene");
  titles.append(title, scene);
  const phase = node("p", "pursuitPhase");
  phase.className = "pursuit-phase";
  phase.setAttribute("role", "status");
  header.append(titles, phase);

  const heat = node("div", "pursuitHeat");
  heat.className = "pursuit-heat";
  heat.hidden = true;
  const stars = node("span", "pursuitWanted");
  stars.setAttribute("role", "img");
  stars.dataset.cooling = "false";
  const starNodes = Array.from({ length: 5 }, () => {
    const item = node("span");
    item.className = "pursuit-star pursuit-star--empty";
    item.setAttribute("aria-hidden", "true");
    item.textContent = "\u2606";
    return item;
  });
  stars.append(...starNodes);
  function renderWantedStars(wanted, cooling) {
    const activeCooling = Boolean(cooling && wanted > 0);
    stars.dataset.cooling = activeCooling ? "true" : "false";
    for (let i = 0; i < 5; i++) {
      const item = starNodes[i];
      if (i < wanted) {
        const nextClass = activeCooling && i === wanted - 1
          ? "pursuit-star pursuit-star--cooling"
          : "pursuit-star pursuit-star--active";
        if (item.className !== nextClass) item.className = nextClass;
        text(item, "\u2605");
      } else {
        const nextClass = "pursuit-star pursuit-star--empty";
        if (item.className !== nextClass) item.className = nextClass;
        text(item, "\u2606");
      }
    }
    const ownText = Object.getOwnPropertyDescriptor(stars, "textContent");
    if (ownText && "value" in ownText) {
      stars.textContent = "\u2605".repeat(wanted) + "\u2606".repeat(5 - wanted);
    }
    const status = `Wanted level ${wanted} of 5`;
    if (stars.getAttribute("aria-label") !== status) stars.setAttribute("aria-label", status);
  }
  const units = node("span", "pursuitUnitCount");
  heat.append(stars, units);

  const situation = node("div", "pursuitSituation");
  situation.className = "pursuit-situation";
  situation.hidden = true;
  const currentReadings = node("dl");
  const proximityLabel = node("dt", "", "Nearest patrol");
  const proximity = node("dd", "pursuitProximity");
  const speed = node("dd", "pursuitActualSpeed");
  const healthLabel = node("dt", "", "Vehicle health"), health = node("dd", "pursuitHealth");
  healthLabel.hidden = health.hidden = true;
  currentReadings.append(proximityLabel, proximity, node("dt", "", "Speed"), speed, healthLabel, health);
  situation.append(currentReadings);

  const controls = node("div");
  controls.className = "pursuit-controls";
  const styleLabel = node("label", "", "Chase style");
  styleLabel.className = "pursuit-style";
  const style = node("select", "pursuitStyle");
  for (const [value, label] of [["survival", "Arcade chase"], ["hunt", "Tactical / training"],
    ["gta", "GTA Chase"], ["dispatch", "Metro Dispatch"], ["dispatch-ppo", "Metro Dispatch · PPO"]]) {
    const option = node("option", "", label);
    option.value = value;
    style.append(option);
  }
  styleLabel.append(style);
  const modelField = node("label", "", "PPO checkpoint");
  modelField.className = "pursuit-style";
  const modelFile = node("input", "pursuitCheckpoint");
  modelFile.type = "file";
  modelFile.accept = ".json,application/json";
  const modelStatus = node("span", "pursuitCheckpointStatus");
  modelStatus.setAttribute("role", "status");
  modelFile.setAttribute("aria-describedby", modelStatus.id);
  modelField.append(modelFile, modelStatus);
  modelField.hidden = true;
  modelFile.addEventListener("change", async () => {
    modelFile.disabled = true;
    try {
      if (await onCheckpoint?.(modelFile.files[0])) selectModel.open = false;
    }
    finally { modelFile.disabled = false; }
  });
  const caseField = node("div");
  caseField.className = "pursuit-pack-case";
  caseField.hidden = true;
  const caseLabel = node("label", "", "Scenario");
  const caseSelect = node("select", "packCase");
  const caseDescription = node("p", "packCaseDescription");
  caseSelect.setAttribute("aria-describedby", caseDescription.id);
  caseLabel.append(caseSelect);
  caseField.append(caseLabel, caseDescription);
  const levelLabel = node("label", "", "Difficulty");
  const level = node("select", "pursuitLevel");
  for (let i = 1; i <= 5; i++) {
    const option = node("option", "", `Level ${i}`);
    option.value = String(i);
    if (i === 5) option.textContent = "5 · Max";
    level.append(option);
  }
  const fifthLevel = level.lastElementChild;
  fifthLevel.hidden = fifthLevel.disabled = true;
  levelLabel.append(level);
  const run = node("button", "pursuitRunBtn", "Run pursuit");
  const restart = node("button", "pursuitRestartBtn", "Restart");
  run.type = restart.type = "button";
  const evasionChoice = node("label", "", "Predictive recovery (experimental)");
  evasionChoice.className = "pursuit-style pursuit-evasion-choice";
  const evasionToggle = node("input", "pursuitEvasion");
  evasionToggle.type = "checkbox";
  evasionToggle.addEventListener("change", () => onEvasion?.(evasionToggle.checked));
  evasionChoice.prepend(evasionToggle);
  const curbChoice = node("label", "", "Manual curb pilot · Tahrir Boulevard");
  curbChoice.className = "pursuit-style pursuit-evasion-choice";
  const curbToggle = node("input", "pursuitCurbSupport");
  curbToggle.type = "checkbox";
  curbToggle.addEventListener("change", () => onCurbSupport?.(curbToggle.checked));
  curbChoice.prepend(curbToggle);
  const driverToggle = node("div", "pakoDriverToggle");
  driverToggle.className = "pursuit-driver-toggle";
  driverToggle.setAttribute("role", "group");
  driverToggle.setAttribute("aria-label", "Chase driver");
  driverToggle.hidden = true;
  const driverRl = node("button", "pakoDriverRl", "RL AI");
  const driverManual = node("button", "pakoDriverManual", "Manual");
  driverRl.type = driverManual.type = "button";
  driverToggle.append(driverRl, driverManual);
  controls.append(caseField, styleLabel, modelField, evasionChoice, curbChoice, driverToggle, levelLabel, run, restart);
  const workflows = node("div", "pakoWorkflows");
  workflows.className = "pursuit-controls";
  const trainAndTest = node("button", "pako-training", "Train & test");
  trainAndTest.type = "button";
  trainAndTest.addEventListener("click", () => onOpenLab?.("training"));
  const selectModel = node("details", "pakoCheckpointChoice");
  selectModel.append(node("summary", "", "Load PPO checkpoint"));
  workflows.append(trainAndTest, selectModel);

  const arcade = node("div", "pursuitArcade");
  arcade.className = "pursuit-arcade";
  const clocks = node("dl");
  const time = node("dd", "pursuitTime"), best = node("dd", "pursuitBest");
  clocks.append(node("dt", "", "Time"), time, node("dt", "", "Best"), best);
  const power = node("div", "pursuitPower"), powerLabel = node("span", "pursuitPowerLabel");
  const fire = node("button", "pursuitFire", "Use");
  fire.type = "button";
  power.append(powerLabel, fire);
  const sound = node("button", "pursuitSound", "Sound on"), soundNote = node("p", "pursuitSoundNote");
  sound.type = "button";
  sound.setAttribute("aria-label", "Mute pursuit audio");
  const camStyleBtn = node("button", "pursuitCamStyleBtn", "Behind car");
  camStyleBtn.type = "button";
  camStyleBtn.hidden = true;
  camStyleBtn.addEventListener("click", () => {
    const next = latest?.chaseCameraStyle === "chasing" ? "follow" : "chasing";
    onCameraStyle?.(next);
  });
  soundNote.setAttribute("role", "status");
  arcade.append(clocks, power, sound, camStyleBtn, soundNote);
  const practice = node("label");
  practice.className = "pursuit-practice";
  const learn = node("input", "pursuitLearn");
  learn.type = "checkbox";
  const practiceLabel = node("span", "", "Learn from this chase");
  practice.append(learn, practiceLabel);
  practice.hidden = true;
  const policy = node("label");
  policy.className = "pursuit-practice pursuit-pack-policy";
  const useLabPolicy = node("input", "packUseLabPolicy");
  useLabPolicy.type = "checkbox";
  const policyLabel = node("span");
  policy.append(useLabPolicy, policyLabel);
  policy.hidden = true;
  const learning = node("p", "pursuitLearning");
  learning.className = "pursuit-practice-status";
  learning.hidden = true;
  const feedback = node("p", "packFeedback");
  feedback.className = "pursuit-pack-feedback";
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-atomic", "true");
  feedback.hidden = true;
  const reward = node("p", "packReward");
  reward.className = "pursuit-pack-reward";
  reward.hidden = true;

  const readings = node("dl");
  readings.className = "pursuit-readings";
  function reading(id, label) {
    const term = node("dt", "", label);
    const value = node("dd", `pursuit${id}`);
    readings.append(term, value);
    return (valueText) => {
      term.hidden = value.hidden = !valueText;
      text(value, valueText);
    };
  }
  const showAction = reading("Action", "Applied");
  const showPlanner = reading("Decision", "Planner");
  const showPatrol = reading("Patrols", "Patrols");
  const showThreats = reading("Threats", "Threats");
  const showRoute = reading("Route", "Route");
  const showGuard = reading("Guard", "Guard");
  const showSupport = reading("Support", "Curb");
  const showEvent = reading("Event", "Last event");
  const showImpact = reading("Impact", "Impact");
  const showPressure = reading("Pressure", "Pressure");
  const showZone = reading("Zones", "Surveillance");

  const danger = node("dl", "pursuitDanger");
  danger.className = "pursuit-danger";
  danger.setAttribute("aria-label", "Pursuit danger counts");
  const counts = [
    ["nearCollisions", "NearMisses", "Near misses"],
    ["collisions", "Contacts", "Contacts"],
    ["pedestrianCollisions", "PedestrianHits", "Pedestrian hits"],
  ].map(([key, id, label]) => {
    const cell = node("div");
    const value = node("dd", `pursuit${id}`, "—");
    cell.append(node("dt", "", label), value);
    danger.append(cell);
    return [key, value];
  });
  const progress = node("p", "pursuitProgress");
  progress.className = "pursuit-progress";
  const error = node("p", "pursuitError");
  error.className = "pursuit-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const telemetry = node("div");
  telemetry.className = "pursuit-telemetry";
  telemetry.append(readings, danger, progress);
  const diagnostics = node("details", "pursuitDiagnostics");
  diagnostics.hidden = true;
  const traceReason = node("p", "pursuitDecisionTrace");
  const exportTrace = node("button", "pursuitExportTrace", "Save decision trace");
  exportTrace.type = "button";
  exportTrace.addEventListener("click", () => onExportTrace?.());
  diagnostics.append(node("summary", "", "Chase diagnostics"), traceReason, exportTrace);
  panel.append(header, heat, situation, feedback, reward, arcade, controls, workflows, practice, policy,
    learning, telemetry, diagnostics, error);
  container.append(panel);

  let latest = null;
  let pending = null;
  let closed = false;
  let compact = false;
  let shownCases = NO_CASES;
  let choiceScope = "";

  function disabled() {
    const street = latest?.street === true || latest?.pako === true;
    const running = latest?.phase === "running";
    const busy = Boolean(pending) || !latest;
    const curbLocksStop = Boolean(
      (latest?.gta?.curbSupport?.active === true && latest.gta.curbSupport.version !== "metro-city-curbs-v2") ||
      latest?.terrain?.active === true,
    );
    run.disabled = busy || (street ? running || (latest.pack === true && latest.review === true) : latest.phase !== "ready");
    if (!latest?.pako && latest?.cityPursuitStyle === "dispatch-ppo" && !latest.checkpointReady) run.disabled = true;
    restart.disabled = busy || (street && !running) || curbLocksStop;
    level.disabled = busy || (street && running);
    style.disabled = busy || running || latest?.review === true;
    learn.disabled = busy || running;
    caseSelect.disabled = busy || running || caseField.hidden;
    useLabPolicy.disabled = busy || running || policy.hidden || latest.labPolicyAvailable !== true;
    fire.disabled = busy || !running || latest?.paused || !latest?.survival?.held;
    driverRl.disabled = !latest?.checkpointReady || Boolean(pending);
    driverManual.disabled = Boolean(pending);
    if (pending) controls.setAttribute("aria-busy", "true");
    else controls.removeAttribute("aria-busy");
  }

  function renderCases(cases, caseId) {
    if (cases !== shownCases) {
      if (cases.length !== shownCases.length || cases.some((item, i) =>
        item.id !== shownCases[i].id || item.label !== shownCases[i].label)) {
        caseSelect.replaceChildren(...cases.map(({ id, label }) => {
          const option = node("option", "", label);
          option.value = id;
          return option;
        }));
      }
      shownCases = cases;
    }
    if (!pending && caseSelect.value !== caseId) caseSelect.value = caseId;
    const description = cases.find(({ id }) => id === caseSelect.value)?.description ?? "";
    text(caseDescription, description);
    caseDescription.hidden = !description;
  }

  function renderPackResult(state, running, paused) {
    const terminal = !running && state.phase !== "ready";
    const [kind, message] = packNotice(state.metrics, terminal);
    feedback.dataset.kind = kind;
    text(feedback, message);
    feedback.hidden = !message;
    const lastReward = state.learning?.lastReward;
    const penalty = state.metrics?.penalty;
    const result = [
      finite(lastReward) ? `Reward ${score.format(lastReward)}` : "",
      finite(penalty) && penalty !== 0 ? `Penalty ${score.format(-Math.abs(penalty))}` : "",
    ].filter(Boolean).join(" · ");
    text(reward, result);
    reward.hidden = !result;
    const driver = packDriverText(state, running, paused);
    text(learning, driver);
    learning.hidden = !driver;
  }

  function renderDiagnostics(state) {
    const { metrics, decision, events, response } = state;
    const active = state.phase !== "ready";
    const applied = active ? appliedAction(state.action) : "";
    showAction(state.street && active && finite(state.appliedCommand?.targetSpeed)
      ? `${(state.appliedSpeedMps ?? state.appliedCommand.targetSpeed).toFixed(1)} m/s target${
          state.appliedSource ? ` · ${sentence(state.appliedSource)}` : ""}`
      : applied);
    showPlanner(active ? describeDecision(decision) : "");
    const patrol = state.patrolStatus;
    showPatrol(patrol && finite(patrol.nearestM)
      ? `${patrol.active}${finite(patrol.target) ? `/${patrol.target}` : ""} on scene · ${Math.round(patrol.nearestM)} m nearest` : "");
    showThreats(active && Array.isArray(decision?.threatSectors)
      ? decision.threatSectors.map(sentence).filter(Boolean).join(" · ") || "None detected" : "");
    showRoute(active && decision?.routeId != null
      ? sentence(state.street ? decision.routeId.replace(/^metro-exit-/, "") : decision.routeId) : "");
    const guard = metrics?.guard;
    showGuard(applied ? (Object.hasOwn(GUARD_STATES, guard) ? GUARD_STATES[guard] : sentence(guard)) : "");
    showSupport(active && finite(metrics?.supportHeightM) && metrics.supportHeightM > 0
      ? `${metrics.supportHeightM.toFixed(2)} m above road` : "");
    showEvent(describeEvent(events?.at(-1)));
    showImpact(describeImpact(metrics?.impact));
    showPressure(compact && finite(response?.pressure) ? `${boundedPercent(response.pressure)}%` : "");
    showZone(response?.dispatch
      ? response.dispatch.zoneIds.map(sentence).join(" · ") || "Outside coverage" : "");
    for (const [key, value] of counts) text(value, count(metrics?.[key]));
    text(progress, [
      finite(metrics?.survivalS) ? `${metrics.survivalS.toFixed(1)} s` : "",
      finite(metrics?.distanceM) ? `${metrics.distanceM.toFixed(1)} m driven` : "",
    ].filter(Boolean).join(" · "));
    progress.hidden = !progress.textContent;
  }

  function update(state = null) {
    if (closed) return;
    if (!state || !Object.hasOwn(PHASES, state.phase)) {
      latest = null;
      pending = null;
      panel.hidden = true;
      panel.dataset.cooling = "false";
      stars.dataset.cooling = "false";
      diagnostics.open = false;
      error.hidden = true;
      disabled();
      return;
    }
    if (latest && state.level !== latest.level) error.hidden = true;
    latest = state;
    const cinematic = state.cinematic === true, running = state.phase === "running";
    const pack = state.pack === true, packLab = pack && state.packLab === true;
    const patrol = state.patrolStatus;
    const noPatrolDrill = packLab && patrol?.active === 0;
    const arcadeSelected = state.cityPursuitStyle === "survival", survival = state.survival;
    const pako = state.pako === true;
    const rlMode = state.pakoDriverMode ? state.pakoDriverMode === "rl" : Boolean(state.checkpointReady);
    const showArcade = !pako && state.street && (running ? Boolean(survival) : arcadeSelected);
    const frozenSelected = state.street && state.cityPursuitStyle === "dispatch-ppo";
    const hasLiveDispatch = running && Boolean(state.response?.dispatch);
    const showDispatch = pako || hasLiveDispatch || (state.street && !running &&
      (state.cityPursuitStyle === "dispatch" || frozenSelected));
    const showGta = pako || hasLiveDispatch || (state.street && (running ? state.variant === "gta" : state.cityPursuitStyle === "gta" || showDispatch));
    const collapsed = cinematic || pack || pako || hasLiveDispatch;
    const cases = packLab && Array.isArray(state.cases) ? state.cases : NO_CASES;
    const scope = packLab ? "pack-lab" : pack && state.street ? "pack-city" : "legacy";
    if (choiceScope !== scope) {
      choiceScope = scope;
      learn.checked = useLabPolicy.checked = false;
    }
    const paused = running && state.paused === true;
    const coolingDown = isCoolingDownState(running, state.response);
    const escapeGuidance = running ? dispatchEscapeGuidance(state.response, coolingDown) : "";
    const escapeGoalText = running && (pako || showDispatch) ? formatEscapeGoal(state.escapeGoal) : "";
    const stage = (cinematic || hasLiveDispatch) && running && !noPatrolDrill && Object.hasOwn(RESPONSE_STAGES, state.response?.stage)
      ? state.response.stage : "";
    const dispatchStage = running && showDispatch
      ? coolingDown
        ? state.response?.dispatch?.hiddenInCover === true
          ? "Hidden · Losing stars"
          : DISPATCH_STAGES.COOLING_DOWN
        : DISPATCH_STAGES[state.response?.dispatch?.state] ?? ""
      : "";
    if (compact !== collapsed) {
      compact = collapsed;
      panel.classList.toggle("pursuit-panel--cinematic", compact);
      if (compact) diagnostics.append(telemetry);
      else diagnostics.before(telemetry);
    }
    panel.hidden = false;
    panel.classList.toggle("pursuit-panel--pack", pack);
    panel.classList.toggle("pursuit-panel--city-arcade", showArcade);
    panel.classList.toggle("pursuit-panel--dispatch", showDispatch);
    panel.classList.toggle("pursuit-panel--simple", pako);
    panel.dataset.phase = paused ? "paused" : state.phase;
    panel.dataset.response = paused ? "" : stage;
    panel.dataset.cooling = coolingDown ? "true" : "false";
    const pakoResult = { busted: "Captured", wrecked: "Crashed", timeout: "Timed out" };
    text(title, pako ? "Chase" : packLab ? "Pursuit Lab" : showArcade ? "Arcade pursuit"
      : showDispatch ? "Metro Dispatch" : showGta ? "GTA Chase" : "Pursuit");
    text(phase, survival?.review ? "Impact replay" : paused ? "Paused" : running && noPatrolDrill ? "In progress"
      : pako && !running && pakoResult[state.phase] ? pakoResult[state.phase]
        : dispatchStage || (stage ? RESPONSE_STAGES[stage] : PHASES[state.phase]));
    text(scene, packLab
      ? running ? cases.find(({ id }) => id === state.caseId)?.label ?? "" : ""
      : pako
      ? running ? [escapeGuidance, escapeGoalText].filter(Boolean).join(" · ")
        : rlMode && state.checkpointReady
          ? state.customCheckpoint === true && !state.pakoAvailable
            ? `PPO test · Development checkpoint (${state.ppoSummary || "custom weights"}), not release-verified.`
            : `RL PPO drives (${state.ppoSummary || "ε = 0.20 · Curb & path evasion"}).`
          : "You drive · Switch to RL AI or load a PPO checkpoint."
      : frozenSelected && !running && ["ready", "stopped"].includes(state.phase)
        ? "Experimental. Runs a frozen model; escape and civilian safety are not validated."
      : showDispatch && !running && ["ready", "stopped"].includes(state.phase)
        ? "Manual chase. Lose shared surveillance and separate from the patrols to escape."
      : showGta && !running && state.variant !== "gta" ? "On these streets. Starts in manual mode."
      : cinematic || hasLiveDispatch
      ? running ? [responseNote(stage, state.response), escapeGoalText].filter(Boolean).join(" · ")
        : state.phase === "ready" ? (showArcade ? "On these streets. Starts self-driving." : "On the city streets")
          : state.phase === "escaped" ? "You lost the patrols." : ""
      : state.street ? state.dispatchWaves ? "Live City · Patrols reinforce" : "On the city streets"
        : state.caseId === "ambient" ? "Seeded streets" : sentence(state.caseId));
    scene.hidden = !scene.textContent;
    const terrain = state.gta?.curbSupport ?? state.terrain;
    const cityCurbs = terrain?.version === "metro-city-curbs-v2";
    if (terrain?.active && (!cityCurbs || terrain.pendingOutcome)) {
      text(scene, terrain.pendingOutcome
        ? `${PHASES[terrain.pendingOutcome]} · Return to pavement to finish.`
        : "Surveyed curb · Return to pavement before ending the chase.");
      scene.hidden = false;
    }
    driverToggle.hidden = !pako || running;
    driverRl.setAttribute("aria-pressed", String(rlMode));
    driverManual.setAttribute("aria-pressed", String(!rlMode));
    const liveSummary = collapsed && running;
    const wanted = Math.max(0, Math.min(5, Math.floor(state.wantedLevel || 0)));
    renderWantedStars(wanted, coolingDown);
    heat.hidden = !liveSummary || noPatrolDrill || (!wanted && !((pack || pako) && finite(patrol?.active)));
    if (!heat.hidden) {
      stars.hidden = !wanted;
      const sectors = Array.isArray(patrol?.sectors) ? patrol.sectors.length : patrol?.sectors;
      const patrolCount = finite(patrol?.active)
        ? `${patrol.active} ${patrol.active === 1 ? "patrol" : "patrols"}`
        : "";
      text(units, (pako || showDispatch) && !pack && patrolCount && finite(patrol?.nearestM) && patrol.nearestM >= 0
        ? `${patrolCount} · ${Math.round(patrol.nearestM)} m`
        : [
            patrolCount,
            pack && Number.isInteger(sectors) && sectors > 0 && sectors <= 4 ? `${sectors}/4 sides` : "",
          ].filter(Boolean).join(" · "));
    }
    caseField.hidden = !packLab || running || !cases.length || typeof onCase !== "function";
    if (!caseField.hidden) renderCases(cases, state.caseId);
    practice.hidden = showGta || showArcade || running || (pack ? packLab ? state.phase !== "ready" : !state.street : !state.arcade);
    text(practiceLabel, packLab ? "Train on this drill" : "Learn from this chase");
    policy.hidden = showArcade || !(pack && state.street && !running);
    if (!policy.hidden) {
      text(policyLabel, state.labPolicyAvailable === true ? "Use Lab policy" : "Use Lab policy (no Lab weights yet)");
      if (!state.labPolicyAvailable) useLabPolicy.checked = false;
    }
    if (pack) renderPackResult(state, running, paused);
    else {
      feedback.hidden = reward.hidden = true;
      learning.hidden = !state.learning;
      if (!learning.hidden) text(learning,
        `RL practice${running && (paused || state.mode === "manual") ? " on hold" : ""} \u00b7 ${state.learning.updates} updates`);
    }
    if (showArcade) {
      const penalty = state.metrics?.penalty;
      reward.hidden = running || survival?.review === true || !penalty;
      if (!reward.hidden) text(reward, `Penalty ${score.format(-Math.abs(penalty))}`);
      if (survival?.impact && Object.hasOwn(IMPACT_CAUSES, survival.impact)) {
        text(feedback, `${IMPACT_CAUSES[survival.impact]} · Run ended`);
        feedback.dataset.kind = "impact";
        feedback.hidden = false;
      }
      if (!feedback.hidden && survival?.review) feedback.hidden = true;
      if (running) {
        text(learning, state.mode === "manual"
          ? "Auto throttle · Steer with A / D · Space brakes"
          : "Self-driving · I takes manual control");
        learning.hidden = false;
      } else {
        text(learning, "R retries on this street");
        learning.hidden = !survival || survival.review === true;
      }
    }
    if (showGta && running) {
      learning.hidden = false;
      const driver = state.frozenDriver;
      text(learning, driver?.status === "active" && pako
        ? pakoActiveLearningText(state, driver, terrain, escapeGuidance)
        : driver?.status === "active" ? `Frozen PPO · ${driver.policy.algorithm} · ${driver.sha256.slice(0, 12)}${driver.shieldReason ? ` · Brake guard: ${driver.shieldReason}` : ""}${escapeGuidance ? ` · ${escapeGuidance}` : ""} · I takes over`
        : driver?.status === "waiting-for-scan" ? "Braking · Waiting for a fresh scan · I takes over"
        : driver?.status === "fault" ? `PPO stopped: ${driver.error} · I takes over`
        : driver?.status === "manual" ? (escapeGuidance ? `Manual takeover · ${escapeGuidance}` : "Manual takeover · W / S throttle · A / D steer · Space brakes")
        : state.mode === "manual" ? (pako ? (escapeGuidance ? `You're driving · ${escapeGuidance}` : "You're driving") : (escapeGuidance || "W / S throttle · A / D steer · Space brakes"))
          : showDispatch ? (escapeGuidance ? `Scripted planner · ${escapeGuidance}` : "Scripted planner · I takes manual control") : "Self-driving · I takes manual control");
    }
    arcade.hidden = !showArcade && (!pako || state.phase === "ready");
    if (showArcade || pako) {
      const playerBest = pako ? state.pakoBestS : state.bestSurvivalS;
      const currentTime = pako ? state.metrics?.survivalS : survival ? state.metrics.survivalS : 0;
      text(time, finite(currentTime) ? `${currentTime.toFixed(1)} s` : "—");
      text(best, pako ? String(state.metrics?.collisions ?? 0) : finite(playerBest) ? `${playerBest.toFixed(1)} s` : "—");
      text(best.previousElementSibling, pako ? "Contacts" : "Best");
      const active = survival?.active, held = survival?.held;
      power.hidden = !running || pako;
      power.dataset.kind = active?.kind ?? held ?? "";
      text(powerLabel, active ? `${POWERS[active.kind]} · ${active.timeLeftS.toFixed(1)} s`
        : held ? `${POWERS[held]} ready` : "Collect a power-up");
      fire.hidden = !held;
      text(fire, held ? `Use ${POWERS[held]} (E)` : "Use");
      sound.hidden = !running || pako;
      text(sound, state.soundMuted ? "Sound off" : "Sound on");
      sound.setAttribute("aria-pressed", String(Boolean(state.soundMuted)));
      camStyleBtn.hidden = !pako || !running;
      const isChasingCam = state.chaseCameraStyle === "chasing";
      text(camStyleBtn, isChasingCam ? "Cam: Chasing" : "Cam: Behind car");
      camStyleBtn.setAttribute("aria-pressed", String(isChasingCam));
      text(soundNote, state.soundError ?? "");
    }
    situation.hidden = !liveSummary || pako;
    proximityLabel.hidden = proximity.hidden = noPatrolDrill;
    healthLabel.hidden = health.hidden = !showGta || !state.gta;
    if (!health.hidden) text(health, `${Math.ceil(state.gta.playerHealth)} / ${state.gta.playerMaxHealth}`);
    if (liveSummary) {
      const nearest = patrol?.nearestM;
      text(proximity, finite(nearest) && nearest >= 0 ? `${Math.round(nearest)} m` : showArcade ? "None" : "Not available");
      text(speed, finite(state.speedMps) ? `${Math.round(Math.abs(state.speedMps) * 3.6)} km/h` : "Not available");
    }
    text(run, pako ? (["busted", "wrecked", "timeout", "escaped"].includes(state.phase) ? "Run again" : "Start chase")
      : state.street ? (showArcade && survival && state.phase !== "ready" ? "Run again" : "Start pursuit")
      : packLab ? "Run drill" : "Run pursuit");
    text(restart, terrain?.active && !cityCurbs ? "Return to pavement first" : pako ? "End chase" : state.street ? "End pursuit" : packLab ? "Restart drill" : "Restart");
    levelLabel.hidden = liveSummary || survival?.review === true;
    styleLabel.hidden = pako || !state.cityPursuitStyle || running || state.review === true;
    const modelParent = pako ? selectModel : controls;
    if (modelField.parentElement !== modelParent) {
      if (pako) selectModel.append(modelField);
      else controls.insertBefore(modelField, evasionChoice);
    }
    modelField.hidden = (!pako && !frozenSelected) || running;
    evasionChoice.hidden = pako || !frozenSelected || running;
    curbChoice.hidden = pako || state.cityPursuitStyle !== "dispatch" || running;
    workflows.hidden = !pako || running;
    text(modelStatus, state.checkpointStatus || "Select a compatible JSON checkpoint.");
    if (state.cityPursuitStyle && style.value !== state.cityPursuitStyle) style.value = state.cityPursuitStyle;
    run.hidden = liveSummary || (packLab && state.phase !== "ready");
    restart.hidden = packLab ? state.phase === "ready" : collapsed && !running;
    fifthLevel.hidden = fifthLevel.disabled = !showGta;
    if (!pending && Number.isInteger(state.level) && state.level >= 1 && state.level <= (showGta ? 5 : 4) &&
        level.value !== String(state.level)) level.value = String(state.level);
    const lastDecision = state.trace?.latest;
    diagnostics.hidden = pako || (!liveSummary && !state.trace?.size);
    if (diagnostics.hidden) diagnostics.open = false;
    exportTrace.hidden = traceReason.hidden = !state.trace?.size;
    if (lastDecision && diagnostics.open) {
      const reason = lastDecision.stopReason ?? lastDecision.planner?.reason;
      text(traceReason, `Tick ${lastDecision.endTick} · ${reason?.replaceAll("_", " ").toLowerCase() ?? "movement accepted"}`);
    }
    if (!collapsed || (!diagnostics.hidden && diagnostics.open)) renderDiagnostics(state);
    disabled();
  }

  async function perform(control, callback, ...args) {
    if (closed || control.disabled || panel.hidden) return;
    error.hidden = true;
    const request = pending = {};
    disabled();
    try {
      const result = await callback(...args);
      if (result === false || result?.ok === false) throw new Error(result?.error);
    } catch (failure) {
      if (!closed && pending === request) {
        text(error, failure?.message || "Pursuit controls could not apply that change. Try again.");
        error.hidden = false;
      }
    } finally {
      if (pending === request) {
        pending = null;
        if (!closed) update(latest);
      }
    }
  }
  const runClick = () => {
    const imported = !policy.hidden && !useLabPolicy.disabled && useLabPolicy.checked;
    return perform(run, onRun, !imported && !practice.hidden && learn.checked, imported);
  };
  const restartClick = () => perform(restart, onRestart);
  const levelChange = () => {
    const requested = Number(level.value);
    if (Number.isInteger(requested) && requested >= 1 && requested <= (fifthLevel.disabled ? 4 : 5))
      perform(level, onLevel, requested);
  };
  const caseChange = () => {
    if (shownCases.some(({ id }) => id === caseSelect.value)) return perform(caseSelect, onCase, caseSelect.value);
    update(latest);
  };
  const learnChange = () => {
    if (learn.checked && !policy.hidden) useLabPolicy.checked = false;
  };
  const policyChange = () => {
    if (useLabPolicy.checked) learn.checked = false;
  };
  const diagnosticsToggle = () => {
    if (diagnostics.open && !diagnostics.hidden && latest) renderDiagnostics(latest);
  };
  const driverRlClick = () => {
    if (!closed && !driverRl.disabled && !panel.hidden) onDriverMode?.("rl");
  };
  const driverManualClick = () => {
    if (!closed && !driverManual.disabled && !panel.hidden) onDriverMode?.("manual");
  };
  run.addEventListener("click", runClick);
  restart.addEventListener("click", restartClick);
  level.addEventListener("change", levelChange);
  style.addEventListener("change", () => onStyle?.(style.value));
  fire.addEventListener("click", () => onUse?.());
  sound.addEventListener("click", () => onSound?.());
  caseSelect.addEventListener("change", caseChange);
  learn.addEventListener("change", learnChange);
  useLabPolicy.addEventListener("change", policyChange);
  diagnostics.addEventListener("toggle", diagnosticsToggle);
  driverRl.addEventListener("click", driverRlClick);
  driverManual.addEventListener("click", driverManualClick);
  disabled();

  function close() {
    if (closed) return;
    closed = true;
    run.removeEventListener("click", runClick);
    restart.removeEventListener("click", restartClick);
    level.removeEventListener("change", levelChange);
    caseSelect.removeEventListener("change", caseChange);
    learn.removeEventListener("change", learnChange);
    useLabPolicy.removeEventListener("change", policyChange);
    diagnostics.removeEventListener("toggle", diagnosticsToggle);
    driverRl.removeEventListener("click", driverRlClick);
    driverManual.removeEventListener("click", driverManualClick);
    panel.remove();
    latest = pending = null;
  }

  return { update, close };
}
