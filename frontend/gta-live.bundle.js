(() => {
  // frontend/gta-live.js
  var $ = (id) => document.getElementById(id);
  var state = null;
  var owner = null;
  var sequence = 0;
  var displayed = null;
  var kind = "rgb";
  var imageBusy = false;
  var lastSerial = null;
  var pulseUntil = 0;
  var sending = false;
  var origin = null;
  var generation = 0;
  var reasons = { READY: "\u0627\u0644\u062A\u062D\u0643\u0645 \u0645\u062A\u0627\u062D", CONTROL_LEASE_EXPIRED: "\u0627\u0644\u0641\u0631\u0627\u0645\u0644 \u0645\u0641\u0639\u0644\u0629 \xB7 \u0644\u0627 \u064A\u0648\u062C\u062F \u0623\u0645\u0631 \u062D\u0631\u0643\u0629", NATIVE_UNAVAILABLE: "\u0628\u0627\u0646\u062A\u0638\u0627\u0631 \u0627\u0644\u0644\u0639\u0628\u0629", STALE_SENSORS: "\u0642\u0631\u0627\u0621\u0629 \u0627\u0644\u062D\u0633\u0627\u0633\u0627\u062A \u0645\u062A\u0623\u062E\u0631\u0629", STALE_DISPLAYED_FRAME: "\u0627\u0644\u0635\u0648\u0631\u0629 \u0627\u0644\u0645\u0639\u0631\u0648\u0636\u0629 \u0642\u062F\u064A\u0645\u0629", UNKNOWN_MEASUREMENTS: "\u0627\u0644\u0642\u064A\u0627\u0633 \u063A\u064A\u0631 \u0645\u062A\u0627\u062D", FRONT_OBSTRUCTION: "\u0639\u0627\u0626\u0642 \u0642\u0631\u064A\u0628 \u0623\u0645\u0627\u0645 \u0627\u0644\u0639\u0631\u0628\u064A\u0629", SPEED_LIMIT: "\u062D\u062F \u0627\u0644\u0633\u0631\u0639\u0629" };
  async function post(path, data) {
    const r = await fetch("/api/gta/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal: AbortSignal.timeout(900) });
    const v = await r.json();
    if (!r.ok) throw Error(v.error || "\u0627\u0644\u062A\u062D\u0643\u0645 \u063A\u064A\u0631 \u0645\u062A\u0627\u062D");
    return v;
  }
  function boxes() {
    const ctx = $("gtaBoxes").getContext("2d");
    ctx.clearRect(0, 0, 640, 360);
    if (kind !== "rgb" || !displayed || state?.vision?.native_frame !== displayed.frame) return;
    ctx.font = "12px Arial";
    for (const d of state.vision.detections) {
      const [x1, y1, x2, y2] = d.xyxy;
      ctx.strokeStyle = d.classification_status === "SUPPORTED" ? "#82f2a5" : "#ffc45c";
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.fillStyle = "#14231bd9";
      ctx.fillRect(x1, y1 - 16, Math.max(70, d.class.length * 7 + 35), 16);
      ctx.fillStyle = "white";
      ctx.fillText(`${d.class} ${Math.round(d.confidence * 100)}%`, x1 + 3, y1 - 4);
    }
  }
  function rays() {
    const ctx = $("gtaRays").getContext("2d");
    ctx.clearRect(0, 0, 360, 300);
    const x = 180, y = 154, k = 3.9;
    ctx.strokeStyle = "#c7d1c1";
    ctx.font = "10px Arial";
    for (const m of [10, 20, 30]) {
      ctx.beginPath();
      ctx.arc(x, y, m * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(`${m}m`, x + 4, y - m * k + 11);
    }
    for (const r of state?.rays || []) {
      if (r[2] !== 2 || !r[3] || r[4] > 35) continue;
      const a = r[0] * Math.PI / 180;
      ctx.fillStyle = r[4] < 3 ? "#c0583f" : "#527e56";
      ctx.fillRect(x + Math.sin(a) * r[4] * k - 1, y - Math.cos(a) * r[4] * k - 1, 2, 2);
    }
    ctx.fillStyle = "#233f31";
    ctx.fillRect(x - 5, y - 9, 10, 18);
  }
  function renderDemo() {
    const d = state?.demonstrations;
    $("gtaDemo").hidden = !d;
    if (!d) return;
    $("gtaAuthority").textContent = state.driving_input?.human ? "\u0623\u0646\u062A \u062A\u0633\u0648\u0642 \xB7 X \u0644\u0644\u0639\u0648\u062F\u0629" : "\u0633\u0627\u0626\u0642 \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \xB7 X \u0644\u0644\u062A\u062F\u062E\u0644";
    $("gtaDemoCount").textContent = `${d.saved_samples} \u0644\u0642\u0637\u0629 \u0645\u062D\u0641\u0648\u0638\u0629 \xB7 ${d.native_acknowledged} \u0625\u0642\u0631\u0627\u0631 \u0641\u0639\u0644\u064A \xB7 ${d.dropped} \u0645\u0641\u0642\u0648\u062F\u0629`;
    $("gtaDemoMemory").textContent = d.diagnostic ? "\u062C\u0644\u0633\u0629 \u0641\u062D\u0635: \u0623\u0645\u062B\u0644\u062A\u0647\u0627 \u0645\u0633\u062A\u0628\u0639\u062F\u0629 \u0645\u0646 \u062A\u0642\u0644\u064A\u062F \u0633\u0648\u0627\u0642\u062A\u0643" : `${d.memory_examples} \u0645\u062B\u0627\u0644 \u0645\u0624\u0647\u0644 \u0644\u0644\u0627\u0642\u062A\u0631\u0627\u062D \xB7 \u062D\u0627\u062C\u0632 \u0627\u0644\u0623\u0645\u0627\u0646 \u0645\u0633\u062A\u0642\u0644`;
  }
  function renderGoal() {
    const g = state?.goal;
    $("gtaGoal").hidden = !g;
    if (!g) return;
    $("gtaGoalPhase").textContent = g.phase || "\u0627\u0646\u062A\u0638\u0627\u0631 \u0627\u0644\u0642\u064A\u0627\u0633\u0627\u062A";
    $("gtaGoalProgress").textContent = Number.isFinite(g.progress_m) ? `${g.progress_m.toFixed(1)} / ${g.route_length_m.toFixed(0)} \u0645\u062A\u0631` : "\u0627\u0644\u0637\u0631\u064A\u0642 \u0642\u064A\u062F \u0627\u0644\u0642\u064A\u0627\u0633";
    $("gtaGoalReason").textContent = g.actual_command?.reason || g.reason || "\u0628\u0627\u0646\u062A\u0638\u0627\u0631 \u0645\u0635\u062F\u0631 \u0627\u0644\u0642\u064A\u0627\u0633";
    $("gtaDestination").textContent = g.destination_m ? g.destination_m.map((v) => v.toFixed(1)).join(" \u060C ") : "\u062A\u062D\u062F\u064A\u062F \u0645\u0633\u0627\u0631 \u0641\u0639\u0644\u064A \u0628\u0637\u0648\u0644 \u0666\u0660\u0660\u2013\u0668\u0660\u0660 \u0645\u062A\u0631";
  }
  function offline() {
    generation++;
    pulseUntil = 0;
    displayed = null;
    lastSerial = null;
    $("gtaStatus").textContent = "\u0627\u0644\u0642\u0631\u0627\u0621\u0627\u062A \u063A\u064A\u0631 \u0645\u062A\u0627\u062D\u0629";
    $("gtaCamera").hidden = true;
    $("gtaEmpty").hidden = false;
    $("gtaEmpty").textContent = "\u0628\u0627\u0646\u062A\u0638\u0627\u0631 \u0642\u064A\u0627\u0633 \u062D\u062F\u064A\u062B \u0645\u0646 \u0627\u0644\u0644\u0639\u0628\u0629\u2026";
    $("gtaCreep").disabled = true;
    for (const id of ["gtaSpeed", "gtaDistance", "gtaRange", "gtaAge"]) $(id).textContent = "\u2014";
    $("gtaRayAge").textContent = "\u063A\u064A\u0631 \u0645\u062A\u0627\u062D";
    $("gtaFrame").textContent = "\u0644\u0627 \u062A\u0648\u062C\u062F \u0635\u0648\u0631\u0629 \u062D\u062F\u064A\u062B\u0629";
    $("gtaVision").textContent = "\u0627\u0644\u0631\u0624\u064A\u0629 \u063A\u064A\u0631 \u0645\u062A\u0627\u062D\u0629";
    $("gtaControlReason").textContent = "\u0641\u0631\u0627\u0645\u0644 \xB7 \u0644\u0627 \u064A\u0648\u062C\u062F \u0642\u064A\u0627\u0633 \u062D\u062F\u064A\u062B";
    $("gtaAck").textContent = "\u0625\u0642\u0631\u0627\u0631 \u0627\u0644\u0644\u0639\u0628\u0629: \u063A\u064A\u0631 \u0645\u062A\u0627\u062D";
    $("gtaGoalPhase").textContent = "\u0628\u0627\u0646\u062A\u0638\u0627\u0631 \u0642\u064A\u0627\u0633 \u062D\u062F\u064A\u062B";
    $("gtaGoalProgress").textContent = "\u0627\u0644\u062A\u0642\u062F\u0645 \u063A\u064A\u0631 \u0645\u062A\u0627\u062D";
    $("gtaAuthority").textContent = "\u0628\u0627\u0646\u062A\u0638\u0627\u0631 \u062D\u0627\u0644\u0629 \u0627\u0644\u062A\u062D\u0643\u0645";
    $("gtaDemoCount").textContent = "\u0627\u0644\u0642\u064A\u0627\u0633\u0627\u062A \u063A\u064A\u0631 \u0645\u062A\u0627\u062D\u0629";
    boxes();
    $("gtaRays").getContext("2d").clearRect(0, 0, 360, 300);
  }
  async function image() {
    if (imageBusy || !state?.connected || !state.image) return;
    const serial = state.image.serial, key = `${kind}:${serial}`, version = generation, requestedKind = kind;
    if (key === lastSerial) return;
    imageBusy = true;
    let url;
    try {
      const r = await fetch(`/api/gta/image?serial=${serial}&kind=${requestedKind}`, { signal: AbortSignal.timeout(800) });
      if (!r.ok) throw Error("\u0627\u0644\u0635\u0648\u0631\u0629 \u0644\u0645 \u062A\u0639\u062F \u062D\u062F\u064A\u062B\u0629");
      const session = r.headers.get("X-GTA-session-id"), frame = Number(r.headers.get("X-GTA-native-frame"));
      if (session !== state.session_id) throw Error("\u062C\u0644\u0633\u0629 \u0635\u0648\u0631\u0629 \u0645\u062E\u062A\u0644\u0641\u0629");
      url = URL.createObjectURL(await r.blob());
      const img = $("gtaCamera");
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      if (version !== generation || !state.connected) return;
      displayed = { session, frame };
      lastSerial = key;
      img.hidden = false;
      $("gtaEmpty").hidden = true;
      img.dataset.nativeFrame = String(frame);
      img.dataset.serial = String(serial);
      img.dataset.kind = requestedKind;
      $("gtaFrame").textContent = `\u0625\u0637\u0627\u0631 ${frame} \xB7 ${requestedKind === "rgb" ? "\u0635\u0648\u0631\u0629 \u062D\u064A\u0629" : "\u0639\u0645\u0642 \u0645\u0642\u0627\u0633"}`;
      boxes();
    } catch (e) {
      $("gtaEmpty").textContent = e.message;
    } finally {
      if (url) URL.revokeObjectURL(url);
      imageBusy = false;
    }
  }
  async function poll() {
    try {
      const r = await fetch("/api/gta/state", { signal: AbortSignal.timeout(800) });
      if (!r.ok) throw Error();
      state = await r.json();
      renderGoal();
      renderDemo();
      if (!state.connected) {
        offline();
        return;
      }
      $("gtaStatus").textContent = "\u0645\u062A\u0635\u0644 \u0628\u0627\u0644\u0639\u0631\u0628\u064A\u0629";
      $("gtaCreep").disabled = Boolean(state.goal);
      $("gtaSpeed").textContent = (state.vehicle.speed_mps * 3.6).toFixed(1);
      $("gtaRange").textContent = state.front.known ? state.front.distance_m.toFixed(1) : "\u063A\u064A\u0631 \u0645\u0642\u0627\u0633";
      $("gtaAge").textContent = Math.round(state.ages_ms.camera);
      $("gtaRayAge").textContent = `${Math.round(state.ages_ms.rays)} ms`;
      if (!origin) origin = state.vehicle.position_m;
      $("gtaDistance").textContent = Math.hypot(...state.vehicle.position_m.map((v, i) => v - origin[i])).toFixed(2);
      $("gtaControlReason").textContent = reasons[state.control.reason] || state.control.reason;
      $("gtaAck").textContent = `\u0625\u0642\u0631\u0627\u0631 \u0627\u0644\u0644\u0639\u0628\u0629: ${state.vehicle.native_sequence} \xB7 \u0625\u0637\u0627\u0631 ${state.native_frame}`;
      $("gtaVision").textContent = state.vision ? `YOLO \xB7 ${state.vision.detections.length} \u0631\u0635\u062F \xB7 ${Math.round(state.vision.inference_ms)} ms` : "\u0627\u0644\u0631\u0624\u064A\u0629 \u0641\u064A \u0627\u0646\u062A\u0638\u0627\u0631 \u0646\u0641\u0633 \u0625\u0637\u0627\u0631 \u0627\u0644\u0635\u0648\u0631\u0629";
      $("gtaSession").textContent = `GTA \xB7 ${state.session_id.slice(0, 10)} \xB7 ${state.game_ms} ms`;
      rays();
      await image();
      boxes();
    } catch {
      offline();
    }
  }
  async function send(brake2 = false) {
    if (sending || !displayed || !owner) return;
    sending = true;
    try {
      await post("control", { owner: owner.owner, session_id: displayed.session, sequence: ++sequence, source_frame: displayed.frame, steering: brake2 ? 0 : Number(document.querySelector("input[name=steering]:checked").value), throttle: brake2 ? 0 : 0.3, brake: brake2 ? 1 : 0 });
    } catch (e) {
      pulseUntil = 0;
      owner = null;
      $("gtaControlReason").textContent = e.message;
    } finally {
      sending = false;
    }
  }
  $("gtaCreep").addEventListener("click", async () => {
    try {
      if (!owner) {
        owner = await post("acquire", { client: "gta-browser" });
        sequence = 0;
      }
      pulseUntil = performance.now() + 1e3;
      await send();
    } catch (e) {
      $("gtaControlReason").textContent = e.message;
    }
  });
  async function brake(manual = false) {
    pulseUntil = 0;
    if (manual && state?.goal) {
      try {
        await post("stop", {});
      } catch {
      }
      return;
    }
    await send(true);
  }
  $("gtaBrake").addEventListener("click", () => brake(true));
  window.addEventListener("blur", () => brake(false));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) brake(false);
  });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      brake(true);
    }
  });
  for (const [id, value] of [["gtaRgb", "rgb"], ["gtaDepth", "depth"]]) $(id).addEventListener("click", () => {
    kind = value;
    generation++;
    lastSerial = null;
    displayed = null;
    $("gtaRgb").setAttribute("aria-pressed", String(kind === "rgb"));
    $("gtaDepth").setAttribute("aria-pressed", String(kind === "depth"));
    $("gtaDepthNote").hidden = kind !== "depth";
    boxes();
    image();
  });
  setInterval(() => {
    if (performance.now() < pulseUntil) send();
  }, 80);
  (async function loop() {
    await poll();
    setTimeout(loop, 120);
  })();
})();
