(() => {
  // frontend/comparison-v2.js
  var comparisonV2Busy = (state) => ["QUEUED", "RESETTING", "RUNNING", "STOPPING"].includes(state?.phase);
  function comparisonStartBlocked(provider2) {
    if (provider2.isReplay) return "Replay is read only.";
    if (!provider2.fresh) return "Connect CARLA to start a journey.";
    if (provider2.restarting) return "Wait for the simulator restart.";
    if (provider2.controlMode === "EMERGENCY_STOP") return "Acknowledge the emergency stop first.";
    if (!provider2.comparisonV2) return "This backend does not provide the RULE journey.";
    if (comparisonV2Busy(provider2.comparisonV2) || comparisonV2Busy(provider2.comparisonDemo)) return "A recorded run is active. Stop it before starting another.";
    if (provider2.trafficPreparation && !["IDLE", "READY"].includes(provider2.trafficPreparation.status)) return "Finish traffic preparation first.";
    const budget = provider2.comparisonV2.budget;
    if (!Number.isFinite(budget?.remaining_s) || !Number.isFinite(budget?.recommended_run_allowance_s)) return "Restart the dashboard backend to verify the experiment allowance.";
    if (budget.remaining_s < budget.recommended_run_allowance_s) return `Experiment budget: ${budget.remaining_s.toFixed(1)} s remain; a journey needs a ${budget.recommended_run_allowance_s.toFixed(0)} s allowance. Review saved results.`;
    return "";
  }
  function installComparisonV2(provider2, stopManual) {
    const legacy = document.querySelector(".comparison-demo");
    const box = document.createElement("section");
    box.className = "comparison-v2";
    box.setAttribute("aria-labelledby", "journeyControlsTitle");
    box.innerHTML = '<h3 id="journeyControlsTitle">Recorded journey</h3><div class="comparison-actions"><button id="ruleDrivingBtn" class="primary">Rules driving</button><button id="modelDrivingBtn" aria-label="YA RAB OSTORHA Model \xB7 experimental">Model <span>experimental</span></button><button id="comparisonV2StopBtn">Stop journey</button></div><p id="comparisonV2Status" role="status"></p><p id="comparisonV2Results" class="muted"></p><button id="journeyResultsBtn">Review recorded journey</button>';
    document.querySelector(".drive-actions").after(box);
    const details = document.createElement("details");
    details.innerHTML = "<summary>Historical safety comparison</summary>";
    legacy.before(details);
    details.append(legacy);
    let pending2 = null;
    for (const [id, side] of [["ruleDrivingBtn", "RULE"], ["modelDrivingBtn", "MODEL"]]) {
      document.getElementById(id).onclick = () => {
        if (pending2 || comparisonStartBlocked(provider2) || side === "MODEL" && !provider2.comparisonV2?.model_available) return;
        stopManual();
        if (provider2.dashboardAction("comparison_v2", { operation: "RUN", side })) {
          pending2 = { sequence: provider2.sequence, session: provider2.sessionId, side };
          update();
          showWorkspace("drive");
        }
      };
    }
    document.getElementById("comparisonV2StopBtn").onclick = () => provider2.stopDriving("comparison_v2_stop");
    document.getElementById("journeyResultsBtn").onclick = () => document.getElementById("resultsTab").click();
    function update() {
      const state = provider2.comparisonV2, busy = comparisonV2Busy(state);
      if (pending2 && (provider2.operationError || pending2.session !== provider2.sessionId || !provider2.fresh || busy || !provider2.pending.has(pending2.sequence))) pending2 = null;
      const reason = pending2 ? "Starting recorded journey\u2026" : comparisonStartBlocked(provider2);
      for (const id of ["ruleDrivingBtn", "modelDrivingBtn"]) {
        document.getElementById(id).disabled = !!reason;
        document.getElementById(id).title = reason;
      }
      document.getElementById("modelDrivingBtn").disabled ||= !state?.model_available;
      if (!state?.model_available) document.getElementById("modelDrivingBtn").title = state?.budget?.scope === "NATIVE_RULE_VALIDATION" ? "This separately authorized validation session permits RULE only. MODEL remains experimental." : "Experimental model weights are unavailable.";
      document.getElementById("comparisonV2StopBtn").disabled = !(busy || pending2) || !provider2.controller || !provider2.fresh || provider2.restarting;
      const pair = state?.pair_id ? ` \xB7 saved pair ${state.pair_id.slice(0, 8)} \xB7 seed ${state.seed}` : "";
      const validation = state?.budget?.scope === "NATIVE_RULE_VALIDATION" ? ` Separate RULE validation \xB7 ${Math.ceil(state.budget.remaining_s)} s remain.` : "";
      document.getElementById("comparisonV2Status").textContent = provider2.operationError || state?.error || reason || `RULE is the default. MODEL is experimental.${pair}${validation}`;
      const latest = state?.latest_attempt;
      document.getElementById("comparisonV2Results").textContent = busy ? `${state.side || "Journey"} \xB7 ${state.phase}${pair} \xB7 automatic recording` : latest ? `Latest attempt \xB7 ${latest.side} \xB7 ${latest.status}${latest.reason ? " \xB7 " + latest.reason : ""}. Saved measurements are in Results.` : "RULE uses measured-motion prediction. Each journey records automatically. MODEL acceptance remains unproven.";
      const results = state || provider2.recordedComparisonV2;
      document.getElementById("journeyResultsBtn").disabled = !Object.keys(results?.results || {}).length && !results?.latest_attempt;
      if (busy || pending2) for (const id of ["demoWithoutBtn", "demoWithBtn", "demoStopBtn", "startDrivingBtn", "startJourneyBtn", "phoneJourneyBtn", "driveJourneyBtn", "journeySpeed", "safetyEnabled", "safetyController", "prepareTrafficBtn"]) {
        const element = document.getElementById(id);
        if (element) {
          element.disabled = true;
          element.title = "Stop the recorded journey first.";
        }
      }
    }
    return { update };
  }

  // frontend/workspace-state.js
  var comparisonBusy = (demo) => ["RESETTING", "RUNNING", "STOPPING"].includes(demo?.phase);
  function driveState(p, state, armed = false) {
    const demo = p.comparisonDemo, journeyRun = p.comparisonV2, safety = p.safetySystem;
    let label = "Ready", tone = "neutral", action = "startDrivingBtn", actionLabel = "Start manual drive";
    if (p.isReplay) {
      label = "Recorded replay";
      action = "replayPauseBtn";
      actionLabel = p.replay?.paused ? "Resume replay" : "Pause replay";
    } else if (p.simulationStarting || p.restarting) {
      label = p.simulationStarting ? "Starting the simulation" : "Restarting simulator";
      action = null;
      actionLabel = label + "\u2026";
    } else if (!p.fresh) {
      label = p.phase === "ERROR" ? "Connection error" : "Disconnected";
      tone = "warning";
      action = "startSimulationBtn";
      actionLabel = "Start the simulation";
    } else if (p.controlMode === "EMERGENCY_STOP") {
      label = "Emergency stopped";
      tone = "danger";
      action = "acknowledgeStopBtn";
      actionLabel = "Acknowledge emergency stop";
    } else if (safety?.enabled && (safety.status?.includes("FAULT") || safety.status === "UNAVAILABLE")) {
      label = "Safety sensor fault";
      tone = "danger";
      action = "sensorBtn";
      actionLabel = "Review sensor status";
    } else if (demo?.error || journeyRun?.error || p.operationError || p.journey?.status === "ERROR") {
      label = "Action failed";
      tone = "danger";
      action = "settingsBtn";
      actionLabel = "Review settings";
    } else if (p.manualStartPending || demo?.phase === "RESETTING" || ["QUEUED", "RESETTING"].includes(journeyRun?.phase) || p.journey?.status === "STARTING") {
      label = "Starting drive";
      action = comparisonV2Busy(journeyRun) ? "pauseBtn" : null;
      actionLabel = action ? "Stop drive" : "Starting\u2026";
    } else if (demo?.phase === "STOPPING" || journeyRun?.phase === "STOPPING" || p.controlMode === "PAUSED" && Math.abs(state.speedKmh ?? 0) > 0.54) {
      label = "Stopping vehicle";
      tone = "warning";
      action = null;
      actionLabel = "Stopping\u2026";
    } else if (safety?.active) {
      label = "Safety intervention";
      tone = "danger";
      action = "pauseBtn";
      actionLabel = "Stop drive";
    } else if (demo?.phase === "RUNNING" || p.controlMode === "AUTOMATIC" || p.controlMode === "MANUAL" && armed) {
      label = "Driving";
      tone = "success";
      action = "pauseBtn";
      actionLabel = "Stop drive";
    } else if (journeyRun?.phase === "FINISHED" && journeyRun.latest_attempt) {
      const status = journeyRun.latest_attempt.status;
      label = { ARRIVED: "Journey arrived", COLLISION: "Drive ended \xB7 collision", TIMEOUT: "Journey timed out", FAILURE: "Journey failed", INTERRUPTED: "Journey interrupted" }[status] || "Journey ended";
      tone = status === "ARRIVED" ? "success" : ["COLLISION", "FAILURE"].includes(status) ? "danger" : "warning";
      action = "resultsTab";
      actionLabel = "Review journey results";
    } else if (demo?.phase === "FINISHED" || p.journey?.status === "ARRIVED") {
      label = demo?.latest_outcome === "COLLISION" ? "Drive ended \xB7 collision" : demo?.latest_outcome === "INTERRUPTED" ? "Comparison interrupted" : demo?.latest_outcome === "INCOMPLETE" ? "Run incomplete" : "Drive completed";
      tone = demo?.latest_outcome === "COLLISION" ? "danger" : ["INTERRUPTED", "INCOMPLETE"].includes(demo?.latest_outcome) ? "warning" : "success";
      action = "resultsTab";
      actionLabel = "Review results";
    } else if (p.journey?.reason && p.journey.reason !== "fresh_native_session") label = p.journey.reason === "focus_lost" ? "Stopped \xB7 focus lost" : "Drive stopped";
    if (p.fresh && !p.isReplay && !p.controller && !p.simulationStarting) {
      action = "ownershipBtn";
      actionLabel = "Take vehicle control";
    } else if (action === "startDrivingBtn" && p.route && !p.route.arrived) {
      action = "driveJourneyBtn";
      actionLabel = p.journey?.status === "PAUSED" ? "Resume destination drive" : "Start destination drive";
    }
    if (action === "startDrivingBtn" && journeyRun) {
      const saved = Object.keys(journeyRun.results || {}).length || journeyRun.latest_attempt;
      action = comparisonStartBlocked(p) && saved ? "journeyResultsBtn" : "ruleDrivingBtn";
      actionLabel = action === "journeyResultsBtn" ? "Review recorded RULE journey" : "Rules driving";
    }
    const mode = p.isReplay ? "Replay \xB7 read only" : !p.fresh ? "Unavailable" : p.controlMode === "AUTOMATIC" ? "Autonomous" : p.controlMode === "MANUAL" && armed ? "Manual \xB7 keyboard" : "Vehicle held";
    let safetyLabel = "Waiting for sensors", safetyTone = "neutral", risk = "Not assessed";
    if (p.isReplay) safetyLabel = "Recorded safety data";
    else if (p.fresh && safety) {
      if (safety.status === "STANDARD_DRIVER") {
        safetyLabel = safety.actual_generator === "SENSOR_BASELINE" ? "Sensor-guided route" : "CARLA standard";
        safetyTone = "neutral";
      } else if (!safety.enabled) {
        safetyLabel = "Safety disabled";
        safetyTone = "danger";
      } else if (safety.status?.startsWith("SUSPENDED")) {
        safetyLabel = "Safety suspended";
        safetyTone = "warning";
      } else if (safety.status?.includes("FAULT") || safety.status === "UNAVAILABLE") {
        safetyLabel = "Sensor fault";
        safetyTone = "danger";
      } else if (safety.active) {
        safetyLabel = "Intervening";
        safetyTone = "danger";
      } else if (safety.status === "STANDBY") safetyLabel = "Standby";
      else {
        safetyLabel = "Monitoring";
        safetyTone = "success";
      }
      const names = { UNKNOWN: "Not assessed", LOW: "Low", CLEAR: "No active risk", NONE: "No active risk", MEDIUM: "Elevated", HIGH: "High", CRITICAL: "Critical" };
      risk = !safety.enabled && safety.status !== "STANDARD_DRIVER" ? "Detection disabled" : names[safety.risk] ?? safety.risk ?? "Not assessed";
      if (["MEDIUM", "HIGH", "CRITICAL"].includes(safety.risk)) safetyTone = safety.risk === "MEDIUM" ? "warning" : "danger";
    }
    return {
      label,
      tone,
      mode,
      action,
      actionLabel,
      safetyLabel,
      safetyTone,
      risk,
      reason: p.fresh && safety ? safety.reason || "No intervention reported" : "Connect the simulator to assess risk.",
      interventions: p.fresh ? safety?.intervention_count ?? null : null
    };
  }
  function selectedComparison(demo) {
    const current = Object.keys(demo?.results || {}).length > 0;
    const comparison = current ? demo : demo?.archived_comparison;
    return { comparison, archived: !current && !!comparison, scope: current ? "Recorded results \xB7 this comparison" : "Archived comparison \xB7 saved recording" };
  }
  function collisionOutcome(result) {
    if (!result) return { label: "Run not recorded", tone: "neutral", symbol: "\u2014" };
    if (result.collision === true || result.outcome?.metrics?.collision_count > 0) return { label: "Collision detected", tone: "danger", symbol: "!" };
    if (result.collision === false || result.outcome?.metrics?.collision_count === 0) return { label: result.completed ? "No collision recorded" : "No collision \xB7 incomplete run", tone: result.completed ? "success" : "warning", symbol: result.completed ? "\u2713" : "!" };
    return { label: "Collision data unavailable", tone: "neutral", symbol: "\u2014" };
  }
  function detectionFreshness(result, telemetry, delta) {
    const frames = Number.isFinite(telemetry?.frame) && Number.isFinite(result.frame_id) ? telemetry.frame - result.frame_id : null;
    const seconds = Number.isFinite(telemetry?.timestamp) && Number.isFinite(result.timestamp_s) ? telemetry.timestamp - result.timestamp_s : frames !== null && Number.isFinite(delta) ? frames * delta : null;
    if (frames === null || seconds === null || frames < 0 || seconds < 0) return { tone: "warning", label: "Frame alignment unavailable", frames, seconds: null };
    return { tone: seconds >= 0.5 ? "warning" : "neutral", label: seconds >= 0.5 ? "Delayed detection" : "Detection age", frames, seconds };
  }

  // frontend/results-view.js
  var $ = (id) => document.getElementById(id);
  var number = (value, suffix = "", digits = 1) => Number.isFinite(value) ? value.toFixed(digits) + suffix : "Not measured";
  var node = (tag, cls, text) => {
    const el2 = document.createElement(tag);
    if (cls) el2.className = cls;
    if (text !== void 0) el2.textContent = text;
    return el2;
  };
  var modes = ["WITHOUT", "WITH"];
  var modeLabel = (mode) => mode === "WITH" ? "With safety \xB7 RULE" : "Without safety";
  function renderJourneyResults(state, connected) {
    const box = $("journeyResults");
    box.replaceChildren();
    box.append(node("h2", null, "Recorded destination journey"), node(
      "p",
      "muted",
      (connected ? "Saved measurements" : "Last received saved measurements \xB7 connection unavailable") + (state?.pair_id ? " \xB7 pair " + state.pair_id.slice(0, 8) + " \xB7 seed " + state.seed : "")
    ));
    if (state?.latest_attempt) {
      const latest = state.latest_attempt;
      box.append(node("p", "latest-journey-attempt", `Latest attempt \xB7 ${latest.side || "Unknown side"} \xB7 ${latest.status || "Not measured"} \xB7 ${latest.reason || "Reason unavailable"}`));
    }
    const results = state?.results || {};
    if (!Object.keys(results).length) box.append(node("p", "muted", "No completed destination journey received. Interrupted attempts do not establish arrival."));
    for (const side of ["RULE", "MODEL"]) {
      const result = results[side];
      if (!result) continue;
      const section = node("section", "journey-result");
      section.dataset.side = side;
      section.append(node("h3", null, side === "RULE" ? "RULE \xB7 saved terminal run" : "MODEL \xB7 experimental saved run"));
      const status = node("p", "state-value", result.status || "Status unavailable");
      status.dataset.tone = result.status === "ARRIVED" ? "success" : result.collision || result.status === "FAILURE" ? "danger" : "warning";
      section.append(status);
      section.append(node("p", null, "Destination reached and stopped: " + (result.destination_arrived === true ? "Yes \xB7 native arrival check" : result.destination_arrived === false ? "No" : "Not measured")));
      const m = result.metrics || {}, out = result.outcome_metrics || result.outcome?.metrics || {};
      const table = node("table", "comparison-table"), body = node("tbody");
      table.append(node("caption", "sr-only", side + " recorded journey measurements"));
      for (const [label, value, suffix, digits] of [
        ["Collision episodes", out.collision_count ?? (result.collision === false ? 0 : null), "", 0],
        ["Recorded duration", out.elapsed_simulation_s ?? m.duration_s, " s", 2],
        ["Route progress", out.progress_m, " m", 2],
        ["Distance traveled", out.distance_traveled_m, " m", 2],
        ["Minimum clearance", out.minimum_clearance_m, " m", 2],
        ["Harsh braking events", m.harsh_braking_events, "", 0],
        ["Emergency intervention", m.emergency_intervention_s, " s", 2],
        ["Waiting proxy", m.unnecessary_waiting_s, " s", 2]
      ]) {
        const row = node("tr"), th = node("th", null, label);
        th.scope = "row";
        row.append(th, node("td", null, number(value, suffix, digits)));
        body.append(row);
      }
      table.append(body);
      section.append(table, node("p", "recording-path", result.recording || "Recording reference unavailable"));
      box.append(section);
    }
    box.append(node("p", "muted", "Waiting is a controller proxy, not all stopped time or a measured unnecessary-delay total. Collision-free arrival does not establish a safe clearance margin. MODEL acceptance and general safety remain unproven."));
  }
  function renderComparison(demo) {
    const { comparison, archived, scope } = selectedComparison(demo), results = comparison?.results || {}, box = $("demoResults");
    box.replaceChildren();
    $("resultScope").textContent = scope;
    if (!Object.keys(results).length) {
      const empty = node("div", "results-empty");
      empty.append(node("h3", null, "No recorded comparison yet"), node("p", "muted", "Run both comparison modes to review collision outcomes, progress and clearance."));
      const button = node("button", "primary", "Configure a comparison");
      button.onclick = () => $("comparisonSetupBtn").click();
      empty.append(button);
      box.append(empty);
    } else {
      const outcomes = node("section", "collision-outcomes");
      outcomes.setAttribute("aria-label", "Recorded collision outcomes");
      for (const mode of modes) {
        const outcome = collisionOutcome(results[mode]), column = node("div", "collision-outcome");
        column.dataset.tone = outcome.tone;
        column.append(node("span", "eyebrow", modeLabel(mode)), node("span", "outcome-symbol", outcome.symbol), node("h3", null, outcome.label), node("p", "muted", results[mode] ? results[mode].completed ? "Full recorded run" : "Interrupted recording \xB7 result is partial" : "Complete this mode to compare"));
        outcomes.append(column);
      }
      box.append(outcomes);
      const clearance = results.WITH?.outcome?.metrics?.minimum_clearance_m;
      if (Number.isFinite(clearance)) {
        const notice = node("p", "clearance-context");
        notice.dataset.tone = clearance < 1 ? "warning" : "neutral";
        notice.textContent = (clearance < 1 ? "\u26A0 Close approach" : "Minimum clearance") + " \xB7 " + number(clearance, " m", 2) + ". Collision outcome and obstacle clearance are separate measurements. A collision-free run does not establish a safe margin.";
        box.append(notice);
      }
      const analysis = node("div", "comparison-analysis"), chart = node("section", "progress-comparison");
      chart.append(node("h3", null, "Progress along the route"), node("p", "muted", "Projected distance along the planned route."));
      const progress = modes.map((mode) => results[mode]?.outcome?.metrics?.progress_m), maximum = Math.max(1, ...progress.filter(Number.isFinite));
      modes.forEach((mode, index) => {
        const row = node("div", "comparison-bar-row"), header2 = node("div", "bar-label");
        header2.append(node("span", null, modeLabel(mode)), node("strong", null, number(progress[index], " m")));
        const track = node("div", "comparison-bar-track"), fill = node("div", "comparison-bar");
        fill.dataset.mode = mode;
        fill.style.width = Number.isFinite(progress[index]) ? Math.max(0, progress[index]) / maximum * 100 + "%" : "0%";
        track.append(fill);
        row.append(header2, track);
        chart.append(row);
      });
      if (progress.every(Number.isFinite) && comparison.initial_conditions_match && modes.every((mode) => results[mode]?.completed)) chart.append(node("p", "progress-delta", number(progress[1] - progress[0], " m") + " change in progress with safety"));
      if (!comparison.initial_conditions_match) chart.append(node("p", "muted", "Starting conditions are not verified as matching. Treat these as separate observations."));
      analysis.append(chart);
      const metrics = node("section", "measured-metrics");
      metrics.append(node("h3", null, "Recorded measurements"));
      const table = node("table", "comparison-table");
      table.append(node("caption", "sr-only", scope + "; saved measurements, not live telemetry"));
      const head = node("thead"), header = node("tr");
      ["Measurement", "Without safety", "With RULE"].forEach((label) => {
        const th = node("th", null, label);
        th.scope = "col";
        header.append(th);
      });
      head.append(header);
      table.append(head);
      const body = node("tbody"), fields = [["Distance traveled", "distance_traveled_m", " m"], ["Minimum clearance", "minimum_clearance_m", " m"], ["Safety interventions", "safety_intervention_count", "", 0], ["Duration", "elapsed_simulation_s", " s"], ["Route completion", "route_completion", "%", 0]];
      for (const [label, key, suffix, digits] of fields) {
        const row = node("tr"), th = node("th", null, label);
        th.scope = "row";
        row.append(th);
        for (const mode of modes) {
          let value = results[mode]?.outcome?.metrics?.[key];
          if (key === "route_completion" && Number.isFinite(value)) value *= 100;
          row.append(node("td", null, number(value, suffix, digits ?? 1)));
        }
        body.append(row);
      }
      table.append(body);
      metrics.append(table);
      analysis.append(metrics);
      box.append(analysis);
      const definitions = node("details", "metric-definitions");
      definitions.append(node("summary", null, "What these measurements mean"));
      const list = node("dl");
      for (const [term, description] of [["Progress", "Distance projected along the planned route; differs from total vehicle movement."], ["Distance traveled", "Total measured vehicle movement during the recording."], ["Minimum clearance", "Smallest gap between planar vehicle and obstacle bounding boxes; not a certified safety margin."], ["Safety interventions", "Reported intervention episodes. RULE applies braking; steering is unavailable in the current rule controller."], ["Not measured", "The recording did not provide this value. It is not zero."]]) list.append(node("dt", null, term), node("dd", null, description));
      definitions.append(list);
      box.append(definitions);
      const evidence = node("details", "technical-evidence");
      evidence.append(node("summary", null, "Technical evidence & recording references"));
      evidence.append(node("p", null, (archived ? "Archived" : "Current comparison") + " \xB7 " + (comparison.scenario_id || "Scenario unavailable") + " \xB7 seed " + (comparison.seed ?? "\u2014")), node("p", null, "Matching starting conditions: " + (comparison.initial_conditions_match ? "Verified" : "Not verified")));
      if (comparison.native_pose_audit) evidence.append(node("pre", null, JSON.stringify(comparison.native_pose_audit, null, 2)));
      modes.forEach((mode) => {
        if (results[mode]) evidence.append(node("p", "recording-path", modeLabel(mode) + ": " + results[mode].recording));
      });
      evidence.append(node("p", "muted", "Per-frame intervention traces are saved in telemetry/comparison-controls.jsonl beside each recording. Archived event playback is not provided by this dashboard API."));
      box.append(evidence);
    }
    $("recordingArchive").replaceChildren(...(demo?.archive || []).slice().reverse().map((item) => {
      const row = node("details", "archive-row");
      row.append(node("summary", null, modeLabel(item.mode) + " \xB7 " + String(item.status).replaceAll("_", " ").toLowerCase()), node("p", null, item.scenario_id + " \xB7 seed " + (item.seed ?? "\u2014")), node("p", "muted", "Progress " + number(item.metrics?.progress_m, " m") + " \xB7 " + number(item.metrics?.elapsed_simulation_s, " s")), node("p", "recording-path", item.recording));
      return row;
    }));
    if (!(demo?.archive || []).length) $("recordingArchive").append(node("p", "muted", "No archived recordings."));
  }

  // frontend/presentation-ui.js
  var $2 = (id) => document.getElementById(id);
  var setText = (id, value) => {
    if ($2(id).textContent !== value) $2(id).textContent = value;
  };
  var activePhase = "drive";
  var lastResults = null;
  var historySession = null;
  var lastSafety = null;
  var newDriveRequested = false;
  var history = [];
  function showWorkspace(phase, { focus = false } = {}) {
    if (phase === "setup") {
      const dialog = $2("advancedSetupDialog");
      if (dialog) {
        $2("setupPhase").hidden = false;
        dialog.showModal();
        document.dispatchEvent(new CustomEvent("advancedsetupopen"));
        return;
      }
    }
    if (!["drive", "results"].includes(phase)) return;
    if ($2("advancedSetupDialog")?.open) $2("advancedSetupDialog").close();
    activePhase = phase;
    for (const other of ["drive", "results", "setup"]) {
      $2(other + "Phase").hidden = other !== phase;
      $2(other + "Tab").setAttribute("aria-selected", String(other === phase));
      $2(other + "Tab").tabIndex = other === phase ? 0 : -1;
    }
    document.body.dataset.workspace = phase;
    document.dispatchEvent(new CustomEvent("workspacechange", { detail: { phase } }));
    window.scrollTo({ top: 0, behavior: "auto" });
    if (focus) $2(phase + "Tab").focus();
  }
  function presentationUI(provider2) {
    const inspector = $2("simulationCenter"), old = document.createElement("div");
    while (inspector.firstChild) old.append(inspector.firstChild);
    old.querySelector("#safetyStatus").remove();
    const nav = document.createElement("nav");
    nav.className = "workspace-tabs";
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-label", "Workspaces");
    nav.title = "Destination journeys continue across workspaces. Manual keyboard driving stops when leaving Driving.";
    nav.innerHTML = '<button role="tab" id="driveTab" aria-controls="drivePhase" aria-selected="true">Driving</button><button role="tab" id="resultsTab" aria-controls="resultsPhase" aria-selected="false" tabindex="-1">Results</button><button role="tab" id="setupTab" aria-controls="setupPhase" aria-selected="false" tabindex="-1">Setup</button>';
    $2("brand").after(nav);
    $2("setupTab").hidden = true;
    const ownership = document.createElement("button");
    ownership.id = "ownershipBtn";
    ownership.textContent = "Take control";
    ownership.onclick = () => provider2.takeControl();
    document.querySelector(".connection").after(ownership);
    const emergency = old.querySelector("#emergencyStopBtn");
    emergency.innerHTML = '<span aria-hidden="true">\u25A0</span> Emergency stop';
    document.querySelector(".app-header").append(emergency);
    document.querySelector("#brand .eyebrow").textContent = "Driving safety lab";
    const heading = document.querySelector(".workspace-heading");
    heading.innerHTML = '<div><span id="sessionScope" class="eyebrow">CURRENT SESSION</span><h2 id="workspaceTitle">Driving workspace</h2></div><div class="workspace-tools"></div>';
    heading.querySelector(".workspace-tools").append($2("toolbar"));
    $2("sensorBtn").lastChild.textContent = "Diagnostics";
    const strip = document.createElement("section");
    strip.className = "controller-strip";
    strip.setAttribute("aria-label", "Current session status");
    strip.innerHTML = '<div><span class="eyebrow">Drive state</span><span id="driveState" class="state-value" role="status">Disconnected</span></div><div><span class="eyebrow">Driving mode</span><strong id="currentDrivingMode">Unavailable</strong></div><div><span class="eyebrow">Safety system</span><strong id="currentSafetyState">Waiting for sensors</strong></div><div title="Reported by the live controller; resets when driving stops. Recorded totals appear in Results."><span class="eyebrow">Live safety counter</span><strong id="liveInterventions">\u2014 interventions</strong></div>';
    heading.after(strip);
    const drive = document.createElement("section");
    drive.id = "drivePhase";
    drive.className = "driving-layout";
    drive.setAttribute("role", "tabpanel");
    drive.setAttribute("aria-labelledby", "driveTab");
    drive.append(document.querySelector(".visual-workspace"), inspector);
    strip.after(drive);
    inspector.innerHTML = `<section class="safety-monitor" aria-labelledby="safetyMonitorTitle"><div class="section-heading"><h2 id="safetyMonitorTitle"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7ZM8 12l3 3 5-6"/></svg> Safety monitor</h2><span class="session-label">CURRENT SESSION</span></div><p id="safetyStatus" class="safety-readout" role="status">Waiting for sensors</p><div class="safety-risk"><span>Risk level</span><strong id="safetyRisk">Not assessed</strong></div><p id="safetyReason">Connect the simulator to assess risk.</p><div class="last-intervention"><span>Last observed intervention</span><p id="lastIntervention">None observed in this session</p></div></section>
    <section class="route-overview" aria-labelledby="routeOverviewTitle"><div class="section-heading"><h3 id="routeOverviewTitle">Route & map</h3><span aria-hidden="true">N \u2191</span></div><div id="inlineMapSlot"></div><div class="route-summary"><strong id="routeName">Choose a destination</strong><span id="routeRemaining">Your route will appear here.</span></div></section>
    <section class="drive-actions"><button id="primaryDriveAction" class="primary">Start the simulation</button><p id="primaryActionHint" class="muted" role="status"></p><div id="quickDriveActions" class="secondary-actions"></div><div id="stopAcknowledgement"></div></section>
    <details class="normal-driving"><summary>Manual controls & destination speed</summary><div id="normalControls"></div></details>
    <details class="comparison-controls"><summary>Run a safety comparison</summary><p class="muted">Two recorded runs with the same starting conditions.</p><div id="comparisonControls"></div><button id="comparisonSetupBtn">Configure comparison</button></details>
    <details class="session-timeline"><summary>Safety timeline <span id="timelineCount">0 events</span></summary><p class="muted">Observed on this page in the current session. This is a partial event log.</p><ol id="safetyTimeline"></ol></details>
    <div id="liveOperationStatus" class="inspector-footer"></div>`;
    $2("inlineMapSlot").append($2("miniMapToggle"));
    $2("miniMapToggle").setAttribute("aria-label", "Expand route map and choose a destination");
    $2("miniRouteHint").textContent = "Expand map \u2197";
    $2("primaryDriveAction").onclick = () => {
      const target = $2("primaryDriveAction").dataset.action;
      if (target) $2(target)?.click();
    };
    inspector.querySelector(".safety-monitor").after(inspector.querySelector(".drive-actions"));
    $2("quickDriveActions").append(old.querySelector("#startDrivingBtn"), $2("phoneToggleBtn"));
    $2("stopAcknowledgement").append(old.querySelector("#acknowledgeStopBtn"));
    $2("normalControls").append(old);
    for (const [label, title] of [["Training environment", "Controlled research tools"], ["City population", "City population & recording"]]) {
      const details = document.createElement("details");
      details.innerHTML = "<summary>" + title + "</summary>";
      details.append($2("normalControls").querySelector('[aria-label="' + label + '"]'));
      $2("sensorPanel").append(details);
    }
    $2("liveOperationStatus").append($2("operationStatus"), $2("recordingStatus"));
    $2("controlMode").hidden = true;
    $2("sensorPanel").append($2("controlMode"), $2("controlSource"), $2("sensorStatus"), $2("performance"), $2("cameraTimestamp"));
    $2("toolbar").append($2("replayPauseBtn"));
    const demo = document.querySelector(".comparison-demo");
    demo.querySelector(".muted").textContent = "Each run resets the scene and records automatically. Traffic can diverge after an intervention.";
    $2("comparisonControls").append(demo);
    $2("demoStopBtn").textContent = "Reset simulation";
    $2("demoStopBtn").classList.add("reset-action");
    const activity = document.createElement("details");
    activity.innerHTML = '<summary>Hazard schedule</summary><pre id="hazardActivity">No comparison active</pre>';
    $2("comparisonControls").append(activity);
    const results = document.createElement("section");
    results.id = "resultsPhase";
    results.setAttribute("role", "tabpanel");
    results.setAttribute("aria-labelledby", "resultsTab");
    results.hidden = true;
    results.innerHTML = '<div class="analysis-heading"><div><h2>Comparison results</h2><p id="resultScope" class="muted">Recorded measurements</p></div><button id="newDriveBtn" class="primary">Start a new drive \u2197</button></div><div id="resultContent"></div><details class="recording-archive"><summary>Recording archive</summary><p class="muted">Saved runs, including interrupted attempts. These measurements are separate from the current session.</p><div id="recordingArchive"></div></details>';
    drive.after(results);
    results.querySelector("h2").textContent = "Journey results";
    const journeyResults = document.createElement("section");
    journeyResults.id = "journeyResults";
    const historicalHeading = document.createElement("h2");
    historicalHeading.textContent = "Historical safety comparison";
    const journeyScope = document.createElement("p");
    journeyScope.className = "muted";
    journeyScope.textContent = "Saved RULE measurements \xB7 MODEL is experimental";
    $2("resultScope").before(journeyScope);
    $2("resultContent").append(journeyResults, historicalHeading, $2("resultScope"), $2("demoResults"));
    $2("newDriveBtn").onclick = () => {
      newDriveRequested = true;
      showWorkspace("drive", { focus: true });
      $2("primaryDriveAction").focus();
    };
    const setup = document.createElement("section");
    setup.id = "setupPhase";
    setup.className = "setup-workspace";
    setup.setAttribute("role", "tabpanel");
    setup.setAttribute("aria-labelledby", "setupTab");
    setup.hidden = true;
    setup.innerHTML = `<div class="analysis-heading"><div><h2>Experiment setup</h2><p class="muted">Set the starting conditions before recording a comparison.</p></div><button id="setupDriveBtn" class="primary">Return to driving \u2197</button></div><div class="setup-columns"><section><h3>Comparison scenario</h3><label for="comparisonScenario">Scenario</label><select id="comparisonScenario"><option value="URBAN_CHAOS">Urban Chaos</option><option value="FRONT_OBSTACLE">Front Obstacle</option></select><label for="comparisonSeed">Scenario seed \xB7 test split</label><input id="comparisonSeed" type="number" min="2000" max="2999" value="2589"><p id="comparisonRecipe" class="muted">40 traffic vehicles \xB7 30 pedestrians \xB7 20 km/h \xB7 60 simulation seconds</p><p class="muted">BasicAgent vehicle and traffic-light checks are disabled in both research runs. Normal destination journeys retain their checks.</p></section><section><h3>Graphics preset</h3><div class="graphics-presets"><button data-preset="LOW">Low</button><button data-preset="BALANCED">Balanced</button><button data-preset="HIGH">High</button><button data-preset="ULTRA">Ultra</button></div><p id="presetApplied" role="status">Reading engine configuration\u2026</p><p class="muted">Applying a preset restarts CARLA and leaves the vehicle stopped.</p><button id="setupSettings">Simulator settings</button></section></div>`;
    results.after(setup);
    const dialog = document.createElement("dialog");
    dialog.id = "advancedSetupDialog";
    dialog.setAttribute("aria-label", "Advanced configuration");
    dialog.innerHTML = '<div class="advanced-dialog-heading"><strong>Advanced configuration</strong><button id="advancedSetupEmergency" class="emergency">Emergency stop</button><button id="closeAdvancedSetup" aria-label="Close advanced configuration">Close \xD7</button></div>';
    document.body.append(dialog);
    dialog.append(setup);
    setup.removeAttribute("role");
    setup.removeAttribute("aria-labelledby");
    const closeSetup = () => {
      dialog.close();
      setup.hidden = true;
    };
    $2("closeAdvancedSetup").onclick = closeSetup;
    $2("advancedSetupEmergency").onclick = () => {
      closeSetup();
      $2("emergencyStopBtn").click();
    };
    dialog.addEventListener("close", () => {
      setup.hidden = true;
    });
    $2("setupDriveBtn").onclick = () => {
      closeSetup();
      showWorkspace("drive", { focus: true });
    };
    $2("comparisonSetupBtn").onclick = () => showWorkspace("setup", { focus: true });
    $2("setupSettings").onclick = () => {
      closeSetup();
      $2("settingsBtn").click();
    };
    for (const phase of ["setup", "drive", "results"]) $2(phase + "Tab").onclick = () => showWorkspace(phase);
    nav.onkeydown = (event) => {
      const tabs = [...nav.querySelectorAll("[role=tab]")].filter((el2) => !el2.hidden), current = tabs.indexOf(document.activeElement);
      if (current < 0 || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].click();
      tabs[next].focus();
    };
    document.querySelectorAll("[data-preset]").forEach((button) => button.onclick = () => {
      provider2.stopDriving("graphics_preset");
      provider2.dashboardAction("restart_graphics", { preset: button.dataset.preset });
    });
    const detection = document.createElement("details");
    detection.className = "detection-details";
    detection.innerHTML = '<summary>Object detection & sign reading <span id="detectionSummary">Waiting for camera</span></summary>';
    detection.append($2("perceptionPanel"));
    $2("liveOperationStatus").before(detection);
    const cameraHeading = $2("cameraCard").querySelector(".section-heading"), providerTitle = $2("providerTitle"), activityBadge = $2("cameraActivity"), caption = document.querySelector(".camera-caption");
    providerTitle.classList.add("sr-only");
    $2("cameraCard").prepend(providerTitle);
    cameraHeading.classList.add("camera-heading");
    cameraHeading.replaceChildren(...heading.children, document.querySelector(".camera-tools"));
    heading.remove();
    caption.prepend(activityBadge);
    $2("cameraSource").classList.add("sr-only");
    document.querySelector(".app-footer").append(caption);
    const freshness = document.createElement("p");
    freshness.id = "perceptionFreshness";
    freshness.setAttribute("role", "status");
    $2("perceptionFrame").before(freshness);
    for (const [id, label] of [["throttleVal", "Throttle"], ["brakeVal", "Brake"]]) {
      const meter = document.createElement("span");
      meter.className = "instrument-meter";
      meter.setAttribute("role", "progressbar");
      meter.setAttribute("aria-label", label);
      meter.setAttribute("aria-valuemin", "0");
      meter.setAttribute("aria-valuemax", "100");
      meter.innerHTML = "<i></i>";
      $2(id).after(meter);
    }
    const resolution = document.createElement("option");
    resolution.textContent = "1280x720";
    $2("settingResolution").append(resolution);
    showWorkspace("drive");
  }
  function observeSafety(p, state) {
    const session = [p.sessionId, p.comparisonDemo?.recording || "normal"].join(":");
    if (historySession !== session) {
      historySession = session;
      history.length = 0;
      lastSafety = null;
      $2("safetyTimeline").replaceChildren();
      $2("lastIntervention").textContent = "None observed in this session";
      $2("timelineCount").textContent = "0 events";
    }
    const safety = p.safetySystem;
    if (!p.fresh || p.isReplay || !safety) return;
    if (safety.active && (!lastSafety?.active || safety.intervention_count !== lastSafety.count) || lastSafety?.active && !safety.active) {
      const entry = { time: state.timestamp, title: safety.active ? "Safety intervention" : "Control released", reason: safety.reason || "Reason unavailable", brake: state.brake, speed: state.speedKmh };
      history.push(entry);
      if (history.length > 40) history.shift();
      if (safety.active) $2("lastIntervention").textContent = entry.reason + " \xB7 brake " + (Number.isFinite(entry.brake) ? Math.round(entry.brake * 100) + "%" : "unavailable");
      $2("safetyTimeline").replaceChildren(...history.slice().reverse().map((event) => {
        const row = document.createElement("li"), title = document.createElement("strong"), detail = document.createElement("p");
        title.textContent = event.title + " \xB7 t " + (Number.isFinite(event.time) ? event.time.toFixed(1) + " s" : "\u2014");
        detail.textContent = event.reason + " \xB7 Brake " + (Number.isFinite(event.brake) ? Math.round(event.brake * 100) + "%" : "\u2014") + " \xB7 " + (Number.isFinite(event.speed) ? event.speed.toFixed(1) + " km/h" : "Speed unavailable");
        row.append(title, detail);
        return row;
      }));
      $2("timelineCount").textContent = history.length + " events";
    }
    lastSafety = { active: safety.active, count: safety.intervention_count };
  }
  function updatePresentation(p, state, armed, manualStartPending = false) {
    const demo = p.comparisonDemo, busy = comparisonBusy(demo) || comparisonV2Busy(p.comparisonV2);
    if (busy || ["MANUAL", "AUTOMATIC"].includes(p.controlMode)) newDriveRequested = false;
    const presentationProvider = newDriveRequested ? { ...p, fresh: p.fresh, comparisonDemo: demo?.phase === "FINISHED" ? { ...demo, phase: "IDLE" } : demo, comparisonV2: p.comparisonV2?.phase === "FINISHED" ? { ...p.comparisonV2, phase: "IDLE" } : p.comparisonV2, journey: p.journey?.status === "ARRIVED" ? { ...p.journey, status: "READY" } : p.journey } : p;
    const view = driveState(manualStartPending ? { ...presentationProvider, fresh: p.fresh, manualStartPending: true } : presentationProvider, state, armed);
    $2("ownershipBtn").hidden = p.controller || p.isReplay || !p.fresh;
    $2("ownershipBtn").disabled = !p.fresh || p.isReplay;
    setText("driveState", view.label);
    $2("driveState").dataset.tone = view.tone;
    $2("currentDrivingMode").textContent = view.mode;
    $2("currentSafetyState").textContent = view.safetyLabel;
    $2("currentSafetyState").dataset.tone = view.safetyTone;
    if (p.fresh && !p.isReplay && p.safetySystem) $2("currentSafetyState").textContent = view.safetyLabel + " \xB7 " + p.safetySystem.controller;
    $2("liveInterventions").textContent = (view.interventions ?? "\u2014") + " interventions";
    setText("safetyStatus", view.safetyLabel);
    $2("safetyStatus").dataset.tone = view.safetyTone;
    $2("safetyRisk").textContent = view.risk;
    $2("safetyRisk").dataset.tone = view.safetyTone;
    $2("safetyReason").textContent = view.reason;
    setText("workspaceTitle", { drive: "Driving workspace", results: "Results workspace", setup: "Simulation setup" }[activePhase]);
    setText("sessionScope", "CURRENT SESSION \xB7 " + (p.isReplay ? "RECORDED REPLAY" : p.fresh ? "CARLA CONNECTED" : "CARLA DISCONNECTED"));
    if (busy) for (const id of ["startDrivingBtn", "startJourneyBtn", "phoneJourneyBtn", "driveJourneyBtn", "journeySpeed"]) {
      $2(id).disabled = true;
      $2(id).title = "Stop the comparison before starting another drive";
    }
    setText("primaryDriveAction", view.actionLabel);
    $2("primaryDriveAction").dataset.action = view.action || "";
    $2("primaryDriveAction").disabled = !view.action || !!$2(view.action)?.disabled;
    setText("primaryActionHint", p.operationError || p.comparisonV2?.error || demo?.error || (p.isReplay ? "Playback only. Vehicle controls are disabled." : !p.fresh ? p.status : !p.controller ? "Another page currently controls the vehicle." : view.label === "Drive completed" ? "Your drive is recorded. Review it or start another." : busy ? "Comparison recording is active." : p.comparisonV2 ? comparisonStartBlocked(p) || "Rules driving restores the saved journey and records automatically. MODEL is experimental." : "Choose a destination or start a manual drive."));
    $2("routeName").textContent = p.route?.destination?.name || "Choose a destination";
    $2("routeRemaining").textContent = p.route ? (Number.isFinite(p.route.remaining_m) ? Math.round(p.route.remaining_m) + " m remaining" : "Route selected") + (p.route.arrived ? " \xB7 Arrived" : "") : "Select a road point or saved destination.";
    $2("miniRouteHint").textContent = "Expand map \u2197";
    $2("hazardActivity").textContent = Object.entries(demo?.hazards || {}).map(([name, v]) => name + ": " + v.status).join("\n") || "No comparison active";
    const journeyResults = p.comparisonV2 || p.recordedComparisonV2;
    const signature = JSON.stringify([demo?.results, demo?.archived_comparison, demo?.archive, journeyResults?.results, journeyResults?.latest_attempt, journeyResults?.pair_id, p.fresh]);
    if (signature !== lastResults) {
      lastResults = signature;
      renderComparison(demo);
      renderJourneyResults(journeyResults, p.fresh);
    }
    $2("presetApplied").textContent = ($2("activeGraphics").textContent || "Waiting for engine settings") + (p.restartResult ? " \xB7 " + p.restartResult.status : "");
    $2("comparisonRecipe").textContent = $2("comparisonScenario").value === "URBAN_CHAOS" ? "40 traffic vehicles \xB7 30 pedestrians \xB7 20 km/h \xB7 60 simulation seconds" : "Front obstacle \xB7 28 km/h \xB7 14 simulation seconds";
    for (const id of ["demoWithoutBtn", "demoWithBtn"]) $2(id).disabled ||= busy;
    $2("cameraView").disabled = busy || !p.controller || !p.fresh;
    for (const id of ["comparisonScenario", "comparisonSeed"]) $2(id).disabled = busy;
    document.querySelectorAll("[data-preset]").forEach((button) => button.disabled = busy || !p.controller || !p.fresh || p.isReplay || Math.abs(state.speedMps ?? 0) > 0.15);
    for (const [id, value] of [["throttleVal", state.throttle], ["brakeVal", state.brake]]) {
      const meter = $2(id).parentElement.querySelector(".instrument-meter"), percent = Number.isFinite(value) ? Math.max(0, Math.min(100, value * 100)) : 0;
      meter.style.setProperty("--value", percent + "%");
      if (Number.isFinite(value)) meter.setAttribute("aria-valuenow", Math.round(percent));
      else meter.removeAttribute("aria-valuenow");
      meter.setAttribute("aria-valuetext", Number.isFinite(value) ? Math.round(percent) + "%" : "Unavailable");
    }
    observeSafety(p, state);
  }

  // frontend/traffic-preparation.js
  var TRAFFIC_COUNT = 25;
  var PEDESTRIAN_COUNT = 20;
  var busyComparison = (p) => ["RESETTING", "RUNNING", "STOPPING"].includes(p.comparisonDemo?.phase) || ["QUEUED", "RESETTING", "RUNNING", "STOPPING"].includes(p.comparisonV2?.phase);
  var pending = (state) => ["REQUESTED", "APPLYING"].includes(state?.status);
  var routeDestinationKey = (route) => route?.destination?.location ? JSON.stringify([route.destination.map ?? null, route.destination.location]) : null;
  function routeCrowdingReady(p) {
    const c = p.population?.route_crowding;
    return !!c?.active && c.status === "READY" && !!routeDestinationKey(p.route) && routeDestinationKey({ destination: c.destination }) === routeDestinationKey(p.route) && c.placed_count === p.population.actual?.vehicles && c.target_count === p.population.requested?.vehicle_count && c.seed === p.population.requested?.seed && c.chaos_percent === p.population.requested?.chaos_percent;
  }
  function routeCrowdingPrepared(p, preparation) {
    const c = p.population?.route_crowding, key = routeDestinationKey(p.route), state = preparation?.state;
    if (!c?.active || !key || routeDestinationKey({ destination: c.destination }) !== key || c.target_count !== p.population.requested?.vehicle_count || c.seed !== p.population.requested?.seed || c.chaos_percent !== p.population.requested?.chaos_percent || pending(state) || state?.status === "FAILED") return false;
    const result = p.dashboardResult, applied = result?.result?.population, receipt = applied?.route_crowding;
    const confirmed = state?.kind === "route" && state.status === "READY" && state.session_id === p.sessionId && state.destination === key && state.actual_count === c.target_count && preparation.requestedPopulation?.seed === c.seed && preparation.requestedPopulation?.chaos_percent === c.chaos_percent;
    if (confirmed && (result?.action !== "crowd_route" || result.operationId === state.operation_id)) return true;
    if (result?.action === "crowd_route" && result.operationId) {
      return result.status === "APPLIED" && receipt?.route_id === c.route_id && receipt.seed === c.seed && receipt.chaos_percent === c.chaos_percent && receipt.target_count === c.target_count && routeCrowdingReady({ ...p, population: applied }) && applied.traffic_manager_connected === true && Number.isInteger(applied.frame_id) && applied.npc_failed === 0 && Array.isArray(applied.errors) && !applied.errors.length;
    }
    return routeCrowdingReady(p) && p.population.traffic_manager_connected === true && p.population.npc_failed === 0 && Array.isArray(p.population.errors) && !p.population.errors.length;
  }
  function trafficPrepared(p, preparation) {
    if (p.population?.route_crowding?.active) return routeCrowdingPrepared(p, preparation);
    const state = preparation?.state, request = preparation?.requestedPopulation;
    return state?.status === "READY" && state.session_id === p.sessionId && !!request && Object.entries(request).every(([k, v]) => p.population?.requested?.[k] === v) && p.population?.traffic_manager_connected === true && p.population.actual?.vehicles === request.vehicle_count && p.population.actual?.pedestrians === request.pedestrian_count && p.population.actual?.controllers === request.pedestrian_count && (request.pedestrian_count === 0 || p.population.actual?.walkers_active === request.pedestrian_count);
  }
  function trafficCommandBlocked(state, type, payload = {}) {
    if (!state || state.status === "READY" || state.status === "IDLE") return false;
    if (type === "controls") {
      const c = payload.controls || {};
      return !(c.throttle === 0 && c.brake === 1 && (c.steering ?? 0) === 0);
    }
    if (["start_driving", "start_journey"].includes(type)) return true;
    if (type === "comparison") return payload.value?.mode !== "STOP";
    return pending(state) && [
      "settings",
      "population",
      "crowd_route",
      "scene",
      "environment",
      "scenario",
      "destination",
      "clear_route",
      "save_place",
      "favorite_place",
      "recording",
      "world_reset",
      "restart_graphics",
      "reset",
      "safety_mode"
    ].includes(type);
  }
  function trafficPreparationReason(p, vehicle) {
    if (!p.fresh || !p.connected || p.isReplay) return "Connect to live CARLA first.";
    if (!p.controller) return "Take control of this page first.";
    if (p.restarting) return "Wait for CARLA to reconnect.";
    if (p.recording || busyComparison(p)) return "Finish the current recording or comparison first.";
    if (p.environment?.mode === "TRAINING") return "Return to Living city to prepare normal traffic.";
    if (p.controlMode !== "PAUSED" || !Number.isFinite(vehicle?.speedMps) || Math.abs(vehicle.speedMps) > 0.15)
      return "Stop driving and wait for the vehicle to stop first.";
    if (!p.population?.requested || !p.population?.actual) return "Waiting for native population data.";
    if (pending(p.trafficPreparation) || p.dashboardResult?.status === "PENDING") return "Preparing the world; wait for completion.";
    return "";
  }
  var TrafficPreparation = class {
    constructor(provider2, stop, { now = () => performance.now(), timeoutMs = 3e4 } = {}) {
      Object.assign(this, { provider: provider2, stop, now, timeoutMs });
      this.session = provider2.sessionId;
      this.state = null;
    }
    request(requestedPopulation = null, { requireWalkers = true } = {}) {
      const p = this.provider;
      const reason = trafficPreparationReason(p, p.getVehicleState());
      if (reason) {
        if (!pending(this.state)) p.operationError = reason;
        return false;
      }
      const population = requestedPopulation ? { ...requestedPopulation } : {
        ...p.population.requested,
        vehicle_count: TRAFFIC_COUNT,
        pedestrian_count: PEDESTRIAN_COUNT,
        placement: "EGO_SURROUNDING",
        vehicle_mix: "MIXED"
      };
      if (!Number.isInteger(population.vehicle_count) || population.vehicle_count < 0 || population.vehicle_count > 75) {
        p.operationError = "Choose 0\u201375 traffic vehicles.";
        return false;
      }
      this.requestedPopulation = population;
      this.action = "settings";
      this.completeCity = requireWalkers;
      this.stop("traffic_preparation");
      const previousOperation = p.dashboardResult?.operationId;
      p.trafficPreparation = null;
      if (!p.dashboardAction("settings", { population })) {
        this.state = { status: "FAILED", reason: "Traffic request was not sent. Reconnect and try again.", session_id: p.sessionId };
        p.trafficPreparation = this.state;
        return false;
      }
      this.session = p.sessionId;
      this.previousOperation = previousOperation;
      this.started = this.now();
      this.errorBefore = p.operationError;
      this.state = { status: "REQUESTED", requested_count: population.vehicle_count, session_id: p.sessionId, reason: "Preparing traffic; driving is held." };
      p.trafficPreparation = this.state;
      return true;
    }
    requestRouteCrowding(options = {}) {
      const p = this.provider, reason = trafficPreparationReason(p, p.getVehicleState());
      if (reason) {
        if (!pending(this.state)) p.operationError = reason;
        return false;
      }
      if (!p.route?.id || !routeDestinationKey(p.route) || p.route.arrived) {
        p.operationError = "Choose a destination first.";
        return false;
      }
      const seed = options.seed ?? p.population.requested.seed;
      const chaos = options.chaos_percent ?? p.population.requested.chaos_percent ?? 0;
      if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647 || !Number.isInteger(chaos) || chaos < 0 || chaos > 100) {
        p.operationError = "Choose a valid seed and randomness from 0\u2013100%.";
        return false;
      }
      this.stop("traffic_preparation");
      this.previousOperation = p.dashboardResult?.operationId;
      p.trafficPreparation = null;
      this.action = "crowd_route";
      this.destination = routeDestinationKey(p.route);
      this.routeId = p.route.id;
      this.completeCity = false;
      this.requestedPopulation = { seed, chaos_percent: chaos };
      this.session = p.sessionId;
      this.started = this.now();
      const sent = p.dashboardAction("crowd_route", { route_id: p.route.id, seed, chaos_percent: chaos });
      this.errorBefore = p.operationError;
      this.state = {
        status: sent ? "REQUESTED" : "FAILED",
        kind: "route",
        destination: this.destination,
        session_id: p.sessionId,
        reason: sent ? "Crowding the selected road; driving is held." : "Road traffic request was not sent. Reconnect and try again."
      };
      p.trafficPreparation = this.state;
      return sent;
    }
    update() {
      const p = this.provider;
      if (this.session !== p.sessionId) {
        this.session = p.sessionId;
        this.state = null;
        p.trafficPreparation = null;
        return;
      }
      if (p.environment?.mode === "TRAINING") {
        this.state = null;
        p.trafficPreparation = null;
        return;
      }
      if (this.state?.kind === "route" && this.destination !== routeDestinationKey(p.route)) {
        this.state = null;
        p.trafficPreparation = null;
        return;
      }
      if (!this.state || this.state.status === "READY") return;
      const fail = (reason) => {
        this.state = { ...this.state, status: "FAILED", reason };
      };
      if (!p.fresh || !p.connected || p.isReplay) fail("Connection lost during preparation. Native completion is unverified.");
      else if (!p.controller) fail("Control moved to another page. Traffic completion is unverified.");
      else if (p.operationError && p.operationError !== this.errorBefore) fail(p.operationError);
      else {
        const result = p.dashboardResult;
        if (result?.action === this.action && result.operationId && result.operationId !== this.previousOperation) {
          if (result.status === "REJECTED") fail(result.error || "CARLA rejected traffic preparation.");
          else if (result.status === "PENDING") this.state = { ...this.state, status: "APPLYING" };
          else if (result.status === "APPLIED") {
            const population = p.population, applied = result.result?.population;
            const frame = p.getVehicleState().frame;
            const crowding = result.result?.crowding;
            const isRoute = this.state.kind === "route";
            const count = isRoute ? crowding?.target_count : this.state.requested_count;
            const completeCity = this.completeCity;
            const valid = Number.isInteger(count) && count >= 0 && count <= 75 && population?.traffic_manager_connected === true && population.frame_id === frame && Number.isInteger(frame) && Number.isInteger(applied?.frame_id) && population.frame_id >= applied.frame_id && population.requested?.vehicle_count === count && applied?.requested?.vehicle_count === count && Object.entries(this.requestedPopulation).every(([k, v]) => population.requested?.[k] === v && applied?.requested?.[k] === v) && population.actual?.vehicles === count && (isRoute || applied?.actual?.vehicles === count) && (!completeCity || [population, applied].every((v) => v.actual?.pedestrians === this.requestedPopulation.pedestrian_count && v.actual?.controllers === this.requestedPopulation.pedestrian_count && v.walkers_failed === 0)) && population.npc_failed === 0 && applied?.npc_failed === 0 && Array.isArray(population.errors) && population.errors.length === 0 && Array.isArray(applied?.errors) && applied.errors.length === 0;
            const routeValid = !isRoute || routeCrowdingReady(p) && crowding?.route_id === this.routeId && population.route_crowding?.route_id === this.routeId && routeDestinationKey({ destination: crowding.destination }) === this.destination;
            const awaitingAdmission = isRoute && Number.isInteger(count) && count > 0 && count <= 75 && population?.traffic_manager_connected === true && Number.isInteger(frame) && Number.isInteger(applied?.frame_id) && population.frame_id >= applied.frame_id && population.requested?.vehicle_count === count && applied.requested?.vehicle_count === count && Object.entries(this.requestedPopulation).every(([k, v]) => population.requested?.[k] === v && applied.requested?.[k] === v) && population.npc_failed === 0 && applied.npc_failed === 0 && Array.isArray(population.errors) && !population.errors.length && Array.isArray(applied.errors) && !applied.errors.length && crowding?.route_id === this.routeId && population.route_crowding?.route_id === this.routeId && routeDestinationKey({ destination: crowding.destination }) === this.destination && routeDestinationKey({ destination: population.route_crowding.destination }) === this.destination;
            if (valid && routeValid && (!completeCity || this.requestedPopulation.pedestrian_count === 0 || population.actual?.walkers_active === this.requestedPopulation.pedestrian_count)) this.state = {
              ...this.state,
              status: "READY",
              actual_count: count,
              native_frame: frame,
              operation_id: result.operationId,
              reason: isRoute ? `${count} vehicles placed along your ${Math.round(crowding.route_length_m)} m road. Ready to drive.` : `${count} traffic vehicles confirmed in CARLA at frame ${frame}. Ready to drive.`
            };
            else if (awaitingAdmission || valid && completeCity || completeCity && population?.admitted?.vehicles === this.requestedPopulation.vehicle_count && population?.admitted?.pedestrians === this.requestedPopulation.pedestrian_count && population.npc_failed === 0 && population.walkers_failed === 0 && !population.errors?.length && Object.entries(this.requestedPopulation).every(([k, v]) => population.requested?.[k] === v)) this.state = {
              ...this.state,
              status: "APPLYING",
              reason: `Waiting for native traffic confirmation: ${population.actual?.vehicles ?? "\u2014"}/${count} vehicles. Driving stays held.`
            };
            else fail(`Road traffic preparation incomplete: ${population?.actual?.vehicles ?? "unknown"}/${count ?? "unknown"} vehicles. Check simulator details and retry explicitly.`);
          }
        }
        if (pending(this.state) && this.now() - this.started > this.timeoutMs)
          fail("Traffic completion timed out. Driving remains held; no automatic retry.");
      }
      p.trafficPreparation = this.state;
    }
  };
  function installTrafficPreparation(provider2, stop, doc = document) {
    const preparation = new TrafficPreparation(provider2, stop);
    const area = doc.createElement("div");
    area.className = "traffic-preparation";
    const button = doc.createElement("button");
    button.id = "prepareTrafficBtn";
    button.type = "button";
    button.textContent = "Prepare surrounding traffic";
    const status = doc.createElement("p");
    status.id = "trafficPreparationStatus";
    status.className = "muted";
    status.setAttribute("role", "status");
    button.setAttribute("aria-describedby", status.id);
    area.append(button, status);
    doc.getElementById("primaryDriveAction").before(area);
    button.onclick = () => preparation.requestRouteCrowding();
    return {
      preparation,
      update(vehicle) {
        preparation.update();
        const reason = trafficPreparationReason(provider2, vehicle) || (!provider2.route?.destination || provider2.route.arrived ? "Choose a destination first." : "");
        button.disabled = !!reason;
        button.title = reason;
        button.textContent = pending(preparation.state) ? "Crowding your road\u2026" : "Make your road crowded";
        status.textContent = preparation.state?.reason || reason || `Before driving: ${provider2.population?.actual?.vehicles ?? "\u2014"} traffic vehicles currently in CARLA.`;
        if (preparation.state?.status === "READY") status.textContent += ` Current: ${provider2.population?.actual?.vehicles ?? "\u2014"}.`;
        const held = preparation.state && preparation.state.status !== "READY";
        if (held) for (const id of ["primaryDriveAction", "startDrivingBtn", "startJourneyBtn", "phoneJourneyBtn", "driveJourneyBtn", "demoWithBtn", "demoWithoutBtn"]) {
          const control = doc.getElementById(id);
          if (control) {
            control.disabled = true;
            control.title = preparation.state.reason;
          }
        }
      }
    };
  }

  // frontend/city-setup.js
  var CITY_PRESETS = {
    CALM: { chaos_percent: 0, vehicle_count: 20, pedestrian_count: 15, crossing_percent: 5, driver_behavior: "NORMAL", light_compliance_percent: 100, speed_behavior: "NORMAL" },
    BUSY: { chaos_percent: 45, vehicle_count: 40, pedestrian_count: 30, crossing_percent: 30, driver_behavior: "BUSY", light_compliance_percent: 80, speed_behavior: "NORMAL" },
    CHAOTIC: { chaos_percent: 85, vehicle_count: 50, pedestrian_count: 35, crossing_percent: 60, driver_behavior: "UNREGULATED", light_compliance_percent: 35, speed_behavior: "FAST" }
  };
  function cityPopulation(base, values) {
    const result = { ...base, ...values };
    for (const [key, max] of Object.entries({ vehicle_count: 75, pedestrian_count: 50, chaos_percent: 100, crossing_percent: 60, seed: 2147483647, light_compliance_percent: 100 })) {
      if (!Number.isInteger(result[key]) || result[key] < 0 || result[key] > max) throw new Error(`${key}: choose a whole value from 0 to ${max}.`);
    }
    if (!["SLOW", "NORMAL", "FAST"].includes(result.speed_behavior)) throw new Error("Choose a traffic pace.");
    return result;
  }
  function installCitySetup(p, preparation, tools2, startJourney2) {
    const $9 = (id) => document.getElementById(id);
    const panel = document.createElement("section");
    panel.className = "city-setup";
    panel.setAttribute("aria-label", "Live city setup");
    panel.innerHTML = `<div class="city-setup-heading"><div><h3>Live city</h3><p class="muted">Prepare traffic, choose a route, then drive.</p></div><div class="city-presets" aria-label="City presets"><button data-city-preset="CALM">Calm</button><button data-city-preset="BUSY">Busy</button><button data-city-preset="CHAOTIC">Chaotic</button></div></div>
  <div class="city-setup-columns"><fieldset><legend>Traffic & people</legend>
    <label for="cityChaos">Chaos <output id="cityChaosValue">0%</output></label><input id="cityChaos" type="range" min="0" max="100" step="5" value="0"><p class="field-hint">More lane changes, varied speeds and less orderly drivers.</p>
    <div class="city-field-pair"><div><label for="cityVehicles">Traffic vehicles</label><input id="cityVehicles" type="number" min="0" max="75" value="25"></div><div><label for="cityWalkers">Pedestrians</label><input id="cityWalkers" type="number" min="0" max="50" value="20"></div></div>
    <label for="cityCrossing">Road crossing <output id="cityCrossingValue">5%</output></label><input id="cityCrossing" type="range" min="0" max="60" step="5" value="5">
    <div class="city-field-pair"><div><label for="cityTrafficPace">Traffic pace</label><select id="cityTrafficPace"><option value="SLOW">Relaxed</option><option value="NORMAL">Normal</option><option value="FAST">Fast</option></select></div><div><label for="cityCompliance">Light compliance %</label><input id="cityCompliance" type="number" min="0" max="100" value="90"></div></div>
    <label for="citySeed">City seed</label><div class="city-seed-row"><input id="citySeed" type="number" min="0" max="2147483647" value="42"><button id="cityShuffle" aria-label="Choose a new city seed">Shuffle</button></div>
  </fieldset><fieldset><legend>Your drive</legend>
    <label>Protection configuration</label><div class="city-mode-buttons" role="group" aria-label="Driving protection"><button id="cityNormalMode" aria-pressed="false">Disable RULE</button><button id="citySafetyMode" aria-pressed="false">Enable RULE</button></div><p id="cityModeStatus" class="field-hint" role="status"></p>
    <label for="cityDrivePace">Destination driving pace</label><select id="cityDrivePace"><option value="20">Normal \xB7 20 km/h</option><option value="25">Responsive \xB7 25 km/h</option><option value="30">Brisk \xB7 30 km/h</option></select><p class="field-hint">Target speed; road limits and live obstacles still apply.</p>
    <label>Destination</label><strong id="cityRouteName">Choose a destination</strong><button id="cityChooseRoute">Choose route on map \u2197</button>
    <div class="city-start-actions"><button id="cityApply" class="primary">Apply city</button><button id="cityGo">Go to destination \u2197</button></div><p id="citySetupStatus" class="muted" role="status"></p>
  </fieldset></div>`;
    const setup = $9("setupPhase");
    setup.querySelector(".analysis-heading h2").textContent = "City & driving setup";
    setup.querySelector(".analysis-heading p").textContent = "Direct controls for your next destination journey.";
    setup.querySelector(".analysis-heading").after(panel);
    const advanced = document.createElement("details");
    advanced.className = "setup-advanced";
    advanced.innerHTML = "<summary>Research comparison & graphics</summary>";
    advanced.append(setup.querySelector(".setup-columns"));
    setup.append(advanced);
    const fields = { vehicle_count: "cityVehicles", pedestrian_count: "cityWalkers", chaos_percent: "cityChaos", crossing_percent: "cityCrossing", seed: "citySeed", light_compliance_percent: "cityCompliance", speed_behavior: "cityTrafficPace" };
    let session = null, dirty = false, behavior = "NORMAL", error = "", modePending = null;
    const describe = () => {
      $9("cityChaosValue").value = $9("cityChaos").value + "%";
      $9("cityCrossingValue").value = $9("cityCrossing").value + "%";
    };
    const markDirty = () => {
      dirty = true;
      error = "";
      describe();
    };
    Object.values(fields).forEach((id) => $9(id).oninput = markDirty);
    panel.querySelectorAll("[data-city-preset]").forEach((button) => button.onclick = () => {
      const values = CITY_PRESETS[button.dataset.cityPreset];
      behavior = values.driver_behavior;
      for (const [key, id] of Object.entries(fields)) if (key in values) $9(id).value = values[key];
      markDirty();
    });
    $9("cityShuffle").onclick = () => {
      const seed = new Uint32Array(1);
      crypto.getRandomValues(seed);
      $9("citySeed").value = seed[0] % 2147483648;
      markDirty();
    };
    $9("cityApply").onclick = () => {
      try {
        const values = Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, key === "speed_behavior" ? $9(id).value : Number($9(id).value)]));
        const config = cityPopulation(p.population.requested, { ...values, driver_behavior: behavior });
        if (preparation.request(config)) {
          dirty = false;
          error = "";
        } else error = p.operationError || "City request was not sent.";
      } catch (e) {
        error = e.message;
      }
    };
    for (const [id, enabled] of [["cityNormalMode", false], ["citySafetyMode", true]]) $9(id).onclick = () => {
      if (p.dashboardAction("safety_mode", { enabled, controller: "RULE" })) modePending = enabled;
    };
    $9("cityDrivePace").onchange = () => {
      $9("journeySpeed").value = $9("cityDrivePace").value;
      $9("journeySpeed").dispatchEvent(new Event("change"));
    };
    $9("cityChooseRoute").onclick = () => tools2.open("routePanel", "cityChooseRoute");
    $9("cityGo").onclick = () => {
      startJourney2();
      showWorkspace("drive");
    };
    return { update(vehicle) {
      if (session !== p.sessionId) {
        session = p.sessionId;
        dirty = false;
        modePending = null;
        error = "";
      }
      const current = p.population?.requested;
      if (!dirty && current && !["REQUESTED", "APPLYING"].includes(preparation.state?.status)) {
        for (const [key, id] of Object.entries(fields)) $9(id).value = current[key] ?? (key === "chaos_percent" ? 0 : $9(id).value);
        behavior = current.driver_behavior || "NORMAL";
        describe();
      }
      const reason = trafficPreparationReason(p, vehicle), locked = !!reason;
      for (const el2 of panel.querySelectorAll("input,select,[data-city-preset],#cityShuffle,#cityApply,#cityNormalMode,#citySafetyMode")) {
        el2.disabled = locked;
        el2.title = reason;
      }
      $9("cityChooseRoute").disabled = !p.fresh || p.isReplay || !p.controller || ["REQUESTED", "APPLYING"].includes(preparation.state?.status);
      if (modePending === p.safetySystem?.enabled || p.operationError) modePending = null;
      $9("cityNormalMode").setAttribute("aria-pressed", String(p.safetySystem?.enabled === false));
      $9("citySafetyMode").setAttribute("aria-pressed", String(p.safetySystem?.enabled === true));
      $9("cityModeStatus").textContent = modePending !== null ? "Applying protection choice\u2026" : p.safetySystem?.enabled === true ? "YA RAB OSTORHA \xB7 " + p.safetySystem.controller : p.safetySystem?.enabled === false ? "Normal \xB7 additional safety OFF" : "Waiting for live protection state";
      $9("cityGo").disabled = dirty || locked || modePending !== null || $9("driveJourneyBtn").disabled;
      $9("cityGo").title = dirty ? "Apply your city changes first." : reason || $9("driveJourneyBtn").title;
      $9("cityRouteName").textContent = p.route?.destination?.name || "Choose a destination";
      $9("citySetupStatus").textContent = error || p.operationError || (dirty ? "Changes ready \xB7 Apply city before driving." : reason || preparation.state?.reason || `Live: ${p.population?.actual?.vehicles ?? "\u2014"} vehicles \xB7 ${p.population?.actual?.pedestrians ?? "\u2014"} pedestrians`);
    } };
  }

  // frontend/guided-drive.js
  function guidedStep(p, vehicle, configured = false, choosing = false) {
    if (p.simulationStarting || p.restarting) return "starting";
    if (!p.connected || !p.fresh || p.isReplay) return "connect";
    if (!p.controller) return "ownership";
    if (p.controlMode === "EMERGENCY_STOP") return "acknowledge";
    if (p.journey?.status === "STARTING") return "journey-starting";
    if (p.controlMode === "AUTOMATIC" || p.controlMode === "MANUAL" || Math.abs(vehicle.speedMps) > 0.15) return "stop";
    if (["REQUESTED", "APPLYING"].includes(p.trafficPreparation?.status) || p.dashboardResult?.status === "PENDING") return "pending";
    if (!p.route?.destination || p.route.arrived || p.dashboardResult?.action === "destination" && p.dashboardResult.status === "REJECTED") return "destination";
    if (choosing) return "behaviour";
    if (!configured || p.trafficPreparation?.status === "FAILED") return "traffic";
    return "drive";
  }
  function modeBlockedReason(p, vehicle, prepared) {
    if (!p.connected || !p.fresh || p.isReplay) return "Connect to live CARLA first.";
    if (!p.controller) return "Take vehicle control first.";
    if (p.restarting || p.simulationStarting) return "Wait for the simulator to reconnect.";
    if (p.controlMode === "EMERGENCY_STOP") return "Acknowledge the emergency stop first.";
    if (p.controlMode !== "PAUSED" || !Number.isFinite(vehicle.speedMps) || Math.abs(vehicle.speedMps) > 0.15) return "Stop driving and wait for the vehicle to stop.";
    if (!p.route?.destination || p.route.arrived) return "Choose a destination first.";
    if (!prepared) return "Apply road traffic and wait for confirmation.";
    if (p.dashboardResult?.status === "PENDING") return "Wait for the current operation to finish.";
    if (p.recording) return "Finish the current recording first.";
    if (["RESETTING", "RUNNING", "STOPPING"].includes(p.comparisonDemo?.phase) || ["QUEUED", "RESETTING", "RUNNING", "STOPPING"].includes(p.comparisonV2?.phase)) return "Stop the research run before starting a journey.";
    if (p.environment?.mode === "TRAINING") return "Return to Living city in Tools.";
    if (!p.navigationAvailable) return "Destination driving is unavailable. Inspect Diagnostics.";
    if (p.safetySystem?.status?.includes("FAULT") || p.safetySystem?.status === "UNAVAILABLE") return "Sensors are unavailable. Inspect Diagnostics before driving.";
    return "";
  }
  function simulatorNeedsStart(p) {
    return p.simulatorStop?.status === "STOPPED" || p.simulatorStart?.status === "FAILED" || !p.simulatorStop && p.simulatorStart?.available === true && !p.connected;
  }
  function installGuidedDrive(p, preparation, tools2, startJourney2, stop, predictionView2) {
    const $9 = (id) => document.getElementById(id), body = document.body;
    body.dataset.ui = "guided";
    let choosing = false, review = false, submitting = false, session = null, destination = null, action = "connect";
    let modeChoice = false, selectedMode = null, preparedKey = null, startPending = false, setupOpen = false, placeKey = "", recoveryPending = false;
    const toggle = document.createElement("button");
    toggle.id = "interfaceMode";
    toggle.textContent = "Tools";
    toggle.title = "Manual controls, city configuration and research";
    toggle.onclick = () => {
      tools2.close(false);
      showWorkspace("setup");
    };
    document.querySelector(".app-header").insertBefore(toggle, $9("emergencyStopBtn"));
    const panel = document.createElement("section");
    panel.id = "guidedDrive";
    panel.setAttribute("aria-label", "Guided simulation setup");
    panel.innerHTML = `<div class="guided-heading"><span class="eyebrow">YOUR NEXT JOURNEY</span><h2>Prepare your drive</h2><p id="guidedHeadingDetail">Choose a road. Then compare both modes.</p></div>
    <div id="guidedActiveSummary" hidden><span id="guidedActiveMode"></span><strong id="guidedActiveDestination"></strong><span id="guidedActiveTraffic"></span><button id="guidedInspectSetup">Inspect setup</button></div>
    <ol class="drive-steps"><li data-step="destination"><b>01</b><span>Choose destination</span></li><li data-step="behaviour"><b>02</b><span>Configure traffic</span></li><li data-step="traffic"><b>03</b><span>Prepare the road</span></li><li data-step="drive"><b>04</b><span>Start driving</span></li></ol>
    <div id="guidedDestination" hidden><label for="guidedDestinationSearch">Find a destination</label><input id="guidedDestinationSearch" type="search" placeholder="Search places or favorites" autocomplete="off"><div id="guidedPlaceResults" aria-label="Available destinations"></div><p class="muted">Current vehicle position is your starting point.</p></div>
    <div id="guidedBehaviour" hidden><label for="guidedChaos">Traffic randomness <output id="guidedChaosValue">0%</output></label><div class="behaviour-presets"><button data-chaos="0">Calm</button><button data-chaos="45">Mixed</button><button data-chaos="85">Chaotic</button></div><input id="guidedChaos" type="range" min="0" max="100" step="5" value="0"><details><summary>Advanced traffic settings</summary><label for="guidedSeed">Random seed</label><div class="guided-seed"><input id="guidedSeed" type="number" min="0" max="2147483647"><button id="guidedShuffle" aria-label="Choose another random seed">Shuffle</button></div><p class="muted">Road density follows native route capacity. Population and driver behavior are available in Settings.</p></details></div>
    <div id="guidedPreparation" hidden><strong id="guidedPreparationTitle">Ready to prepare</strong><p id="guidedPreparationDetail"></p></div>
    <button id="guidedPrimary" class="primary">Start Simulation</button><p id="guidedStatus" role="status" aria-live="polite"></p>
    <div id="guidedModeChoices" hidden aria-label="Choose your driving experience"><button id="robosphereModeBtn" data-mode="ROBOSPHERE"><span class="mode-symbol" aria-hidden="true">\u25CE</span><strong>Ya Rab Ostorha Mode</strong><span>Drive with Robosphere protection</span><em>Drive with Ya Rab Ostorha \u2197</em></button><button id="normalModeBtn" data-mode="NORMAL"><span class="mode-symbol" aria-hidden="true">\u25C7</span><strong>Normal Mode</strong><span>Self-driving route, no Robosphere overlay</span><em>Drive in Normal Mode \u2197</em></button></div>
    <div id="guidedJourneyOptions" hidden><label for="guidedSpeed">Target speed</label><input id="guidedSpeed" type="number" min="5" max="30" step="1" value="30"><span>km/h</span></div>
    <button id="guidedViewResults" class="primary" hidden>View Results \u2197</button><button id="guidedOtherMode" hidden>Run the other mode \u2197</button>
    <button id="guidedRoute" hidden>Edit destination</button><button id="guidedEditTraffic" hidden>Edit traffic</button><p id="guidedLiveCounts" class="muted"></p>`;
    document.querySelector(".drive-inspector").prepend(panel);
    const vision = document.createElement("details");
    vision.id = "modelVision";
    vision.setAttribute("aria-label", "Camera analysis");
    vision.innerHTML = '<summary>Camera analysis <span id="guidedPredictionStatus">Waiting for measured tracks</span></summary>';
    vision.append($9("perceptionPanel"));
    document.querySelector(".camera-stage").append(vision);
    const set2 = (id, value) => {
      if ($9(id).textContent !== String(value)) $9(id).textContent = String(value);
    };
    const route = () => tools2.open("routePanel", "guidedPrimary");
    const choose = () => {
      choosing = true;
      review = false;
      submitting = false;
      p.operationError = null;
      $9("guidedChaos").value = p.population?.requested?.chaos_percent ?? 0;
      $9("guidedChaos").oninput();
      $9("guidedSeed").value = p.population?.requested?.seed ?? 2589;
    };
    const validate = () => {
      const seed = Number($9("guidedSeed").value);
      if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) {
        p.operationError = "Choose a seed between 0 and 2147483647.";
        $9("guidedSeed").closest("details").open = true;
        $9("guidedSeed").focus();
        return false;
      }
      return true;
    };
    $9("guidedChaos").oninput = () => {
      set2("guidedChaosValue", $9("guidedChaos").value + "%");
      panel.querySelectorAll("[data-chaos]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.chaos === $9("guidedChaos").value)));
    };
    panel.querySelectorAll("[data-chaos]").forEach((b) => b.onclick = () => {
      $9("guidedChaos").value = b.dataset.chaos;
      $9("guidedChaos").oninput();
    });
    $9("guidedShuffle").onclick = () => {
      $9("guidedSeed").value = crypto.getRandomValues(new Uint32Array(1))[0] % 2147483648;
    };
    $9("guidedSpeed").onchange = () => {
      $9("journeySpeed").value = $9("guidedSpeed").value;
      $9("journeySpeed").dispatchEvent(new Event("change"));
    };
    $9("guidedRoute").onclick = route;
    $9("guidedEditTraffic").onclick = choose;
    $9("guidedViewResults").onclick = () => showWorkspace("results", { focus: true });
    $9("guidedOtherMode").onclick = () => {
      showWorkspace("results");
      document.querySelector(`#ordinaryComparisonPanels [data-mode="${p.journey?.driving_mode === "NORMAL" ? "ROBOSPHERE" : "NORMAL"}"] .run-mode-cta`)?.click();
    };
    $9("guidedInspectSetup").onclick = () => {
      setupOpen = !setupOpen;
      panel.classList.toggle("inspect-running-setup", setupOpen);
      $9("guidedInspectSetup").setAttribute("aria-expanded", String(setupOpen));
    };
    panel.querySelectorAll("[data-step]").forEach((li) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Edit";
      b.className = "step-edit";
      b.setAttribute("aria-label", "Edit " + li.querySelector("span").textContent);
      b.onclick = () => li.dataset.step === "destination" ? route() : choose();
      li.append(b);
    });
    const renderPlaces = () => {
      const query = $9("guidedDestinationSearch").value.toLocaleLowerCase(), places = (tools2.catalog?.places || []).filter((v) => v.name.toLocaleLowerCase().includes(query)).sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite)).slice(0, 4);
      const key = JSON.stringify([p.sessionId, query, places]);
      if (key === placeKey) return;
      placeKey = key;
      $9("guidedPlaceResults").replaceChildren(...places.map((place) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = (place.favorite ? "\u2605 " : "") + place.name;
        b.onclick = () => tools2.choose(place.id);
        return b;
      }));
      if (!places.length) $9("guidedPlaceResults").textContent = tools2.catalog ? "No matching places. Choose on the map." : "Waiting for native destinations.";
    };
    $9("guidedDestinationSearch").oninput = renderPlaces;
    $9("guidedPrimary").onclick = () => {
      if (action === "connect") {
        if (simulatorNeedsStart(p)) p.startSimulation();
        else {
          p.reconnectNative();
          p.connect();
        }
        return;
      }
      if (action === "ownership") {
        p.takeControl();
        return;
      }
      if (action === "acknowledge") {
        p.acknowledgeStop();
        return;
      }
      if (action === "stop") {
        stop("operator_stop");
        return;
      }
      if (action === "destination") {
        route();
        return;
      }
      if (action === "drive") {
        modeChoice = true;
        return;
      }
      if (action === "traffic") {
        choose();
        return;
      }
      if (action === "behaviour") {
        if (validate()) {
          choosing = false;
          review = true;
        }
        return;
      }
      if (action !== "prepare" || !validate()) return;
      if (preparation.request({
        ...p.population.requested,
        vehicle_count: TRAFFIC_COUNT,
        pedestrian_count: PEDESTRIAN_COUNT,
        seed: Number($9("guidedSeed").value),
        chaos_percent: Number($9("guidedChaos").value),
        placement: "EGO_SURROUNDING",
        vehicle_mix: "MIXED"
      })) {
        submitting = true;
        review = true;
        $9("guidedPrimary").disabled = true;
      }
    };
    panel.querySelectorAll("[data-mode]").forEach((button) => button.onclick = () => {
      if (action !== "drive" || button.disabled) return;
      const blocked = modeBlockedReason(p, p.getVehicleState(), trafficPrepared(p, preparation));
      if (blocked) {
        p.operationError = blocked;
        return;
      }
      selectedMode = button.dataset.mode;
      if (startJourney2(selectedMode, p.journey?.prepared_pair_id) !== false) {
        startPending = true;
        panel.querySelectorAll("[data-mode]").forEach((b) => b.disabled = true);
      }
    });
    return { chooseMode(value, { restoring = false } = {}) {
      modeChoice = true;
      selectedMode = value;
      recoveryPending = restoring;
    }, update(vehicle) {
      const routeKey = routeDestinationKey(p.route);
      if (session !== p.sessionId || destination !== routeKey) {
        session = p.sessionId;
        destination = routeKey;
        choosing = review = submitting = false;
        startPending = false;
      }
      const key = p.sessionId + ":" + p.journey?.prepared_pair_id + ":" + p.journey?.prepared_mode;
      if (p.journey?.prepared_pair_id && key !== preparedKey) {
        preparedKey = key;
        modeChoice = true;
        selectedMode = p.journey.prepared_mode;
        $9("guidedSpeed").value = $9("journeySpeed").value = String(p.journey.speed_kmh);
      }
      const configured = trafficPrepared(p, preparation), failed = preparation.state?.status === "FAILED";
      if (submitting && configured) {
        choosing = review = submitting = false;
      } else if (submitting && failed) {
        submitting = false;
        review = true;
      }
      action = guidedStep(p, vehicle, configured, choosing);
      if (action === "traffic" && (review || failed)) action = "prepare";
      if (p.journey?.status === "STARTING" || p.journey?.status === "RUNNING" || p.operationError) startPending = false;
      const running = ["RUNNING", "STARTING"].includes(p.journey?.status), ended = !!p.journey?.pair_id && !running && p.journey.status !== "READY" && p.journeyComparison?.pair_id === p.journey.pair_id;
      body.classList.toggle("journey-active", running);
      panel.classList.toggle("journey-running", running);
      $9("guidedDestination").hidden = action !== "destination";
      if (action === "destination") renderPlaces();
      $9("guidedBehaviour").hidden = action !== "behaviour";
      $9("guidedPreparation").hidden = !["prepare", "pending"].includes(action);
      set2("guidedPreparationTitle", failed ? "Road preparation failed" : action === "pending" ? "Preparing the road\u2026" : "Verify your road traffic");
      set2("guidedPreparationDetail", failed ? preparation.state.reason : action === "pending" ? "Waiting for native placement confirmation. Vehicle held." : $9("guidedChaos").value + "% randomness \xB7 seed " + $9("guidedSeed").value);
      const names = { connect: simulatorNeedsStart(p) ? "Start Simulation" : "Connect to Simulator", starting: "Starting simulation\u2026", "journey-starting": "Starting your drive\u2026", ownership: "Take Vehicle Control", acknowledge: "\u0641\u0643 \u0625\u064A\u0642\u0627\u0641 \u0627\u0644\u0637\u0648\u0627\u0631\u0626", stop: "\u0625\u064A\u0642\u0627\u0641 \u0627\u0644\u0639\u0631\u0628\u064A\u0629", pending: "Preparing road traffic\u2026", traffic: "Configure Traffic", behaviour: "Continue to preparation", prepare: failed ? "Retry preparation" : "Apply Road Traffic", destination: "Choose on Map", drive: "Start Driving" };
      set2("guidedPrimary", p.isReplay ? "Recorded replay" : names[action]);
      const blocked = action === "drive" ? recoveryPending ? "Restore the saved comparison setup before driving." : modeBlockedReason(p, vehicle, configured) : ["behaviour", "prepare"].includes(action) ? trafficPreparationReason(p, vehicle) : "";
      $9("guidedPrimary").disabled = ["pending", "starting", "journey-starting"].includes(action) || p.isReplay || !!blocked || startPending;
      $9("guidedPrimary").hidden = action === "drive" && modeChoice;
      $9("guidedModeChoices").hidden = action !== "drive" || !modeChoice;
      panel.querySelectorAll("[data-mode]").forEach((b) => {
        b.disabled = action !== "drive" || !!blocked || startPending;
        b.title = blocked || "";
        b.setAttribute("aria-pressed", String(selectedMode === b.dataset.mode));
      });
      const hints = { connect: simulatorNeedsStart(p) ? "Launch CARLA with the vehicle held." : "Reconnect this dashboard. Movement requires an explicit start.", starting: "CARLA and its sensors are starting. Vehicle held.", ownership: "This dashboard is observing. Taking control leaves the vehicle held.", acknowledge: "Acknowledgement releases the latch and keeps the vehicle stopped.", stop: p.safetySystem?.active ? p.safetySystem.reason || "Safety intervention active" : "Stop finalizes this run and keeps its recording.", pending: "Driving stays blocked until preparation is confirmed.", traffic: "Choose how traffic should behave.", behaviour: "These settings have not been applied yet.", prepare: "Apply the selected settings to this route.", destination: "Select a destination without moving the vehicle.", drive: modeChoice ? "Select a mode to begin driving and recording." : "Road traffic confirmed. Choose your driving mode." };
      set2("guidedStatus", p.isReplay ? "Recorded data \xB7 vehicle controls are unavailable. Use Pause replay below the camera." : p.operationError || blocked || (startPending ? "Start requested. Waiting for backend acceptance." : hints[action]));
      panel.dataset.error = String(!!p.operationError || failed);
      const crowd = p.population?.route_crowding, live = p.fresh && !p.isReplay;
      set2("guidedLiveCounts", !live ? "Live measurements unavailable" : configured ? `Surrounding traffic \xB7 ${p.population.actual.vehicles}/${p.population.requested.vehicle_count} vehicles \xB7 ${p.population.actual.pedestrians}/${p.population.requested.pedestrian_count} pedestrians` : `Live city \xB7 ${p.population?.actual?.vehicles ?? "\u2014"} vehicles \xB7 ${p.population?.actual?.pedestrians ?? "\u2014"} pedestrians`);
      $9("guidedJourneyOptions").hidden = action !== "drive";
      $9("guidedRoute").hidden = !["traffic", "behaviour", "prepare", "drive"].includes(action);
      $9("guidedEditTraffic").hidden = action !== "drive";
      $9("guidedViewResults").hidden = !ended;
      $9("guidedOtherMode").hidden = !ended;
      set2("guidedActiveMode", p.journey?.driving_mode === "NORMAL" ? "Normal Mode" : "Ya Rab Ostorha Mode");
      set2("guidedActiveDestination", p.route?.destination?.name || "Destination journey");
      set2("guidedActiveTraffic", `${p.population?.requested?.chaos_percent ?? "\u2014"}% randomness \xB7 ${p.journeyComparison?.runs?.[p.journey?.driving_mode]?.duration_s?.toFixed(1) ?? "\u2014"} s`);
      $9("guidedActiveSummary").hidden = !running;
      set2("guidedHeadingDetail", ended ? { ARRIVED: "Destination reached and stopped", COLLISION: "Run ended with a collision", ERROR: "Run failed", PAUSED: "Run interrupted" }[p.journey.status] || "Review the saved run." : "Choose a road. Then compare both modes.");
      panel.querySelector(".guided-heading h2").textContent = running ? "Simulation active" : ended ? "Run recorded" : "Prepare your drive";
      const order = ["destination", "behaviour", "traffic", "drive"], step = action === "traffic" ? "behaviour" : ["prepare", "pending"].includes(action) ? "traffic" : action === "stop" || action === "journey-starting" ? "drive" : action, current = order.indexOf(step);
      panel.querySelectorAll("[data-step]").forEach((el2) => {
        const index = order.indexOf(el2.dataset.step), complete = running || current > index;
        el2.setAttribute("aria-current", el2.dataset.step === step ? "step" : "false");
        el2.dataset.complete = String(complete);
        el2.querySelector("b").textContent = complete ? "\u2713" : String(index + 1).padStart(2, "0");
        el2.querySelector(".step-edit").hidden = !complete || running || el2.dataset.step === "drive";
        if (el2.dataset.step === "destination") el2.querySelector("span").textContent = complete ? p.route?.destination?.name || "Destination selected" : "Choose destination";
        if (el2.dataset.step === "traffic") el2.querySelector("span").textContent = complete ? "Road ready" : "Prepare the road";
      });
      set2("guidedPredictionStatus", predictionView2.message || "Waiting for measured tracks");
    } };
  }

  // frontend/journey-continuity.js
  function journeyActive(p) {
    return p.fresh && p.connected && p.controller && !p.isReplay && !p.restarting && !["EMERGENCY_STOP", "DISCONNECTED", "REPLAY"].includes(p.controlMode) && (p.controlMode === "AUTOMATIC" || p.journey?.status === "STARTING") && ["STARTING", "RUNNING"].includes(p.journey?.status);
  }
  function keepJourneyOnInspection(p, hidden) {
    return !hidden && journeyActive(p);
  }
  function journeyHeartbeatAllowed(p, hidden, manualOverridePending2) {
    return !hidden && !manualOverridePending2 && journeyActive(p);
  }

  // frontend/provider.js
  var SimulationProvider = class {
    getVehicleState() {
      throw new Error("getVehicleState must be implemented");
    }
    getEngineState() {
      return this.getVehicleState();
    }
    getDamageState() {
      return this.getVehicleState().damage;
    }
    getSensorFrame() {
      throw new Error("Sensor unavailable");
    }
    updateControls() {
      throw new Error("updateControls must be implemented");
    }
  };

  // frontend/simulation-client.js
  function unavailableState() {
    return {
      source: "carla",
      timestamp: null,
      physicsTick: null,
      speedMps: null,
      accelerationMps2: null,
      steeringAngleRad: null,
      steeringWheelAngleRad: null,
      throttle: null,
      brake: null,
      gear: null,
      engineRPM: null,
      engineRunning: null,
      fuelLevelL: null,
      fuelCapacityL: null,
      instantConsumptionLph: null,
      positionWorldM: null,
      velocityWorldMps: null,
      steeringInput: null,
      frame: null,
      reverse: null
    };
  }
  var SimulationClient = class extends SimulationProvider {
    constructor({
      fetcher = (...args) => globalThis.fetch(...args),
      Socket = globalThis.WebSocket,
      location = globalThis.location,
      now = () => performance.now(),
      schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
      cancel = (timer) => globalThis.clearTimeout(timer)
    } = {}) {
      super();
      Object.assign(this, { fetcher, Socket, location, now, schedule, cancel });
      this.telemetry = unavailableState();
      this.world = {};
      this.connected = false;
      this.controller = false;
      this.status = "CARLA \u2014 DISCONNECTED";
      this.phase = "DISCONNECTED";
      this.sequence = 0;
      this.pending = /* @__PURE__ */ new Map();
      this.sensorMetadata = {};
      this.sensorRates = {};
      this.sensorErrors = {};
      this.latencyMs = null;
      this.receivedAt = -Infinity;
      this.gearCommand = 1;
      this.retryMs = 1e3;
      this.closed = false;
      this.isReplay = false;
      this.controlMode = "DISCONNECTED";
      this.replay = null;
      this.lastFrame = this.lastTimestamp = null;
      this.route = this.dashboardResult = this.operationError = null;
      this.safetySystem = null;
      this.comparisonDemo = null;
      this.comparisonV2 = null;
      this.recordedComparisonV2 = null;
      this.stopDiagnostics = null;
      this.rearAssist = false;
      this.manualDrivingMode = "ROBOSPHERE";
      this.navigationAvailable = false;
      this.lastControlSentAt = -Infinity;
      this.lastManualFrame = null;
      this.simulatorStart = null;
      this.starting = false;
    }
    get simulationStarting() {
      return this.starting || this.simulatorStart?.status === "STARTING";
    }
    async startSimulation() {
      return this.requestSimulationStart(false);
    }
    async resetSimulation() {
      return this.requestSimulationStart(true);
    }
    async requestSimulationStart(reset) {
      if (this.closed || this.isReplay) return false;
      if (!reset && this.connected && this.fresh) return true;
      if (this.simulationStarting) return false;
      this.operationError = null;
      this.starting = true;
      this.resetting = reset;
      this.resetReady = false;
      this.resetSession = this.sessionId;
      this.simulatorStart = { status: "STARTING", ...reset ? { operation: "RESET" } : {} };
      this.startTimer = this.schedule(() => {
        this.starting = false;
        this.resetting = false;
        this.simulatorStart = { status: "FAILED", error: "Simulation startup timed out. Check runtime details and retry." };
        this.operationError = this.simulatorStart.error;
      }, 18e4);
      try {
        const response = await this.fetcher(reset ? "/api/simulation/reset-session" : "/api/simulation/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const result = await response.json();
        if (!response.ok || result.status === "FAILED") throw new Error(result.error || "Simulation could not start. Retry from this button.");
        this.retryMs = 1e3;
        await this.connect();
        return true;
      } catch (error) {
        this.cancel(this.startTimer);
        this.startTimer = null;
        this.starting = false;
        this.resetting = false;
        this.simulatorStart = { status: "FAILED", error: error.message };
        this.operationError = error.message;
        return false;
      }
    }
    async connect() {
      if (this.closed || this.connecting || this.socket?.readyState <= 1) return;
      this.cancel(this.retryTimer);
      this.retryTimer = null;
      this.connecting = true;
      this.phase = "STARTING";
      const abort = new AbortController();
      this.connectTimer = this.schedule(() => {
        abort.abort();
        const expiredSocket = this.socket;
        this.socket = null;
        expiredSocket?.close();
        this.disconnect("Connection timeout; controls suspended");
        this.retry();
      }, 5e3);
      try {
        const response = await this.fetcher("/api/simulation/status", { cache: "no-store", signal: abort.signal });
        if (!response.ok) throw new Error("Application backend unavailable");
        const status = await response.json();
        if (!status.configured || !["carla", "replay"].includes(status.provider) || !status.websocketPort)
          throw new Error(status.error || "CARLA must be running with its matching Python API");
        if (this.closed || abort.signal.aborted) return;
        const socket = new this.Socket(`${this.location.protocol === "https:" ? "wss" : "ws"}://${this.location.hostname}:${status.websocketPort}`);
        this.socket = socket;
        socket.onmessage = (event) => {
          if (socket !== this.socket) return;
          try {
            this.acceptSnapshot(JSON.parse(event.data));
          } catch {
            this.disconnect("Invalid backend telemetry");
            socket.close();
          }
        };
        socket.onclose = () => {
          if (socket !== this.socket) return;
          this.socket = null;
          this.disconnect("CARLA connection closed; controls released");
          this.retry();
        };
        socket.onerror = () => {
          this.disconnect("CARLA connection error; controls released");
          socket.close();
        };
      } catch (error) {
        this.cancel(this.connectTimer);
        this.connectTimer = null;
        this.disconnect(error.message);
        this.retry();
      } finally {
        this.connecting = false;
      }
    }
    acceptSnapshot(message) {
      if (message.type === "error") {
        this.operationError = message.error;
        return;
      }
      if (message.type !== "snapshot") return;
      if (message.sessionId && this.sessionId && message.sessionId !== this.sessionId) this.disconnect("New native session");
      this.sessionId = message.sessionId ?? this.sessionId;
      this.journey = message.journey ?? {};
      this.journeyComparison = message.journeyComparison ?? this.journeyComparison ?? null;
      this.hybridDriving = message.hybridDriving ?? null;
      this.navigationAvailable = message.navigationAvailable === true;
      this.restarting = message.restarting ?? false;
      this.restartResult = message.restartResult ?? null;
      this.simulatorStop = message.simulatorStop ?? null;
      this.simulatorStart = message.simulatorStart ?? this.simulatorStart;
      this.simulatorReset = message.simulatorReset ?? null;
      if (this.simulatorStart?.status === "FAILED") {
        this.starting = false;
        this.cancel(this.startTimer);
        this.startTimer = null;
        this.operationError = this.simulatorStart.error;
      }
      this.performance = message.performance ?? {};
      this.controlSource = message.controlSource;
      this.recording = message.recording ?? false;
      this.dashboardResult = message.dashboardResult ?? null;
      this.route = message.route ?? null;
      this.population = message.population ?? null;
      this.environment = message.environment ?? null;
      this.safetySystem = message.safetySystem ?? null;
      this.comparisonDemo = message.comparisonDemo ?? null;
      this.comparisonV2 = message.comparisonV2 ?? null;
      if (this.comparisonV2) this.recordedComparisonV2 = {
        pair_id: this.comparisonV2.pair_id,
        seed: this.comparisonV2.seed,
        results: this.comparisonV2.results,
        latest_attempt: this.comparisonV2.latest_attempt
      };
      this.stopDiagnostics = message.stopDiagnostics ?? null;
      this.lastDriveStop = message.lastDriveStop ?? null;
      this.rearAssist = message.rearAssist === true;
      this.manualDrivingMode = message.manualDrivingMode ?? this.manualDrivingMode;
      this.displayCamera = message.displayCamera ?? null;
      this.motionQuality = message.motionQuality ?? null;
      this.maneuver = message.maneuver ?? null;
      this.controlScene = message.controlScene ?? null;
      this.controlSceneError = message.controlSceneError ?? null;
      this.controlDecisionPrediction = message.controlDecisionPrediction ?? null;
      this.nearbyActors = message.nearbyActors ?? null;
      const replay = message.mode === "REPLAY" && message.provider === "replay" && message.connected === false && message.available === true && message.replay?.dataOrigin === "REAL_SIMULATION";
      const sourceValid = replay ? message.vehicle?.source === message.replay.recordedProvider && message.world?.source === message.replay.recordedProvider : message.connected === true && message.mode !== "REPLAY" && message.provider !== "replay" && message.vehicle?.source === "carla" && message.world?.source === "carla";
      const live = sourceValid && Number.isInteger(message.vehicle.frame) && message.vehicle.frame >= 0 && Number.isFinite(message.vehicle.timestamp) && message.vehicle.timestamp >= 0 && message.world.frame === message.vehicle.frame && message.world.timestamp === message.vehicle.timestamp;
      if (!live) {
        this.disconnect(message.error || "Waiting for live CARLA telemetry");
        if (message.error) this.phase = "ERROR";
      } else {
        if (!replay && this.lastFrame != null && (message.vehicle.frame < this.lastFrame || message.vehicle.timestamp < this.lastTimestamp || message.vehicle.frame === this.lastFrame && message.vehicle.timestamp !== this.lastTimestamp || message.vehicle.frame > this.lastFrame && message.vehicle.timestamp <= this.lastTimestamp)) {
          this.disconnect("Out-of-order native observations; controls suspended");
          this.phase = "ERROR";
          return;
        }
        const newFrame = replay || message.vehicle.frame !== this.lastFrame;
        this.connected = !replay;
        this.isReplay = replay;
        this.phase = replay ? "REPLAY" : "CONNECTED";
        if (!replay && this.starting && (!this.resetting || message.sessionId !== this.resetSession)) {
          this.resetReady = !!this.resetting;
          this.resetting = false;
          this.starting = false;
          this.cancel(this.startTimer);
          this.startTimer = null;
          this.simulatorStart = { ...this.simulatorStart, status: "READY" };
          this.operationError = null;
        }
        this.controlMode = replay ? "REPLAY" : message.mode ?? "MANUAL";
        this.replay = replay ? message.replay : null;
        this.cancel(this.connectTimer);
        this.connectTimer = null;
        this.world = message.world ?? {};
        this.controller = !replay && message.controller === true;
        this.telemetry = message.vehicle;
        if (newFrame || this.controlMode === "PAUSED") this.receivedAt = this.now();
        this.lastFrame = message.vehicle.frame;
        this.lastTimestamp = message.vehicle.timestamp;
        this.retryMs = 1e3;
        this.status = replay ? `MODE: REPLAY \xB7 Recorded run ${message.replay.runId} \xB7 No simulator connection` : this.controller ? `CARLA \u2014 CONNECTED \xB7 ${this.controlMode.replaceAll("_", " ")}` : "CARLA \u2014 CONNECTED \xB7 READ ONLY";
        this.sensorMetadata = message.sensors ?? {};
        this.sensorRates = message.sensorRatesHz ?? {};
        this.sensorErrors = message.sensorErrors ?? {};
      }
      const sent = this.pending.get(message.acknowledged);
      if (sent != null) {
        this.latencyMs = this.now() - sent;
      }
      if (Number.isInteger(message.acknowledged)) for (const sequence of this.pending.keys()) {
        if (sequence <= message.acknowledged) this.pending.delete(sequence);
      }
    }
    disconnect(reason) {
      this.cancel(this.connectTimer);
      this.connectTimer = null;
      this.connected = this.controller = false;
      this.telemetry = unavailableState();
      this.world = {};
      this.sensorMetadata = {};
      this.sensorRates = {};
      this.sensorErrors = {};
      this.displayCamera = this.motionQuality = this.maneuver = null;
      this.controlScene = this.controlSceneError = this.controlDecisionPrediction = null;
      this.pending.clear();
      this.latencyMs = null;
      this.gearCommand = 1;
      this.lastManualFrame = null;
      this.status = reason;
      this.phase = "DISCONNECTED";
      this.isReplay = false;
      this.controlMode = "DISCONNECTED";
      this.replay = null;
      this.lastFrame = this.lastTimestamp = null;
      this.route = null;
      this.navigationAvailable = false;
      this.population = this.nearbyActors = null;
      this.environment = null;
      this.safetySystem = null;
      this.comparisonDemo = null;
      this.comparisonV2 = null;
      this.stopDiagnostics = null;
      this.rearAssist = false;
    }
    retry() {
      if (this.closed || this.retryTimer) return;
      this.retryTimer = this.schedule(() => {
        this.retryTimer = null;
        this.connect();
      }, this.retryMs);
      this.retryMs = Math.min(15e3, this.retryMs * 2);
    }
    get fresh() {
      return (this.connected || this.isReplay) && this.now() - this.receivedAt < 750;
    }
    getVehicleState() {
      return this.fresh ? this.telemetry : unavailableState();
    }
    async getSensorFrame(name) {
      const response = await this.fetcher(`/api/simulation/sensor?name=${encodeURIComponent(name)}`, { cache: "no-store" });
      const frame = await response.json();
      if (!response.ok) throw new Error(frame.error);
      return frame;
    }
    send(type, payload = {}) {
      if (this.closed || this.isReplay || this.socket?.readyState !== 1) return false;
      if (this.restarting || this.simulationStarting) return false;
      if (trafficCommandBlocked(this.trafficPreparation, type, payload)) {
        return false;
      }
      const comparisonStart = type === "comparison_v2" && payload.value?.operation === "RUN";
      if (!["reconnect", "stop_simulator"].includes(type) && (!this.connected || !this.fresh || !this.controller && !comparisonStart && !["start_driving", "start_journey", "take_control"].includes(type))) return false;
      if (type === "controls" && ["PAUSED", "EMERGENCY_STOP", "DISCONNECTED"].includes(this.controlMode)) return false;
      if (type === "controls" && this.now() - this.lastControlSentAt < 30) return false;
      const sequence = ++this.sequence;
      this.pending.set(sequence, this.now());
      if (this.pending.size > 40) this.pending.delete(this.pending.keys().next().value);
      this.socket.send(JSON.stringify({ type, sequence, frame_id: this.telemetry.frame, timestamp_s: this.telemetry.timestamp, ...payload }));
      if (type === "controls") this.lastControlSentAt = this.now();
      return true;
    }
    startDriving(driving_mode = null) {
      this.operationError = null;
      this.lastManualFrame = null;
      return this.send("start_driving", driving_mode ? { driving_mode } : {});
    }
    startJourney(speed_kmh, driving_mode = null, pair_id = null, benchmark = false) {
      this.operationError = null;
      return this.send("start_journey", { speed_kmh, ...driving_mode ? { driving_mode } : {}, ...pair_id ? { pair_id } : {}, ...benchmark ? { benchmark: true } : {} });
    }
    journeyHeartbeat() {
      return this.send("journey_heartbeat", { session_id: this.sessionId });
    }
    journeySpeed(speed_kmh) {
      this.operationError = null;
      return this.send("journey_speed", { speed_kmh });
    }
    stopDriving(reason = "operator_stop") {
      return this.send("stop_driving", { reason });
    }
    takeControl() {
      return this.send("take_control");
    }
    stopSimulator() {
      this.operationError = null;
      return this.send("stop_simulator");
    }
    reconnectNative() {
      this.operationError = null;
      return this.send("reconnect");
    }
    dashboardAction(type, value) {
      this.operationError = null;
      return this.send(type, { value });
    }
    async catalog() {
      const response = await this.fetcher("/api/simulation/catalog", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    }
    updateControls({ throttle = 0, brake = 0, steering = 0, parkingbrake = 0 } = {}) {
      if (this.telemetry.frame === this.lastManualFrame) return false;
      const controls2 = { throttle, brake, steering, parkingbrake };
      if (this.gearCommand != null) controls2.gear = this.gearCommand;
      if (this.send("controls", { controls: controls2 })) {
        this.lastManualFrame = this.telemetry.frame;
        this.gearCommand = null;
        return true;
      }
      return false;
    }
    setGear(gear) {
      this.gearCommand = gear;
    }
    resetVehicle() {
      this.gearCommand = 1;
      return this.send("reset");
    }
    setPaused(paused) {
      this.releaseControls();
      this.send("pause", { paused });
    }
    releaseControls() {
      this.cancel(this.releaseTimer);
      if (!this.send("controls", { controls: { throttle: 0, brake: 1, steering: 0, parkingbrake: 0 } }) && this.connected && this.controller && !this.isReplay) {
        this.releaseTimer = this.schedule(() => {
          this.releaseTimer = null;
          this.send("controls", { controls: { throttle: 0, brake: 1, steering: 0, parkingbrake: 0 } });
        }, 35);
      }
    }
    emergencyStop() {
      return this.send("emergency_stop");
    }
    acknowledgeStop() {
      return this.send("acknowledge_stop");
    }
    async setReplayPaused(paused) {
      if (!this.isReplay) return false;
      const response = await this.fetcher("/api/simulation/replay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused }) });
      if (!response.ok) throw new Error("Replay playback request failed");
      return true;
    }
    close() {
      this.releaseControls();
      this.closed = true;
      this.cancel(this.retryTimer);
      this.retryTimer = null;
      this.cancel(this.connectTimer);
      this.connectTimer = null;
      this.cancel(this.releaseTimer);
      this.releaseTimer = null;
      this.cancel(this.startTimer);
      this.startTimer = null;
      this.socket?.close();
      this.disconnect("Disconnected");
    }
  };

  // frontend/controls.js
  var DrivingControls = class {
    constructor() {
      this.clear();
    }
    clear() {
      this.keys = /* @__PURE__ */ new Set();
      this.reverseSince = null;
      this.mode = "D";
      this.gear = 1;
    }
    setMode(mode) {
      this.mode = mode;
      this.reverseSince = null;
    }
    sample(speedMps, nowMs) {
      const w = this.keys.has("KeyW"), s = this.keys.has("KeyS");
      const result = {
        throttle: 0,
        brake: 0,
        steering: Number(this.keys.has("KeyA")) - Number(this.keys.has("KeyD")),
        parkingbrake: this.keys.has("Space") ? 1 : 0,
        gear: this.gear
      };
      if (!Number.isFinite(speedMps)) return { ...result, brake: 1, steering: 0 };
      if (this.keys.has("Space") || w && s) {
        this.reverseSince = null;
        return { ...result, brake: 1 };
      }
      if (this.mode === "N") {
        this.gear = result.gear = 0;
        result.brake = Number(s);
        return result;
      }
      if (w) {
        this.reverseSince = null;
        const oppositeMotion = this.mode === "R" ? speedMps > 0.35 : speedMps < -0.35;
        const boost = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
        const speedLimitMps = (boost ? 80 : 30) / 3.6;
        const forwardSpeed = Math.max(0, speedMps);
        const remaining = Math.max(0, speedLimitMps - forwardSpeed);
        const pedal = boost ? Math.min(1, remaining / 3) : Math.min(0.55, remaining / 3);
        result.brake = Number(oppositeMotion);
        result.throttle = oppositeMotion ? 0 : this.mode === "R" ? 0.55 : pedal;
        if (!oppositeMotion && this.mode === "D" && forwardSpeed > speedLimitMps)
          result.brake = Math.min(0.35, Math.max(0.05, (forwardSpeed - speedLimitMps) / 4));
        if (!oppositeMotion) this.gear = result.gear = this.mode === "R" ? -1 : 1;
      } else if (s) {
        if (this.mode === "R") {
          result.brake = 1;
          return result;
        }
        if (speedMps > 0.35) {
          this.reverseSince = null;
          result.brake = 1;
        } else {
          this.reverseSince ??= nowMs;
          if (speedMps < -0.35 || nowMs - this.reverseSince >= 300) {
            this.gear = result.gear = -1;
            result.throttle = 1;
          } else result.brake = 1;
        }
      } else this.reverseSince = null;
      return result;
    }
  };

  // frontend/telemetry.js
  var n = (value, scale = 1) => Number.isFinite(value) ? (value * scale).toFixed(2) : "unavailable";
  var vec = (value) => value?.map((v) => n(v)).join(" / ") || "unavailable";
  function telemetryText(t, { latencyMs, sensorRates = {}, sensorErrors = {}, world = {}, mode = "DISCONNECTED" } = {}) {
    return [
      `MODE: ${mode.replaceAll("_", " ")} \xB7 ${mode === "REPLAY" ? "RECORDED OBSERVATIONS" : "LIVE OBSERVATIONS ONLY"}`,
      "VEHICLE",
      `Speed magnitude ${n(t.speedMagnitudeMps, 3.6)} km/h \xB7 Signed longitudinal speed ${n(t.speedMps)} m/s`,
      `Longitudinal acceleration ${n(t.accelerationMps2)} m/s\xB2`,
      `Steering input ${n(t.steeringInput)} (positive right; normalized input, not wheel angle)`,
      `Throttle ${n(t.throttle, 100)}% \xB7 Brake ${n(t.brake, 100)}%`,
      `Gear ${t.gear ?? "unavailable"} \xB7 Reverse ${t.reverse ?? "unavailable"} \xB7 Handbrake ${t.handbrake ?? "unavailable"}`,
      `Position ${vec(t.positionWorldM)} m \xB7 Velocity ${vec(t.velocityWorldMps)} m/s`,
      `Angular velocity ${vec(t.angularVelocityWorldRadps)} rad/s`,
      "PHYSICS \xB7 LIMITATIONS",
      "RPM / wheel dynamics: native 0.9.16 API; mapping and validation pending",
      "Fuel / mechanical engine damage / suspension compression: unavailable",
      "Collision: native event frame/time, other actor and impulse; no component damage inferred",
      "SENSORS \xB7 NATIVE DATA ONLY",
      ...Object.entries({ frontCamera: "RGB", depth: "Depth", radar: "Radar", lidar: "LiDAR", imu: "IMU", gnss: "GNSS", collision: "Collision" }).map(([key, label]) => `${label}: ${n(sensorRates[key])} Hz${sensorErrors[key] ? ` \xB7 ERROR ${sensorErrors[key]}` : ""}`),
      "SIMULATION",
      `CARLA ${world.version ?? "unavailable"} \xB7 API ${world.pythonApiVersion ?? "unavailable"}`,
      `Map ${world.map ?? "unavailable"} \xB7 Frame ${t.frame ?? "unavailable"} \xB7 Time ${n(t.timestamp)} s`,
      `Fixed step ${n(world.fixedDeltaSeconds)} s \xB7 Synchronous ${world.synchronous ?? "unavailable"}`,
      `Backend round trip ${n(latencyMs)} ms`,
      "Sensor frames keep their native IDs/timestamps; unmatched frames are not fused."
    ].join("\n");
  }

  // frontend/sensor-frame.js
  function sensorFrameKey(metadata) {
    if (!metadata?.frameAvailable || !Number.isInteger(metadata.frame) || metadata.frame < 0 || !Number.isFinite(metadata.timestamp) || metadata.timestamp < 0) return null;
    return JSON.stringify([metadata.frame, metadata.timestamp, metadata.asset?.path ?? null]);
  }
  function matchesSensorResponse(metadata, headers) {
    if (sensorFrameKey(metadata) === null) return false;
    const frame = headers.get("X-Sensor-Frame"), timestamp = headers.get("X-Sensor-Time");
    if (frame === null || timestamp === null || frame.trim() === "" || timestamp.trim() === "") return false;
    return Number(frame) === metadata.frame && Number.isInteger(Number(frame)) && Number.isFinite(Number(timestamp)) && Math.abs(Number(timestamp) - metadata.timestamp) <= 1e-6;
  }

  // frontend/dashboard-tools.js
  var $3 = (id) => document.getElementById(id);
  var weatherFields = {
    cloudiness: "settingCloud",
    precipitation: "settingRain",
    wetness: "settingWet",
    fog_density: "settingFog",
    sun_altitude_angle: "settingSun",
    sun_azimuth_angle: "settingSunAzimuth"
  };
  var svgNamespace = "http://www.w3.org/2000/svg";
  var DashboardTools = class {
    constructor(provider2, controls2, clearControls2, options = {}) {
      Object.assign(this, { provider: provider2, controls: controls2, clearControls: clearControls2, options });
      this.catalog = null;
      this.session = null;
      this.loading = false;
      this.retryAt = 0;
      this.selectedPlace = null;
      this.result = null;
      this.panel = null;
      this.panelTrigger = null;
      this.restartAfterSave = null;
      this.restartSeen = null;
      this.lightingPending = false;
      this.recordingPath = "";
      this.cameraChange = null;
      const populationAction = (operation) => {
        clearControls2();
        provider2.dashboardAction("population", operation);
      };
      $3("clearTrafficBtn").onclick = () => populationAction("clear_traffic");
      $3("clearPedestriansBtn").onclick = () => populationAction("clear_pedestrians");
      $3("resetPopulationBtn").onclick = () => populationAction("reset");
      $3("respawnPopulationBtn").onclick = () => populationAction("respawn");
      const scenario = (operation) => {
        clearControls2();
        provider2.dashboardAction("scenario", { operation });
      };
      $3("loadScenarioBtn").onclick = () => {
        clearControls2();
        provider2.dashboardAction("scenario", {
          operation: "load",
          scenario_type: $3("scenarioType").value,
          seed: Number($3("scenarioSeed").value),
          split: $3("scenarioSplit").value,
          difficulty: Number($3("scenarioDifficulty").value)
        });
      };
      $3("resetScenarioBtn").onclick = () => scenario("reset");
      $3("startScenarioBtn").onclick = () => scenario("start");
      $3("stopScenarioBtn").onclick = () => scenario("stop");
      $3("livingCityBtn").onclick = () => {
        clearControls2();
        provider2.dashboardAction("environment", "LIVING_CITY");
      };
      $3("scenarioSplit").onchange = () => {
        $3("scenarioSeed").value = { TRAIN: 42, VALIDATION: 1042, TEST: 2042 }[$3("scenarioSplit").value];
      };
      $3("settingWorldProfile").onchange = () => {
        const profile = this.catalog?.urban_world_profiles?.[$3("settingWorldProfile").value];
        if (profile) {
          $3("settingTrafficCount").value = profile.vehicle_count;
          $3("settingPedestrianCount").value = profile.pedestrian_count;
        }
      };
      $3("recordRunBtn").onclick = () => {
        clearControls2();
        provider2.dashboardAction("recording", { enabled: !provider2.recording });
      };
      $3("applyRadiusBtn").onclick = () => provider2.dashboardAction("inspector", Number($3("nearbyRadius").value));
      $3("clearRouteBtn").onclick = () => provider2.dashboardAction("clear_route", null);
      $3("worldResetBtn").onclick = () => {
        clearControls2();
        provider2.dashboardAction("world_reset", null);
      };
      $3("applySceneBtn").onclick = () => {
        if (this.catalog?.scenes?.[$3("settingScene").value]) {
          clearControls2();
          provider2.dashboardAction("scene", $3("settingScene").value);
        }
      };
      $3("applyProfileBtn").onclick = () => {
        const profile = this.catalog?.profiles?.[$3("settingProfile").value];
        if (profile) {
          clearControls2();
          provider2.dashboardAction("settings", { population: profile.population });
        }
      };
      for (const id of Object.values(weatherFields)) $3(id).oninput = () => {
        $3("settingWeather").value = "CUSTOM";
        this.updateLightingValue();
      };
      $3("settingWeather").onchange = () => {
        const values = this.catalog?.settings.weather_preset_values?.[$3("settingWeather").value];
        if (values) for (const [key, id] of Object.entries(weatherFields)) $3(id).value = values[key];
        this.updateLightingValue();
      };
      $3("applyLightingBtn").onclick = () => {
        clearControls2();
        this.lightingPending = provider2.dashboardAction("settings", { weather: { sun_altitude_angle: Number($3("settingSun").value) } });
        $3("lightingStatus").textContent = this.lightingPending ? "Applying scene lighting\u2026" : "Take control in connection settings first.";
      };
      $3("applyViewDistanceBtn").onclick = () => this.restartGraphics({
        quality: $3("settingQuality").value,
        resolution: this.catalog?.settings.active_launch?.resolution || $3("settingWindow").value
      });
      $3("phoneToggleBtn").onclick = () => this.toggle("inGamePhone", "phoneToggleBtn");
      $3("mapDestinationsBtn").onclick = () => this.open("inGamePhone", "mapDestinationsBtn");
      $3("settingsBtn").onclick = () => {
        this.toggle("settingsPanel", "settingsBtn");
        this.load(true);
      };
      $3("connectionSetupBtn").onclick = () => {
        this.open("settingsPanel", "connectionSetupBtn");
        $3("connectionSettings").open = true;
        $3("connectionSettings").scrollIntoView({ block: "start", behavior: this.scrollBehavior() });
        $3("connectionSettings").querySelector("summary").focus({ preventScroll: true });
        this.load(true);
      };
      $3("sensorBtn").onclick = () => this.toggle("sensorPanel", "sensorBtn");
      $3("routeBtn").onclick = () => this.toggle("routePanel", "routeBtn");
      $3("miniMapToggle").onclick = () => this.toggle("routePanel", "miniMapToggle");
      $3("routeMap").onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.open("inGamePhone", "routeMap");
        }
      };
      for (const [panel, button] of [["inGamePhone", "closePhoneBtn"], ["settingsPanel", "closeSettingsBtn"], ["sensorPanel", "closeSensorBtn"], ["routePanel", "closeMapBtn"]])
        $3(button).onclick = () => this.close();
      $3("panelBackdrop").onclick = () => this.close();
      document.addEventListener("keydown", (event) => {
        if (event.code === "Escape") {
          if (this.panel) this.close();
          else if ($3("cameraCard").classList.contains("camera-expanded")) this.expandCamera(false);
        }
        if (event.key === "Tab" && this.panel) {
          const elements = [...$3(this.panel).querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter((el2) => el2.getClientRects().length && !el2.closest("[inert]"));
          if (!elements.length) return;
          const first = elements[0], last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      });
      $3("startSimulationBtn").onclick = () => {
        clearControls2();
        provider2.startSimulation();
      };
      $3("nativeDisconnectBtn").onclick = () => {
        clearControls2();
        provider2.dashboardAction("disconnect");
      };
      $3("takeControlBtn").onclick = () => {
        clearControls2();
        provider2.takeControl();
      };
      $3("expandCameraBtn").onclick = () => this.expandCamera(!$3("cameraCard").classList.contains("camera-expanded"));
      $3("cameraView").onchange = () => {
        const requested = $3("cameraView").value, confirmed = this.catalog?.settings?.camera_view;
        if (requested === confirmed) return;
        this.controls.keys.clear();
        const previousResult = provider2.dashboardResult?.operationId;
        if (provider2.dashboardAction("settings", { camera_view: requested }))
          this.cameraChange = { requested, confirmed, previousResult, status: "pending" };
        else {
          this.cameraChange = { requested, confirmed, status: "failed", error: "Take control before changing the camera." };
          if (confirmed) $3("cameraView").value = confirmed;
        }
      };
      $3("settingsForm").onsubmit = (event) => {
        event.preventDefault();
        this.apply();
      };
      $3("cleanImageBtn").onclick = () => {
        $3("settingResolution").value = "800x450";
        $3("settingPostprocess").checked = false;
        $3("settingMotionBlur").value = 0;
        $3("settingBloom").value = 0;
        $3("settingsStatus").textContent = "Clear image settings ready. Select Apply changes to activate.";
      };
      $3("restartGraphicsBtn").onclick = () => this.restartGraphics({ quality: $3("settingQuality").value, resolution: $3("settingWindow").value });
      $3("destinationSearch").oninput = () => {
        this.selectedPlace = null;
        this.renderPlaces();
      };
      $3("chooseDestinationBtn").onclick = () => {
        const text = $3("destinationSearch").value.trim();
        const place = this.selectedPlace || this.catalog?.places.find((p) => p.name === text || p.id === text);
        if (!place) {
          $3("destinationStatus").textContent = "Choose a destination from the search results first.";
          return;
        }
        this.choose(place.id);
      };
      $3("savePlaceBtn").onclick = () => {
        const name = $3("savePlaceName").value.trim() || "Saved place " + (/* @__PURE__ */ new Date()).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
        clearControls2();
        provider2.dashboardAction("save_place", name);
      };
      $3("routeMap").onclick = (event) => {
        if (!this.project || !this.inverse) return;
        const point = $3("routeMap").createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const matrix2 = $3("routeMap").getScreenCTM();
        if (!matrix2) return;
        const nativePoint = point.matrixTransform(matrix2.inverse());
        this.choose({ location: this.inverse([nativePoint.x, nativePoint.y]) });
      };
    }
    scrollBehavior() {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    }
    expandCamera(enlarged) {
      $3("cameraCard").classList.toggle("camera-expanded", enlarged);
      if (!$3("expandCameraBtn").classList.contains("camera-icon-button")) $3("expandCameraBtn").textContent = enlarged ? "Shrink image" : "Expand image";
      $3("expandCameraBtn").setAttribute("aria-label", enlarged ? "Restore camera size" : "Expand camera");
      $3("expandCameraBtn").setAttribute("aria-expanded", String(enlarged));
      if (!enlarged) $3("expandCameraBtn").focus({ preventScroll: true });
    }
    open(panel, trigger) {
      if (this.panel === panel) return;
      const advanced = $3("advancedSetupDialog");
      if (advanced?.open) advanced.close();
      const scenarios = $3("cockpitScenarios"), returnToScenarios = scenarios?.open && panel === "routePanel";
      if (scenarios?.open) scenarios.close();
      this.close(false);
      this.returnToScenarios = returnToScenarios;
      if (this.provider.controlMode === "MANUAL" || this.options.isManualArmed?.()) this.clearControls("modal_inspection");
      this.panel = panel;
      this.panelTrigger = trigger;
      $3(panel).hidden = false;
      $3(panel).querySelector(".section-heading").append($3("emergencyStopBtn"));
      $3("panelBackdrop").hidden = false;
      document.body.classList.add("panel-open");
      for (const element of document.querySelectorAll(".app-header,.workspace,.app-footer,.skip-link,.studio-rail")) element.inert = true;
      $3(trigger)?.setAttribute("aria-expanded", "true");
      $3(panel).querySelector("button")?.focus();
      if (panel === "inGamePhone") this.load();
    }
    close(returnFocus = true) {
      if (!this.panel) return;
      $3(this.panel).hidden = true;
      $3("panelBackdrop").hidden = true;
      (document.querySelector(".cockpit-header-actions") || document.querySelector(".app-header")).append($3("emergencyStopBtn"));
      document.body.classList.remove("panel-open");
      for (const element of document.querySelectorAll(".app-header,.workspace,.app-footer,.skip-link,.studio-rail")) element.inert = false;
      $3(this.panelTrigger)?.setAttribute("aria-expanded", "false");
      if (returnFocus) $3(this.panelTrigger)?.focus();
      this.panel = null;
      if (this.returnToScenarios && returnFocus) document.body.classList.add("studio-setup-open");
      this.returnToScenarios = false;
    }
    toggle(panel, trigger) {
      if (this.panel === panel) this.close();
      else this.open(panel, trigger);
    }
    choose(value) {
      this.clearControls();
      const accepted = this.provider.dashboardAction("destination", value);
      $3("destinationStatus").textContent = $3("mapSelectionStatus").textContent = accepted ? "Planning from the current vehicle position\u2026" : "Take control in connection settings before selecting a destination.";
      if (accepted) this.close();
    }
    async load(force = false) {
      if (this.loading || !this.provider.fresh || this.provider.isReplay || !force && (this.catalog || performance.now() < this.retryAt)) return;
      this.loading = true;
      const session = this.provider.sessionId;
      try {
        const catalog = await this.provider.catalog();
        if (session !== this.provider.sessionId || !this.provider.fresh) return;
        this.catalog = catalog;
        this.fillSettings();
        this.renderPlaces();
        this.renderRoads();
      } catch (error) {
        this.retryAt = performance.now() + 2e3;
        $3("settingsStatus").textContent = error.message;
      } finally {
        this.loading = false;
      }
    }
    renderPlaces() {
      const list = $3("placeResults");
      list.replaceChildren();
      const query = $3("destinationSearch").value.trim().toLocaleLowerCase();
      const places = this.catalog?.places.filter((p) => p.name.toLocaleLowerCase().includes(query) || String(p.road_id).includes(query)) ?? [];
      const groups = /* @__PURE__ */ new Map();
      for (const place of places) {
        const name = place.favorite ? "Favorites \u2605" : place.id.startsWith("saved-") ? "Your saved places" : place.sector ? place.sector + " \xB7 Road " + place.road_id : "Available places";
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(place);
      }
      for (const [name, entries] of [...groups].sort(([a], [b]) => Number(b === "Favorites \u2605") - Number(a === "Favorites \u2605"))) {
        const title = document.createElement("div");
        title.className = "place-group";
        title.textContent = name;
        list.append(title);
        for (const place of entries) {
          const button = document.createElement("button");
          button.className = "place-option";
          button.type = "button";
          button.textContent = place.name;
          button.dataset.placeId = place.id;
          button.classList.toggle("selected", this.selectedPlace?.id === place.id);
          button.onclick = () => {
            this.selectedPlace = place;
            $3("destinationSearch").value = place.name;
            this.renderPlaces();
            $3("chooseDestinationBtn").focus();
          };
          button.setAttribute("aria-pressed", String(this.selectedPlace?.id === place.id));
          const row = document.createElement("div");
          row.className = "place-row";
          row.setAttribute("role", "listitem");
          const star = document.createElement("button");
          star.type = "button";
          star.className = "place-favorite";
          star.textContent = place.favorite ? "\u2605" : "\u2606";
          star.setAttribute("aria-label", (place.favorite ? "Remove from favorites: " : "Add to favorites: ") + place.name);
          star.disabled = !this.provider.fresh || !this.provider.controller || this.provider.isReplay;
          star.title = star.disabled ? "Take control in connection settings first" : "Favorites persist after reconnection";
          star.onclick = () => this.provider.dashboardAction("favorite_place", place.id);
          row.append(button, star);
          list.append(row);
        }
      }
      if (!places.length) list.textContent = this.catalog ? "No results. Try an area name or select from the map." : "Waiting for map CARLA\u2026";
    }
    updateLightingValue() {
      const altitude = Number($3("settingSun").value);
      const phase = altitude < -6 ? "Night" : altitude <= 6 ? "Twilight" : altitude < 30 ? "Low sun" : "Daylight";
      $3("lightingValue").textContent = phase + " \xB7 " + altitude + "\xB0";
    }
    restartGraphics(launch) {
      this.restartAfterSave = launch;
      this.clearControls();
      const sent = this.provider.dashboardAction("settings", { next_launch: launch });
      if (!sent) this.restartAfterSave = null;
      $3("restartStatus").textContent = $3("viewDistanceStatus").textContent = sent ? "Saving settings before restarting CARLA\u2026" : "Take control in connection settings first.";
    }
    fillSettings() {
      const s = this.catalog.settings;
      const population = s.population?.requested || s.population_saved;
      for (const [id, entries] of [
        ["settingVehicle", s.vehicle_options.map((p) => [p.id, p.name])],
        ["settingSpawn", s.spawn_options.map((p) => [p.index, p.name])],
        ["settingWeather", [["CUSTOM", "Custom"], ...s.weather_presets.map((name) => [name, { ClearNoon: "Clear \u2014 Noon", CloudyNoon: "Cloudy \u2014 Noon", WetNoon: "Wet ground", WetCloudyNoon: "Wet and cloudy", MidRainyNoon: "Moderate rain", HardRainNoon: "Heavy rain", SoftRainNoon: "Light rain", ClearSunset: "Clear sunset", CloudySunset: "Cloudy sunset", WetSunset: "Wet sunset", HardRainSunset: "Heavy rain sunset" }[name] || name])]],
        ["settingProfile", Object.entries(this.catalog.profiles || {}).map(([name, p]) => [name, name + " \xB7 " + p.population.vehicle_count + " / " + p.population.pedestrian_count])]
      ]) {
        const select = $3(id), previous = select.value;
        select.replaceChildren();
        for (const [value, text] of entries) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = text;
          select.append(option);
        }
        if (id === "settingProfile" && entries.some(([value]) => value === previous)) select.value = previous;
      }
      const fields = {
        settingVehicle: s.vehicle,
        settingSpawn: s.spawn_index,
        settingResolution: s.camera_resolution,
        settingFov: s.camera_fov,
        settingHz: s.simulation_hz,
        settingQuality: s.next_launch.quality,
        settingWindow: s.next_launch.resolution,
        settingTrafficCount: population.vehicle_count,
        settingPedestrianCount: population.pedestrian_count,
        settingTrafficSpeed: population.speed_behavior,
        settingFastWalk: population.fast_walk_percent,
        settingSeed: population.seed,
        settingDriverBehavior: population.driver_behavior ?? "NORMAL",
        settingCompliance: population.light_compliance_percent ?? 90,
        settingCrossing: population.crossing_percent ?? 5,
        settingWorldProfile: population.world_profile ?? "TRAINING_DEVELOPMENT",
        settingWeather: s.weather_preset,
        cameraView: s.camera_view,
        settingMotionBlur: s.camera_motion_blur,
        settingBloom: s.camera_bloom
      };
      for (const [id, value] of Object.entries(fields)) $3(id).value = value ?? 0;
      $3("settingPostprocess").checked = s.camera_postprocess === true;
      for (const [key, id] of Object.entries(weatherFields)) $3(id).value = s.weather[key];
      this.updateLightingValue();
      const applied = s.active_launch;
      const distance = { Low: "Near \xB7 Low \xB7 about 50 m", Epic: "Far \xB7 Epic \xB7 full distance" };
      $3("activeViewDistance").textContent = "Applied: " + (distance[applied?.quality] || "Unavailable");
      $3("activeGraphics").textContent = applied ? "Applied: " + (applied.render_profile || applied.quality || "unknown") + " \xB7 " + (applied.resolution || "unknown resolution") + (applied.offscreen ? " \xB7 displayed in dashboard" : "") : "Applied graphics settings are unavailable.";
      $3("effectsNote").textContent = s.camera_effects?.note || "";
      $3("weatherApplied").textContent = "Applied weather: " + s.weather_preset;
      if (!Object.keys(this.catalog.profiles || {}).length) {
        const option = document.createElement("option");
        option.textContent = "Waiting for performance measurements";
        $3("settingProfile").append(option);
      }
    }
    apply() {
      if (!this.catalog) return;
      const number3 = (id) => Number($3(id).value), current = this.catalog.settings;
      const data = {
        weather: Object.fromEntries(Object.entries(weatherFields).map(([key, id]) => [key, number3(id)])),
        next_launch: { quality: $3("settingQuality").value, resolution: $3("settingWindow").value },
        population: {
          ...this.provider.population?.requested || current.population?.requested || current.population_saved,
          vehicle_count: number3("settingTrafficCount"),
          pedestrian_count: number3("settingPedestrianCount"),
          speed_behavior: $3("settingTrafficSpeed").value,
          fast_walk_percent: number3("settingFastWalk"),
          seed: number3("settingSeed"),
          driver_behavior: $3("settingDriverBehavior").value,
          light_compliance_percent: number3("settingCompliance"),
          crossing_percent: number3("settingCrossing"),
          world_profile: $3("settingWorldProfile").value
        }
      };
      if ($3("settingWeather").value !== "CUSTOM") {
        delete data.weather;
        data.weather_preset = $3("settingWeather").value;
      }
      const candidates = {
        vehicle: $3("settingVehicle").value,
        spawn_index: number3("settingSpawn"),
        camera_view: $3("cameraView").value,
        camera_resolution: $3("settingResolution").value,
        camera_fov: number3("settingFov"),
        simulation_hz: number3("settingHz"),
        camera_postprocess: $3("settingPostprocess").checked,
        camera_motion_blur: number3("settingMotionBlur"),
        camera_bloom: number3("settingBloom")
      };
      for (const [key, value] of Object.entries(candidates)) if (value !== current[key]) data[key] = value;
      this.clearControls();
      $3("settingsStatus").textContent = this.provider.dashboardAction("settings", data) ? "Applying live settings\u2026" : "Take control in connection settings first.";
    }
    disable(id, reason) {
      const button = $3(id);
      button.disabled = !!reason;
      button.title = reason || "";
    }
    render(state, controllable) {
      const p = this.provider;
      if (this.session !== p.sessionId) {
        this.lightingPending = false;
        this.session = p.sessionId;
        this.catalog = null;
        this.selectedPlace = null;
        this.result = null;
        this.cameraChange = null;
        this.project = this.inverse = null;
        $3("roadGeometry").replaceChildren();
        $3("routeLine").setAttribute("d", "");
        $3("miniRoadGeometry").replaceChildren();
        $3("miniRouteLine").setAttribute("d", "");
        $3("miniRouteCar").setAttribute("hidden", "");
        $3("miniRouteTarget").setAttribute("hidden", "");
        $3("mapEmpty").hidden = false;
        $3("routeCar").setAttribute("hidden", "");
        $3("routeTarget").setAttribute("hidden", "");
      }
      const blocked = p.isReplay ? "Replay is read-only; driving is disabled" : p.restarting ? "Restarting CARLA" : !p.fresh ? "Waiting for native connection to CARLA" : "";
      const ownerBlocked = blocked || (!p.controller ? "Take control in connection settings" : "");
      for (const star of document.querySelectorAll(".place-favorite")) {
        star.disabled = !!ownerBlocked;
        star.title = ownerBlocked || "Favorites persist after reconnection";
      }
      const emergency = p.controlMode === "EMERGENCY_STOP" ? "Acknowledge the emergency stop first" : "";
      this.disable("startDrivingBtn", blocked || emergency);
      const journeyBusy = ["STARTING", "RUNNING"].includes(p.journey?.status);
      const destinationPending = p.dashboardResult?.action === "destination" && p.dashboardResult.status === "PENDING";
      const journeyBlocked = blocked || emergency || (!p.navigationAvailable ? "Journeys are unavailable in this mode" : "") || (destinationPending ? "Planning route\u2026" : "") || (!p.route ? "Choose a valid destination and show its route first" : "") || (journeyBusy ? "Journey running; stop it before starting again" : "") || (p.route?.arrived && state.speedMagnitudeMps < 0.15 ? "Vehicle is already at the destination; choose another" : "");
      for (const id of ["startJourneyBtn", "phoneJourneyBtn", "driveJourneyBtn"]) this.disable(id, journeyBlocked);
      this.disable("journeySpeed", ownerBlocked || emergency);
      $3("journeySpeedApplied").textContent = journeyBusy ? "Current target speed: " + p.journey.speed_kmh + " km/h; the lower road limit takes priority." : "5\u201330 km/h. You can change it during the journey.";
      const resume = p.route && p.journey?.route_id === p.route.id && ["PAUSED", "ERROR"].includes(p.journey?.status);
      for (const id of ["startJourneyBtn", "driveJourneyBtn"]) $3(id).textContent = resume ? "Resume journey to destination" : "Go to destination";
      $3("phoneJourneyBtn").textContent = resume ? "Resume journey to current destination" : "Go to current destination";
      $3("journeyAvailability").textContent = $3("phoneJourneyAvailability").textContent = $3("driveJourneyAvailability").textContent = journeyBlocked || "Destination: " + p.route.destination.name + (resume ? " \u2014 saved; resume from your current position." : " \u2014 Select Go to start the destination journey.");
      this.disable("pauseBtn", ownerBlocked || emergency);
      this.disable("emergencyStopBtn", ownerBlocked);
      this.disable("acknowledgeStopBtn", ownerBlocked);
      $3("acknowledgeStopBtn").hidden = !emergency;
      for (const id of ["cameraView", "chooseDestinationBtn", "savePlaceBtn", "nativeDisconnectBtn", "resetBtn"])
        this.disable(id, ownerBlocked);
      const comparisonBlocked = comparisonV2Busy(p.comparisonV2) || comparisonV2Busy(p.comparisonDemo) ? "Stop the recorded run before changing settings" : "";
      const configurationBlocked = ownerBlocked || comparisonBlocked || (p.recording ? "Finish recording before changing sensor settings" : "");
      this.disable("applySettingsBtn", configurationBlocked);
      this.disable("applyLightingBtn", configurationBlocked || (!this.catalog ? "Reading settings" : "") || (this.lightingPending ? "Applying lighting" : "") || comparisonBlocked);
      this.disable("worldResetBtn", configurationBlocked);
      for (const id of ["restartGraphicsBtn", "applyViewDistanceBtn"]) this.disable(id, configurationBlocked || (!this.catalog ? "Reading settings" : "") || comparisonBlocked || (this.restartAfterSave ? "Saving graphics settings" : "") || (state.speedMagnitudeMps > 0.15 ? "Stop the vehicle first" : ""));
      this.disable("startSimulationBtn", p.isReplay ? "Replay not connected to simulator" : p.simulationStarting ? "Starting the simulation" : p.restarting ? "Restarting" : p.connected && p.fresh ? "Simulation is running" : "");
      $3("startSimulationBtn").textContent = p.simulationStarting ? "Starting the simulation\u2026" : "Start the simulation";
      this.disable("takeControlBtn", blocked);
      this.disable("drivingMode", blocked || emergency);
      this.disable("clearRouteBtn", ownerBlocked || (!p.route ? "No active route" : ""));
      $3("modeExplanation").textContent = p.isReplay ? "Recorded data and camera; native driving disabled." : "Go drives the vehicle to the destination. Enable manual driving prepares the keyboard for driving.";
      $3("manualHint").textContent = p.isReplay ? "Keyboard sends no driving commands during Replay." : "Select Take manual control first, then use W/A/S/D. The route remains available after takeover.";
      $3("drivingInstruction").textContent = blocked || emergency || (!p.controller ? "Another page controls the vehicle. Take control in settings." : p.controlMode === "AUTOMATIC" ? "Autonomous drive active. Use Take manual control before the keyboard." : controllable ? "Keyboard ready. W+Shift increases throttle from 55% to 100%." : "Vehicle held by command safety. Enable manual driving to move.");
      const reasons = {
        manual_intervention: "Manual control taken",
        dashboard_heartbeat_timeout: "Dashboard heartbeat lost",
        destination_reached: "Destination reached and vehicle stopped",
        collision: "Journey stopped after collision",
        controls_released: "Control stopped",
        operator_stop: "Driving stopped",
        focus_lost: "Dashboard lost focus",
        workspace_changed: "Stopped when leaving the driving workspace",
        route_ended_before_destination: "Route ended far from destination; select the route again",
        page_closed: "Driving page closed",
        ownership_taken: "Control transferred to this page",
        fresh_native_session: "New session; explicitly choose driving to begin"
      };
      const statuses = {
        IDLE: "",
        READY: "Route ready",
        STARTING: "Starting journey",
        RUNNING: "Destination journey running",
        PAUSED: "Journey paused",
        ARRIVED: "Arrived",
        ERROR: "Journey could not complete"
      };
      $3("journeyStatus").textContent = p.route ? p.isReplay ? "Recorded route; driving disabled" : (statuses[p.journey?.status] || "Route ready") + (p.journey?.reason ? " \xB7 " + (reasons[p.journey.reason] || p.journey.reason) : "") : "";
      const population = p.population;
      $3("trafficActual").textContent = population?.actual.vehicles ?? "\u2014";
      $3("pedestrianActual").textContent = population?.actual.pedestrians ?? "\u2014";
      const health = p.isReplay ? "Recorded frame counts; no connection to Traffic Manager" : population ? "TM " + (population.traffic_manager_connected ? "connected" : "disconnected") + " \xB7 active walkers " + population.actual.walkers_active + " \xB7 requested " + population.requested.vehicle_count + " / " + population.requested.pedestrian_count + " \xB7 last spawn NPC " + population.npc_spawned + " \xB7 failed NPC " + population.npc_failed + " / walkers " + population.walkers_failed + " \xB7 native removals " + population.vehicles_removed_native + " vehicle / " + population.walkers_lost + " walkers" : "Waiting for population data";
      $3("populationHealth").textContent = $3("populationApplied").textContent = health;
      const environment = p.environment, training = environment?.mode === "TRAINING";
      $3("environmentStatus").textContent = environment ? environment.mode + " \xB7 " + environment.scenario_phase + (environment.scenario ? " \xB7 " + environment.scenario.scenario_id + " \xB7 seed " + environment.scenario.random_seed + " \xB7 level " + environment.scenario.difficulty : "") : "Environment unavailable";
      $3("safetyPolicyStatus").textContent = p.safetySystem ? "YA RAB OSTORHA \xB7 " + p.safetySystem.controller + " \xB7 " + p.safetySystem.status + " \xB7 generator " + p.safetySystem.actual_generator + " \xB7 model " + p.safetySystem.model_health + " \xB7 control " + (p.controlSource ?? "unavailable") : "Safety sensors unavailable";
      $3("policyObservationStatus").textContent = environment?.observation_status ? "Observation " + environment.observation_status.status + " \xB7 history " + environment.observation_status.history_frames + " \xB7 ground truth excluded" : "Waiting for synchronized policy observations";
      $3("scenarioOutcome").textContent = environment?.outcome ? JSON.stringify(environment.outcome, null, 2) : "No outcome yet";
      const scenarioBlocked = ownerBlocked || (p.recording ? "Finish recording before changing scenario lifecycle" : "");
      this.disable("loadScenarioBtn", scenarioBlocked);
      this.disable("resetScenarioBtn", scenarioBlocked || (!training ? "Load a scenario first" : ""));
      this.disable("startScenarioBtn", ownerBlocked || (environment?.scenario_phase !== "READY" ? "Reset or load a ready scenario" : ""));
      this.disable("stopScenarioBtn", ownerBlocked || (environment?.scenario_phase !== "RUNNING" ? "No running scenario" : ""));
      this.disable("livingCityBtn", scenarioBlocked || (!training ? "Living city is already selected" : ""));
      const local = population?.local_counts;
      if (local) $3("populationHealth").textContent += " \xB7 within 120 m: " + local.vehicles_120m + " vehicles / " + local.walkers_120m + " walkers";
      $3("recordRunBtn").textContent = p.recording ? "Stop recording" : "Start recording";
      $3("recordRunBtn").dataset.recording = String(!!p.recording);
      $3("recordingStatus").textContent = (p.recording ? "Recording camera and sensor data." : "Recording stopped.") + (this.recordingPath ? " " + this.recordingPath : "");
      for (const id of ["recordRunBtn", "clearTrafficBtn", "clearPedestriansBtn", "resetPopulationBtn", "respawnPopulationBtn", "applyRadiusBtn", "applySceneBtn"]) this.disable(id, ownerBlocked || comparisonBlocked);
      this.disable("applyProfileBtn", ownerBlocked || (!Object.keys(this.catalog?.profiles || {}).length ? "Performance measurements are incomplete" : ""));
      if (training) for (const id of ["clearTrafficBtn", "clearPedestriansBtn", "resetPopulationBtn", "respawnPopulationBtn", "applySceneBtn", "applySettingsBtn", "applyProfileBtn", "applyLightingBtn", "applyViewDistanceBtn"])
        this.disable(id, ownerBlocked || "Return to Living city before changing world settings");
      if (this.panel === "sensorPanel") {
        const native = p.nearbyActors;
        $3("trafficLightState").textContent = native?.traffic_light?.relevant ? "Actor " + native.traffic_light.actor_id + " \xB7 " + native.traffic_light.state + " \xB7 " + Math.round(native.traffic_light.distance_to_actor_origin_m) + " m to actor origin" : "Vehicle is not at a traffic light according to CARLA";
        $3("nearbyActors").textContent = native ? "Frame " + native.frame_id + " \xB7 Radius " + native.radius_m + " m\n" + native.actors.map((a) => a.category + " #" + a.actor_id + " " + a.type + "\n" + a.distance_m.toFixed(1) + " m \xB7 relative " + a.relative_position_m.map((v) => v.toFixed(1)).join("/") + " \xB7 velocity " + a.velocity_mps.map((v) => v.toFixed(1)).join("/")).join("\n\n") : "No live data";
      }
      if (p.operationError) {
        if (this.lightingPending) {
          $3("lightingStatus").textContent = p.operationError;
          this.lightingPending = false;
        }
        if (this.restartAfterSave) {
          $3("restartStatus").textContent = $3("viewDistanceStatus").textContent = p.operationError;
          this.restartAfterSave = null;
        }
        $3("operationStatus").textContent = p.operationError;
        this.errorShown = true;
      } else if (this.errorShown) {
        $3("operationStatus").textContent = "";
        this.errorShown = false;
      }
      if (p.dashboardResult && JSON.stringify(p.dashboardResult) !== this.result) {
        const result = p.dashboardResult;
        this.result = JSON.stringify(result);
        if (result.action === "settings" && this.cameraChange?.status === "pending" && result.operationId !== this.cameraChange.previousResult) {
          if (result.status === "APPLIED") this.cameraChange.status = "applied";
          if (result.status === "REJECTED") {
            this.cameraChange.status = "failed";
            this.cameraChange.error = result.error || "Camera change rejected.";
            if (this.cameraChange.confirmed) $3("cameraView").value = this.cameraChange.confirmed;
          }
        }
        if (result.status === "REJECTED") {
          $3("operationStatus").textContent = $3("settingsStatus").textContent = $3("destinationStatus").textContent = result.error;
          if (result.action === "destination") $3("mapSelectionStatus").textContent = result.error;
          this.restartAfterSave = null;
          if (this.lightingPending) {
            $3("lightingStatus").textContent = result.error;
            this.lightingPending = false;
          }
          $3("viewDistanceStatus").textContent = result.error;
        }
        if (result.status === "APPLIED") {
          if (result.action === "settings") {
            if (this.lightingPending) {
              $3("lightingStatus").textContent = "Scene lighting applied.";
              this.lightingPending = false;
            }
            $3("settingsStatus").textContent = "Live changes applied. Graphics saved for restart.";
            if (this.restartAfterSave) {
              p.dashboardAction("restart_graphics", this.restartAfterSave);
              this.restartAfterSave = null;
            }
            this.load(true);
          }
          if (result.action === "save_place") {
            $3("destinationStatus").textContent = "Place saved: " + result.result.name;
            this.load(true);
          }
          if (result.action === "favorite_place") {
            $3("destinationStatus").textContent = result.result.favorite ? "Destination added to favorites." : "Destination removed from favorites.";
            this.load(true);
          }
          if (result.action === "destination") $3("destinationStatus").textContent = $3("mapSelectionStatus").textContent = "Route ready to " + result.result.destination.name + "; select Go or drive manually.";
          if (result.action === "recording") this.recordingPath = result.result.path;
          if (result.action === "population") {
            $3("settingsStatus").textContent = "Population updated; actual counts appear in Living city.";
            this.load(true);
          }
          if (result.action === "scene") {
            $3("settingsStatus").textContent = "Seeded normal scene and weather applied.";
            this.load(true);
          }
          if (result.action === "world_reset") $3("settingsStatus").textContent = "Map created by restarting CARLA and verifying; vehicle stopped and population removed.";
        }
      }
      const restart = p.restartResult;
      if (restart && JSON.stringify(restart) !== this.restartSeen) {
        this.restartSeen = JSON.stringify(restart);
        const names = {
          STOPPING: "Vehicle and sensor cleanup",
          LAUNCHING: "Start CARLA",
          ROLLING_BACK: "Restore previous graphics settings",
          VERIFYING: "Inspect images, sensors and performance",
          APPLIED: "Graphics applied and verified",
          ROLLED_BACK: "Requested settings failed; previous settings restored",
          FAILED: "Failed to start CARLA"
        };
        $3("restartStatus").textContent = $3("viewDistanceStatus").textContent = (names[restart.status] || restart.status) + (restart.error ? " \xB7 " + restart.error : "");
        if (["APPLIED", "ROLLED_BACK"].includes(restart.status)) this.load(true);
      }
      this.load();
      $3("originPosition").textContent = state.positionWorldM?.map((v) => v.toFixed(1)).join(" / ") || "Waiting for vehicle position";
      this.renderRoute(p.route, state.positionWorldM);
    }
    renderRoads() {
      const roads = this.catalog?.roads;
      if (!roads) return;
      const [minX, minY, maxX, maxY] = roads.bounds;
      const scale = Math.min(750 / Math.max(1, maxX - minX), 280 / Math.max(1, maxY - minY));
      const offsetX = (800 - (maxX - minX) * scale) / 2, offsetY = (330 - (maxY - minY) * scale) / 2;
      $3("routeMap").setAttribute("viewBox", [offsetX - 15, offsetY - 15, (maxX - minX) * scale + 30, (maxY - minY) * scale + 30].join(" "));
      this.project = (p) => [offsetX + (p[0] - minX) * scale, offsetY + (p[1] - minY) * scale];
      this.inverse = (p) => [(p[0] - offsetX) / scale + minX, (p[1] - offsetY) / scale + minY, 0];
      const path = document.createElementNS(svgNamespace, "path");
      path.setAttribute("d", roads.segments.map((line) => "M" + this.project(line[0]).join(",") + "L" + this.project(line[1]).join(",")).join(" "));
      $3("roadGeometry").replaceChildren(path);
      $3("miniRoadGeometry").replaceChildren(path.cloneNode(true));
      this.mapScale = scale;
      $3("mapEmpty").hidden = roads.segments.length > 0;
    }
    renderRoute(route, car) {
      if (!this.project) return;
      const carVisible = this.provider.fresh && !!car;
      $3("routeCar").toggleAttribute("hidden", !carVisible);
      if (carVisible) {
        const [x2, y2] = this.project(car);
        $3("routeCar").setAttribute("cx", x2);
        $3("routeCar").setAttribute("cy", y2);
      }
      $3("miniRouteCar").toggleAttribute("hidden", !carVisible);
      $3("miniRouteTarget").toggleAttribute("hidden", !route);
      if (carVisible) {
        const [x2, y2] = this.project(car), span = 100 * this.mapScale;
        $3("miniRouteCar").setAttribute("cx", x2);
        $3("miniRouteCar").setAttribute("cy", y2);
        $3("miniRouteMap").setAttribute("viewBox", [x2 - span / 2, y2 - span / 2, span, span].join(" "));
      }
      $3("miniRouteHint").textContent = route ? Math.round(route.remaining_m) + " m \xB7 Map" : "Map";
      $3("miniRouteLine").setAttribute("d", route ? route.points.map((point, i) => (i ? "L" : "M") + this.project(point).join(",")).join(" ") : "");
      if (route) {
        const [x2, y2] = this.project(route.destination.location);
        $3("miniRouteTarget").setAttribute("cx", x2);
        $3("miniRouteTarget").setAttribute("cy", y2);
      }
      $3("routeTarget").toggleAttribute("hidden", !route);
      if (!route) {
        $3("routeLine").setAttribute("d", "");
        $3("routeDetail").textContent = "Click a road on the map or choose a destination from the list.";
        $3("turnInstruction").textContent = "";
        return;
      }
      $3("routeLine").setAttribute("d", route.points.map((point, i) => (i ? "L" : "M") + this.project(point).join(",")).join(" "));
      const [x, y] = this.project(route.destination.location);
      $3("routeTarget").setAttribute("cx", x);
      $3("routeTarget").setAttribute("cy", y);
      $3("routeDetail").textContent = route.destination.name + " \xB7 " + Math.round(route.remaining_m) + " m remaining";
      const names = { LEFT: "North", RIGHT: "Right", STRAIGHT: "Straight", CHANGELANELEFT: "Change lane left", CHANGELANERIGHT: "Change lane right" };
      $3("turnInstruction").textContent = route.next_instruction ? "Next direction: " + (names[route.next_instruction.action] || route.next_instruction.action) : "Follow the route to the destination.";
    }
  };

  // frontend/input-policy.js
  var DRIVING_KEYS = /* @__PURE__ */ new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"]);
  function isEditableTarget(target) {
    return !!target && (/INPUT|SELECT|TEXTAREA/.test(target.tagName) || target.isContentEditable);
  }
  function drivingInputAllowed({ fresh, replay, owner, focused, modal, mode, armed }) {
    return fresh && !replay && owner && focused && !modal && mode === "MANUAL" && armed;
  }

  // frontend/prediction-view.js
  function matrix(pose) {
    const { roll: r = 0, pitch: p = 0, yaw: y = 0 } = pose.rotation_rad || {};
    const cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
    return [
      [cp * cy, cy * sp * sr - sy * cr, -cy * sp * cr - sy * sr],
      [cp * sy, sy * sp * sr + cy * cr, -sy * sp * cr + cy * sr],
      [sp, -cp * sr, cp * cr]
    ];
  }
  var multiply = (m, v) => m.map((row) => row.reduce((a, x, i) => a + x * v[i], 0));
  function predictionWorldPoint(point, reference) {
    if (!reference?.position_m) return null;
    return multiply(matrix(reference), [point[0], point[1], point[2] ?? 0]).map((x, i) => x + reference.position_m[i]);
  }
  function projectPrediction(point, reference, camera) {
    if (!reference?.position_m || !camera?.worldTransform?.position_m || !camera.width || !camera.height || !camera.fovDeg) return null;
    const world = predictionWorldPoint([point[0], point[1], point[2] ?? 1], reference);
    const delta = world.map((x, i) => x - camera.worldTransform.position_m[i]);
    const cm = matrix(camera.worldTransform), local = multiply(cm[0].map((_, i) => cm.map((row) => row[i])), delta);
    if (local[0] <= 0.05) return null;
    const f = camera.width / (2 * Math.tan(camera.fovDeg * Math.PI / 360));
    return [(camera.width - 1) / 2 + f * local[1] / local[0], (camera.height - 1) / 2 - f * local[2] / local[0]];
  }
  function predictionMatches(prediction, session, camera) {
    return !!prediction && prediction.session_id === session && prediction.coordinate_frame === "EGO_AT_EVALUATION" && Number.isFinite(camera?.timestamp) && Math.abs(prediction.timestamp_s - camera.timestamp) <= 1e-6 && (!Number.isFinite(camera.frame) || prediction.evaluation_frame === camera.frame);
  }
  function measuredPredictionFresh(prediction, session, timestamp) {
    const age = timestamp - prediction?.timestamp_s;
    return !!prediction && prediction.session_id === session && Number.isFinite(age) && age >= 0 && age <= 0.75;
  }
  var visibleModes = (prediction) => {
    const confirmed = new Set(prediction.tracks.filter((t) => t.confirmed).map((t) => t.id)), counts = /* @__PURE__ */ new Map();
    return (prediction.trajectories || []).filter((mode) => {
      const n2 = counts.get(mode.track_id) || 0;
      if (!confirmed.has(mode.track_id) || n2 >= 3) return false;
      counts.set(mode.track_id, n2 + 1);
      return true;
    });
  };
  var PredictionView = class {
    constructor(provider2) {
      this.provider = provider2;
      this.observed = null;
      this.nextAt = 0;
      this.busy = false;
      this.message = "Waiting for measured tracks\u2026";
      this.imagePrediction = null;
      this.imageRequest = null;
      this.imageBusy = false;
      const host = document.getElementById("frontCameraView");
      host.style.position = "relative";
      this.canvas = document.createElement("canvas");
      this.canvas.className = "prediction-overlay";
      this.canvas.setAttribute("aria-hidden", "true");
      this.map = document.createElement("canvas");
      this.map.className = "prediction-surroundings";
      this.map.width = 180;
      this.map.height = 180;
      this.map.setAttribute("aria-label", "Measured surroundings including outside the camera view");
      this.drawMap(null);
      this.label = document.createElement("p");
      this.label.className = "prediction-label";
      this.label.setAttribute("role", "status");
      host.append(this.canvas, this.map, this.label);
      this.diagnostic = document.createElement("p");
      this.diagnostic.className = "prediction-diagnostic";
      document.getElementById("liveOperationStatus").append(this.diagnostic);
    }
    async pollFrame(camera) {
      const p = this.provider, key = p.sessionId + ":" + camera?.frame;
      if (!p.fresh || p.isReplay || !Number.isFinite(camera?.frame) || this.imageBusy || this.imageRequest === key) return;
      this.imageRequest = key;
      this.imageBusy = true;
      const session = p.sessionId;
      try {
        const response = await fetch("/api/simulation/prediction?frame_id=" + camera.frame, { cache: "no-store", signal: AbortSignal.timeout(1500) });
        const value = await response.json();
        if (p.sessionId === session) this.imagePrediction = value.status === "RUNNING" ? value.prediction : null;
      } catch {
        this.imagePrediction = null;
      } finally {
        this.imageBusy = false;
      }
    }
    async poll() {
      if (document.hidden) return;
      const p = this.provider;
      if (!p.fresh || p.isReplay) {
        this.observed = null;
        return;
      }
      if (this.busy || performance.now() < this.nextAt) return;
      this.busy = true;
      this.nextAt = performance.now() + 300;
      const session = p.sessionId;
      try {
        const response = await fetch("/api/simulation/prediction", { cache: "no-store", signal: AbortSignal.timeout(2e3) });
        if (!response.ok) throw new Error("Prediction observer unavailable");
        const result = await response.json();
        if (p.sessionId !== session || !p.fresh) return;
        this.observed = result.status === "RUNNING" && result.prediction?.session_id === session ? result.prediction : null;
        if (!this.observed) this.message = result.error || "Waiting for measured tracks\u2026";
      } catch (error) {
        this.observed = null;
        this.message = error.message;
      } finally {
        this.busy = false;
      }
    }
    draw(camera) {
      this.poll();
      this.pollFrame(camera);
      const p = this.provider, latest = p.safetySystem?.prediction || this.observed, img = document.getElementById("authoritativeCamera");
      const applied = latest?.applied_decision_prediction;
      const appliedFresh = applied && measuredPredictionFresh(applied, p.sessionId, p.telemetry?.timestamp ?? camera?.timestamp);
      const principal = appliedFresh ? applied : latest;
      this.currentPrediction = principal;
      const measured = (p.fresh || p.isReplay) && measuredPredictionFresh(principal, p.sessionId, p.telemetry?.timestamp ?? camera?.timestamp) ? principal : null;
      this.map.hidden = false;
      const mapKey = [p.sessionId, measured?.timestamp_s, measured?.display_source].join(":");
      if (mapKey !== this.mapKey) {
        this.mapKey = mapKey;
        this.drawMap(measured);
      }
      this.label.hidden = !measured || img.hidden;
      if (measured) {
        const age = Math.max(0, (p.telemetry?.timestamp ?? camera.timestamp) - measured.timestamp_s);
        this.message = `${measured.display_source || measured.decision_source} \xB7 ${measured.tracks.filter((t) => t.confirmed).length} confirmed tracks \xB7 measurement age ${age.toFixed(1)} s. ${measured.model_reason || ""}`;
        const conflict2 = measured.conflict_point;
        const context = appliedFresh ? "Applied decision forecast" : "Display forecast";
        const supplementary = latest?.supplementary_model_candidates?.length ?? 0;
        this.label.textContent = (conflict2 ? `${context} \xB7 overlap in ${conflict2.time_s.toFixed(1)} s` : context) + (supplementary ? ` \xB7 ${supplementary} supplementary model candidates` : "");
        this.label.dataset.tone = conflict2 ? "amber" : "neutral";
      } else this.message = p.fresh ? "Waiting for fresh measured motion\u2026" : "Motion observations unavailable";
      const prediction = predictionMatches(latest, p.sessionId, camera) ? latest : this.imagePrediction;
      const ok = (p.fresh || p.isReplay) && !img.hidden && predictionMatches(prediction, p.sessionId, camera);
      this.canvas.hidden = !ok;
      const diagnostic = p.stopDiagnostics;
      this.diagnostic.textContent = diagnostic?.braking ? `${diagnostic.decision_source} \xB7 ${diagnostic.reason || "Brake applied"} \xB7 sensor age ${(diagnostic.sensor_wall_age_s ?? 0).toFixed(2)} s` : "";
      if (!ok) return;
      const bounds = img.getBoundingClientRect(), host = img.parentElement.getBoundingClientRect();
      const scale = Math.min(bounds.width / camera.width, bounds.height / camera.height);
      const width = camera.width * scale, height = camera.height * scale;
      Object.assign(this.canvas.style, { left: bounds.left - host.left + (bounds.width - width) / 2 + "px", top: bounds.top - host.top + (bounds.height - height) / 2 + "px", width: width + "px", height: height + "px" });
      if (this.canvas.width !== camera.width || this.canvas.height !== camera.height) {
        this.canvas.width = camera.width;
        this.canvas.height = camera.height;
      }
      const ctx = this.canvas.getContext("2d"), conflict = prediction.conflict_point;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const red = ["STOPPING", "BRAKING"].includes(p.safetySystem?.status), color = red ? "#D9254F" : "#81551B";
      const project = (point) => projectPrediction(point, prediction.render_reference, camera);
      const visible = this.visualOptions?.trajectories === false ? [] : visibleModes(prediction);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      for (const mode of visible) {
        ctx.strokeStyle = mode.source.includes("TRAJECTRON") ? "#753CF7" : "#4B84FC";
        ctx.beginPath();
        let begun = false;
        for (const row of mode.points) {
          const q = project([row[1], row[2], 0.3]);
          if (!q) {
            begun = false;
            continue;
          }
          begun ? ctx.lineTo(...q) : ctx.moveTo(...q);
          begun = true;
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const maneuver = p.maneuver;
      if (this.visualOptions?.trajectories !== false && maneuver?.selected_path && Math.abs(maneuver.timestamp_s - camera.timestamp) <= 0.1 && maneuver.render_reference) {
        ctx.strokeStyle = "#00BA69";
        ctx.lineWidth = 3;
        ctx.beginPath();
        let begun = false;
        for (const row of maneuver.selected_path) {
          const q = projectPrediction([row[1], row[2], 0.15], maneuver.render_reference, camera);
          if (!q) {
            begun = false;
            continue;
          }
          begun ? ctx.lineTo(...q) : ctx.moveTo(...q);
          begun = true;
        }
        ctx.stroke();
      }
      if (conflict && this.visualOptions?.safety !== false) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.setLineDash([7, 5]);
        ctx.beginPath();
        let begun = false;
        for (const row of conflict.trajectory) {
          const q = project([row[1], row[2], 0.3]);
          if (!q) {
            begun = false;
            continue;
          }
          if (begun) ctx.lineTo(...q);
          else ctx.moveTo(...q);
          begun = true;
        }
        ctx.stroke();
        ctx.setLineDash([]);
        const point = project([conflict.point_m[0], conflict.point_m[1], 0.1]);
        if (point) {
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.arc(...point, 6, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    drawMap(prediction) {
      const m = this.map.getContext("2d");
      m.clearRect(0, 0, 180, 180);
      m.fillStyle = "rgba(15,23,42,.88)";
      m.fillRect(0, 0, 180, 180);
      if (!prediction) {
        m.fillStyle = "#cbd5e1";
        m.font = "11px sans-serif";
        m.fillText("Waiting for motion", 24, 94);
        return;
      }
      const conflict = prediction.conflict_point, color = "#f59e0b", visible = visibleModes(prediction);
      const mapPoint = (point) => [90 + point[1] * 3, 120 - point[0] * 3];
      m.strokeStyle = "#ffffff24";
      m.beginPath();
      m.moveTo(90, 0);
      m.lineTo(90, 180);
      m.moveTo(0, 120);
      m.lineTo(180, 120);
      m.stroke();
      m.fillStyle = "#e2e8f0";
      m.fillRect(86.5, 112.5, 7, 15);
      for (const mode of visible) {
        m.strokeStyle = mode.source.includes("TRAJECTRON") ? "#a78bfa99" : "#67e8f999";
        m.setLineDash([3, 3]);
        m.beginPath();
        mode.points.forEach((row, i) => {
          const q = mapPoint([row[1], row[2]]);
          i ? m.lineTo(...q) : m.moveTo(...q);
        });
        m.stroke();
      }
      m.setLineDash([]);
      for (const tr of prediction.tracks) {
        const q = mapPoint(tr.position_m);
        m.fillStyle = tr.id === conflict?.track_id ? color : tr.confirmed ? "#67e8f9" : "#94a3b8";
        m.beginPath();
        m.arc(...q, tr.class === "person" ? 3 : 4, 0, Math.PI * 2);
        m.fill();
      }
      if (conflict) {
        m.strokeStyle = color;
        m.beginPath();
        conflict.trajectory.forEach((row, i) => {
          const q = mapPoint([row[1], row[2]]);
          i ? m.lineTo(...q) : m.moveTo(...q);
        });
        m.stroke();
      }
      m.fillStyle = "#f8fafc";
      m.font = "10px sans-serif";
      m.fillText("Measured \xB7 30 m", 8, 16);
    }
  };

  // frontend/perception-view.js
  var $4 = (id) => document.getElementById(id);
  var PerceptionView = class {
    constructor(provider2) {
      this.provider = provider2;
      this.busy = false;
      this.token = null;
      this.url = null;
      this.nextAt = 0;
      this.overlay = null;
    }
    async drawMotion(result) {
      if (this.overlay) this.overlay.hidden = true;
      const response = await fetch("/api/simulation/prediction?frame_id=" + result.frame_id, { cache: "no-store", signal: AbortSignal.timeout(2e3) });
      const value = await response.json(), prediction = value.prediction;
      if (!prediction || this.token !== result.image_token || prediction.session_id !== this.provider.sessionId || Math.abs(prediction.timestamp_s - result.timestamp_s) > 1e-6) return;
      const pose = prediction.render_reference;
      if (!pose) return;
      const camera = prediction.front_camera;
      if (!camera || camera.frame !== result.frame_id) return;
      const { width: iw, height: ih } = camera;
      if (!this.overlay) {
        this.overlay = document.createElement("canvas");
        this.overlay.className = "prediction-overlay";
        this.overlay.setAttribute("aria-hidden", "true");
        const host2 = $4("perceptionCamera").parentElement;
        host2.style.position = "relative";
        host2.append(this.overlay);
      }
      const image = $4("perceptionCamera"), bounds = image.getBoundingClientRect(), host = image.parentElement.getBoundingClientRect();
      const scale = Math.min(bounds.width / iw, bounds.height / ih), width = iw * scale, height = ih * scale;
      Object.assign(this.overlay.style, { left: bounds.left - host.left + (bounds.width - width) / 2 + "px", top: bounds.top - host.top + (bounds.height - height) / 2 + "px", width: width + "px", height: height + "px" });
      this.overlay.width = iw;
      this.overlay.height = ih;
      const c = this.overlay.getContext("2d");
      for (const mode of prediction.trajectories || []) {
        c.strokeStyle = mode.source.includes("TRAJECTRON") ? "#a78bfa" : "#67e8f9";
        c.lineWidth = mode.selected ? 2 : 1;
        c.setLineDash([5, 4]);
        c.beginPath();
        let begun = false;
        for (const row of mode.points) {
          const q = projectPrediction([row[1], row[2], 0.3], pose, camera);
          if (!q) {
            begun = false;
            continue;
          }
          begun ? c.lineTo(...q) : c.moveTo(...q);
          begun = true;
        }
        c.stroke();
      }
      this.overlay.hidden = false;
    }
    metadata(result) {
      this.result = result;
      const age = detectionFreshness(result, this.provider.telemetry, this.provider.world.fixedDeltaSeconds);
      $4("perceptionStatus").textContent = result.detections.length + " objects detected \xB7 " + Math.round(result.inference_ms) + " ms inference";
      $4("perceptionFreshness").textContent = age.label + (age.seconds === null ? "" : " \xB7 " + age.seconds.toFixed(2) + " s \xB7 " + age.frames + " frames behind");
      $4("perceptionFreshness").dataset.tone = age.tone;
      $4("detectionSummary").textContent = age.tone === "warning" ? age.label + (age.seconds === null ? "" : " \xB7 " + age.seconds.toFixed(2) + " s") : result.detections.length + " objects \xB7 " + age.seconds.toFixed(2) + " s behind";
      $4("perceptionFreshness").title = "Display delay notice starts at 0.5 simulation seconds. Inference is display only.";
      $4("detectionSummary").dataset.tone = age.tone;
      $4("perceptionFrame").textContent = "Analyzed frame " + result.frame_id + " \xB7 t " + result.timestamp_s.toFixed(3) + " s \xB7 Nano ONNX 320 + English OCR \xB7 " + result.device;
    }
    clear(reason) {
      this.result = null;
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = this.token = null;
      $4("perceptionCamera").hidden = true;
      $4("perceptionCamera").removeAttribute("src");
      if (this.overlay) this.overlay.hidden = true;
      $4("perceptionEmpty").hidden = false;
      $4("perceptionEmpty").textContent = reason;
      $4("ocrTexts").replaceChildren();
      $4("perceptionFrame").textContent = "";
      $4("perceptionFreshness").textContent = "";
      $4("perceptionFreshness").dataset.tone = "neutral";
      $4("detectionSummary").textContent = reason;
      $4("detectionSummary").dataset.tone = "neutral";
    }
    async update() {
      if (document.hidden) return;
      const p = this.provider;
      if (!p.fresh || p.isReplay) {
        $4("perceptionStatus").textContent = p.isReplay ? "REPLAY \xB7 Live inference stopped" : "Inference stopped";
        this.clear(p.isReplay ? "Live inference stopped during Replay." : "Waiting for connection CARLA.");
        return;
      }
      if (this.busy || performance.now() < this.nextAt) return;
      this.busy = true;
      this.nextAt = performance.now() + 500;
      const session = p.sessionId;
      try {
        const response = await fetch("/api/simulation/perception", { cache: "no-store", signal: AbortSignal.timeout(3e3) });
        if (!response.ok) throw new Error("Could not read inference worker");
        const result = await response.json();
        if (result.status !== "RUNNING") {
          const labels = { DEMO_PAUSED: "Comparison demo \xB7 YOLO/OCR paused", LOADING: "Loading YOLO and OCR\u2026", WAITING: "Waiting for a frame from this session", UNAVAILABLE: "Inference not installed", STALE: "Inference frame is stale", ERROR: "Inference failed", DISCONNECTED: "Inference stopped" };
          $4("perceptionStatus").textContent = labels[result.status] || result.status;
          if (this.token && this.imageSession === session && performance.now() - this.imageAt < 3e3 && ["WAITING", "STALE", "ERROR"].includes(result.status)) {
            if (this.overlay) this.overlay.hidden = true;
            $4("perceptionFreshness").textContent = "Last analyzed frame \xB7 waiting for an update";
            $4("perceptionFreshness").dataset.tone = "warning";
            return;
          }
          this.clear(result.error || "Waiting for a native analyzed frame");
          return;
        }
        if (result.session_id !== session || !p.fresh || p.isReplay) return;
        if (result.image_token === this.token) {
          this.metadata(result);
          return;
        }
        const image = await fetch("/api/simulation/perception.jpg?token=" + encodeURIComponent(result.image_token), { cache: "no-store", signal: AbortSignal.timeout(3e3) });
        if (!image.ok || image.headers.get("X-Perception-Token") !== result.image_token) return;
        const blob = await image.blob();
        if (p.sessionId !== session || !p.fresh || p.isReplay) return;
        const nextUrl = URL.createObjectURL(blob);
        try {
          const decoded = new Image();
          decoded.src = nextUrl;
          await decoded.decode();
        } catch (error) {
          URL.revokeObjectURL(nextUrl);
          throw error;
        }
        if (p.sessionId !== session || !p.fresh || p.isReplay) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        const previousUrl = this.url;
        this.url = nextUrl;
        this.token = result.image_token;
        this.imageSession = session;
        this.imageAt = performance.now();
        $4("perceptionCamera").src = this.url;
        $4("perceptionCamera").hidden = false;
        $4("perceptionEmpty").hidden = true;
        this.metadata(result);
        this.drawMotion(result).catch(() => {
          if (this.overlay) this.overlay.hidden = true;
        });
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        const nlp = result.nlp;
        const rows = (nlp?.items || result.texts).map((item) => {
          const row = document.createElement("p");
          row.textContent = (item.raw_text || item.text) + " \u2192 " + (item.instruction || "TEXT") + (item.value ? ": " + item.value : "") + " (" + Math.round(item.confidence * 100) + "%)" + (nlp ? " \xB7 source frame " + nlp.frame_id : "");
          return row;
        });
        if (!rows.length) {
          const empty = document.createElement("p");
          empty.textContent = "No text recognized with sufficient confidence in this frame.";
          rows.push(empty);
        }
        $4("ocrTexts").replaceChildren(...rows);
      } catch (error) {
        $4("perceptionStatus").textContent = "Inference unavailable";
        this.clear(error.message);
      } finally {
        this.busy = false;
      }
    }
  };

  // frontend/motion-readout.js
  var num = (v, unit = "", digits = 1) => Number.isFinite(v) ? v.toFixed(digits) + unit : "\u2014";
  function motionReadout(p, prediction, vehicle) {
    const m = { ...prediction?.surroundings, ...p.maneuver }, age = prediction ? vehicle.timestamp - prediction.timestamp_s : null;
    const valid = !!prediction && prediction.session_id === p.sessionId && age >= 0 && age <= 0.25;
    const conflict = m?.predicted_conflicts?.[0] || prediction?.conflict_point;
    const insufficient = ["UNKNOWN_SPACE", "STALE_OBSERVATION", "SENSOR_UNAVAILABLE", "INVALID_OBSERVATION"].includes(p.safetySystem?.risk);
    return {
      valid,
      state: !valid || insufficient || m?.action === "HOLD" ? "Insufficient data" : conflict ? "Possible intersection" : "No predicted intersection",
      action: p.stopDiagnostics?.braking ? (p.stopDiagnostics.decision_source || "RULE") + " BRAKE" : m?.action?.replaceAll("_", " ") || "HOLD",
      reason: p.stopDiagnostics?.braking ? p.stopDiagnostics.reason || "Protective brake" : m?.reason?.replaceAll("_", " ") || "Waiting for measured motion",
      values: [
        ["Actual / target", num(vehicle.speedKmh) + " / " + num(m?.target_speed_kmh ?? p.journey?.speed_kmh) + " km/h"],
        ["Front / rear gap", num(m?.front_gap_m) + " / " + num(m?.rear_gap_m) + " m"],
        ["Front / rear TTC", num(m?.front_ttc_s) + " / " + num(m?.rear_ttc_s) + " s"],
        ["Acceleration", num(vehicle.accelerationMps2, " m/s\xB2")],
        ["Measurement age", num(age, " s", 2)],
        ["Inference / planner", num(prediction?.inference_ms, "", 0) + " / " + num(m?.planning_ms, "", 1) + " ms"]
      ]
    };
  }
  function objectReadout(track, prediction, maneuver, speed) {
    if (!track) return "No measured object selected";
    const [x, y] = track.position_m, [vx, vy] = track.velocity_mps, r = Math.hypot(x, y);
    const moving = Math.hypot(vx, vy), closing = r > 0.01 ? -((vx - speed) * x + vy * y) / r : 0;
    const c = maneuver?.predicted_conflicts?.find((c2) => c2.track_id === track.id);
    const assessment = maneuver?.object_assessments?.[track.id] || prediction?.object_assessments?.[track.id];
    const clearance = assessment?.minimum_clearance_m;
    const state = assessment?.status?.replaceAll("_", " ").toLowerCase() || "insufficient data";
    return `${track.class} #${track.id} \xB7 ${state} \xB7 speed ${num(moving * 3.6, " km/h")} \xB7 movement ${moving < 0.3 ? "stationary" : num(Math.atan2(vy, vx) * 180 / Math.PI, "\xB0 relative to ego")} \xB7 closing ${num(closing, " m/s")} \xB7 minimum clearance ${num(clearance, " m")} \xB7 intersection ${num(c?.time_s ?? assessment?.intersection_time_s, " s")} \xB7 gaze unknown`;
  }
  function installMotionReadout(p, predictionView2) {
    const host = document.createElement("section");
    host.id = "motionReadout";
    host.setAttribute("aria-label", "Motion and maneuver measurements");
    host.innerHTML = '<div class="motion-decision"><strong id="motionState">Insufficient data</strong><span id="motionAction"></span></div><dl id="motionNumbers"></dl><details><summary>Objects, prediction quality & alternatives</summary><label for="motionObject">Measured object</label><select id="motionObject"></select><p id="motionObjectData"></p><table><caption>Forecast error against subsequent measured tracks</caption><thead><tr><th>Horizon</th><th>ADE</th><th>FDE</th><th>Inside bound</th><th>Samples</th></tr></thead><tbody id="motionScores"></tbody></table><p id="motionCoverage"></p><p id="motionRejected"></p></details>';
    document.querySelector(".visual-workspace").append(host);
    const $9 = (id) => host.querySelector("#" + id);
    let signature = "", lastUpdate = "", lastTracks = [], trackSession = null;
    const text = (el2, value) => {
      if (el2.textContent !== String(value)) el2.textContent = value;
    };
    const numbers = motionReadout(p, null, {}).values.map(([label]) => {
      const d = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = label;
      d.append(dt, dd);
      $9("motionNumbers").append(d);
      return dd;
    });
    const scores = [1, 2, 3].map(() => {
      const tr = document.createElement("tr"), cells = Array.from({ length: 5 }, () => document.createElement("td"));
      tr.append(...cells);
      $9("motionScores").append(tr);
      return cells;
    });
    return { update(vehicle) {
      const prediction = predictionView2.currentPrediction, m = p.maneuver, v = motionReadout(p, prediction, vehicle);
      const updateKey = [p.sessionId, vehicle.frame, prediction?.timestamp_s, m?.action, m?.reason, $9("motionObject").value, p.motionQuality?.issued].join("|");
      if (updateKey === lastUpdate) return;
      lastUpdate = updateKey;
      text($9("motionState"), v.state);
      $9("motionState").dataset.tone = v.state === "Possible intersection" ? "warning" : "neutral";
      text($9("motionAction"), v.action + " \xB7 " + v.reason + (m?.experimental ? " \xB7 experimental" : ""));
      v.values.forEach(([, value], i) => text(numbers[i], value));
      if (trackSession !== p.sessionId) {
        trackSession = p.sessionId;
        lastTracks = [];
      }
      if (v.valid) lastTracks = prediction.tracks;
      const tracks = lastTracks, key = tracks.map((t) => t.id + ":" + t.class).join();
      $9("motionObject").disabled = !v.valid;
      if (key !== signature) {
        signature = key;
        const selected = $9("motionObject").value;
        $9("motionObject").replaceChildren(...tracks.map((t) => {
          const o = document.createElement("option");
          o.value = t.id;
          o.textContent = t.class + " #" + t.id;
          return o;
        }));
        if (tracks.some((t) => t.id === selected)) $9("motionObject").value = selected;
      }
      text($9("motionObjectData"), objectReadout(tracks.find((t) => t.id === $9("motionObject").value), prediction, m, vehicle.speedMps) + (tracks.length && !v.valid ? " \xB7 stale measurement" : ""));
      const q = p.motionQuality;
      [1, 2, 3].forEach((h, i) => {
        const s = q?.horizons?.[h];
        [h + " s", num(s?.ade_m, " m", 2), num(s?.fde_m, " m", 2), num(s?.within_threshold_percent, "%", 0), s?.samples ?? "\u2014"].forEach((value, j) => text(scores[i][j], value));
      });
      $9("motionCoverage").textContent = `Coverage ${num(q?.coverage_percent, "%")} \xB7 unobservable ${q?.unobservable_samples ?? "\u2014"} \xB7 bounds 0.5 m person / 1 m other. These measure track consistency; independent accuracy is pending.`;
      $9("motionRejected").textContent = (m?.rejected || []).map((r) => r.action + ": " + r.reason.replaceAll("_", " ")).join(" \xB7 ") || "No alternatives rejected";
    } };
  }

  // frontend/journey-comparison.js
  var JOURNEY_MODES = ["ROBOSPHERE", "NORMAL"];
  var modeName = (mode) => ({ NORMAL: "Normal Mode", HYBRID: "\u0627\u0644\u0646\u0638\u0627\u0645 \u0627\u0644\u0647\u062C\u064A\u0646", BASELINE: "\u0633\u0627\u0626\u0642 CARLA \u0627\u0644\u0639\u0627\u062F\u064A" })[mode] || "Ya Rab Ostorha Mode";
  function comparisonSummary(data) {
    const runs = data?.runs || {}, count = JOURNEY_MODES.filter((m) => runs[m] && runs[m].status !== "RUNNING").length;
    const arrived = JOURNEY_MODES.every((m) => runs[m]?.status === "ARRIVED");
    return {
      count,
      arrived,
      title: arrived ? "Both journeys complete" : count === 2 ? "Two attempts recorded" : "Comparison incomplete",
      detail: arrived ? data.conditions_match ? "Matching setup verified; live traffic can diverge." : "Setup differs or is unverified. Results are separate observations; differences are hidden." : count === 2 ? "One or both journeys ended early. Compare their duration and coverage." : "Run both modes to complete your comparison."
    };
  }
  function metricValue(run, field, digits = 0, suffix = "") {
    if (!run || run.samples === 0) return "\u2014";
    if (field === "destination_reached") return run.status === "RUNNING" ? "In progress" : typeof run.destination_reached === "boolean" ? run.destination_reached ? "Yes" : "No" : run.status === "ARRIVED" ? "Yes" : "\u2014";
    if (["collisions", "maximum_impulse_ns"].includes(field) && run.setup?.collision_measurement_available === false) return "\u2014";
    if (field === "harsh_braking_events" && run.acceleration_samples === 0) return "\u2014";
    if (["safety_interventions", "safety_intervention_s"].includes(field) && run.intervention_samples === 0) return "\u2014";
    const value = run[field];
    if (["near_misses", "high_risk_s", "minimum_forward_range_m"].includes(field) && !run.observed_samples) return "\u2014";
    return Number.isFinite(value) ? value.toFixed(digits) + suffix : "\u2014";
  }
  function measuredDifference(data, field) {
    const a = data?.runs?.ROBOSPHERE, b = data?.runs?.NORMAL;
    if (field === "destination_reached" || a?.samples === 0 || b?.samples === 0) return null;
    if (a?.status !== "ARRIVED" || b?.status !== "ARRIVED" || data.conditions_match !== true) return null;
    if (metricValue(a, field) === "\u2014" || metricValue(b, field) === "\u2014") return null;
    if (["collisions", "maximum_impulse_ns"].includes(field) && (a.setup?.collision_measurement_available === false || b.setup?.collision_measurement_available === false)) return null;
    if (["near_misses", "high_risk_s", "minimum_forward_range_m"].includes(field) && (!Number.isFinite(a.sensor_coverage_percent) || !Number.isFinite(b.sensor_coverage_percent) || Math.min(a.sensor_coverage_percent, b.sensor_coverage_percent) < 80)) return null;
    return Number.isFinite(a[field]) && Number.isFinite(b[field]) ? a[field] - b[field] : null;
  }

  // frontend/unified-map.js
  function worldToEgo(point, origin, yaw) {
    const dx = point[0] - origin[0], dy = point[1] - origin[1], c = Math.cos(yaw), s = Math.sin(yaw);
    return [dx * c + dy * s, -dx * s + dy * c];
  }
  function perspectivePoint(point, origin, yaw, zoom = 1, expanded = false, width = 480, height = 360) {
    const [forward, right] = worldToEgo(point, origin, yaw), scale = (expanded ? 6 : 4.8) * zoom;
    const depth = 1 + Math.max(0, forward) / 100;
    const compactScale = expanded ? 1 : Math.max(0.7, width / 480);
    return [width / 2 + right * scale * compactScale / depth, height * (262 / 360) - forward * scale * (expanded ? height / 360 : 0.75) * 0.78 / depth];
  }
  function mapCanvasPoint(x, y, box, width = 480, height = 360) {
    const scale = Math.min(box.width / width, box.height / height);
    return [(x - box.left - (box.width - width * scale) / 2) / scale, (y - box.top - (box.height - height * scale) / 2) / scale];
  }
  function mapPrediction(prediction, p) {
    return (p.fresh || p.isReplay) && prediction?.render_reference && prediction.coordinate_frame === "EGO_AT_EVALUATION" && measuredPredictionFresh(prediction, p.sessionId, p.telemetry?.timestamp) ? prediction : null;
  }
  function mapForecastStatus(prediction, p) {
    if (!p.fresh && !p.isReplay) return "Forecast unavailable \xB7 simulator disconnected";
    if (!prediction) return "Forecast unavailable \xB7 waiting for measured motion";
    if (!mapPrediction(prediction, p)) return "Forecast stale or incompatible \xB7 paths hidden";
    const age = (p.telemetry.timestamp - prediction.timestamp_s).toFixed(1), tracks = prediction.tracks || [];
    const source = prediction.display_source || prediction.decision_source || "Measured";
    const horizon = prediction.horizon_s ?? prediction.trajectories?.[0]?.points?.at(-1)?.[0];
    return `${source} \xB7 ${age} s old${Number.isFinite(horizon) ? " \xB7 " + horizon + " s horizon" : ""} \xB7 ${tracks.length ? tracks.length + " measured objects" : "No tracked actors"}${prediction.model_reason ? " \xB7 " + prediction.model_reason : ""}`;
  }
  function installUnifiedMap(p, view, tools2) {
    const panel = document.createElement("section");
    panel.id = "unifiedMap";
    panel.setAttribute("aria-label", "Unified Navigation & Prediction Map");
    panel.innerHTML = '<button id="unifiedMapToggle" type="button" aria-expanded="false" aria-label="Open route map (M)"></button><header><span><small>LIVE GEOMETRY</small><strong>Navigation</strong></span><span class="unified-map-actions"><button id="unifiedRouteAction" aria-label="Choose a destination">Route \u2197</button><button id="expandUnifiedMap" aria-expanded="false" aria-label="Collapse navigation and prediction map">\xD7</button></span></header><div class="map-layer-switch" role="group" aria-label="Map layers"><button data-layer="route">Route</button><button data-layer="predictions">Predictions</button><button data-layer="both" aria-pressed="true">Both</button></div><canvas width="480" height="360" id="unifiedMapCanvas" role="img" aria-label="Actual CARLA road geometry and measured motion forecasts"></canvas><p id="unifiedMapRoute">Waiting for route</p><p id="unifiedMapMeta" role="status">Waiting for map data</p><div class="unified-expanded-tools"><div class="unified-filters"><label><input type="checkbox" data-filter="vehicles" checked>Vehicles</label><label><input type="checkbox" data-filter="people" checked>People</label><label><input type="checkbox" data-filter="paths" checked>Paths</label><label><input type="checkbox" data-filter="conflicts" checked>Conflicts</label></div><label for="unifiedMapActor">Measured object</label><select id="unifiedMapActor"><option value="">Overview</option></select><p id="unifiedActorInfo">Select a measured object to inspect its motion.</p><button id="unifiedChooseDestination">Choose destination \u2197</button></div>';
    document.getElementById("frontCameraView").append(panel);
    const $9 = (id) => panel.querySelector("#" + id), canvas = $9("unifiedMapCanvas"), ctx = canvas.getContext("2d");
    let layer = "both", expanded = false, selected = "", markers = [], lastKey = "", actorKey = "", lastPrediction = null, lastPose = null, lastSession = null, lastVehicle = null, zoom = 1;
    const redraw = () => {
      lastKey = "";
      if (lastVehicle) map.update(lastVehicle);
    };
    const zoomTools = document.createElement("div");
    zoomTools.className = "unified-zoom";
    for (const [label, factor] of [["\u2212", 0.8], ["+", 1.25], ["Recenter", 0]]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.setAttribute("aria-label", label === "+" ? "Zoom map in" : label === "\u2212" ? "Zoom map out" : "Recenter map on vehicle");
      b.onclick = () => {
        zoom = factor ? Math.max(0.25, Math.min(4, zoom * factor)) : 1;
        redraw();
      };
      zoomTools.append(b);
    }
    panel.querySelector(".unified-expanded-tools").prepend(zoomTools);
    const filters = { vehicles: true, people: true, paths: true, conflicts: true };
    const text = (el2, value) => {
      if (el2.textContent !== value) el2.textContent = value;
    };
    const toggle = () => {
      expanded = !expanded;
      panel.classList.toggle("map-expanded", expanded);
      $9("expandUnifiedMap").setAttribute("aria-expanded", String(expanded));
      $9("expandUnifiedMap").setAttribute("aria-label", expanded ? "Collapse navigation and prediction map" : "Expand navigation and prediction map");
      $9("unifiedMapToggle").setAttribute("aria-expanded", String(expanded));
      $9("unifiedMapToggle").setAttribute("aria-label", expanded ? "Close route map (M)" : "Open route map (M)");
      $9("expandUnifiedMap").textContent = "\xD7";
      redraw();
      if (expanded && (p.controlMode === "MANUAL" || tools2.options.isManualArmed?.())) tools2.controls.keys.clear();
    };
    $9("expandUnifiedMap").onclick = toggle;
    $9("unifiedMapToggle").onclick = toggle;
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && expanded) {
        e.stopPropagation();
        toggle();
        $9("expandUnifiedMap").focus();
      }
    });
    panel.querySelectorAll("[data-layer]").forEach((b) => b.onclick = () => {
      layer = b.dataset.layer;
      panel.querySelectorAll("[data-layer]").forEach((other) => other.setAttribute("aria-pressed", String(other === b)));
      redraw();
    });
    panel.querySelectorAll("[data-filter]").forEach((box) => box.onchange = () => {
      filters[box.dataset.filter] = box.checked;
      redraw();
    });
    $9("unifiedChooseDestination").onclick = () => tools2.open("routePanel", "unifiedChooseDestination");
    $9("unifiedRouteAction").onclick = () => tools2.open("routePanel", "unifiedRouteAction");
    $9("unifiedMapActor").onchange = () => {
      selected = $9("unifiedMapActor").value;
      redraw();
    };
    new ResizeObserver(() => {
      const box = canvas.getBoundingClientRect();
      if (box.width < 40 || box.height < 40) return;
      const width = Math.round(box.width), height = Math.round(box.height);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        redraw();
      }
    }).observe(canvas);
    canvas.onclick = (event) => {
      const box = canvas.getBoundingClientRect(), [x, y] = mapCanvasPoint(event.clientX, event.clientY, box, canvas.width, canvas.height);
      const close = markers.map((m) => ({ ...m, d: Math.hypot(m.x - x, m.y - y) })).sort((a, b) => a.d - b.d)[0];
      selected = close?.d < 18 ? close.id : "";
      $9("unifiedMapActor").value = selected;
      if (!expanded) toggle();
      else redraw();
    };
    const map = { update(vehicle) {
      lastVehicle = vehicle;
      if (document.body.dataset.ui !== "guided" || document.body.dataset.workspace !== "drive") return;
      if (!p.fresh && !p.isReplay) lastPose = null;
      if (lastSession && p.sessionId && lastSession !== p.sessionId) lastPose = null;
      if (p.sessionId) lastSession = p.sessionId;
      const prediction = mapPrediction(view.currentPrediction, p), roads = tools2.catalog?.roads;
      const key = [p.sessionId, vehicle.frame, prediction?.evaluation_frame, p.route?.id, layer, expanded, selected, document.documentElement.dataset.appearance, Object.values(filters).join()].join(":");
      if (key === lastKey && lastPrediction === prediction) return;
      lastKey = key;
      lastPrediction = prediction;
      if (vehicle.positionWorldM?.every(Number.isFinite) && Number.isFinite(vehicle.headingRad)) lastPose = { origin: vehicle.positionWorldM, yaw: vehicle.headingRad };
      panel.dataset.offline = String(!lastPose && !p.fresh && !p.isReplay);
      const { origin, yaw } = lastPose || {};
      const colors = { landFar: "#E7F0FF", landNear: "#F0FAF7", roadShadow: "#E6ECF6", roadEdge: "#E6ECF6", road: "#FFFFFF", lane: "#E6ECF6", route: "#4B84FC", routeGlow: "#E7F0FF", actor: "#4B84FC", person: "#753CF7", text: "#11182F", muted: "#66738F", destination: "#753CF7" };
      const mapWidth = canvas.width, mapHeight = canvas.height, carY = mapHeight * (262 / 360);
      ctx.clearRect(0, 0, mapWidth, mapHeight);
      markers = [];
      const ground = ctx.createLinearGradient(0, 0, 0, mapHeight);
      ground.addColorStop(0, colors.landFar);
      ground.addColorStop(1, colors.landNear);
      ctx.fillStyle = ground;
      ctx.fillRect(0, 0, mapWidth, mapHeight);
      if (!origin || !Number.isFinite(yaw)) {
        text($9("unifiedMapMeta"), "Map unavailable \xB7 simulator disconnected");
        return;
      }
      const project = (world) => perspectivePoint(world, origin, yaw, zoom, expanded, mapWidth, mapHeight);
      const line = (points, color, width = 2, dash = []) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(dash);
        ctx.beginPath();
        points.forEach((q, i) => i ? ctx.lineTo(...q) : ctx.moveTo(...q));
        ctx.stroke();
        ctx.setLineDash([]);
      };
      const ribbon = (points, widths, color, offsetY = 0) => {
        if (points.length < 2) return;
        ctx.beginPath();
        for (const side of [1, -1]) for (const i of side === 1 ? points.keys() : Array.from(points.keys()).reverse()) {
          const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
          const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy) || 1;
          const x = points[i][0] - dy / length * widths[i] * side / 2, y = points[i][1] + dx / length * widths[i] * side / 2 + offsetY;
          if (side === 1 && i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };
      if (roads?.segments?.length) {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (const segment of roads.segments) {
          const pts = segment.map(project);
          if (!pts.some((q) => q[0] > -30 && q[0] < mapWidth + 30 && q[1] > -30 && q[1] < mapHeight + 30)) continue;
          const widths = segment.map((point) => {
            const forward = worldToEgo(point, origin, yaw)[0];
            return Math.max(expanded ? 6 : 3, 34 * (expanded ? mapWidth / 480 : 0.65) * zoom / (1 + Math.max(0, forward) / 75));
          });
          ribbon(pts, widths.map((width) => width + 9), colors.roadShadow, 5);
          ribbon(pts, widths.map((width) => width + 5), colors.roadEdge, 2);
          ribbon(pts, widths, colors.road);
          line(pts, colors.lane, 1.5, [9, 13]);
        }
      }
      if (layer !== "predictions" && p.route?.points?.length) {
        const path = p.route.points.map(project);
        line(path, colors.routeGlow, 12);
        line(path, colors.route, 5);
        if (p.route.destination?.location) {
          const q = project(p.route.destination.location), x = Math.max(20, Math.min(mapWidth - 20, q[0])), y = Math.max(22, Math.min(mapHeight - 35, q[1]));
          ctx.fillStyle = colors.destination;
          ctx.beginPath();
          ctx.moveTo(x, y + 11);
          ctx.lineTo(x - 8, y - 3);
          ctx.arc(x, y - 4, 8, Math.PI, 0);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.arc(x, y - 4, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      const convert = (point) => project(predictionWorldPoint(point, prediction.render_reference));
      const tracks = (prediction?.tracks || []).filter((t) => t.class === "person" ? filters.people : filters.vehicles);
      if (prediction && layer !== "route") {
        const ids2 = new Set(tracks.filter((t) => t.confirmed).map((t) => String(t.id))), counts = /* @__PURE__ */ new Map();
        if (filters.paths) for (const mode of prediction.trajectories || []) {
          const id = String(mode.track_id), count = counts.get(id) || 0;
          if (!ids2.has(id) || count >= 3) continue;
          counts.set(id, count + 1);
          const path = mode.points.map((row) => convert([row[1], row[2], 0])), color = mode.source?.includes("TRAJECTRON") ? selected && selected !== id ? "#a898cb66" : "#ae7ce9" : selected && selected !== id ? "#3ca0a666" : colors.actor;
          line(path, color, selected === id ? 3.6 : 2.6, [7, 5]);
          if (path.length) {
            const end = path.at(-1);
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(end[0], end[1], selected === id ? 4.5 : 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        if (filters.conflicts && prediction.conflict_point) {
          const q = convert([...prediction.conflict_point.point_m, 0]);
          ctx.strokeStyle = "#dc8b36";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(...q, 13, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      if (prediction) for (const tr2 of tracks) {
        const [x, y] = convert([...tr2.position_m, 0]), id = String(tr2.id);
        markers.push({ id, x, y });
        ctx.fillStyle = selected === id ? colors.route : tr2.confirmed ? tr2.class === "person" ? colors.person : colors.actor : colors.muted;
        if (tr2.class === "person") {
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(x - 4, y - 7, 8, 14);
        }
        if (selected === id) {
          ctx.strokeStyle = colors.route;
          ctx.beginPath();
          ctx.arc(x, y, 11, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      const carX = mapWidth / 2;
      ctx.shadowColor = "#b05c7955";
      ctx.shadowBlur = 12;
      ctx.fillStyle = colors.route;
      ctx.beginPath();
      ctx.arc(carX, carY, Math.min(19, mapWidth * 0.08), 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(carX, carY - 15);
      ctx.lineTo(carX - 9, carY + 11);
      ctx.lineTo(carX, carY + 6);
      ctx.lineTo(carX + 9, carY + 11);
      ctx.closePath();
      ctx.fill();
      if (expanded) {
        ctx.fillStyle = colors.text;
        ctx.font = "bold 11px Geist, sans-serif";
        ctx.fillText("YOU \u2191", carX + 24, carY + 4);
        ctx.font = "10px Geist, sans-serif";
        ctx.fillStyle = colors.muted;
        ctx.fillText((p.world?.map || "CARLA") + " \xB7 native road map", 12, mapHeight - 17);
      }
      const age = prediction ? Math.max(0, p.telemetry.timestamp - prediction.timestamp_s).toFixed(1) : null;
      const coverage = p.safetySystem?.observed_road_range_m;
      const gap = p.safetySystem?.measured_range_m;
      const measuredRoad = p.fresh && Number.isFinite(coverage) ? `Road seen ${coverage.toFixed(1)} m${Number.isFinite(gap) ? ` \xB7 Front gap ${gap.toFixed(1)} m` : ""} \xB7 ` : "";
      text($9("unifiedMapMeta"), (!p.fresh && !p.isReplay ? "Last measured map \xB7 " : roads ? "" : "Road geometry unavailable \xB7 ") + measuredRoad + mapForecastStatus(view.currentPrediction, p));
      text($9("unifiedMapRoute"), p.route?.destination?.name ? `${p.route.destination.name} \xB7 ${Number.isFinite(p.route.remaining_m) ? Math.round(p.route.remaining_m) + " m remaining" : "route selected"}` : "Choose a destination to see the route");
      const ids = tracks.map((t) => t.id).join("|");
      if (ids !== actorKey) {
        actorKey = ids;
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = "Overview";
        $9("unifiedMapActor").replaceChildren(empty, ...tracks.map((t) => {
          const o = document.createElement("option");
          o.value = t.id;
          o.textContent = t.class + " #" + t.id;
          return o;
        }));
        if (!tracks.some((t) => String(t.id) === selected)) selected = "";
        $9("unifiedMapActor").value = selected;
      }
      const tr = tracks.find((t) => String(t.id) === selected), assessment = prediction?.object_assessments?.[selected];
      text($9("unifiedActorInfo"), tr ? `${tr.class} #${tr.id} \xB7 ${(Math.hypot(...tr.velocity_mps) * 3.6).toFixed(1)} km/h \xB7 ${Math.hypot(...tr.velocity_mps) < 0.3 ? "stationary" : Math.round(Math.atan2(tr.velocity_mps[1], tr.velocity_mps[0]) * 180 / Math.PI) + "\xB0 relative to ego at measurement"} \xB7 ${assessment?.status?.replaceAll("_", " ") || "intersection unassessed"}${Number.isFinite(assessment?.minimum_clearance_m) ? " \xB7 gap " + assessment.minimum_clearance_m.toFixed(1) + " m" : ""} \xB7 gaze unknown` : "Select a measured object to inspect its motion.");
      canvas.setAttribute("aria-label", `${roads ? "CARLA road geometry" : "Road geometry unavailable"}; ${p.route ? "route selected" : "no route"}; ${prediction ? tracks.length + " measured objects, " + age + " seconds old" : "prediction unavailable"}. Expand for keyboard object selection.`);
    } };
    new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] });
    return map;
  }

  // frontend/cockpit-state.js
  var finite = (value) => Number.isFinite(value) && value >= 0;
  var metricText = (value, digits = 0) => finite(value) ? value.toFixed(digits) : "\u2014";
  function controlReasonText(reason) {
    return {
      CONTROL_PROCESSING_DEADLINE: "\u062D\u0633\u0627\u0628 \u0642\u0631\u0627\u0631 \u0627\u0644\u0642\u064A\u0627\u062F\u0629 \u062A\u0623\u062E\u0631\u061B \u0627\u0646\u062A\u0638\u0627\u0631 \u0641\u0631\u064A\u0645 \u062D\u062F\u064A\u062B.",
      STALE_CONTROL_SCENE: "\u0628\u064A\u0627\u0646\u0627\u062A \u0627\u0644\u062D\u0633\u0627\u0633\u0627\u062A \u0642\u062F\u064A\u0645\u0629 \u0623\u0648 \u063A\u064A\u0631 \u0645\u062A\u0632\u0627\u0645\u0646\u0629\u061B \u0627\u0646\u062A\u0638\u0627\u0631 \u0641\u0631\u064A\u0645 \u062C\u062F\u064A\u062F.",
      AWAITING_CURRENT_SENSOR_FRAME: "\u0627\u0646\u062A\u0638\u0627\u0631 \u062D\u0633\u0627\u0633\u0627\u062A \u0646\u0641\u0633 \u0641\u0631\u064A\u0645 \u0627\u0644\u0633\u064A\u0627\u0631\u0629.",
      NO_VERIFIED_SAFE_ACTION: "\u0644\u0645 \u062A\u062A\u0623\u0643\u062F \u0645\u0633\u0627\u062D\u0629 \u0645\u0646\u0627\u0648\u0631\u0629 \u0622\u0645\u0646\u0629\u061B \u0627\u0644\u0633\u064A\u0627\u0631\u0629 \u0645\u062A\u0648\u0642\u0641\u0629.",
      SWEPT_SPACE_UNKNOWN_OR_OCCUPIED: "\u0645\u0633\u0627\u062D\u0629 \u0627\u0644\u062D\u0631\u0643\u0629 \u0644\u0645 \u062A\u064F\u0642\u064E\u0633 \u0628\u0627\u0644\u0643\u0627\u0645\u0644 \u0623\u0648 \u0628\u0647\u0627 \u0639\u0627\u0626\u0642.",
      REACHABLE_CORRIDOR_UNCERTAINTY: "\u062D\u0631\u0643\u0629 \u062C\u0633\u0645 \u0642\u0631\u064A\u0628 \u063A\u064A\u0631 \u0645\u0624\u0643\u062F\u0629\u061B \u0627\u0646\u062A\u0638\u0627\u0631 \u0642\u064A\u0627\u0633 \u0623\u0648\u0636\u062D.",
      PREDICTED_INTERSECTION: "\u0645\u0633\u0627\u0631 \u062C\u0633\u0645 \u0645\u062A\u0648\u0642\u0651\u0639 \u064A\u062A\u0642\u0627\u0637\u0639 \u0645\u0639 \u0645\u0633\u0627\u0631 \u0627\u0644\u0633\u064A\u0627\u0631\u0629.",
      BODY_OUTSIDE_DRIVABLE_ROAD: "\u0627\u0644\u0645\u0646\u0627\u0648\u0631\u0629 \u062A\u064F\u062E\u0631\u062C \u062C\u0632\u0621\u064B\u0627 \u0645\u0646 \u0627\u0644\u0633\u064A\u0627\u0631\u0629 \u0639\u0646 \u0627\u0644\u0637\u0631\u064A\u0642.",
      TRAFFIC_RULE_STOP: "\u0627\u0646\u062A\u0638\u0627\u0631 \u0625\u0634\u0627\u0631\u0629 \u0627\u0644\u0645\u0631\u0648\u0631.",
      HYBRID_CONTROLLED_DECELERATION: "\u062A\u0647\u062F\u0626\u0629 \u0645\u062D\u0633\u0648\u0628\u0629 \u062D\u0633\u0628 \u0627\u0644\u0645\u0633\u0627\u0631 \u0648\u0627\u0644\u0645\u0633\u0627\u062D\u0629 \u0627\u0644\u0645\u062A\u0627\u062D\u0629.",
      HYBRID_VALIDATION_EXPIRED: "\u0627\u0646\u062A\u0647\u0649 \u0648\u0642\u062A \u0627\u0644\u0627\u062E\u062A\u0628\u0627\u0631 \u0627\u0644\u062D\u0631\u0643\u064A\u061B \u0627\u0644\u0633\u064A\u0627\u0631\u0629 \u0645\u062A\u0648\u0642\u0641\u0629."
    }[reason] || String(reason || "");
  }
  function observationCurrent(value, provider2, maxAge = 0.75) {
    const age = provider2.telemetry?.timestamp - value?.timestamp_s;
    return provider2.fresh && !provider2.isReplay && Number.isFinite(value?.timestamp_s) && Number.isFinite(age) && age >= -1e-6 && age <= maxAge && (!value.session_id || value.session_id === provider2.sessionId);
  }
  function cockpitMeasurements(provider2, vehicle) {
    const live = provider2.fresh && !provider2.isReplay;
    const safety = provider2.safetySystem;
    const fault = /FAULT|UNAVAILABLE|SUSPENDED/.test(safety?.status || "");
    const motion = observationCurrent(provider2.maneuver, provider2) && !fault ? provider2.maneuver : null;
    const observed = observationCurrent(safety, provider2) && !fault ? safety : null;
    return {
      speed: provider2.fresh ? vehicle.speedKmh : null,
      brake: provider2.fresh && finite(vehicle.brake) && vehicle.brake <= 1 ? vehicle.brake * 100 : null,
      target: live && provider2.controlMode !== "MANUAL" ? provider2.journey?.speed_kmh : null,
      gap: motion?.front_gap_m ?? observed?.measured_range_m ?? null,
      ttc: motion?.front_ttc_s ?? observed?.ttc_s ?? null,
      measurement: motion || observed
    };
  }
  function safetyNotice(provider2) {
    if (!provider2.fresh || provider2.isReplay) return null;
    if (provider2.controlMode === "EMERGENCY_STOP") return {
      tone: "danger",
      title: "Emergency stop active",
      detail: "Movement locked. Use \u0641\u0643 \u0625\u064A\u0642\u0627\u0641 \u0627\u0644\u0637\u0648\u0627\u0631\u0626 in the header, then start driving again."
    };
    if (provider2.controlMode === "PAUSED" && provider2.lastDriveStop?.status !== "ERROR" && (provider2.journey?.status === "ARRIVED" || provider2.route?.arrived)) return {
      tone: "neutral",
      title: "\u0648\u0635\u0644\u062A \u0644\u0644\u0648\u062C\u0647\u0629",
      detail: "\u0627\u0644\u0639\u0631\u0628\u064A\u0629 \u0648\u0635\u0644\u062A \u0648\u062A\u0648\u0642\u0641\u062A. \u0627\u062E\u062A\u0627\u0631 \u0648\u062C\u0647\u0629 \u062C\u062F\u064A\u062F\u0629 \u0644\u0628\u062F\u0621 \u0645\u0634\u0648\u0627\u0631 \u0622\u062E\u0631."
    };
    if (provider2.controlMode === "PAUSED" && provider2.route && ["PAUSED", "ERROR"].includes(provider2.journey?.status)) {
      const stopped = provider2.lastDriveStop;
      const reason = stopped?.detail || provider2.stopDiagnostics?.reason || provider2.journey?.reason;
      const names = {
        focus_lost: "\u0627\u0644\u0642\u064A\u0627\u062F\u0629 \u062A\u0648\u0642\u0641\u062A \u0639\u0646\u062F \u0641\u0642\u062F\u0627\u0646 \u062A\u0631\u0643\u064A\u0632 \u0627\u0644\u0635\u0641\u062D\u0629",
        operator_stop: "\u0625\u064A\u0642\u0627\u0641 \u0627\u0644\u0639\u0631\u0628\u064A\u0629 \u0628\u0637\u0644\u0628 \u0627\u0644\u0645\u0633\u062A\u062E\u062F\u0645",
        controls_released: "\u0623\u0648\u0627\u0645\u0631 \u0627\u0644\u0642\u064A\u0627\u062F\u0629 \u0627\u062A\u0642\u0641\u0644\u062A",
        dashboard_heartbeat_timeout: "\u0627\u0646\u0642\u0637\u0639 \u0627\u062A\u0635\u0627\u0644 \u0623\u0648\u0627\u0645\u0631 \u0627\u0644\u0642\u064A\u0627\u062F\u0629"
      };
      return {
        tone: stopped?.status === "ERROR" ? "warning" : "neutral",
        title: "\u0627\u0644\u0642\u064A\u0627\u062F\u0629 \u0645\u062A\u0648\u0642\u0641\u0629",
        detail: (names[reason] || reason || "\u0627\u0644\u0639\u0631\u0628\u064A\u0629 \u0645\u062A\u0648\u0642\u0641\u0629") + " \xB7 \u0627\u0636\u063A\u0637 \u0627\u0633\u062A\u0626\u0646\u0627\u0641 \u0627\u0644\u0642\u064A\u0627\u062F\u0629 \u0644\u0644\u0645\u062A\u0627\u0628\u0639\u0629."
      };
    }
    if (provider2.controlMode === "AUTOMATIC" && provider2.stopDiagnostics?.braking && provider2.stopDiagnostics?.decision_source === "NAVIGATION" && /red traffic light/i.test(provider2.stopDiagnostics.reason || "")) return {
      tone: "neutral",
      title: "\u0627\u0646\u062A\u0638\u0627\u0631 \u0627\u0644\u0625\u0634\u0627\u0631\u0629 \u0627\u0644\u062D\u0645\u0631\u0627\u0621",
      detail: "\u0627\u0644\u0645\u0634\u0648\u0627\u0631 \u0634\u063A\u0651\u0627\u0644\u061B \u0627\u0644\u0639\u0631\u0628\u064A\u0629 \u062A\u062A\u062D\u0631\u0643 \u062A\u0644\u0642\u0627\u0626\u064A\u064B\u0627 \u0644\u0645\u0627 \u0627\u0644\u0625\u0634\u0627\u0631\u0629 \u062A\u0633\u0645\u062D."
    };
    if (provider2.controlMode === "AUTOMATIC" && provider2.journey?.driving_mode === "HYBRID" && provider2.stopDiagnostics?.braking) return {
      tone: "warning",
      title: "\u0627\u0644\u0642\u064A\u0627\u062F\u0629 \u0627\u0644\u0647\u062C\u064A\u0646\u0629 \u062A\u0647\u062F\u0651\u0626 \u0623\u0648 \u062A\u062A\u0648\u0642\u0641",
      detail: controlReasonText(provider2.stopDiagnostics.reason)
    };
    const safety = provider2.safetySystem;
    if (!safety) return { tone: "neutral", title: "Safety unavailable", detail: "Waiting for safety telemetry. Inspect Diagnostics before driving." };
    if (/FAULT|UNAVAILABLE/.test(safety.status || "")) return {
      tone: "danger",
      title: "Safety sensors unavailable",
      detail: safety.reason || "Inspect Diagnostics before driving."
    };
    if (/SUSPENDED/.test(safety.status || "")) return {
      tone: "warning",
      title: "Safety supervision suspended",
      detail: safety.reason || "Inspect the active mode in Scenarios."
    };
    if (!safety.active) return null;
    if (safety.status === "SENSOR_DELAY_HOLD") return { tone: "warning", title: "\u0627\u0646\u062A\u0638\u0627\u0631 \u0641\u0631\u064A\u0645 \u062D\u0633\u0627\u0633\u0627\u062A \u062C\u062F\u064A\u062F", detail: safety.reason };
    const releasing = /RELEAS/.test(safety.status || "");
    const holding = /HOLD/.test(safety.teacher_state || safety.status || "");
    return {
      tone: "warning",
      title: releasing ? "Safety brake releasing" : holding ? "Protective stop active" : "Safety braking active",
      detail: safety.reason || "The safety supervisor is overriding the driver."
    };
  }
  function safetyChip(provider2) {
    if (provider2.isReplay) return { label: "Recorded safety", tone: "neutral" };
    if (!provider2.fresh) return { label: "Protection offline", tone: "neutral" };
    const s = provider2.safetySystem;
    if (!s) return { label: "Safety unavailable", tone: "neutral" };
    if (provider2.controlMode === "EMERGENCY_STOP") return { label: "Emergency stopped", tone: "danger" };
    if (/FAULT|UNAVAILABLE/.test(s.status || "")) return { label: "Safety unavailable", tone: "danger" };
    if (provider2.controlMode === "AUTOMATIC" && provider2.journey?.driving_mode === "BASELINE") return { label: "\u062D\u0645\u0627\u064A\u0629 \u0633\u0627\u0626\u0642 CARLA", tone: "protection" };
    if (s.status === "STANDARD_DRIVER") return { label: "Normal \xB7 protection off", tone: "neutral" };
    if (!s.enabled) return { label: "Protection off", tone: "danger" };
    if (/SUSPENDED/.test(s.status || "")) return { label: "Protection suspended", tone: "warning" };
    if (s.active) return { label: "Safety override", tone: "warning" };
    return { label: s.experimental || s.controller === "MODEL" ? "Experimental protection" : s.status === "STANDBY" ? "Protection standby" : "Protection active", tone: "protection" };
  }
  function driverCaption(provider2) {
    if (provider2.isReplay) return "Read only";
    if (!provider2.fresh) return "Driver offline";
    if (provider2.controlMode === "EMERGENCY_STOP") return "Emergency stop";
    if (provider2.controlMode === "PAUSED") return provider2.lastDriveStop?.status !== "ERROR" && (provider2.journey?.status === "ARRIVED" || provider2.route?.arrived) ? "Arrived" : "Vehicle held";
    if (provider2.safetySystem?.status === "SENSOR_DELAY_HOLD") return "Waiting for sensors";
    if (provider2.safetySystem?.active) return "Safety override";
    if (provider2.controlMode === "AUTOMATIC" && provider2.journey?.driving_mode === "HYBRID") return "\u0627\u0644\u0642\u064A\u0627\u062F\u0629 \u0627\u0644\u0647\u062C\u064A\u0646\u0629";
    if (provider2.controlMode === "AUTOMATIC" && provider2.journey?.driving_mode === "BASELINE") return "\u0633\u0627\u0626\u0642 CARLA \u0627\u0644\u0639\u0627\u062F\u064A";
    const m = provider2.maneuver;
    if (provider2.controlMode === "AUTOMATIC" && observationCurrent(m, provider2, 0.1)) {
      if (m.phase === "REVERSING" && m.action === "BACK_UP") return "Repositioning \xB7 Reverse";
      if (m.phase === "CLEARING" && m.selected_path) return "Repositioning";
      if (m.phase === "SETTLE") return "Repositioning \xB7 Stopping";
    }
    return provider2.controlMode === "AUTOMATIC" ? "Self Driving" : provider2.controlMode === "MANUAL" ? "Manual \xB7 WASD" : "Vehicle held";
  }
  function perceptionCounts(result, provider2) {
    const age = provider2.telemetry?.timestamp - result?.timestamp_s;
    const compatible = provider2.fresh && !provider2.isReplay && result?.session_id === provider2.sessionId && Number.isFinite(age) && age >= 0 && Number.isInteger(result.frame_id) && result.frame_id <= provider2.telemetry?.frame;
    if (!compatible || age >= 0.5 || !Array.isArray(result.detections)) return {
      vehicles: null,
      people: null,
      label: compatible ? "Front detections delayed \xB7 " + age.toFixed(1) + " s" : "Front detections unavailable"
    };
    const vehicleClasses = /* @__PURE__ */ new Set(["car", "truck", "bus", "motorcycle", "bicycle", "train"]);
    return {
      vehicles: result.detections.filter((d) => vehicleClasses.has(d.class)).length,
      people: result.detections.filter((d) => d.class === "person" || d.class === "pedestrian").length,
      label: "Front camera \xB7 2D detections \xB7 " + age.toFixed(1) + " s old"
    };
  }
  function detectionFrameMatches(result, provider2, displayed, front) {
    if (!provider2.fresh || provider2.isReplay || result?.session_id !== provider2.sessionId || !Number.isInteger(result?.frame_id) || result.frame_id !== displayed?.frame || !Number.isFinite(result.timestamp_s) || !Number.isFinite(displayed?.timestamp) || Math.abs(result.timestamp_s - displayed.timestamp) > 1e-6 || !finite(result.width) || !finite(result.height) || !result.width || !result.height) return false;
    if (displayed.sensorId === "frontCamera") return displayed.width === result.width && displayed.height === result.height;
    if (!front?.mountTransform || !displayed.mountTransform || !Number.isFinite(front.fovDeg) || Math.abs(front.fovDeg - displayed.fovDeg) > 1e-6 || Math.abs(result.width / result.height - displayed.width / displayed.height) > 1e-6) return false;
    const a = front.mountTransform, b = displayed.mountTransform;
    return ["pitch", "yaw", "roll"].every((k) => Math.abs((a.rotation_deg?.[k] ?? 0) - (b.rotation_deg?.[k] ?? 0)) < 1e-6) && a.position_m?.length === 3 && b.position_m?.length === 3 && a.position_m.every((v, i) => Number.isFinite(v) && Math.abs(v - b.position_m[i]) < 1e-6);
  }
  function containedImageRect(bounds, width, height) {
    if (![bounds.width, bounds.height, width, height].every((v) => Number.isFinite(v) && v > 0)) return null;
    const scale = Math.min(bounds.width / width, bounds.height / height);
    return { left: (bounds.width - width * scale) / 2, top: (bounds.height - height * scale) / 2, width: width * scale, height: height * scale };
  }
  function validDetectionBox(detection, width, height) {
    const b = detection.xyxy;
    if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[2] <= b[0] || b[3] <= b[1]) return null;
    const clipped = [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(width, b[2]), Math.min(height, b[3])];
    return clipped[2] > clipped[0] && clipped[3] > clipped[1] ? clipped : null;
  }

  // frontend/driving-studio.js
  var $5 = (id) => document.getElementById(id);
  var node2 = (tag, cls, text) => {
    const el2 = document.createElement(tag);
    if (cls) el2.className = cls;
    if (text !== void 0) el2.textContent = text;
    return el2;
  };
  var txt = (el2, value) => {
    if (el2.textContent !== String(value)) el2.textContent = value;
  };
  var icon = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  var icons = { drive: icon('<path d="m3 11 9-8 9 8M5 10v11h14V10M10 21v-7h4v7"/>'), results: icon('<path d="M4 21V11h4v10M10 21V6h4v15M16 21V2h4v19"/>'), map: icon('<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3ZM9 3v15M15 6v15"/>'), settings: icon('<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>') };
  function installDrivingStudio(p, guided2, predictionView2, tools2) {
    const rail = node2("aside", "studio-rail");
    rail.setAttribute("aria-label", "Main navigation");
    rail.innerHTML = '<span class="rail-brand" title="Ya Rab Ostorha" aria-hidden="true">o<span></span></span>';
    const nav = document.querySelector(".workspace-tabs");
    rail.append(nav);
    document.body.prepend(rail);
    for (const phase of ["drive", "results", "setup"]) {
      const b = $5(phase + "Tab");
      b.innerHTML = (icons[phase] || icons.settings) + `<span>${phase === "drive" ? "Driving" : phase === "results" ? "Results" : "Setup"}</span>`;
      b.title = phase === "drive" ? "Driving" : phase === "results" ? "Results" : "Advanced setup";
      b.setAttribute("aria-label", b.title);
    }
    const map = node2("button");
    map.innerHTML = icons.map + "<span>Map</span>";
    map.title = "Choose destination";
    map.onclick = () => $5("routeBtn").click();
    const settings = node2("button");
    settings.innerHTML = icons.settings + "<span>Settings</span>";
    settings.title = "Settings";
    settings.onclick = () => $5("settingsBtn").click();
    const advanced = node2("button", "", "City & research configuration \u2197");
    advanced.id = "openAdvancedSetup";
    advanced.onclick = () => {
      tools2.close(false);
      if (p.controlMode === "MANUAL") tools2.clearControls("setup_inspection");
      showWorkspace("setup");
    };
    $5("settingsPanel").append(advanced);
    document.addEventListener("advancedsetupopen", () => {
      if (p.controlMode === "MANUAL" || tools2.options.isManualArmed?.()) tools2.clearControls("setup_inspection");
    });
    const diagnostics = node2("button");
    diagnostics.innerHTML = icon('<path d="M3 12h4l3-8 4 16 3-8h4"/>') + "<span>Diagnostics</span>";
    diagnostics.title = "Diagnostics";
    diagnostics.setAttribute("aria-label", "Diagnostics");
    diagnostics.onclick = () => $5("sensorBtn").click();
    const research = node2("button");
    research.innerHTML = icon('<path d="M9 3h6M10 3v6l-6 10a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3M7 15h10"/>') + "<span>Tools</span>";
    research.title = "Tools";
    research.setAttribute("aria-label", "Tools");
    research.onclick = () => {
      tools2.close(false);
      showWorkspace("setup");
    };
    rail.append(map, research, diagnostics, settings, node2("span", "rail-orb"));
    const setupShade = node2("button", "studio-setup-shade");
    setupShade.setAttribute("aria-label", "Close driving setup");
    setupShade.onclick = () => document.body.classList.remove("studio-setup-open");
    const setupDock = node2("button", "studio-setup-dock");
    setupDock.innerHTML = '<span>YOUR NEXT STEP</span><strong id="studioSetupDockLabel">Open driving setup</strong><b>\u2191</b>';
    setupDock.onclick = () => document.body.classList.add("studio-setup-open");
    document.body.append(setupShade, setupDock);
    const setupClose = node2("button", "studio-setup-close", "Close \xD7");
    setupClose.setAttribute("aria-label", "Close driving setup");
    setupClose.onclick = () => document.body.classList.remove("studio-setup-open");
    $5("guidedDrive").prepend(setupClose);
    const mobileEngineStop = node2("button", "studio-mobile-engine-stop", "Stop CARLA \xB7 Free GPU");
    mobileEngineStop.onclick = () => $5("stopSimulatorBtn").click();
    $5("settingsPanel").prepend(mobileEngineStop);
    document.addEventListener("workspacechange", (e) => {
      if (e.detail.phase === "results") document.body.classList.remove("studio-setup-open");
    });
    map.setAttribute("aria-label", "Choose destination on map");
    settings.setAttribute("aria-label", "Settings");
    for (const selector of [".normal-driving", ".comparison-controls", ".comparison-v2"]) {
      const feature = document.querySelector(selector);
      if (feature) $5("setupPhase").append(feature);
    }
    $5("normalControls").prepend($5("quickDriveActions"), $5("stopAcknowledgement"));
    const town = node2("div", "studio-town");
    town.innerHTML = icons.map + '<div><strong id="studioTown">CARLA</strong><span id="studioOwnership">Driving simulator</span></div>';
    $5("brand").after(town);
    document.querySelector("#brand h1").textContent = "Ya Rab Ostorha";
    document.querySelector("#brand .eyebrow").textContent = "CARLA Driving Simulator";
    document.querySelector(".guided-heading .eyebrow").textContent = "YOUR NEXT JOURNEY";
    const camera = $5("frontCameraView");
    const stage = camera.parentElement;
    const controlBar = node2("section", "studio-control-bar");
    controlBar.setAttribute("aria-label", "Driving controls");
    controlBar.innerHTML = '<div class="studio-drive-context"><span>LIVE DRIVE / CONTROL</span><strong id="studioRouteContext">No destination selected</strong><small id="studioControlStage">Vehicle held</small></div><div class="studio-manual-cluster"><div id="studioManualMode" class="studio-manual-modes" data-mode="ROBOSPHERE" role="group" aria-label="Keyboard driving protection"><button type="button" data-manual-mode="ROBOSPHERE" aria-pressed="true">Protected</button><button type="button" data-manual-mode="NORMAL" aria-pressed="false">Normal</button></div><span id="studioManualContext">Robosphere protection</span></div><div class="studio-drive-buttons"><button id="studioManualStop" type="button">Stop</button><button id="studioResultsLink" type="button">Results \u2197</button></div>';
    $5("cameraCard").insertBefore(controlBar, stage);
    controlBar.querySelector(".studio-drive-buttons").prepend($5("startDrivingBtn"));
    $5("studioManualStop").onclick = () => tools2.clearControls("operator_stop");
    $5("studioResultsLink").onclick = () => showWorkspace("results");
    const shortcutButton = node2("button", "", "Keys ?");
    shortcutButton.id = "studioShortcutButton";
    shortcutButton.type = "button";
    shortcutButton.title = "Keyboard shortcuts (H)";
    controlBar.querySelector(".studio-drive-buttons").append(shortcutButton);
    const shortcutDialog = node2("dialog");
    shortcutDialog.id = "studioShortcutDialog";
    shortcutDialog.innerHTML = '<header><h2>Driving shortcuts</h2><button type="button" id="studioShortcutClose">Close \xD7</button></header><dl><dt>Steer and drive <small>Manual mode</small></dt><dd><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd></dd><dt>Boost to 80 km/h <small>Hold with W</small></dt><dd><kbd>Shift</kbd> + <kbd>W</kbd></dd><dt>Brake / parking brake</dt><dd><kbd>Space</kbd></dd><dt>Cycle cameras</dt><dd><kbd>C</kbd></dd><dt>Open / close route map</dt><dd><kbd>M</kbd></dd><dt>Fullscreen simulation</dt><dd><kbd>F</kbd></dd><dt>Phone tools</dt><dd><kbd>P</kbd></dd><dt>Show this guide</dt><dd><kbd>H</kbd></dd><dt>Close overlay</dt><dd><kbd>Esc</kbd></dd></dl>';
    document.body.append(shortcutDialog);
    shortcutButton.onclick = () => {
      if (shortcutDialog.open) return;
      if (p.controlMode === "MANUAL" || tools2.options.isManualArmed?.()) tools2.clearControls("shortcut_inspection");
      shortcutDialog.showModal();
    };
    shortcutDialog.querySelector("#studioShortcutClose").onclick = () => shortcutDialog.close();
    controlBar.querySelectorAll("[data-manual-mode]").forEach((button) => button.onclick = () => {
      if (button.disabled) return;
      $5("studioManualMode").dataset.mode = button.dataset.manualMode;
      controlBar.querySelectorAll("[data-manual-mode]").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    });
    const hud = node2("div", "studio-hud");
    hud.innerHTML = '<span id="studioGear">N</span><strong id="studioSpeed">\u2014</strong><span>km/h</span><small id="studioTarget">Target \u2014</small>';
    camera.append(hud);
    const mode = node2("div", "studio-mode-pill");
    mode.innerHTML = '<i></i><span id="studioMode">Ready when you are</span><b id="studioElapsed"></b>';
    camera.append(mode);
    const intervention = node2("div", "studio-safety-alert");
    intervention.id = "studioSafetyAlert";
    intervention.setAttribute("role", "status");
    intervention.hidden = true;
    camera.append(intervention);
    const mapLabel = node2("span", "sensor-overlay-label", "Measured surroundings");
    camera.append(mapLabel);
    $5("miniMapToggle").hidden = true;
    const unifiedMap = installUnifiedMap(p, predictionView2, tools2);
    const views = node2("section", "studio-camera-views");
    views.setAttribute("aria-label", "Camera views");
    views.innerHTML = "<h3>" + icon('<path d="M3 6h13v13H3zM16 10l5-3v11l-5-3"/>') + ' Camera views</h3><div class="studio-view-buttons"></div>';
    for (const [value, label] of [["front", "Front"], ["hood", "Hood"], ["chase", "Chase"], ["rear", "Rear"], ["top", "Top"]]) {
      const b = node2("button", "", label);
      b.dataset.camera = value;
      b.onclick = () => {
        if (b.disabled) return;
        $5("cameraView").value = value;
        $5("cameraView").dispatchEvent(new Event("change"));
      };
      views.lastElementChild.append(b);
    }
    $5("modelVision").before(views);
    const cameraStatus = node2("span", "studio-camera-status", "");
    cameraStatus.id = "studioCameraStatus";
    cameraStatus.setAttribute("role", "status");
    views.append(cameraStatus, $5("replayPauseBtn"), $5("expandCameraBtn"));
    const fullscreen = node2("div", "studio-fullscreen-controls");
    fullscreen.innerHTML = '<strong>Ya Rab Ostorha \xB7 Live simulation</strong><button id="studioFullscreenStop">\u0625\u064A\u0642\u0627\u0641 \u0627\u0644\u0639\u0631\u0628\u064A\u0629</button><button id="studioFullscreenEmergency" class="emergency">\u0625\u064A\u0642\u0627\u0641 \u0637\u0648\u0627\u0631\u0626</button><button id="studioFullscreenClose" aria-label="Exit expanded simulator">Close \xD7</button>';
    $5("cameraCard").prepend(fullscreen);
    $5("studioFullscreenStop").onclick = () => tools2.clearControls("operator_stop");
    $5("studioFullscreenEmergency").onclick = () => $5("emergencyStopBtn").click();
    $5("studioFullscreenClose").onclick = () => tools2.expandCamera(false);
    const kpis = node2("section", "studio-kpis");
    kpis.setAttribute("aria-label", "Live measurements");
    const liveFields = ["Vehicles", "Pedestrians", "Front gap", "TTC", "Brake", "Collisions"];
    const liveValues = liveFields.map((name, i) => {
      const cell = node2("div");
      cell.dataset.index = i;
      cell.append(node2("span", "", name), node2("strong", "", "\u2014"));
      kpis.append(cell);
      return cell.lastChild;
    });
    $5("cameraCard").append(kpis);
    const health = node2("section", "studio-health");
    health.innerHTML = '<h3>Safety monitor <span id="studioHealthStatus">Offline</span></h3><dl><div><dt>Sensors</dt><dd id="studioSensorHealth">\u2014</dd></div><div><dt>Control</dt><dd id="studioControlHealth">Vehicle held</dd></div><div><dt>Simulation</dt><dd id="studioRate">\u2014</dd></div></dl>';
    $5("sensorPanel").append(health);
    const results = $5("resultsPhase");
    results.querySelector(".analysis-heading h2").textContent = "Comparison results";
    const sub = node2("p", "studio-result-subtitle", "Your driving, with and without Robosphere.");
    results.querySelector(".analysis-heading h2").after(sub);
    const ordinary = node2("section", "journey-comparison");
    ordinary.id = "ordinaryComparison";
    ordinary.dataset.view = "journey";
    ordinary.dataset.focusMode = "ROBOSPHERE";
    ordinary.innerHTML = '<div class="studio-comparison-banner"><div><strong id="ordinaryComparisonTitle">Comparison incomplete</strong><p id="ordinaryComparisonHint">Run both modes to complete your comparison.</p><p id="ordinaryRecoveryStatus" role="status"></p></div><div><span id="ordinaryComparisonCount">0 of 2 attempts recorded</span><progress id="ordinaryComparisonProgress" max="2" value="0" aria-label="Recorded modes"></progress></div></div><div class="studio-result-controls"><div class="studio-result-view" role="group" aria-label="Comparison measurements"><button data-result-view="journey" aria-pressed="true">Journey</button><button data-result-view="safety" aria-pressed="false">Safety & sensing</button></div><div class="studio-run-switch" role="group" aria-label="Comparison mode"><button data-focus-mode="ROBOSPHERE" aria-pressed="true">With Robosphere</button><button data-focus-mode="NORMAL" aria-pressed="false">Without</button></div><button id="studioResultDetailsBtn">More details \u2197</button></div><div id="ordinaryComparisonPanels" class="studio-result-pair"></div>';
    ordinary.querySelectorAll("[data-result-view]").forEach((button) => button.onclick = () => {
      ordinary.dataset.view = button.dataset.resultView;
      ordinary.querySelectorAll("[data-result-view]").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    });
    ordinary.querySelectorAll("[data-focus-mode]").forEach((button) => button.onclick = () => {
      ordinary.dataset.focusMode = button.dataset.focusMode;
      ordinary.querySelectorAll("[data-focus-mode]").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    });
    results.querySelector(".analysis-heading").after(ordinary);
    const detail = node2("details", "studio-diagnostics");
    detail.id = "studioDiagnostics";
    detail.innerHTML = '<summary>Diagnostics & research archive</summary><div id="studioDiagnosticContent"></div>';
    results.append(detail);
    const researchScope = results.querySelector(".analysis-heading .muted");
    if (researchScope) $5("studioDiagnosticContent").append(researchScope);
    $5("sensorPanel").append($5("motionReadout"));
    for (const el2 of [document.querySelector(".safety-monitor"), document.querySelector(".session-timeline"), $5("liveOperationStatus"), $5("resultContent"), document.querySelector(".recording-archive")]) if (el2) $5("studioDiagnosticContent").append(el2);
    const definitions = node2("details", "studio-definitions");
    definitions.innerHTML = '<summary>How the comparison is measured</summary><p>Collisions are native contact episodes per actor, separated by more than 1 second. Impulse is the maximum native contact impulse (N\xB7s). A forward near miss requires measured TTC below 1.5 s and range below 5 m, with a 1-second release gap.</p><p>High-risk time comes from the same forward sensor observer in both modes. Coverage shows how much of the run had fresh, usable observations. Unknown space is not counted as clear. Normal follows the native route and traffic signals. Normal manual control preserves the driver pedals and steering. Normal autonomous control follows the route and signals without automatic obstacle braking. Sensors and RULE proposals are recorded for observation only; operator stops, emergency stops and connection watchdogs remain active.</p><p>Each run records automatically. Arrived, stopped, collision and failed attempts stay distinct. The paired setup restores origin, destination, weather, requested speed and seeded traffic settings. Live actor trajectories can diverge; these are measured differences, not a causal count of prevented accidents. Historical research and its budgets remain separate.</p><p id="ordinaryRecordingReferences"></p>';
    ordinary.append(definitions);
    const provenance = node2("details", "studio-provenance");
    provenance.innerHTML = '<summary>Comparison Details \xB7 setup & recordings</summary><div id="ordinaryProvenance"></div>';
    ordinary.append(provenance);
    const fields = [["Collision episodes", "collisions", 0, ""], ["Run duration", "duration_s", 1, " s"], ["Reached & stopped", "destination_reached", 0, ""], ["Route completion", "route_completion_percent", 0, "%"], ["Distance travelled", "distance_m", 0, " m"], ["Minimum forward gap", "minimum_forward_range_m", 1, " m"], ["Harsh braking episodes", "harsh_braking_events", 0, ""], ["RULE interventions", "safety_interventions", 0, ""], ["Intervention time", "safety_intervention_s", 1, " s"], ["Forward near misses", "near_misses", 0, ""], ["High-risk time", "high_risk_s", 1, " s"], ["Sensor coverage", "sensor_coverage_percent", 0, "%"]];
    const cards = {}, pending2 = { intent: null, sent: false };
    const recovery = node2("div", "studio-recovery-actions");
    recovery.hidden = true;
    const retryRecovery = node2("button", "", "Retry saved setup"), cancelRecovery = node2("button", "", "Use current setup");
    recovery.append(retryRecovery, cancelRecovery);
    $5("guidedStatus").after(recovery);
    let failedPreparation = null;
    retryRecovery.onclick = () => {
      if (!failedPreparation) return;
      p.operationError = null;
      pending2.intent = failedPreparation;
      pending2.sent = false;
      recovery.hidden = true;
    };
    cancelRecovery.onclick = () => {
      p.operationError = null;
      pending2.intent = preparedRequest = failedPreparation = null;
      recovery.hidden = true;
      guided2.chooseMode(selectedRecoveryMode);
    };
    let selectedRecoveryMode = "ROBOSPHERE";
    for (const mode2 of JOURNEY_MODES) {
      const panel = node2("article", "studio-run-panel");
      panel.dataset.mode = mode2;
      const header = node2("header");
      header.innerHTML = `<span class="mode-symbol" aria-hidden="true">${mode2 === "NORMAL" ? "\u25C7" : "\u25CE"}</span><div><h3>${mode2 === "NORMAL" ? "Without Robosphere" : "With Robosphere"}</h3><p>${mode2 === "NORMAL" ? "Normal Mode \xB7 native route driver" : "Ya Rab Ostorha Mode \xB7 RULE protection"}</p></div><span class="run-status">Not Run</span>`;
      panel.append(header);
      const grid = node2("dl", "studio-run-metrics");
      const values = fields.map(([label, key], i) => {
        const cell = node2("div");
        cell.dataset.field = key;
        cell.dataset.group = i < 6 ? "journey" : "safety";
        cell.append(node2("dt", "", label), node2("dd", "", "\u2014"), node2("span", "metric-difference", ""));
        grid.append(cell);
        return cell;
      });
      panel.append(grid);
      const chart = node2("div", "studio-risk-chart");
      chart.innerHTML = '<h4>Forward risk over time</h4><div class="risk-bars"></div><p class="risk-chart-caption">No simulation data</p>';
      panel.append(chart);
      const extra = node2("p", "run-extra");
      panel.append(extra);
      const events = node2("ol", "studio-run-events");
      panel.append(events);
      const button = node2("button", "run-mode-cta", `Run ${modeName(mode2)} \u2197`);
      panel.insertBefore(button, grid);
      button.onclick = () => {
        if (button.disabled) return;
        if (["RUNNING", "STARTING"].includes(p.journey?.status)) {
          p.operationError = "Stop the current drive before preparing another mode.";
          return;
        }
        pending2.intent = { mode: mode2, pair_id: p.journeyComparison?.pair_id };
        pending2.sent = false;
        selectedRecoveryMode = mode2;
        failedPreparation = null;
        recovery.hidden = true;
        showWorkspace("drive");
        document.body.classList.add("studio-setup-open");
        guided2.chooseMode(mode2, { restoring: !!pending2.intent.pair_id });
        txt($5("ordinaryRecoveryStatus"), "Preparing " + modeName(mode2) + ". Follow the readiness steps in Driving.");
      };
      $5("ordinaryComparisonPanels").append(panel);
      cards[mode2] = { panel, header, values, chart, extra, events, button, eventKey: null };
    }
    const detailDialog = node2("dialog", "studio-result-dialog");
    detailDialog.id = "studioResultDialog";
    const detailHeading = node2("div", "studio-result-dialog-heading");
    detailHeading.innerHTML = '<strong>Comparison details</strong><button id="studioResultDialogClose" aria-label="Close comparison details">Close \xD7</button>';
    detailDialog.append(detailHeading, definitions, provenance, detail);
    for (const mode2 of JOURNEY_MODES) {
      const section = node2("section", "studio-event-detail");
      section.append(node2("h3", "", mode2 === "NORMAL" ? "Normal Mode events" : "Ya Rab Ostorha Mode events"), cards[mode2].events);
      detailDialog.append(section);
    }
    document.body.append(detailDialog);
    $5("studioResultDetailsBtn").onclick = () => detailDialog.showModal();
    $5("studioResultDialogClose").onclick = () => detailDialog.close();
    const backToDrive = node2("button", "studio-back-to-drive", "\u2190 Live drive");
    backToDrive.onclick = () => showWorkspace("drive");
    results.querySelector(".analysis-heading").append(backToDrive);
    let resultKey = "", preparedRequest = null, previousPreparation = null;
    let modeSession = null;
    return { update(vehicle) {
      if (modeSession !== p.sessionId) {
        modeSession = p.sessionId;
        $5("studioManualMode").dataset.mode = p.manualDrivingMode || "ROBOSPHERE";
      }
      const automatic = ["STARTING", "RUNNING"].includes(p.journey?.status) && p.controlMode === "AUTOMATIC";
      if (automatic) $5("studioManualMode").dataset.mode = p.journey?.driving_mode || "ROBOSPHERE";
      if (p.controlMode === "MANUAL") $5("studioManualMode").dataset.mode = p.manualDrivingMode || "ROBOSPHERE";
      const manualMode = $5("studioManualMode").dataset.mode;
      controlBar.querySelectorAll("[data-manual-mode]").forEach((button) => {
        button.disabled = automatic || p.controlMode === "MANUAL" || p.isReplay || !p.fresh;
        button.setAttribute("aria-pressed", String(button.dataset.manualMode === manualMode));
        button.title = button.disabled && automatic ? "Stop autonomous driving before changing protection" : "";
      });
      txt($5("studioRouteContext"), p.route?.destination?.name || "No destination \xB7 keyboard available");
      txt($5("studioControlStage"), automatic ? "Self-driving \xB7 " + modeName(manualMode) : p.controlMode === "MANUAL" ? "Keyboard driving \xB7 " + modeName(manualMode) : "Vehicle held");
      txt($5("studioManualContext"), manualMode === "NORMAL" ? "Normal \xB7 obstacle protection off" : "Robosphere \xB7 " + (p.safetySystem?.controller || "RULE") + " protection");
      txt($5("startDrivingBtn"), automatic ? "Take manual control" : p.controlMode === "MANUAL" ? "Keyboard active" : "Start keyboard control");
      $5("startDrivingBtn").disabled ||= p.controlMode === "MANUAL";
      $5("studioManualStop").disabled = !p.fresh || p.isReplay || !p.controller || !["MANUAL", "AUTOMATIC"].includes(p.controlMode);
      $5("studioResultsLink").disabled = p.isReplay && !p.journeyComparison;
      mobileEngineStop.disabled = $5("stopSimulatorBtn").disabled;
      txt($5("studioSetupDockLabel"), $5("guidedPrimary").textContent || "Open driving setup");
      if (!document.body.classList.contains("light-cockpit") && ["RUNNING", "STARTING"].includes(p.journey?.status)) document.body.classList.remove("studio-setup-open");
      unifiedMap.update(vehicle);
      $5("studioFullscreenEmergency").disabled = $5("emergencyStopBtn").disabled;
      $5("studioFullscreenStop").disabled = !p.fresh || !p.controller || p.isReplay;
      const setupEmergency = $5("advancedSetupEmergency");
      if (setupEmergency) setupEmergency.disabled = $5("emergencyStopBtn").disabled;
      for (const m of JOURNEY_MODES) cards[m].button.disabled = ["RUNNING", "STARTING"].includes(p.journey?.status) || !!p.recording || !!pending2.intent || p.isReplay;
      const fresh = p.fresh && !p.isReplay, measured = p.fresh, num2 = (v, suffix = "", digits = 0) => Number.isFinite(v) ? v.toFixed(digits) + suffix : "\u2014";
      txt($5("studioTown"), p.world?.map?.split("/").pop() || "CARLA");
      txt($5("studioOwnership"), p.isReplay ? "Recorded replay" : !fresh ? "Simulator offline" : p.controller ? "Vehicle control owned" : "Observer \xB7 control elsewhere");
      txt($5("studioSpeed"), measured ? num2(vehicle.speedKmh) : "\u2014");
      txt($5("studioGear"), measured ? vehicle.gear || "N" : "N");
      txt($5("studioTarget"), p.controlMode === "MANUAL" ? "30 \xB7 Shift 80 max" : "Target " + (fresh ? num2(p.journey?.speed_kmh, " km/h") : "\u2014"));
      const run = p.journeyComparison?.runs?.[p.journey?.driving_mode];
      txt($5("studioMode"), p.isReplay ? "Recorded replay" : !fresh ? "Simulator disconnected" : p.controlMode === "MANUAL" ? "Keyboard \xB7 " + modeName(p.manualDrivingMode) : ["RUNNING", "STARTING"].includes(p.journey?.status) ? (p.journey.status === "STARTING" ? "Starting \xB7 " : "") + modeName(p.journey.driving_mode) : $5("driveState").textContent);
      const braking = p.stopDiagnostics?.braking, active = p.safetySystem?.active && p.journey?.driving_mode !== "NORMAL";
      const rear = p.journey?.status === "RUNNING" && p.safetySystem?.side_rear_observations?.find((item) => item.relation === "REAR_APPROACH" && item.matched_frames >= 5 && item.time_to_conflict_s > 0 && item.time_to_conflict_s <= 2);
      const front = p.safetySystem?.measured_range_m;
      if (!document.body.classList.contains("light-cockpit")) {
        intervention.hidden = !fresh || !(active || braking || rear);
        intervention.dataset.tone = rear && !active && !braking ? "info" : "warning";
        txt(intervention, rear && Number.isFinite(front) && front < 5 ? `Rear vehicle closing \xB7 front gap ${front.toFixed(1)} m; holding to avoid a front collision` : active ? "Safety intervention \xB7 " + controlReasonText(p.safetySystem.reason || "RULE braking") : braking ? (p.stopDiagnostics.decision_source || "Vehicle hold") + " \xB7 " + controlReasonText(p.stopDiagnostics.reason || "Brake applied") : rear ? `Rear vehicle closing \xB7 ${p.rearAssist ? "accelerating within target speed" : "keeping lane and forward clearance"}` : "");
      }
      txt($5("studioElapsed"), run?.status === "RUNNING" ? num2(run.duration_s, " s") : "");
      mode.dataset.mode = p.controlMode === "MANUAL" ? p.manualDrivingMode : p.journey?.driving_mode || "";
      const sensorKeys = Object.keys(p.sensorMetadata || {}), healthy = sensorKeys.filter((k) => !p.sensorErrors?.[k]).length;
      [
        fresh ? p.population?.actual?.vehicles : null,
        fresh ? p.population?.actual?.pedestrians : null,
        fresh ? p.maneuver?.front_gap_m ?? p.safetySystem?.measured_range_m : null,
        fresh ? p.maneuver?.front_ttc_s ?? p.safetySystem?.ttc_s : null,
        fresh && Number.isFinite(vehicle.brake) ? vehicle.brake * 100 : null,
        fresh && run?.setup?.collision_measurement_available ? run.collisions : null
      ].forEach((value, i) => txt(liveValues[i], num2(value, i === 2 ? " m" : i === 3 ? " s" : i === 4 ? "%" : "", i === 2 || i === 3 ? 1 : 0)));
      txt($5("studioHealthStatus"), fresh ? p.controlMode === "AUTOMATIC" ? "Active" : "Ready" : "Offline");
      $5("studioHealthStatus").dataset.tone = !fresh ? "neutral" : p.safetySystem?.active ? "danger" : p.safetySystem?.status?.includes("FAULT") ? "danger" : "success";
      txt($5("studioSensorHealth"), fresh ? healthy + " / " + sensorKeys.length : "Waiting");
      txt($5("studioControlHealth"), fresh ? p.controlMode === "AUTOMATIC" && p.journey?.driving_mode === "BASELINE" ? "\u062D\u0645\u0627\u064A\u0629 \u0633\u0627\u0626\u0642 CARLA" : p.controlMode === "AUTOMATIC" && p.journey?.driving_mode === "HYBRID" ? "\u0645\u062A\u0627\u0628\u0639\u0629 \u0627\u0644\u062D\u0631\u0643\u0629" : p.journey?.driving_mode === "NORMAL" && p.controlMode === "AUTOMATIC" ? "Normal \xB7 route and signals" : p.safetySystem?.active ? "RULE braking" : p.controlMode === "AUTOMATIC" ? "RULE monitoring" : "Vehicle held" : "Vehicle held");
      txt($5("studioRate"), fresh ? num2(p.performance?.nativeTickRateHz, " Hz", 1) : "Offline");
      const cameraChange = tools2.cameraChange, confirmedView = cameraChange?.status === "applied" ? cameraChange.requested : tools2.catalog?.settings?.camera_view;
      views.querySelectorAll("[data-camera]").forEach((b) => {
        b.setAttribute("aria-pressed", String(!!confirmedView && b.dataset.camera === confirmedView));
        b.disabled = $5("cameraView").disabled || cameraChange?.status === "pending";
      });
      txt(cameraStatus, cameraChange?.status === "pending" ? "Changing camera\u2026" : cameraChange?.status === "failed" ? cameraChange.error : cameraChange?.status === "applied" ? cameraChange.requested[0].toUpperCase() + cameraChange.requested.slice(1) + " view applied" : "");
      cameraStatus.dataset.tone = cameraChange?.status || "";
      if (document.body.dataset.ui === "guided" && views.nextElementSibling !== $5("modelVision")) $5("modelVision").before(views);
      if (pending2.intent && !pending2.sent && fresh && p.controller && p.controlMode === "PAUSED" && Math.abs(vehicle.speedMps) < 0.15) {
        if (pending2.intent.pair_id) {
          previousPreparation = p.dashboardResult?.operationId;
          if (p.dashboardAction("prepare_journey_mode", pending2.intent)) {
            pending2.sent = true;
            preparedRequest = pending2.intent;
          }
        } else {
          guided2.chooseMode(pending2.intent.mode);
          pending2.intent = null;
        }
      }
      if (preparedRequest && p.dashboardResult?.operationId !== previousPreparation && p.dashboardResult?.action === "prepare_journey_mode" && ["APPLIED", "REJECTED"].includes(p.dashboardResult.status)) {
        if (p.dashboardResult.status === "APPLIED") guided2.chooseMode(preparedRequest.mode);
        else {
          p.operationError = p.dashboardResult.error;
          failedPreparation = preparedRequest;
          recovery.hidden = false;
        }
        pending2.intent = preparedRequest = null;
      }
      if (preparedRequest && p.operationError) {
        failedPreparation = preparedRequest;
        recovery.hidden = false;
        pending2.intent = preparedRequest = null;
      }
      if (pending2.intent && !pending2.sent) txt($5("guidedStatus"), !fresh ? "Comparison selected. Connect the simulator to restore its setup." : !p.controller ? "Comparison selected. Take vehicle control to restore its setup." : p.controlMode !== "PAUSED" || Math.abs(vehicle.speedMps) >= 0.15 ? "Stop and wait for the vehicle to be held before restoring the comparison." : "Restoring the saved comparison setup\u2026");
      if (preparedRequest) txt($5("guidedStatus"), "Restoring the saved origin, route and traffic. Waiting for confirmation.");
      const data = p.journeyComparison, key = JSON.stringify(data);
      if (key === resultKey) return;
      resultKey = key;
      const summary = comparisonSummary(data);
      txt($5("ordinaryComparisonTitle"), summary.title);
      txt($5("ordinaryComparisonHint"), summary.detail);
      if (summary.arrived && !pending2.intent && !preparedRequest && !failedPreparation) txt($5("ordinaryRecoveryStatus"), "");
      const archiveNote = data?.storage_error ? ` \xB7 Result save failed: ${data.storage_error}` : "";
      if (archiveNote && !$5("ordinaryComparisonHint").textContent.includes(archiveNote)) $5("ordinaryComparisonHint").textContent += archiveNote;
      txt($5("ordinaryComparisonCount"), summary.count + " of 2 attempts recorded");
      $5("ordinaryComparisonProgress").value = summary.count;
      ordinary.dataset.complete = String(summary.arrived && data?.conditions_match === true);
      txt($5("ordinaryRecordingReferences"), JOURNEY_MODES.filter((m) => data?.runs?.[m]?.recording).map((m) => modeName(m) + ": " + data.runs[m].recording).join(" \xB7 ") || "No recordings yet.");
      for (const m of JOURNEY_MODES) {
        const c = cards[m], r = data?.runs?.[m];
        c.panel.dataset.empty = String(!r);
        const labels = { ARRIVED: "Completed", RUNNING: "Recording", COLLISION: "Collision", INTERRUPTED: "Incomplete", ERROR: "Failed", FAILURE: "Failed", TIMEOUT: "Incomplete" };
        txt(c.header.querySelector(".run-status"), r ? labels[r.status] || r.status : "Not run");
        c.header.querySelector(".run-status").dataset.status = r?.status || "EMPTY";
        fields.forEach(([, field, digits, suffix], i) => {
          txt(c.values[i].querySelector("dd"), metricValue(r, field, digits, suffix));
          const d = m === "ROBOSPHERE" ? measuredDifference(data, field) : null;
          txt(c.values[i].lastChild, d !== null ? (d > 0 ? "+" : "") + d.toFixed(digits) + suffix + " vs Normal" : "");
        });
        const timeline = r?.risk_timeline || [], bars = c.chart.querySelector(".risk-bars");
        const chartKey = JSON.stringify(timeline);
        if (c.chartKey !== chartKey) {
          c.chartKey = chartKey;
          bars.replaceChildren(...timeline.filter((_, i) => i % Math.max(1, Math.ceil(timeline.length / 100)) === 0).map((point) => {
            const bar = node2("i");
            bar.dataset.risk = point.risk;
            bar.title = point.elapsed_s.toFixed(1) + " s \xB7 " + point.risk;
            return bar;
          }));
        }
        txt(c.chart.lastChild, !r ? "No simulation data" : timeline.length ? "High \xB7 clear \xB7 unknown (grey)" : "Waiting for measured samples");
        txt(c.extra, r ? `Mean ${metricValue(r, "mean_speed_kmh", 1, " km/h")} \xB7 max impulse ${metricValue(r, "maximum_impulse_ns", 1, " N\xB7s")} \xB7 ${r.samples} samples${r.reason ? " \xB7 " + r.reason.replaceAll("_", " ") : ""}` : "Not simulated yet. No measurements recorded.");
        const eventKey = JSON.stringify(r?.events || []);
        if (eventKey !== c.eventKey) {
          c.eventKey = eventKey;
          c.events.replaceChildren(...(r?.events || []).slice(-3).reverse().map((e) => {
            const li = node2("li");
            li.append(node2("strong", "", e.title), node2("span", "", e.detail));
            return li;
          }));
        }
        txt(c.button, (r ? "Run again \xB7 " : "Run ") + modeName(m) + " \u2197");
      }
      const rows = [["Run ID", (r) => r.id], ["Status", (r) => r.status], ["Town", (r) => r.setup?.map], ["Vehicle", (r) => r.setup?.blueprint], ["Destination", (r) => r.setup?.destination?.name], ["Origin", (r) => r.setup?.origin?.location?.map((x) => x.toFixed(2)).join(", ")], ["Target speed", (r) => Number.isFinite(r.setup?.speed_kmh) ? r.setup.speed_kmh + " km/h" : null], ["Traffic seed", (r) => r.setup?.population?.seed], ["Requested population", (r) => r.setup?.population && `${r.setup.population.vehicle_count} vehicles \xB7 ${r.setup.population.pedestrian_count} pedestrians \xB7 ${r.setup.population.chaos_percent}% randomness`], ["Applied population", (r) => r.setup?.actual_population && JSON.stringify(r.setup.actual_population)], ["Weather", (r) => r.setup?.weather && JSON.stringify(r.setup.weather)], ["Protection", (r) => r.mode === "NORMAL" ? "Obstacle protection off; route and signals only" : "Established RULE protection"], ["Recording", (r) => r.recording || "No recording reference"], ["Recorded at UTC", (r) => r.created_at_utc]];
      const table = node2("table");
      table.innerHTML = '<thead><tr><th scope="col">Conditions</th><th scope="col">With Robosphere</th><th scope="col">Without Robosphere</th></tr></thead>';
      const tbody = node2("tbody");
      for (const [label, get] of rows) {
        const tr = node2("tr");
        const th = node2("th", "", label);
        th.scope = "row";
        tr.append(th);
        for (const m of JOURNEY_MODES) {
          const r = data?.runs?.[m];
          tr.append(node2("td", "", r ? get(r) ?? "Not measured" : "Not Run"));
        }
        tbody.append(tr);
      }
      table.append(tbody);
      $5("ordinaryProvenance").replaceChildren(table);
    } };
  }

  // frontend/light-cockpit.js
  var $6 = (id) => document.getElementById(id);
  var el = (tag, cls, text) => {
    const n2 = document.createElement(tag);
    if (cls) n2.className = cls;
    if (text !== void 0) n2.textContent = text;
    return n2;
  };
  var svg = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  var icons2 = {
    car: svg('<path d="m5 8 2-4h10l2 4M4 8h16v10H4zM7 12h2m6 0h2M6 18v2m12-2v2"/>'),
    route: svg('<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3ZM9 3v15M15 6v15"/>'),
    shield: svg('<path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7Z"/><path d="m8 12 3 3 5-6"/>'),
    camera: svg('<path d="M4 7h4l2-3h4l2 3h4v13H4Z"/><circle cx="12" cy="13" r="3"/>'),
    expand: svg('<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>'),
    layers: svg('<path d="m12 3 10 5-10 5L2 8ZM2 12l10 5 10-5M2 16l10 5 10-5"/>'),
    person: svg('<circle cx="12" cy="5" r="2"/><path d="m7 21 3-7-2-4 4-2 3 4 4 1M12 9v6l4 6M8 10l-3 5"/>'),
    cube: svg('<path d="m12 3 9 5v9l-9 5-9-5V8ZM3 8l9 5 9-5M12 13v9M8 5l9 5"/>'),
    brake: svg('<circle cx="12" cy="12" r="6"/><path d="M4 5a10 10 0 0 0 0 14M20 5a10 10 0 0 1 0 14M12 9v4m0 3v.1"/>'),
    distance: svg('<path d="M3 7v10M21 7v10M4 12h16m-13-3-3 3 3 3m10-6 3 3-3 3"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')
  };
  var set = (id, value) => {
    const n2 = $6(id), s = String(value);
    if (n2.textContent !== s) n2.textContent = s;
  };
  function installLightCockpit(p, tools2, perception2, predictionView2, onResume) {
    document.body.classList.add("light-cockpit");
    document.querySelector("#brand h1").textContent = "YA RAB OSTORHA";
    document.querySelector("#brand .eyebrow").textContent = "Driving Simulator";
    document.querySelector(".brand-mark").innerHTML = icons2.shield;
    const rail = document.querySelector(".studio-rail"), nav = rail.querySelector("nav");
    rail.querySelector(".rail-brand").innerHTML = icons2.car;
    $6("driveTab").innerHTML = icons2.car + "<span>Driving</span>";
    const oldButtons = [...rail.children].filter((n2) => n2.tagName === "BUTTON");
    const scenario = oldButtons.find((n2) => n2.textContent === "Map");
    const toolsNav = oldButtons.find((n2) => n2.textContent === "Tools");
    const diagnostics = oldButtons.find((n2) => n2.textContent === "Diagnostics");
    const settings = oldButtons.find((n2) => n2.textContent === "Settings");
    scenario.id = "scenariosNav";
    scenario.innerHTML = icons2.route + "<span>Scenarios</span>";
    scenario.setAttribute("aria-label", "Scenarios");
    scenario.setAttribute("aria-controls", "cockpitScenarios");
    scenario.setAttribute("aria-expanded", "false");
    scenario.removeAttribute("title");
    settings.removeAttribute("title");
    toolsNav.removeAttribute("title");
    $6("driveTab").removeAttribute("title");
    $6("resultsTab").removeAttribute("title");
    nav.insertBefore(scenario, $6("resultsTab"));
    nav.append(toolsNav, settings);
    const railCaption = el("span", "rail-caption", "CARLA 0.9.16");
    rail.querySelector(".rail-orb").replaceWith(railCaption);
    const setup = el("dialog", "cockpit-dialog cockpit-scenarios");
    setup.id = "cockpitScenarios";
    setup.setAttribute("aria-labelledby", "cockpitScenariosTitle");
    setup.innerHTML = '<header class="cockpit-dialog-heading"><div><span class="eyebrow">DRIVE CONFIGURATION</span><h2 id="cockpitScenariosTitle">Scenarios</h2></div><button type="button" class="cockpit-dialog-emergency">Emergency stop</button><button type="button" class="cockpit-dialog-close" aria-label="Close scenarios">\xD7</button></header>';
    const inspector = document.querySelector(".drive-inspector");
    setup.append(inspector);
    const controlBar = document.querySelector(".studio-control-bar");
    setup.append(controlBar);
    document.body.append(setup);
    const openSetup = () => {
      showWorkspace("drive");
      tools2.close(false);
      if (p.controlMode === "MANUAL" || tools2.options.isManualArmed?.()) tools2.clearControls("setup_inspection");
      document.body.classList.add("studio-setup-open");
    };
    scenario.onclick = openSetup;
    document.addEventListener("workspacechange", (e) => {
      if (e.detail.phase === "results" && setup.open) setup.close();
    });
    setup.querySelector(".cockpit-dialog-close").onclick = () => setup.close();
    setup.addEventListener("close", () => {
      document.body.classList.remove("studio-setup-open");
      scenario.setAttribute("aria-expanded", "false");
    });
    setup.addEventListener("click", (e) => {
      if (e.target === setup) {
        const r = setup.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) setup.close();
      }
    });
    const syncSetup = () => {
      const open = document.body.classList.contains("studio-setup-open");
      if (open && !setup.open) setup.showModal();
      if (!open && setup.open) {
        setup.close();
        $6("frontCameraView").focus({ preventScroll: true });
      }
      scenario.setAttribute("aria-expanded", String(open));
    };
    new MutationObserver(syncSetup).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    const toolDialog = el("dialog", "cockpit-dialog");
    toolDialog.id = "cockpitTools";
    toolDialog.setAttribute("aria-labelledby", "cockpitToolsTitle");
    toolDialog.innerHTML = '<header class="cockpit-dialog-heading"><h2 id="cockpitToolsTitle">Simulator tools</h2><button type="button" class="cockpit-dialog-emergency">Emergency stop</button><button type="button" class="cockpit-dialog-close" aria-label="Close tools">\xD7</button></header><section class="cockpit-tool-group"><h3>Inspect & configure</h3><div id="cockpitToolActions"></div></section><section class="cockpit-tool-group"><h3>Simulator lifecycle</h3><p>Shut down the CARLA server and release its GPU memory. Use Stop in the header to end only the current drive.</p><div id="cockpitLifecycle"></div></section>';
    document.body.append(toolDialog);
    toolDialog.querySelector(".cockpit-dialog-close").onclick = () => toolDialog.close();
    $6("cockpitToolActions").append(diagnostics);
    diagnostics.onclick = () => {
      toolDialog.close();
      tools2.open("sensorPanel", toolsNav.id);
    };
    const research = el("button", "", "Scenario & research configuration");
    research.onclick = () => {
      toolDialog.close();
      showWorkspace("setup");
    };
    $6("cockpitToolActions").append(research);
    $6("cockpitLifecycle").textContent = "Free GPU and Reset are always available in the main header. Reset creates an empty session at the default start.";
    toolsNav.id = "cockpitToolsNav";
    toolsNav.setAttribute("aria-controls", "cockpitTools");
    toolsNav.setAttribute("aria-expanded", "false");
    toolsNav.onclick = () => {
      tools2.close(false);
      if (p.controlMode === "MANUAL" || tools2.options.isManualArmed?.()) tools2.clearControls("tools_inspection");
      toolDialog.showModal();
      toolsNav.setAttribute("aria-expanded", "true");
    };
    toolDialog.addEventListener("close", () => toolsNav.setAttribute("aria-expanded", "false"));
    const header = document.querySelector(".app-header");
    const chips = el("div", "cockpit-status-chips");
    chips.setAttribute("aria-label", "Live simulator status");
    chips.innerHTML = '<span class="cockpit-chip" id="cockpitConnection"><i></i><span id="cockpitConnectionText">CARLA Disconnected</span></span><span class="cockpit-chip" id="cockpitProtection">' + icons2.shield + '<span id="cockpitProtectionText">Protection offline</span></span><span class="cockpit-chip" id="cockpitDriver">' + icons2.car + '<span id="cockpitDriverText">Vehicle held</span></span>';
    const actions = el("div", "cockpit-header-actions");
    actions.append($6("replayPauseBtn"), $6("stopSimulatorBtn"), $6("resetSimulatorBtn"), $6("studioManualStop"), $6("emergencyStopBtn"), $6("acknowledgeStopBtn"));
    header.append(chips, actions);
    $6("studioManualStop").innerHTML = '<span aria-hidden="true">\u25A0</span> \u0625\u064A\u0642\u0627\u0641 \u0627\u0644\u0639\u0631\u0628\u064A\u0629';
    $6("studioManualStop").setAttribute("aria-label", "\u0625\u064A\u0642\u0627\u0641 \u0627\u0644\u0639\u0631\u0628\u064A\u0629");
    $6("studioManualStop").title = "Full brake and end the current drive; start driving again to resume";
    $6("emergencyStopBtn").textContent = "\u0625\u064A\u0642\u0627\u0641 \u0637\u0648\u0627\u0631\u0626";
    for (const btn of document.querySelectorAll(".cockpit-dialog-emergency")) btn.textContent = "\u0625\u064A\u0642\u0627\u0641 \u0637\u0648\u0627\u0631\u0626";
    for (const btn of document.querySelectorAll(".cockpit-dialog-emergency")) btn.onclick = () => {
      btn.closest("dialog").close();
      $6("emergencyStopBtn").click();
    };
    const camera = $6("frontCameraView");
    camera.tabIndex = -1;
    const cameraTools = el("div", "cockpit-camera-tools");
    const selector = el("label", "cockpit-camera-select");
    selector.innerHTML = icons2.camera + '<span class="sr-only">Camera view</span>';
    const select = el("select");
    select.id = "cockpitCameraView";
    select.setAttribute("aria-label", "Camera view");
    for (const option of $6("cameraView").options) {
      const n2 = option.cloneNode(true);
      n2.textContent = n2.value[0].toUpperCase() + n2.value.slice(1) + " View";
      select.append(n2);
    }
    selector.append(select);
    cameraTools.append(selector);
    const options = el("details", "cockpit-overlay-settings");
    options.innerHTML = '<summary aria-label="Overlay settings" title="Overlay settings">' + icons2.layers + '</summary><div class="cockpit-overlay-menu"><strong>Camera overlays</strong><label><input type="checkbox" data-overlay="boxes">Bounding boxes <small>2D</small></label><label><input type="checkbox" data-overlay="labels">Object labels</label><label><input type="checkbox" data-overlay="trajectories">Trajectory predictions</label><label><input type="checkbox" data-overlay="safety">Safety highlights</label><p id="cockpitOverlayState">3D geometry unavailable. 2D boxes require the matching front-camera frame.</p><button type="button" id="cockpitAnalysisLink">View analyzed frame \u2197</button></div>';
    cameraTools.append(options);
    camera.append(cameraTools);
    let preferences = { boxes: true, labels: true, trajectories: true, safety: true };
    try {
      const saved = JSON.parse(localStorage.getItem("camera-overlays-v1"));
      for (const k of Object.keys(preferences)) if (typeof saved?.[k] === "boolean") preferences[k] = saved[k];
    } catch {
    }
    predictionView2.visualOptions = preferences;
    for (const box of options.querySelectorAll("input")) {
      box.checked = preferences[box.dataset.overlay];
      box.onchange = () => {
        preferences[box.dataset.overlay] = box.checked;
        try {
          localStorage.setItem("camera-overlays-v1", JSON.stringify(preferences));
        } catch {
        }
      };
    }
    select.onchange = () => {
      $6("cameraView").value = select.value;
      $6("cameraView").dispatchEvent(new Event("change"));
      if (tools2.cameraChange?.status === "pending") {
        select.disabled = true;
        select.value = tools2.cameraChange.confirmed || select.value;
      }
      select.blur();
    };
    document.addEventListener("click", (e) => {
      if (!options.contains(e.target)) options.open = false;
    });
    options.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        options.open = false;
        options.querySelector("summary").focus();
      }
    });
    const expand = $6("expandCameraBtn");
    expand.classList.add("camera-icon-button");
    expand.innerHTML = icons2.expand;
    expand.setAttribute("aria-label", "Expand camera");
    expand.title = "Expand camera (F)";
    camera.append(expand);
    const cameraCaption = el("div", "cockpit-camera-caption");
    cameraCaption.innerHTML = '<span id="cockpitCameraState">Waiting for camera</span><span id="cockpitCameraRate"></span>';
    camera.append(cameraCaption);
    const canvas = el("canvas", "cockpit-detections");
    canvas.hidden = true;
    canvas.setAttribute("aria-hidden", "true");
    camera.append(canvas);
    const telemetry = el("aside", "cockpit-telemetry");
    telemetry.setAttribute("aria-label", "Essential driving telemetry");
    telemetry.innerHTML = '<div class="cockpit-speed"><div class="cockpit-rail-heading">' + icons2.car + '<h2>Vehicle speed</h2></div><div class="cockpit-gauge"><svg viewBox="0 0 200 115" aria-hidden="true"><path class="gauge-track" d="M22 98a78 78 0 0 1 156 0" pathLength="100"/><path id="cockpitSpeedArc" class="gauge-value" d="M22 98a78 78 0 0 1 156 0" pathLength="100"/><text x="19" y="114">0</text><text x="92" y="15">60</text><text x="165" y="114">120</text></svg><div class="cockpit-speed-value"><strong id="cockpitSpeed">\u2014</strong><span>km/h</span></div></div><p id="cockpitTarget">Target \u2014</p></div><div class="cockpit-metric cockpit-brake"><div>' + icons2.brake + '<h3>Brake</h3><span>Applied</span></div><p><strong id="cockpitBrake">\u2014</strong><span>%</span></p><div class="cockpit-brake-track"><span id="cockpitBrakeBar"></span></div><small id="cockpitBrakeReason" role="status">Waiting for command</small></div><div class="cockpit-metric cockpit-gap"><div>' + icons2.distance + '<h3>Front gap</h3></div><p><strong id="cockpitGap">\u2014</strong><span>m</span></p><small id="cockpitGapStatus">Measurement unavailable</small></div><div class="cockpit-metric cockpit-ttc"><div>' + icons2.clock + '<h3 title="Time to collision from measured closing speed">Time to collision</h3></div><p><strong id="cockpitTtc">\u2014</strong><span>s</span></p><small id="cockpitTtcStatus">Measurement unavailable</small></div>';
    $6("cameraCard").append(telemetry);
    const summary = el("section", "cockpit-summary");
    summary.setAttribute("aria-label", "Perception summary");
    summary.innerHTML = '<div class="cockpit-summary-heading"><h2>Objects in view</h2><p id="cockpitObjectsStatus">Front detections unavailable</p></div><div class="cockpit-object vehicles">' + icons2.car + '<div><span>Vehicles</span><strong id="cockpitVehicles">\u2014</strong></div></div><div class="cockpit-object people">' + icons2.person + '<div><span>Pedestrians</span><strong id="cockpitPeople">\u2014</strong></div></div><div class="cockpit-object tracks" title="Confirmed measured tracks from surrounding sensors; these are not camera detections">' + icons2.cube + '<div><span>Tracked objects</span><strong id="cockpitTracks">\u2014</strong><small>Surrounding sensors</small></div></div><button id="cockpitViewDetails">View details <span aria-hidden="true">\u2197</span></button>';
    $6("cameraCard").append(summary);
    const details = el("dialog", "cockpit-dialog cockpit-details");
    details.id = "cockpitDetails";
    details.setAttribute("aria-labelledby", "cockpitDetailsTitle");
    details.innerHTML = '<header class="cockpit-dialog-heading"><h2 id="cockpitDetailsTitle">Camera & sensor details</h2><button type="button" class="cockpit-dialog-emergency">\u0625\u064A\u0642\u0627\u0641 \u0637\u0648\u0627\u0631\u0626</button><button type="button" class="cockpit-dialog-close" aria-label="Close camera details">\xD7</button></header><p id="cockpitDetailsStatus"></p><h3>Scenario population</h3><p class="muted">Actors configured in the world. These counts are separate from camera detections.</p>';
    const kpis = document.querySelector(".studio-kpis");
    kpis.firstElementChild.firstElementChild.textContent = "Scenario vehicles";
    kpis.children[1].firstElementChild.textContent = "Scenario pedestrians";
    details.append(kpis, $6("modelVision"));
    const diagnosticButton = el("button", "", "Open full Diagnostics \u2197");
    diagnosticButton.onclick = () => {
      details.close();
      tools2.open("sensorPanel", "cockpitViewDetails");
    };
    details.append(diagnosticButton);
    document.body.append(details);
    details.querySelector(".cockpit-dialog-close").onclick = () => details.close();
    details.querySelector(".cockpit-dialog-emergency").onclick = () => {
      details.close();
      $6("emergencyStopBtn").click();
    };
    const openDetails = () => {
      if (p.controlMode === "MANUAL" || tools2.options.isManualArmed?.()) tools2.clearControls("details_inspection");
      details.showModal();
    };
    $6("cockpitViewDetails").onclick = openDetails;
    $6("cockpitAnalysisLink").onclick = () => {
      options.open = false;
      $6("modelVision").open = true;
      openDetails();
    };
    $6("connectionSetupBtn").onclick = openSetup;
    $6("connectionSetupBtn").textContent = "Set up simulation";
    const safety = $6("studioSafetyAlert");
    safety.replaceChildren();
    safety.setAttribute("aria-live", "polite");
    safety.append(el("span", "notice-icon"), el("div", "notice-copy"));
    safety.firstElementChild.innerHTML = icons2.shield;
    safety.lastElementChild.append(el("strong"), el("p"));
    const resume = el("button", "", "\u0627\u0633\u062A\u0626\u0646\u0627\u0641 \u0627\u0644\u0642\u064A\u0627\u062F\u0629");
    resume.id = "cockpitResumeDrive";
    resume.type = "button";
    resume.hidden = true;
    resume.onclick = () => onResume?.(p.journey?.driving_mode || p.manualDrivingMode || "ROBOSPHERE");
    safety.append(resume);
    let lastNotice = "", lastBoxKey = "", previousMode = p.controlMode;
    function drawDetections(displayed) {
      const result = perception2.result, front = p.sensorMetadata?.frontCamera;
      const match = preferences.boxes && !tools2.cameraChange?.status?.includes("pending") && !$6("authoritativeCamera").hidden && detectionFrameMatches(result, p, displayed, front);
      canvas.hidden = !match;
      set("cockpitOverlayState", match ? "2D fallback \xB7 exact front-camera frame. 3D geometry unavailable." : !preferences.boxes ? "Bounding boxes hidden. 3D geometry unavailable." : "3D geometry unavailable. 2D boxes require the matching front-camera frame.");
      if (!match) return;
      const bounds = $6("authoritativeCamera").getBoundingClientRect(), host = camera.getBoundingClientRect();
      const rect = containedImageRect(bounds, displayed.width, displayed.height);
      if (!rect) {
        canvas.hidden = true;
        return;
      }
      Object.assign(canvas.style, { left: bounds.left - host.left + rect.left + "px", top: bounds.top - host.top + rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
      const key = [result.image_token, preferences.labels].join(":");
      if (key === lastBoxKey) return;
      lastBoxKey = key;
      canvas.width = result.width;
      canvas.height = result.height;
      const c = canvas.getContext("2d");
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.lineWidth = Math.max(1, result.width / 500);
      c.font = `600 ${Math.max(11, result.width / 65)}px Manrope, sans-serif`;
      for (const detection of result.detections || []) {
        const b = validDetectionBox(detection, result.width, result.height);
        if (!b) continue;
        c.strokeStyle = detection.class === "person" ? "#753CF7" : "#4B84FC";
        c.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
        if (preferences.labels) {
          const text = String(detection.class || "Object") + " \xB7 2D", width = c.measureText(text).width + 10, y = Math.max(0, b[1] - 20);
          c.fillStyle = "#111827";
          c.fillRect(b[0], y, width, 20);
          c.fillStyle = "#FFFFFF";
          c.fillText(text, b[0] + 5, y + 14);
        }
      }
    }
    return { update(vehicle, displayed) {
      const m = cockpitMeasurements(p, vehicle), fresh = p.fresh && !p.isReplay;
      set("cockpitSpeed", metricText(m.speed));
      set("cockpitBrake", metricText(m.brake));
      set("cockpitGap", metricText(m.gap, 1));
      set("cockpitTtc", metricText(m.ttc, 1));
      set("cockpitTarget", p.isReplay ? "Recorded replay" : p.controlMode === "MANUAL" ? "Manual control" : "Target " + metricText(m.target) + (Number.isFinite(m.target) ? " km/h" : ""));
      $6("cockpitSpeedArc").style.strokeDasharray = `${Number.isFinite(m.speed) ? Math.min(100, Math.max(0, m.speed / 120 * 100)) : 0} 100`;
      $6("cockpitBrakeBar").style.width = (Number.isFinite(m.brake) ? m.brake : 0) + "%";
      set("cockpitBrakeReason", fresh ? (p.stopDiagnostics?.decision_source || "Driver") + " \xB7 " + controlReasonText(p.stopDiagnostics?.reason || "No braking requested") : "Waiting for live command");
      set("cockpitGapStatus", Number.isFinite(m.gap) ? "Measured forward distance" : fresh ? "Unavailable or stale" : "Waiting for live sensors");
      set("cockpitTtcStatus", Number.isFinite(m.ttc) ? "Measured closing time" : fresh ? "No valid closing measurement" : "Waiting for live sensors");
      set("cockpitConnectionText", p.isReplay ? "Recorded replay" : fresh ? "CARLA Connected" : p.simulationStarting ? "CARLA Starting" : p.restarting ? "CARLA Restarting" : p.phase === "ERROR" ? "CARLA Error" : "CARLA Disconnected");
      $6("cockpitConnection").dataset.tone = fresh ? "connected" : "neutral";
      const protection = safetyChip(p);
      set("cockpitProtectionText", protection.label);
      $6("cockpitProtection").dataset.tone = protection.tone;
      set("cockpitDriverText", driverCaption(p));
      $6("cockpitDriver").title = !fresh ? "No live control session" : p.controller ? "This page owns vehicle control" : "Observer \xB7 another page owns vehicle control";
      const cameraChange = tools2.cameraChange, confirmed = cameraChange?.status === "applied" ? cameraChange.requested : tools2.catalog?.settings?.camera_view;
      if (confirmed && select.value !== confirmed) select.value = confirmed;
      select.disabled = $6("cameraView").disabled || cameraChange?.status === "pending";
      selector.title = cameraChange?.status === "failed" ? cameraChange.error : cameraChange?.status === "pending" ? "Changing camera\u2026" : "Select a camera view";
      set("cockpitCameraState", $6("authoritativeCamera").hidden ? fresh ? "Waiting for live camera" : "Camera offline" : p.isReplay ? "RECORDED \xB7 RGB" : "LIVE \xB7 CARLA RGB");
      if ($6("authoritativeCamera").hidden) {
        const starting = p.simulationStarting, restarting = p.restarting, failed = p.simulatorStart?.status === "FAILED" || p.phase === "ERROR", stopped = p.simulatorStop?.status === "STOPPED";
        set("cameraEmptyTitle", starting ? "Starting CARLA" : restarting ? "Restarting CARLA" : failed ? "Simulator connection failed" : stopped ? "CARLA is stopped" : fresh ? "Waiting for camera frames" : "Simulator disconnected");
        set("cameraEmptyDescription", failed ? p.simulatorStart?.error || p.operationError || p.status : starting || restarting ? "Connecting the simulator, vehicle and sensors. Driving remains stopped." : fresh ? "The connection is live. Camera frames are not available; inspect Diagnostics." : "Open Scenarios to start the simulator and prepare your drive.");
        $6("connectionSetupBtn").hidden = fresh || p.isReplay;
        set("connectionSetupBtn", starting || restarting ? "View startup progress" : "Set up simulation");
      }
      set("cockpitCameraRate", !$6("authoritativeCamera").hidden && Number.isFinite(p.performance?.sensorWallRatesHz?.[displayed?.sensorId]) ? p.performance.sensorWallRatesHz[displayed.sensorId].toFixed(1) + " Hz" : "");
      const counts = perceptionCounts(perception2.result, p);
      set("cockpitVehicles", metricText(counts.vehicles));
      set("cockpitPeople", metricText(counts.people));
      set("cockpitObjectsStatus", counts.label);
      const prediction = predictionView2.currentPrediction;
      set("cockpitTracks", fresh && measuredPredictionFresh(prediction, p.sessionId, p.telemetry?.timestamp) ? (prediction.tracks || []).filter((t) => t.confirmed).length : "\u2014");
      const notice = safetyNotice(p), noticeKey = JSON.stringify(notice);
      safety.hidden = !notice;
      if (noticeKey !== lastNotice) {
        lastNotice = noticeKey;
        if (notice) {
          safety.dataset.tone = notice.tone;
          safety.querySelector(".notice-copy strong").textContent = notice.title;
          safety.querySelector(".notice-copy p").textContent = notice.detail;
        }
      }
      resume.hidden = !(notice && p.controlMode === "PAUSED" && p.route && !p.route.arrived && ["PAUSED", "ERROR"].includes(p.journey?.status));
      resume.disabled = !fresh || !p.controller || p.recording || p.recordingStatus?.finalized === false || p.restarting || !onResume || p.journey?.driving_mode === "HYBRID" && p.hybridDriving?.available !== true;
      for (const btn of document.querySelectorAll(".cockpit-dialog-emergency")) btn.disabled = $6("emergencyStopBtn").disabled;
      set("cockpitDetailsStatus", p.isReplay ? "Recorded replay \xB7 live inference is stopped." : fresh ? "Live measurements \xB7 " + (p.world?.map?.split("/").pop() || "CARLA") : "Simulator disconnected \xB7 live measurements unavailable.");
      if (setup.open && p.controlMode !== previousMode && ["MANUAL", "AUTOMATIC"].includes(p.controlMode)) document.body.classList.remove("studio-setup-open");
      previousMode = p.controlMode;
      document.querySelector(".studio-fullscreen-controls strong").textContent = protection.label + " \xB7 " + $6("cockpitDriverText").textContent;
      drawDetections(displayed);
    } };
  }

  // frontend/demo-drive.js
  var $7 = (id) => document.getElementById(id);
  var benchmarkModes = ["BASELINE", "HYBRID"];
  function selectPlaybackLeader(items) {
    return items.reduce((best, item) => !best || (item.duration_s || item.video?.duration || 0) > (best.duration_s || best.video?.duration || 0) ? item : best, null);
  }
  function recordingVideoRoot(path) {
    const match = String(path || "").replaceAll("\\", "/").match(/\/normal_city\/(run_[a-f0-9]{32})$/);
    return match ? "/runs/normal_city/" + match[1] + "/" : null;
  }
  function demoFailure(reason) {
    if (!reason) return "";
    const control = controlReasonText(reason);
    if (control !== reason) return control;
    if (/benchmark.*mismatch|initial.conditions/i.test(reason)) return "\u062A\u0639\u0630\u0631\u062A \u0645\u0637\u0627\u0628\u0642\u0629 \u0628\u062F\u0627\u064A\u0629 \u0627\u0644\u0645\u0634\u0648\u0627\u0631\u064A\u0646. \u0623\u0639\u062F \u062A\u0634\u063A\u064A\u0644 \u0627\u0644\u0645\u0642\u0627\u0631\u0646\u0629 \u0645\u0646 \u0627\u0644\u0628\u062F\u0627\u064A\u0629.";
    if (reason === "collision") return "\u062D\u062F\u062B \u062A\u0644\u0627\u0645\u0633 \u0641\u062A\u0648\u0642\u0641 \u0627\u0644\u0645\u0634\u0648\u0627\u0631. \u0623\u0639\u062F \u062A\u0647\u064A\u0626\u0629 \u0627\u0644\u0645\u062D\u0627\u0643\u0627\u0629 \u0642\u0628\u0644 \u0627\u0644\u0645\u062D\u0627\u0648\u0644\u0629 \u0627\u0644\u062A\u0627\u0644\u064A\u0629.";
    if (/acceptance|unfinished/i.test(reason)) return "\u0627\u0644\u062A\u062D\u0642\u0642 \u0627\u0644\u062D\u0631\u0643\u064A \u0644\u0644\u0647\u062C\u064A\u0646 \u0644\u0645 \u064A\u0643\u062A\u0645\u0644. \u062A\u0641\u0627\u0635\u064A\u0644 \u0627\u0644\u0627\u062E\u062A\u0628\u0627\u0631\u0627\u062A \u0645\u062A\u0627\u062D\u0629 \u0641\u064A \u0627\u0644\u0646\u062A\u0627\u0626\u062C.";
    if (/no space left|not enough.*space|insufficient.*space|storage|disk|ENOSPC/i.test(reason)) return "\u0627\u0644\u062A\u0633\u062C\u064A\u0644 \u064A\u062D\u062A\u0627\u062C \u0645\u0633\u0627\u062D\u0629 \u0645\u062A\u0627\u062D\u0629. \u0627\u062D\u062A\u0641\u0638 \u0628\u0627\u0644\u0623\u0631\u0634\u064A\u0641 \u062B\u0645 \u0648\u0641\u0651\u0631 \u0645\u0633\u0627\u062D\u0629 \u0648\u0623\u0639\u062F \u0627\u0644\u0645\u062D\u0627\u0648\u0644\u0629.";
    if (/recording.*queue|queue.*exhaust/i.test(reason)) return "\u062D\u0641\u0638 \u0627\u0644\u062A\u0633\u062C\u064A\u0644 \u0623\u0628\u0637\u0623 \u0645\u0646 \u0648\u0635\u0648\u0644 \u0627\u0644\u0628\u064A\u0627\u0646\u0627\u062A. \u0623\u0648\u0642\u0641 \u0627\u0644\u0639\u0631\u0636 \u0627\u0644\u0625\u0636\u0627\u0641\u064A \u062B\u0645 \u0623\u0639\u062F \u0627\u0644\u0645\u062D\u0627\u0648\u0644\u0629.";
    if (/recording/i.test(reason)) return "\u0627\u0644\u062A\u0633\u062C\u064A\u0644 \u0644\u0645 \u064A\u0643\u062A\u0645\u0644. \u0627\u0644\u0645\u062D\u0627\u0648\u0644\u0629 \u0645\u062D\u0641\u0648\u0638\u0629\u061B \u0623\u0639\u062F \u062A\u0647\u064A\u0626\u0629 \u0627\u0644\u0645\u062D\u0627\u0643\u0627\u0629 \u0642\u0628\u0644 \u0645\u0634\u0648\u0627\u0631 \u062C\u062F\u064A\u062F.";
    if (/sensor|scene|freshness/i.test(reason)) return "\u0628\u064A\u0627\u0646\u0627\u062A \u0627\u0644\u062D\u0631\u0643\u0629 \u063A\u064A\u0631 \u062C\u0627\u0647\u0632\u0629. \u0623\u0648\u0642\u0641 \u0627\u0644\u0633\u064A\u0627\u0631\u0629 \u062B\u0645 \u0623\u0639\u062F \u062A\u0647\u064A\u0626\u0629 \u0627\u0644\u0645\u062D\u0627\u0643\u0627\u0629.";
    if (/heartbeat|connection|disconnected/i.test(reason)) return "\u0627\u0644\u0627\u062A\u0635\u0627\u0644 \u0627\u0646\u0642\u0637\u0639. \u0623\u0639\u062F \u0627\u0644\u0627\u062A\u0635\u0627\u0644 \u062B\u0645 \u0627\u0636\u063A\u0637 \u062A\u0634\u063A\u064A\u0644.";
    if (reason === "focus_lost") return "\u062A\u0648\u0642\u0641\u062A \u0627\u0644\u0642\u064A\u0627\u062F\u0629 \u0639\u0646\u062F \u0625\u062E\u0641\u0627\u0621 \u0627\u0644\u0635\u0641\u062D\u0629. \u0627\u0636\u063A\u0637 \u062A\u0634\u063A\u064A\u0644 \u0644\u0644\u0645\u062A\u0627\u0628\u0639\u0629.";
    if (reason === "operator_stop") return "\u062A\u0645 \u0625\u064A\u0642\u0627\u0641 \u0627\u0644\u0633\u064A\u0627\u0631\u0629. \u064A\u0645\u0643\u0646\u0643 \u0628\u062F\u0621 \u0645\u0634\u0648\u0627\u0631 \u062C\u062F\u064A\u062F.";
    return String(reason);
  }
  function installDemoDrive(p, tools2, clearControls2) {
    document.body.classList.add("demo-drive");
    const panel = document.createElement("section");
    panel.id = "simpleDrive";
    panel.dir = "rtl";
    panel.setAttribute("aria-label", "\u062A\u0634\u063A\u064A\u0644 \u0627\u0644\u0642\u064A\u0627\u062F\u0629");
    panel.innerHTML = '<div class="simple-route"><span>\u0627\u0644\u0648\u062C\u0647\u0629</span><strong id="simpleDestination">\u0627\u062E\u062A\u0631 \u0648\u062C\u0647\u0629 \u0639\u0644\u0649 \u0627\u0644\u062E\u0631\u064A\u0637\u0629</strong><button id="simpleChooseDestination">\u0627\u062E\u062A\u064A\u0627\u0631 \u0627\u0644\u0648\u062C\u0647\u0629</button></div><label>\u0627\u0644\u0633\u0631\u0639\u0629 \u0627\u0644\u0645\u0637\u0644\u0648\u0628\u0629<select id="simpleSpeed"><option value="20">20 \u0643\u0645/\u0633</option><option value="30" selected>30 \u0643\u0645/\u0633</option><option value="40">40 \u0643\u0645/\u0633</option><option value="50">50 \u0643\u0645/\u0633</option></select></label><label>\u0627\u0644\u0632\u062D\u0645\u0629<select id="simpleTraffic"><option value="CALM">\u062E\u0641\u064A\u0641\u0629</option><option value="BUSY" selected>\u0645\u062A\u0648\u0633\u0637\u0629</option><option value="CHAOTIC">\u0643\u062B\u064A\u0641\u0629</option></select></label><div class="simple-actions"><button id="simpleRun" class="primary">\u062A\u0634\u063A\u064A\u0644</button><button id="simpleCompare">\u062A\u0634\u063A\u064A\u0644 \u0627\u0644\u0645\u0642\u0627\u0631\u0646\u0629</button></div><p id="simpleStatus" role="status">\u0627\u062E\u062A\u0631 \u0627\u0644\u0648\u062C\u0647\u0629 \u0648\u0627\u0644\u0633\u0631\u0639\u0629\u060C \u062B\u0645 \u0634\u063A\u0651\u0644 \u0627\u0644\u0642\u064A\u0627\u062F\u0629.</p>';
    $7("cameraCard").before(panel);
    const results = document.createElement("section");
    results.id = "hybridResults";
    results.dir = "rtl";
    results.innerHTML = '<div class="hybrid-results-heading"><div><h2>\u0627\u0644\u0633\u0627\u0626\u0642 \u0627\u0644\u0639\u0627\u062F\u064A \u0648\u0627\u0644\u0646\u0638\u0627\u0645 \u0627\u0644\u0647\u062C\u064A\u0646</h2><p id="hybridPairStatus">\u0627\u0644\u0645\u0642\u0627\u0631\u0646\u0629 \u062A\u0633\u062A\u062E\u062F\u0645 \u0646\u0641\u0633 \u0627\u0644\u0628\u062F\u0627\u064A\u0629 \u0648\u0627\u0644\u0637\u0631\u064A\u0642 \u0648\u0627\u0644\u0633\u0631\u0639\u0629 \u0648\u0627\u0644\u0645\u0631\u0648\u0631.</p></div><button id="hybridPlayPair">\u062A\u0634\u063A\u064A\u0644 \u0627\u0644\u0641\u064A\u062F\u064A\u0648\u0647\u064A\u0646</button></div><div class="hybrid-videos"></div><p id="hybridVideoStatus" role="status"></p>';
    $7("resultsPhase").querySelector(".analysis-heading").after(results);
    const videos = {};
    for (const mode of benchmarkModes) {
      const box = document.createElement("article");
      box.innerHTML = "<h3>" + (mode === "BASELINE" ? "\u0633\u0627\u0626\u0642 CARLA \u0627\u0644\u0639\u0627\u062F\u064A" : "\u0627\u0644\u0646\u0638\u0627\u0645 \u0627\u0644\u0647\u062C\u064A\u0646") + '</h3><video controls playsinline preload="metadata"></video><p class="hybrid-run-result">\u0644\u0645 \u064A\u0628\u062F\u0623</p>';
      results.querySelector(".hybrid-videos").append(box);
      videos[mode] = { box, video: box.querySelector("video"), key: null, status: "MISSING" };
    }
    let linkedPlayback = false, playbackLeader = null;
    for (const item of Object.values(videos)) {
      const leading = () => linkedPlayback && playbackLeader === item;
      const others = () => Object.values(videos).filter((v) => v !== item);
      const sync = () => {
        if (leading()) for (const peer of others()) {
          if (peer.video.readyState < 1) continue;
          const time = Math.min(item.video.currentTime, Number.isFinite(peer.video.duration) ? peer.video.duration : Infinity);
          if (Math.abs(peer.video.currentTime - time) > 0.08) peer.video.currentTime = time;
        }
      };
      const playOthers = () => {
        if (leading()) for (const peer of others()) {
          if (!Number.isFinite(peer.video.duration) || peer.video.currentTime < peer.video.duration - 0.02) peer.video.play().catch(() => {
          });
        }
      };
      item.video.addEventListener("timeupdate", sync);
      item.video.addEventListener("seeking", sync);
      item.video.addEventListener("pause", () => {
        if (leading()) for (const peer of others()) peer.video.pause();
      });
      item.video.addEventListener("waiting", () => {
        if (leading()) for (const peer of others()) peer.video.pause();
      });
      item.video.addEventListener("play", playOthers);
      item.video.addEventListener("playing", playOthers);
    }
    $7("hybridPlayPair").onclick = async () => {
      const available = Object.values(videos).filter((v) => v.status === "READY");
      linkedPlayback = available.length === 2;
      playbackLeader = selectPlaybackLeader(available);
      for (const item of available) item.video.currentTime = 0;
      await Promise.all(available.map((v) => v.video.play().catch(() => {
      })));
    };
    let pending2 = null, pair = null, lastResult = null, lastVideoPoll = 0, renderPair = null;
    const requestRun = (mode, pairId = null, benchmark = false) => {
      clearControls2("operator_stop");
      p.startJourney(Number($7("simpleSpeed").value), mode, pairId, benchmark);
    };
    const prepareTraffic = () => {
      lastResult = p.dashboardResult?.operationId;
      const requested = p.population?.requested;
      if (!requested) {
        p.operationError = "\u0628\u064A\u0627\u0646\u0627\u062A \u0627\u0644\u0645\u0631\u0648\u0631 \u063A\u064A\u0631 \u062C\u0627\u0647\u0632\u0629.";
        return false;
      }
      const config = cityPopulation(requested, CITY_PRESETS[$7("simpleTraffic").value]);
      const seed = new Uint32Array(1);
      crypto.getRandomValues(seed);
      config.seed = seed[0] % 2147483648;
      p.takeControl();
      return p.dashboardAction("population", config);
    };
    $7("simpleChooseDestination").onclick = () => tools2.open("routePanel", "simpleChooseDestination");
    $7("simpleRun").onclick = () => {
      if (!p.connected) {
        p.startSimulation();
        return;
      }
      if (p.operationError) p.operationError = null;
      if (prepareTraffic()) pending2 = { stage: "population", comparison: false };
    };
    $7("simpleCompare").onclick = () => {
      if (prepareTraffic()) pending2 = { stage: "population", comparison: true };
    };
    $7("hybridPlayPair").disabled = true;
    return { update() {
      const active = ["STARTING", "RUNNING"].includes(p.journey?.status), locked = active || !!p.recording || p.restarting || !!pending2;
      const available = p.hybridDriving?.available === true;
      $7("simpleRun").textContent = p.connected ? "\u062A\u0634\u063A\u064A\u0644 \u0627\u0644\u0642\u064A\u0627\u062F\u0629" : "\u062A\u0634\u063A\u064A\u0644 \u0627\u0644\u0645\u062D\u0627\u0643\u0627\u0629";
      $7("simpleRun").disabled = p.connected && (locked || !p.route || !available || p.controlMode === "EMERGENCY_STOP");
      $7("simpleCompare").disabled = locked || !p.fresh || !p.route || !available || p.controlMode === "EMERGENCY_STOP";
      $7("simpleChooseDestination").disabled = locked || !p.fresh;
      $7("simpleSpeed").disabled = $7("simpleTraffic").disabled = locked;
      $7("simpleDestination").textContent = p.route?.destination?.name || "\u0627\u062E\u062A\u0631 \u0648\u062C\u0647\u0629 \u0639\u0644\u0649 \u0627\u0644\u062E\u0631\u064A\u0637\u0629";
      const actions = { FOLLOW: "\u0627\u062A\u0628\u0627\u0639 \u0627\u0644\u0637\u0631\u064A\u0642", SLOW: "\u062A\u0647\u062F\u0626\u0629", DECELERATE: "\u062A\u0647\u062F\u0626\u0629", EXIT: "\u062A\u063A\u064A\u064A\u0631 \u0627\u0644\u062D\u0627\u0631\u0629", PASS: "\u062A\u062C\u0627\u0648\u0632 \u0639\u0627\u0626\u0642", RETURN: "\u0627\u0644\u0639\u0648\u062F\u0629 \u0644\u0644\u0645\u0633\u0627\u0631", REVERSE: "\u0625\u0639\u0627\u062F\u0629 \u062A\u0645\u0631\u0643\u0632 \u0644\u0644\u062E\u0644\u0641", HOLD: "\u0627\u0646\u062A\u0638\u0627\u0631 \u0645\u0633\u0627\u062D\u0629 \u0644\u0644\u062D\u0631\u0643\u0629" };
      let message = p.recordingStatus?.error ? demoFailure(p.recordingStatus.error) : p.operationError ? demoFailure(p.operationError) : !available && p.connected ? "\u0627\u0644\u0642\u064A\u0627\u062F\u0629 \u0627\u0644\u0647\u062C\u064A\u0646\u0629 \u0642\u064A\u062F \u0627\u0644\u062A\u062D\u0642\u0642 \u0627\u0644\u062D\u0631\u0643\u064A\u061B \u0646\u062A\u0627\u0626\u062C \u0627\u0644\u0627\u062E\u062A\u0628\u0627\u0631\u0627\u062A \u0644\u0627 \u062A\u064F\u0639\u062A\u0628\u0631 \u0642\u0628\u0648\u0644\u064B\u0627 \u062A\u0644\u0642\u0627\u0626\u064A\u064B\u0627." : active ? "\u0627\u0644\u0642\u064A\u0627\u062F\u0629 \u062A\u0639\u0645\u0644 \xB7 " + (actions[p.maneuver?.action] || "\u0627\u062A\u0628\u0627\u0639 \u0627\u0644\u0637\u0631\u064A\u0642") : p.journey?.status === "ARRIVED" ? "\u0648\u0635\u0644\u062A \u0627\u0644\u0633\u064A\u0627\u0631\u0629 \u0625\u0644\u0649 \u0627\u0644\u0648\u062C\u0647\u0629." : p.lastDriveStop?.detail ? demoFailure(p.lastDriveStop.detail) : "\u0627\u062E\u062A\u0631 \u0627\u0644\u0648\u062C\u0647\u0629 \u0648\u0627\u0644\u0633\u0631\u0639\u0629 \u0648\u0627\u0644\u0632\u062D\u0645\u0629\u060C \u062B\u0645 \u0634\u063A\u0651\u0644 \u0627\u0644\u0642\u064A\u0627\u062F\u0629.";
      if (active && p.stopDiagnostics?.braking && p.journey?.driving_mode === "HYBRID") message = controlReasonText(p.stopDiagnostics.reason);
      if (p.hybridDriving?.validation_active && !p.hybridDriving?.accepted) message = "\u0627\u062E\u062A\u0628\u0627\u0631 \u062D\u0631\u0643\u064A \u0645\u062D\u062F\u0648\u062F \u0627\u0644\u0645\u062F\u0629 \xB7 " + message;
      const result = p.dashboardResult;
      if (pending2 && p.operationError) {
        pending2 = null;
        pair = null;
      }
      if (pending2 && result?.operationId !== lastResult && ["APPLIED", "REJECTED"].includes(result?.status)) {
        if (pending2.stage === "population" && result.action === "population") {
          lastResult = result.operationId;
          if (result.status === "REJECTED") {
            pending2 = null;
          } else {
            const comparison = pending2.comparison;
            pending2 = null;
            pair = comparison ? { stage: "first" } : null;
            requestRun(comparison ? "BASELINE" : "HYBRID", null, comparison);
          }
        } else if (pending2.stage === "restore" && result.action === "prepare_journey_mode") {
          lastResult = result.operationId;
          const id = pending2.id;
          pending2 = null;
          if (result.status === "APPLIED") {
            pair = { stage: "second" };
            requestRun("HYBRID", id, true);
          } else pair = null;
        }
      }
      if (pair?.stage === "first" && p.journey?.driving_mode === "BASELINE" && ["ARRIVED", "ERROR", "PAUSED"].includes(p.journey.status) && !p.recording && p.recordingStatus?.finalized !== false) {
        if (p.journey.status === "ARRIVED" || p.journey.reason === "collision") {
          const id = p.journeyComparison?.pair_id;
          if (id && p.dashboardAction("prepare_journey_mode", { mode: "HYBRID", pair_id: id })) {
            pending2 = { stage: "restore", id };
            pair.stage = "restoring";
          }
        } else {
          pair = null;
          message = "\u0627\u0644\u0645\u062D\u0627\u0648\u0644\u0629 \u0627\u0644\u0623\u0648\u0644\u0649 \u0644\u0645 \u062A\u0643\u062A\u0645\u0644\u061B \u0646\u062A\u064A\u062C\u062A\u0647\u0627 \u0645\u062D\u0641\u0648\u0638\u0629. \u0623\u0639\u062F \u0627\u0644\u0645\u0642\u0627\u0631\u0646\u0629 \u0645\u0646 \u0627\u0644\u0628\u062F\u0627\u064A\u0629.";
        }
      }
      $7("simpleStatus").textContent = message;
      const data = p.journeyComparison, benchmark = data?.version === 2;
      results.hidden = !benchmark;
      $7("ordinaryComparison").hidden = benchmark;
      const heading = $7("resultsPhase").querySelector(".analysis-heading");
      heading.querySelector("h2").textContent = benchmark ? "\u0646\u062A\u0627\u0626\u062C \u0627\u0644\u0645\u0642\u0627\u0631\u0646\u0629" : "Comparison results";
      heading.querySelector("p").textContent = benchmark ? "\u0633\u0627\u0626\u0642 CARLA \u0627\u0644\u0639\u0627\u062F\u064A \u0648\u0627\u0644\u0646\u0638\u0627\u0645 \u0627\u0644\u0647\u062C\u064A\u0646" : "Your driving, with and without Robosphere.";
      if (benchmark) {
        if (renderPair !== data.pair_id) {
          linkedPlayback = false;
          playbackLeader = null;
          renderPair = data.pair_id;
          for (const v of Object.values(videos)) {
            v.video.pause();
            v.key = null;
            v.status = "MISSING";
            v.error = null;
            v.duration_s = null;
            v.video.removeAttribute("src");
          }
        }
        $7("hybridPairStatus").textContent = data.conditions_match ? "\u062A\u0645 \u0627\u0644\u062A\u062D\u0642\u0642 \u0645\u0646 \u062A\u0637\u0627\u0628\u0642 \u0638\u0631\u0648\u0641 \u0627\u0644\u0628\u062F\u0627\u064A\u0629. \u0627\u0644\u0645\u0631\u0648\u0631 \u064A\u062A\u0641\u0627\u0639\u0644 \u0623\u062B\u0646\u0627\u0621 \u0643\u0644 \u0645\u062D\u0627\u0648\u0644\u0629." : "\u0627\u0644\u0645\u0642\u0627\u0631\u0646\u0629 \u063A\u064A\u0631 \u0645\u0643\u062A\u0645\u0644\u0629 \u0623\u0648 \u0644\u0645 \u062A\u062B\u0628\u062A \u0645\u0637\u0627\u0628\u0642\u0629 \u0627\u0644\u0628\u062F\u0627\u064A\u0629.";
        for (const mode of benchmarkModes) {
          const run = data.runs?.[mode], item = videos[mode];
          const status = { ARRIVED: "\u0648\u0635\u0644", ERROR: "\u062A\u0648\u0642\u0641 \u0628\u0633\u0628\u0628 \u062E\u0637\u0623", PAUSED: "\u0645\u062A\u0648\u0642\u0641", RUNNING: "\u064A\u0639\u0645\u0644", STARTING: "\u064A\u0628\u062F\u0623" };
          item.box.querySelector(".hybrid-run-result").textContent = run ? `${status[run.status] || run.status} \xB7 ${run.distance_m.toFixed(1)} \u0645\u062A\u0631 \xB7 \u062A\u0644\u0627\u0645\u0633 ${run.collisions} \xB7 ${run.route_completion_percent.toFixed(0)}% \u0645\u0646 \u0627\u0644\u0637\u0631\u064A\u0642` : "\u0644\u0645 \u064A\u0628\u062F\u0623";
          const root = recordingVideoRoot(run?.recording);
          if (root && item.status !== "READY" && performance.now() - lastVideoPoll > 2e3) {
            fetch(root + "video-status.json", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((status2) => {
              if (!status2 || p.journeyComparison?.pair_id !== renderPair) return;
              item.status = status2.status;
              item.error = status2.error;
              item.duration_s = status2.duration_s;
              if (status2.status === "READY" && item.key !== root) {
                item.key = root;
                item.video.src = root + "driving.mp4";
              }
            }).catch(() => {
            });
          }
        }
        if (performance.now() - lastVideoPoll > 2e3) lastVideoPoll = performance.now();
        $7("hybridPlayPair").disabled = !Object.values(videos).every((v) => v.status === "READY");
        const failedVideo = Object.values(videos).find((v) => v.status === "ERROR");
        $7("hybridVideoStatus").textContent = failedVideo ? "\u062A\u0639\u0630\u0631 \u062A\u062C\u0647\u064A\u0632 \u0627\u0644\u0641\u064A\u062F\u064A\u0648 \xB7 " + demoFailure(failedVideo.error || "\u0627\u0644\u062A\u0633\u062C\u064A\u0644 \u0627\u0644\u0623\u0635\u0644\u064A \u0645\u062D\u0641\u0648\u0638.") : Object.values(videos).every((v) => v.status === "READY") ? "\u0627\u0644\u0641\u064A\u062F\u064A\u0648\u0647\u0627\u062A \u062A\u0633\u062A\u062E\u062F\u0645 \u062A\u0648\u0642\u064A\u062A \u0627\u0644\u0645\u062D\u0627\u0643\u0627\u0629\u060C \u0648\u064A\u0628\u062F\u0623 \u0643\u0644 \u0645\u0634\u0648\u0627\u0631 \u0645\u0646 \u0627\u0644\u0632\u0645\u0646 \u0635\u0641\u0631." : "\u0627\u0644\u0641\u064A\u062F\u064A\u0648 \u064A\u064F\u062C\u0647\u0651\u0632 \u0628\u0639\u062F \u0627\u0646\u062A\u0647\u0627\u0621 \u0627\u0644\u062A\u0633\u062C\u064A\u0644. \u0627\u0644\u0645\u062D\u0627\u0648\u0644\u0627\u062A \u0627\u0644\u0641\u0627\u0634\u0644\u0629 \u062A\u0638\u0644 \u0645\u062D\u0641\u0648\u0638\u0629.";
      }
    } };
  }

  // frontend/dashboard.js
  var $8 = (id) => document.getElementById(id);
  var provider = new SimulationClient();
  var controls = new DrivingControls();
  presentationUI(provider);
  var perception = new PerceptionView(provider);
  var predictionView = new PredictionView(provider);
  var comparisonV2 = installComparisonV2(provider, () => {
    resetKeys();
    manualArmed = false;
    manualRequestedUntil = 0;
  });
  var displayedCamera = null;
  var number2 = (value, suffix = "", digits = 1) => Number.isFinite(value) ? value.toFixed(digits) + suffix : "\u2014";
  var manualArmed = false;
  var manualRequestedUntil = 0;
  var manualOverridePending = false;
  var lastMode = null;
  var lastGear = null;
  var seenSession = null;
  var cameraReceipt = null;
  var cameraUrl = null;
  var cameraRequest = null;
  var cameraGeneration = 0;
  var tools = new DashboardTools(provider, controls, clearControls, { canInput, isManualArmed: () => manualArmed });
  var trafficPreparation = installTrafficPreparation(provider, clearControls);
  var citySetup = installCitySetup(provider, trafficPreparation.preparation, tools, startJourney);
  var guided = installGuidedDrive(provider, trafficPreparation.preparation, tools, startJourney, clearControls, predictionView);
  var motionReadout2 = installMotionReadout(provider, predictionView);
  var studio = installDrivingStudio(provider, guided, predictionView, tools);
  var cockpit = installLightCockpit(provider, tools, perception, predictionView, (mode) => startJourney(mode));
  var demoDrive = installDemoDrive(provider, tools, clearControls);
  $8("stopSimulatorBtn").onclick = () => {
    clearControls("simulator_shutdown");
    provider.stopSimulator();
  };
  $8("resetSimulatorBtn").onclick = () => {
    resetKeys();
    manualArmed = false;
    manualRequestedUntil = 0;
    clearCamera();
    provider.resetSimulation();
  };
  function canInput() {
    if (document.body.dataset.workspace !== "drive") return false;
    return drivingInputAllowed({
      fresh: provider.fresh,
      replay: provider.isReplay,
      owner: provider.controller,
      focused: document.hasFocus() && !document.hidden,
      modal: !!tools.panel || !!document.querySelector("dialog[open]"),
      mode: provider.controlMode,
      armed: manualArmed
    });
  }
  function resetKeys() {
    controls.clear();
    controls.setMode($8("gearSelect").value);
    controls.gear = controls.mode === "R" ? -1 : controls.mode === "N" ? 0 : 1;
    lastGear = null;
    manualOverridePending = false;
  }
  function clearControls(reason = "operator_stop") {
    resetKeys();
    manualArmed = false;
    manualRequestedUntil = 0;
    provider.stopDriving(reason);
  }
  function sendManual(state) {
    const command = controls.sample(state.speedMps, performance.now());
    if (command.gear !== lastGear) {
      provider.setGear(command.gear);
      lastGear = command.gear;
    }
    if (provider.updateControls(command)) manualOverridePending = false;
  }
  function clearCamera() {
    displayedCamera = null;
    cameraGeneration++;
    cameraRequest?.abort();
    cameraRequest = null;
    if (cameraUrl) URL.revokeObjectURL(cameraUrl);
    cameraUrl = cameraReceipt = null;
    $8("authoritativeCamera").hidden = true;
    $8("authoritativeCamera").removeAttribute("src");
    $8("cameraUnavailable").hidden = false;
    $8("cameraActivity").textContent = "Image unavailable";
    $8("cameraTimestamp").textContent = "t \u2014";
  }
  async function updateCamera(metadata) {
    if (document.hidden) return;
    if (displayedCamera && Number.isFinite(provider.telemetry?.timestamp) && provider.telemetry.timestamp - displayedCamera.timestamp > 0.75) clearCamera();
    const key = sensorFrameKey(metadata);
    if (key === null || !provider.fresh || provider.sensorErrors[metadata?.sensorId || "frontCamera"]) {
      clearCamera();
      return;
    }
    if (cameraRequest || key === cameraReceipt) return;
    const generation = cameraGeneration, request = new AbortController();
    cameraRequest = request;
    try {
      const response = await fetch("/api/simulation/camera.jpg?frame_id=" + metadata.frame + (metadata.sensorId === "drivingCamera" ? "&view=driving" : ""), { cache: "no-store", signal: request.signal });
      if (!response.ok || !matchesSensorResponse(metadata, response.headers)) return;
      const blob = await response.blob();
      if (!provider.fresh || generation !== cameraGeneration) return;
      const nextUrl = URL.createObjectURL(blob);
      const decoded = new Image();
      decoded.src = nextUrl;
      try {
        await decoded.decode();
      } catch (error) {
        URL.revokeObjectURL(nextUrl);
        throw error;
      }
      if (!provider.fresh || generation !== cameraGeneration) {
        URL.revokeObjectURL(nextUrl);
        return;
      }
      const previousUrl = cameraUrl;
      cameraUrl = nextUrl;
      cameraReceipt = key;
      displayedCamera = { ...metadata };
      $8("authoritativeCamera").src = cameraUrl;
      $8("authoritativeCamera").hidden = false;
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      $8("cameraUnavailable").hidden = true;
      $8("cameraActivity").textContent = provider.isReplay ? "REPLAY \xB7 Recorded image" : "RGB \xB7 Live image";
      $8("cameraTimestamp").textContent = "t " + number2(Number(response.headers.get("X-Sensor-Time")), " s", 3);
      $8("cameraMetadata").textContent = "Frame " + response.headers.get("X-Sensor-Frame") + " \xB7 " + metadata.width + "\xD7" + metadata.height + " \xB7 FOV " + metadata.fovDeg + "\xB0 \xB7 mount " + JSON.stringify(metadata.mountTransform ?? null);
    } catch (error) {
      if (error.name !== "AbortError" && !provider.fresh) clearCamera();
    } finally {
      if (cameraRequest === request) cameraRequest = null;
    }
  }
  function refresh() {
    if (provider.resetReady) {
      provider.resetReady = false;
      window.location.reload();
      return;
    }
    if ((provider.connected || provider.isReplay) && !provider.fresh) {
      manualArmed = false;
      provider.disconnect("Data stream lost; driving stopped");
    }
    if (provider.sessionId !== seenSession) {
      seenSession = provider.sessionId;
      manualArmed = false;
      resetKeys();
      clearCamera();
    }
    const state = provider.getVehicleState(), live = provider.fresh;
    $8("cameraEmptyTitle").textContent = live ? "Waiting for camera image" : "Waiting for simulator connection";
    $8("cameraEmptyDescription").textContent = live ? "No image available yet. Inspect sensor status in Details." : "Select Start the simulation to launch CARLA and connect cameras and telemetry.";
    $8("connectionSetupBtn").hidden = live || provider.isReplay;
    if (!live) $8("mapEmpty").hidden = false;
    if (!live || provider.isReplay || !document.hasFocus() || document.hidden || performance.now() > manualRequestedUntil && (!provider.controller || provider.controlMode === "PAUSED" && lastMode === "MANUAL" || provider.controlMode === "EMERGENCY_STOP")) manualArmed = false;
    lastMode = provider.controlMode;
    const controllable = canInput();
    const stopped = provider.simulatorStop;
    const connectedLabel = provider.isReplay ? "REPLAY \u2014 real recording" : provider.simulationStarting ? "CARLA \u2014 STARTING" : stopped?.status === "STOPPING" ? "CARLA \u2014 STOPPING" : stopped?.status === "STOPPED" ? "CARLA \u2014 STOPPED" : provider.restarting ? "CARLA \u2014 RESTARTING" : "CARLA \u2014 " + (live && provider.connected ? "CONNECTED" : "DISCONNECTED");
    $8("cityStatus").textContent = $8("simulationState").textContent = connectedLabel;
    const stopButton = $8("stopSimulatorBtn");
    stopButton.disabled = !stopped?.available || provider.isReplay || provider.simulationStarting || provider.restarting || ["STOPPING", "STOPPED"].includes(stopped?.status) || provider.controlMode === "TRAINING";
    stopButton.textContent = provider.simulationStarting ? "Starting\u2026" : stopped?.status === "STOPPING" ? "Stopping\u2026" : stopped?.status === "STOPPED" ? "GPU released" : stopped?.status === "FAILED" ? "Retry GPU release" : "Free GPU";
    stopButton.title = stopped?.error || (stopped?.status === "STOPPED" ? "GPU resources released. Select Start the simulation to start again." : "Stop CARLA and release its GPU and VRAM");
    const resetButton = $8("resetSimulatorBtn");
    resetButton.disabled = !provider.simulatorReset?.available || provider.isReplay || provider.simulationStarting || provider.restarting || stopped?.status === "STOPPING" || provider.controlMode === "TRAINING";
    resetButton.textContent = provider.resetting ? "Resetting\u2026" : "Reset";
    resetButton.title = provider.operationError || "Restart CARLA and the application: default start, zero speed, no traffic or route. Recordings are kept.";
    $8("connectionDot").classList.toggle("connected", live && provider.connected);
    $8("missionText").textContent = provider.isReplay ? "Replay \xB7 Driving disabled" : provider.population ? provider.population.actual.vehicles + " traffic vehicle \xB7 " + provider.population.actual.pedestrians + " walkers" : "Waiting for population CARLA";
    const modeNames = {
      MANUAL: manualArmed ? "Manual driving" : "Vehicle held by command safety",
      AUTOMATIC: "Destination journey",
      PAUSED: state.speedKmh > 0.54 ? "Stopping vehicle" : "Vehicle stopped",
      EMERGENCY_STOP: "Emergency stop",
      DISCONNECTED: "Simulator disconnected",
      REPLAY: "Replay"
    };
    $8("controlMode").textContent = modeNames[provider.controlMode] || provider.controlMode;
    $8("controlSource").textContent = provider.controlSource || "";
    const safety = provider.safetySystem;
    const demo = provider.comparisonDemo;
    const demoBusy = ["RESETTING", "RUNNING", "STOPPING"].includes(demo?.phase);
    for (const id of ["demoWithoutBtn", "demoWithBtn", "demoStopBtn"]) {
      $8(id).disabled = !live || provider.isReplay || !provider.controller || provider.restarting || provider.controlMode === "EMERGENCY_STOP";
    }
    $8("demoWithoutBtn").setAttribute("aria-pressed", String(demo?.mode === "WITHOUT" && demoBusy));
    $8("demoWithBtn").setAttribute("aria-pressed", String(demo?.mode === "WITH" && demoBusy));
    $8("demoStatus").textContent = demo?.mode ? (demo.mode === "WITH" ? "WITH YA RAB OSTORHA" : "WITHOUT SAFETY") + " \xB7 " + demo.phase + " \xB7 Safety " + (demo.safety_enabled ? "ON" : "OFF") + " during run \xB7 Controller: " + demo.active_controller + (demo.latest_outcome ? " \xB7 Outcome: " + demo.latest_outcome : "") + (demo.error ? " \xB7 " + demo.error : "") : demo?.error || "Choose a comparison mode. Each button resets and automatically records a fresh run.";
    const measured = demo?.mode && ["RUNNING", "STOPPING", "FINISHED"].includes(demo.phase);
    const ds = demoBusy ? safety : demo?.last_safety;
    $8("demoMeasurements").textContent = measured ? "Hazard: " + (demo.mode === "WITHOUT" ? "Safety detection OFF" : ds?.risk ?? "UNKNOWN") + " \xB7 Reason: " + (ds?.reason ?? "Waiting for sensors") + " \xB7 Run brake: " + number2((demoBusy ? state.brake : demo.last_applied_brake) == null ? null : (demoBusy ? state.brake : demo.last_applied_brake) * 100, "%") + " \xB7 Interventions: " + (demo.metrics?.safety_intervention_count ?? "\u2014") + " \xB7 Collision: " + (demo.metrics?.collision_count == null ? "Not assessed" : demo.metrics.collision_count > 0 ? "Collision detected" : "No collision recorded") + " \xB7 Time: " + number2(demo.metrics?.elapsed_simulation_s, " s") + " \xB7 Distance: " + number2(demo.metrics?.distance_traveled_m, " m") + " \xB7 Progress: " + number2(demo.metrics?.progress_m, " m") : "Measurements appear during the real CARLA run.";
    $8("safetyEnabled").checked = safety?.enabled === true;
    $8("safetyEnabled").disabled = !live || provider.isReplay || !provider.controller || provider.controlMode === "TRAINING" || demoBusy || !Number.isFinite(state.speedMps) || Math.abs(state.speedMps) > 0.15;
    $8("safetyController").disabled = $8("safetyEnabled").disabled;
    $8("safetyController").value = safety?.controller ?? "RULE";
    for (const option of $8("safetyController").options) option.disabled = !(safety?.available_controllers ?? ["RULE"]).includes(option.value);
    $8("connectionDetail").textContent = provider.isReplay ? "Recorded data view; no simulator controls." : live ? provider.controller ? "Take control from this page." : "Another page controls the vehicle; take control in Settings." : provider.restarting ? "Restarting CARLA and reconnecting\u2026" : "Simulator disconnected. Open connection setup to continue.";
    $8("phoneStatus").textContent = live ? "Destinations from map " + (provider.world.map?.split("/").at(-1) || "CARLA") : "Waiting for simulator connection.";
    $8("providerStatus").textContent = provider.status;
    $8("providerTitle").textContent = provider.isReplay ? "Recorded camera" : "Camera CARLA";
    $8("cameraSource").textContent = provider.isReplay ? "RECORDED RGB" : "CARLA RGB";
    $8("speedVal").textContent = number2(state.speedKmh, "", 0);
    $8("gearVal").textContent = state.gear ?? "\u2014";
    $8("throttleVal").textContent = number2(state.throttle == null ? null : state.throttle * 100, "%");
    $8("brakeVal").textContent = number2(state.brake == null ? null : state.brake * 100, "%");
    $8("steerVal").textContent = number2(state.steeringInput);
    $8("versionVal").textContent = provider.world.version ?? "\u2014";
    $8("mapVal").textContent = provider.world.map?.split("/").at(-1) ?? "\u2014";
    $8("frameVal").textContent = state.frame ?? "\u2014";
    $8("timeVal").textContent = number2(state.timestamp, " s", 3);
    $8("accelVal").textContent = number2(state.accelerationMps2, " m/s\xB2");
    $8("reverseVal").textContent = state.reverse == null ? "\u2014" : state.reverse ? "Yes" : "No";
    $8("positionVal").textContent = state.positionWorldM ? "X / Y / Z: " + state.positionWorldM.map((v) => number2(v)).join(" / ") + " m" : "Position unavailable";
    $8("headingVal").textContent = state.rotationDeg ? "Yaw " + number2(state.rotationDeg.yaw, "\xB0") : "";
    $8("gearSelect").disabled = !controllable || provider.controlMode === "AUTOMATIC";
    $8("gearSelect").title = !$8("gearSelect").disabled ? "" : provider.isReplay ? "Replay is read-only; driving is disabled" : !live ? "Waiting for native connection to CARLA" : provider.controlMode === "AUTOMATIC" ? "Journey controller selects the gear; take manual control to change it" : !provider.controller ? "Take control in connection settings first" : "Enable manual driving to change gear";
    $8("controlStatus").textContent = provider.isReplay ? "REPLAY \xB7 Driving disabled" : !document.hasFocus() || document.hidden ? "Focus the dashboard to use the keyboard" : controllable ? "WASD ready \xB7 W+Shift More throttle" : "Keyboard stopped \u2014 Enable driving first";
    const sensorCount = Object.keys(provider.sensorMetadata).length;
    $8("sensorStatus").textContent = provider.isReplay ? sensorCount + " sensors from recorded frame \xB7 recorded collision events" : live ? sensorCount + " periodic sensors receiving data \xB7 Collision sensor is event-driven" : "Sensors unavailable";
    const displayedSensor = provider.displayCamera ? "drivingCamera" : "frontCamera";
    $8("cameraFps").textContent = number2(provider.performance?.sensorWallRatesHz?.[displayedSensor]) + " /wall seconds \xB7 " + number2(provider.sensorRates[displayedSensor]) + " Hz sim";
    const perf = provider.performance || {}, gpu = perf.gpu;
    $8("performance").textContent = "actual steps: " + number2(perf.nativeTickRateHz) + " /s \xB7 Simulation time: " + (provider.world.fixedDeltaSeconds ? number2(1 / provider.world.fixedDeltaSeconds) + " Hz" : "\u2014") + (gpu ? " \xB7 VRAM " + gpu.usedMiB + " / " + gpu.totalMiB + " MiB" : "") + " \xB7 FPS Rendering unavailable";
    $8("debugTelemetry").textContent = telemetryText(state, {
      remote: true,
      latencyMs: provider.latencyMs,
      sensorRates: provider.sensorRates,
      sensorErrors: provider.sensorErrors,
      world: provider.world,
      mode: provider.controlMode
    });
    $8("replayPauseBtn").hidden = !provider.isReplay;
    $8("replayPauseBtn").textContent = provider.replay?.paused ? "Resume replay" : "Pause replay";
    if (controllable && provider.controlMode === "MANUAL") sendManual(state);
    updateCamera(provider.displayCamera || provider.sensorMetadata.frontCamera);
    tools.render(state, controllable);
    trafficPreparation.update(state);
    citySetup.update(state);
    perception.update();
    comparisonV2.update();
    updatePresentation(provider, state, manualArmed, manualArmed && provider.controlMode === "PAUSED" && performance.now() < manualRequestedUntil);
    predictionView.draw(displayedCamera);
    guided.update(state);
    motionReadout2.update(state);
    studio.update(state);
    cockpit.update(state, displayedCamera);
    demoDrive.update();
  }
  $8("startDrivingBtn").onclick = () => {
    showWorkspace("drive");
    resetKeys();
    manualArmed = true;
    manualRequestedUntil = performance.now() + 1e3;
    $8("drivingMode").value = "MANUAL";
    const selected = document.querySelector("#studioManualMode")?.dataset.mode;
    const drivingMode = provider.controlMode === "AUTOMATIC" ? provider.journey?.driving_mode : selected || provider.manualDrivingMode;
    const manualMode = ["ROBOSPHERE", "NORMAL"].includes(drivingMode) ? drivingMode : provider.manualDrivingMode || "ROBOSPHERE";
    if (!provider.startDriving(manualMode)) {
      manualArmed = false;
      manualRequestedUntil = 0;
      return;
    }
    document.activeElement?.blur();
    $8("drivingInstruction").textContent = "Switching to keyboard control\u2026";
  };
  function startJourney(drivingMode = null, pairId = null) {
    if (typeof drivingMode !== "string") drivingMode = null;
    const hybrid = ["HYBRID", "BASELINE"].includes(drivingMode);
    const speed = Number(hybrid ? provider.journey?.speed_kmh || 30 : $8("journeySpeed").value);
    if (!Number.isFinite(speed) || speed < 5 || speed > (hybrid ? 50 : 30)) {
      $8("operationStatus").textContent = "Choose a valid driving speed.";
      return;
    }
    showWorkspace("drive");
    tools.close(false);
    resetKeys();
    manualArmed = false;
    manualRequestedUntil = 0;
    $8("drivingMode").value = "AUTOMATIC";
    const sent = provider.startJourney(speed, drivingMode, pairId);
    if (sent) $8("journeyStatus").textContent = "Starting destination journey\u2026";
    document.activeElement?.blur();
    return sent;
  }
  $8("startJourneyBtn").onclick = $8("phoneJourneyBtn").onclick = $8("driveJourneyBtn").onclick = () => startJourney();
  $8("journeySpeed").onchange = () => {
    const speed = Number($8("journeySpeed").value);
    if (!Number.isFinite(speed) || speed < 5 || speed > 30) {
      $8("operationStatus").textContent = "Choose a speed between 5 and 30 km/h.";
      return;
    }
    if (provider.controlMode === "AUTOMATIC") provider.journeySpeed(speed);
  };
  $8("drivingMode").onchange = () => {
    clearControls();
  };
  $8("safetyEnabled").onchange = () => provider.dashboardAction("safety_mode", { enabled: $8("safetyEnabled").checked });
  for (const [id, mode] of [["demoWithoutBtn", "WITHOUT"], ["demoWithBtn", "WITH"], ["demoStopBtn", "STOP"]]) {
    $8(id).onclick = () => {
      if (mode === "STOP" && !window.confirm("Reset the simulation? This returns the vehicle to its starting position and rebuilds traffic. Saved recordings are kept.")) return;
      const seed = Number($8("comparisonSeed").value);
      if (!Number.isInteger(seed) || seed < 2e3 || seed > 2999) {
        $8("operationStatus").textContent = "Choose a whole scenario seed between 2000 and 2999.";
        return;
      }
      resetKeys();
      manualArmed = false;
      manualRequestedUntil = 0;
      if (provider.dashboardAction("comparison", { mode, scenario: $8("comparisonScenario").value, seed })) {
        if (mode !== "STOP") showWorkspace("drive");
        $8("demoStatus").textContent = mode === "STOP" ? "Resetting simulation\u2026" : "Starting comparison\u2026";
        $8("primaryActionHint").textContent = $8("demoStatus").textContent;
      }
    };
  }
  $8("safetyController").onchange = () => provider.dashboardAction("safety_mode", { enabled: $8("safetyEnabled").checked, controller: $8("safetyController").value });
  $8("gearSelect").onchange = () => {
    controls.setMode($8("gearSelect").value);
    provider.releaseControls();
    lastGear = null;
  };
  $8("pauseBtn").onclick = () => clearControls();
  $8("resetBtn").onclick = () => {
    if (!window.confirm("Reset the vehicle to its spawn point? The current drive will end.")) return;
    resetKeys();
    manualArmed = false;
    manualRequestedUntil = 0;
    provider.resetVehicle();
  };
  $8("emergencyStopBtn").onclick = () => {
    tools.close(false);
    tools.expandCamera(false);
    resetKeys();
    manualArmed = false;
    manualRequestedUntil = 0;
    provider.emergencyStop();
  };
  $8("acknowledgeStopBtn").onclick = () => {
    resetKeys();
    manualArmed = false;
    manualRequestedUntil = 0;
    provider.acknowledgeStop();
  };
  $8("replayPauseBtn").onclick = () => provider.setReplayPaused(!provider.replay?.paused).catch((e) => {
    $8("operationStatus").textContent = e.message;
  });
  document.addEventListener("keydown", (event) => {
    if (isEditableTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey || tools.panel || document.querySelector("dialog[open]")) return;
    if (!event.repeat && document.body.dataset.workspace === "drive") {
      if (event.code === "KeyM") {
        event.preventDefault();
        document.getElementById("unifiedMapToggle")?.click();
        return;
      }
      if (event.code === "KeyF") {
        event.preventDefault();
        $8("expandCameraBtn").click();
        return;
      }
      if (event.code === "KeyC") {
        event.preventDefault();
        const select = $8("cameraView");
        if (!select.disabled) {
          const options = [...select.options].filter((option) => !option.disabled);
          const index = options.findIndex((option) => option.value === select.value);
          select.value = options[(index + 1) % options.length]?.value || select.value;
          select.dispatchEvent(new Event("change"));
        }
        return;
      }
      if (event.code === "KeyH") {
        event.preventDefault();
        $8("studioShortcutButton")?.click();
        return;
      }
    }
    if (DRIVING_KEYS.has(event.code)) {
      event.preventDefault();
      if (provider.controlMode === "AUTOMATIC" && event.code.startsWith("Shift")) return;
      if (!event.repeat && canInput()) controls.keys.add(event.code);
    }
    if (!event.repeat && event.code === "KeyP") tools.toggle("inGamePhone", "phoneToggleBtn");
  });
  document.addEventListener("keyup", (event) => controls.keys.delete(event.code));
  function inspectWithoutManualControl(reason) {
    if (keepJourneyOnInspection(provider, document.hidden) && !manualOverridePending) {
      resetKeys();
      manualArmed = false;
      manualRequestedUntil = 0;
    } else clearControls(reason);
  }
  document.addEventListener("workspacechange", (event) => {
    if (event.detail.phase !== "drive") inspectWithoutManualControl("workspace_changed");
  });
  window.addEventListener("blur", () => inspectWithoutManualControl("focus_lost"));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearControls("focus_lost");
  });
  window.addEventListener("pagehide", () => {
    clearControls("page_closed");
    clearCamera();
    provider.close();
  });
  provider.connect();
  refresh();
  setInterval(refresh, 50);
  setInterval(() => {
    if (journeyHeartbeatAllowed(provider, document.hidden, manualOverridePending)) provider.journeyHeartbeat();
  }, 100);
})();
