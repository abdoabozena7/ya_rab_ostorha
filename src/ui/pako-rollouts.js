import { angleDelta, pointOnRoad, roadRect } from "../core/geometry.js";
import { STEP } from "../core/config.js";
import { PERSPECTIVE_GHOST_CAP } from "../render/pako-perspective.js";
import { createActorPlayback } from "../rl/pursuit-actor-recording.js";

const palette = { escaped: "#76d0a6", wrecked: "#ff8d78", busted: "#e8ae70", timeout: "#a5bdde" };
const outcomeLabel = { escaped: "escaped", wrecked: "crashed", busted: "captured", timeout: "timed out" };
const bounds = (low, high) => ({ minX: low[0], maxX: high[0], minZ: low[1], maxZ: high[1] });
function sampledPose(trajectory, value) {
  const index = trajectory.findIndex(point => point[0] >= value);
  const next = index < 0 ? trajectory.at(-1) : trajectory[index], prev = index <= 0 ? next : trajectory[index - 1];
  const t = next[0] === prev[0] ? 0 : (value - prev[0]) / (next[0] - prev[0]);
  return [value, prev[1] + (next[1] - prev[1]) * t, prev[2] + (next[2] - prev[2]) * t,
    prev[3] + (next[3] - prev[3]) * t, prev[4] + angleDelta(next[4], prev[4]) * t];
}

function readForecastCases(value) {
  const label = text => typeof text === "string" && /^[A-Za-z0-9 -]{1,100}$/.test(text);
  const validPath = path => Array.isArray(path) && path.length >= 2 && path.length <= 8 &&
    path.every((point, i) => Array.isArray(point) && point.length === 3 &&
      point.every(n => Number.isFinite(n) && Math.abs(n) <= 2000) &&
      point[0] > (i ? path[i - 1][0] : 0) && point[0] <= 10);
  if (value?.schema !== "pako-forecast-comparison-v1" ||
      !Array.isArray(value.cases) || !value.cases.length || value.cases.length > 20 ||
      value.cases.some(row => !label(row?.name) || !Array.isArray(row.branches) || row.branches.length < 2 ||
        row.branches.length > 10 || row.branches.some(branch => !label(branch?.name) ||
          !validPath(branch.actual) || !validPath(branch.predicted) ||
          branch.actual.length !== branch.predicted.length ||
          branch.actual.some((point, i) => point[0] !== branch.predicted[i][0]))))
    throw new TypeError("Invalid PAKO forecast comparison or mismatched observation times.");
  return value.cases;
}

export function mountForecastComparison(doc) {
  const get = id => doc.getElementById(id);
  const file = get("pakoForecastFile"), status = get("pakoForecastStatus"), result = get("pakoForecastResult");
  const approach = get("pakoForecastCase"), choice = get("pakoForecastBranch"), canvas = get("pakoForecastMap");
  const ctx = canvas.getContext("2d");
  let cases = [];
  const options = rows => rows.map(({ name }, i) => new Option(name, String(i)));
  function draw() {
    const branch = cases[Number(approach.value)]?.branches[Number(choice.value)];
    if (!branch || !ctx) return;
    const { width, height } = canvas, { actual, predicted } = branch;
    const all = actual.concat(predicted, [[0, 0, 0]]);
    const lateral = all.map(point => point[1]), forward = all.map(point => point[2]);
    const minX = Math.min(...lateral) - 2, maxX = Math.max(...lateral) + 2;
    const minZ = Math.min(...forward) - 2, maxZ = Math.max(...forward) + 2;
    const scale = Math.min((width - 52) / (maxX - minX), (height - 48) / (maxZ - minZ));
    const x = metres => width / 2 + (metres - (minX + maxX) / 2) * scale;
    const y = metres => height / 2 - (metres - (minZ + maxZ) / 2) * scale;
    ctx.fillStyle = "#122126";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#40565a";
    ctx.beginPath();
    ctx.moveTo(x(0), 15); ctx.lineTo(x(0), height - 15);
    ctx.moveTo(15, y(0)); ctx.lineTo(width - 15, y(0));
    ctx.stroke();
    function path(points, ink, dash) {
      ctx.strokeStyle = ctx.fillStyle = ink;
      ctx.lineWidth = 2.25;
      ctx.setLineDash(dash);
      ctx.beginPath();
      points.forEach((point, i) => i ? ctx.lineTo(x(point[1]), y(point[2])) : ctx.moveTo(x(point[1]), y(point[2])));
      ctx.stroke();
      ctx.setLineDash([]);
      for (const [, a, b] of points) {
        ctx.beginPath();
        ctx.arc(x(a), y(b), 3.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    path(actual, "#ece8d8", []);
    path(predicted, "#75d9de", [7, 5]);
    ctx.fillStyle = "#adc3c6";
    ctx.font = "15px system-ui";
    ctx.fillText("Ego reference", Math.min(width - 120, x(0) + 5), Math.max(20, y(0) - 6));
    const mean = actual.reduce((sum, point, i) => sum +
      Math.hypot(point[1] - predicted[i][1], point[2] - predicted[i][2]), 0) / actual.length;
    status.textContent = `${branch.name} · ${actual.length} matched times · Mean error ${mean.toFixed(2)} m`;
    canvas.setAttribute("aria-label", `${status.textContent}. Dashed forecast, solid measured trajectory.`);
  }
  const selectApproach = () => {
    choice.replaceChildren(...options(cases[Number(approach.value)].branches));
    draw();
  };
  approach.onchange = selectApproach;
  choice.onchange = draw;
  file.onchange = async () => {
    const selected = file.files[0];
    cases = [];
    result.hidden = true;
    if (!selected) {
      status.textContent = "No comparison loaded.";
      return;
    }
    try {
      if (!ctx) throw new Error("Canvas drawing is unavailable in this browser.");
      if (selected.size > 200_000) throw new RangeError("Load a comparison file under 200 KB.");
      const incoming = readForecastCases(JSON.parse(await selected.text()));
      if (file.files[0] !== selected) return;
      cases = incoming;
      approach.replaceChildren(...options(cases));
      result.hidden = false;
      selectApproach();
    } catch (error) {
      if (file.files[0] === selected) status.textContent = `Could not load forecast comparison: ${error.message}`;
    }
  };
}

export function mountRolloutPlayback(doc, roads) {
  const get = id => doc.getElementById(id);
  const box = get("pakoGhostFleet"), canvas = get("pakoGhostMap"), status = get("pakoGhostSummary");
  const focus = get("pakoGhostFocus"), play = get("pakoGhostPlay"), step = get("pakoGhostStep"),
    rate = get("pakoGhostSpeed"), time = get("pakoGhostTime"), save = get("pakoGhostExport"), camera = get("pakoGhostCamera");
  const ctx = canvas.getContext("2d");
  const roadAreas = roads.map(road => ({ ...roadRect(road), road }));
  const extent = bounds([
    Math.min(...roadAreas.map(r => r.minX)), Math.min(...roadAreas.map(r => r.minZ)),
  ], [
    Math.max(...roadAreas.map(r => r.maxX)), Math.max(...roadAreas.map(r => r.maxZ)),
  ]);
  const history = [];
  const actorPlayback = new Map();
  let playing = false, lastFrame = 0, tick = 0, frameId = 0, mode = "train", worldCount = 1;
  const shown = () => focus.value ? history.filter(value => value.id === focus.value) : history;
  let viewport = extent;
  let streetLabel = "";

  function draw(value = tick) {
    if (!ctx || !box.open) return;
    const { width, height } = canvas;
    ctx.fillStyle = "#122126";
    ctx.fillRect(0, 0, width, height);
    const scale = Math.min((width - 28) / (viewport.maxX - viewport.minX),
      (height - 28) / (viewport.maxZ - viewport.minZ));
    const x = a => width / 2 + (a - (viewport.minX + viewport.maxX) / 2) * scale;
    const z = a => height / 2 + (a - (viewport.minZ + viewport.maxZ) / 2) * scale;
    ctx.fillStyle = "#273a40";
    ctx.strokeStyle = "#273a40";
    for (const r of roadAreas) {
      if (r.road.axis === "diag") {
        ctx.lineWidth = r.road.width * scale;
        ctx.beginPath();
        ctx.moveTo(x(r.road.x1), z(r.road.z1));
        ctx.lineTo(x(r.road.x2), z(r.road.z2));
        ctx.stroke();
      } else {
        ctx.fillRect(x(r.minX), z(r.minZ), (r.maxX - r.minX) * scale, (r.maxZ - r.minZ) * scale);
      }
    }
    ctx.strokeStyle = "#6a8081";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 8]);
    ctx.beginPath();
    for (const { road } of roadAreas) {
      if (road.width < 7) continue;
      if (road.axis === "diag") {
        ctx.moveTo(x(road.x1), z(road.z1));
        ctx.lineTo(x(road.x2), z(road.z2));
      } else {
        ctx.moveTo(x(road.axis === "x" ? road.min : road.fixed), z(road.axis === "z" ? road.min : road.fixed));
        ctx.lineTo(x(road.axis === "x" ? road.max : road.fixed), z(road.axis === "z" ? road.max : road.fixed));
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    const choices = shown(), carWidth = Math.max(3.4, 1.85 * scale), carLength = Math.max(7, 4.5 * scale);
    for (const { trajectory, phase } of choices) {
      const color = palette[phase] ?? "#c6d0d1";
      ctx.strokeStyle = ctx.fillStyle = color;
      ctx.globalAlpha = focus.value ? .9 : .46;
      ctx.lineWidth = focus.value ? 2 : 1.25;
      ctx.beginPath();
      ctx.moveTo(x(trajectory[0][1]), z(trajectory[0][2]));
      for (let i = 1; i < trajectory.length; i++) ctx.lineTo(x(trajectory[i][1]), z(trajectory[i][2]));
      ctx.stroke();
      const [, a, b, , heading] = sampledPose(trajectory, value);
      ctx.save();
      ctx.translate(x(a), z(b));
      ctx.rotate(-heading);
      ctx.globalAlpha = focus.value ? 1 : .64;
      ctx.beginPath();
      ctx.roundRect(-carWidth / 2, -carLength / 2, carWidth, carLength, Math.min(2.4, carWidth * .16));
      ctx.fill();
      ctx.fillStyle = "#122126";
      const wheelH = carLength * .17, wheelW = Math.max(1, carWidth * .14);
      for (const side of [-1, 1]) for (const axle of [-1, 1])
        ctx.fillRect(side * carWidth * .48 - wheelW / 2, axle * carLength * .31 - wheelH / 2, wheelW, wheelH);
      ctx.fillRect(-carWidth * .32, carLength * .18, carWidth * .64, Math.max(1, carLength * .16));
      ctx.restore();
    }
    // Draw end markers above the cars, with a separate lead when focused.
    for (const { trajectory, phase } of choices) {
      const last = trajectory.at(-1), px = x(last[1]), py = z(last[2]);
      const offset = focus.value ? Math.max(10, carLength / 2 + 5) : 0;
      const r = focus.value ? 5 : 2.5;
      ctx.globalAlpha = focus.value ? 1 : .65;
      ctx.strokeStyle = palette[phase] ?? "#c6d0d1";
      ctx.lineWidth = focus.value ? 1.8 : 1;
      ctx.beginPath();
      if (offset) {
        ctx.moveTo(px, py);
        ctx.lineTo(px + offset - r, py - offset + r);
      }
      if (phase === "wrecked") {
        ctx.moveTo(px + offset - r, py - offset - r);
        ctx.lineTo(px + offset + r, py - offset + r);
        ctx.moveTo(px + offset - r, py - offset + r);
        ctx.lineTo(px + offset + r, py - offset - r);
      } else {
        ctx.moveTo(px + offset + r, py - offset);
        ctx.arc(px + offset, py - offset, r, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = "#ff9d85";
    ctx.lineWidth = 1.7;
    ctx.globalAlpha = focus.value ? 1 : .72;
    for (const entry of choices) for (const marker of entry.collisionMarkers ?? []) {
      const px = x(marker.x), py = z(marker.z), r = focus.value ? 5 : 3;
      ctx.beginPath();
      ctx.moveTo(px, py - r); ctx.lineTo(px + r, py);
      ctx.lineTo(px, py + r); ctx.lineTo(px - r, py); ctx.closePath();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.font = "600 15px system-ui";
    ctx.fillStyle = "#cddddd";
    if (streetLabel) ctx.fillText(streetLabel, 15, 25);
    const metres = scale > 8 ? 5 : scale > 2 ? 10 : 40;
    const scaleX = width - 15 - metres * scale;
    ctx.fillRect(scaleX, height - 18, metres * scale, 1.5);
    ctx.fillText(`${metres} m`, scaleX, height - 24);
  }

  function select(reset = true) {
    const latest = history.at(-1)?.id;
    for (const id of actorPlayback.keys()) if (id !== latest && id !== focus.value) actorPlayback.delete(id);
    const choices = shown();
    const limit = Math.max(0, ...choices.map(rollout => rollout.trajectory.at(-1)[0]));
    time.max = String(limit);
    if (reset) tick = limit;
    time.value = String(Math.round(tick));
    time.disabled = play.disabled = step.disabled = limit < 1;
    save.disabled = history.length === 0;
    camera.disabled = history.length === 0;
    viewport = extent;
    streetLabel = "Metro";
    if (choices.length) {
      const poses = choices.flatMap(rollout => rollout.trajectory);
      const xs = poses.map(pose => pose[1]), zs = poses.map(pose => pose[2]);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minZ = Math.min(...zs), maxZ = Math.max(...zs);
      const padX = Math.max(5, (26 - maxX + minX) / 2), padZ = Math.max(5, (19 - maxZ + minZ) / 2);
      viewport = bounds([minX - padX, minZ - padZ], [maxX + padX, maxZ + padZ]);
      const start = poses[0];
      const road = roads.find(candidate => pointOnRoad({ x: start[1], z: start[2] }, [candidate]));
      if (road) streetLabel = road.id.replaceAll("-", " ").replace(/^\w/, initial => initial.toUpperCase());
    }
    const count = `${choices.length} displayed / ${history.length} recorded` + (camera.value === "city"
      ? ` · City view: ${Math.min(choices.length, PERSPECTIVE_GHOST_CAP)} replay cars` : "");
    const selected = focus.value && choices[0];
    const detail = selected && camera.value === "city" ? (actorPlayback.has(selected.id)
      ? " · Recorded traffic, people and patrols" : " · SUV path only") : "";
    status.textContent = !ctx ? "Canvas playback is unavailable in this browser." : history.length
      ? `${count} · ${worldCount === 1 ? "1 simulation world" : `Up to ${worldCount} interleaved simulation worlds`} · 1 ${
        mode === "evaluate" ? "frozen" : "shared PPO"} policy${
        selected ? ` · Episode ${selected.index}: ${outcomeLabel[selected.phase] ?? selected.phase}, ${selected.collisions} contacts${
          selected.collisionMarkers?.length ? " · Diamonds mark recorded contact positions" : ""}${detail}` : ""}`
      : "No completed episodes to display.";
    canvas.setAttribute("aria-label", `Overhead Metro map. ${status.textContent}`);
    draw();
  }

  function togglePlayback(active) {
    playing = active;
    play.textContent = active ? "Pause playback" : "Play";
    cancelAnimationFrame(frameId);
    if (active) {
      if (tick >= Number(time.max)) tick = 0;
      lastFrame = performance.now();
      frameId = requestAnimationFrame(animate);
    }
  }
  function animate(now) {
    if (!playing || !box.open || box.closest("[hidden]")) {
      togglePlayback(false);
      return;
    }
    tick = Math.min(Number(time.max), tick + (now - lastFrame) * .001 / STEP * Number(rate.value));
    time.value = String(Math.round(tick));
    draw();
    lastFrame = now;
    if (tick < Number(time.max)) frameId = requestAnimationFrame(animate);
    else togglePlayback(false);
  }
  play.onclick = () => togglePlayback(!playing);
  save.onclick = () => {
    if (!history.length) return;
    const json = JSON.stringify({ schema: "pako-actual-rollouts-v1", profile: "metro-v4", mode,
      positioning: ["tick", "xM", "zM", "speedMps", "headingRad"], episodes: history });
    const url = URL.createObjectURL(new Blob([json + "\n"], { type: "application/json" }));
    const link = doc.createElement("a");
    link.href = url;
    link.download = "pako-actual-rollouts.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  time.oninput = () => { togglePlayback(false); tick = Number(time.value); draw(); };
  step.onclick = () => {
    togglePlayback(false);
    const max = Number(time.max);
    if (tick >= max) tick = 0;
    const recording = camera.value === "city" && actorPlayback.get(focus.value);
    const next = recording ? [recording.nextTick(tick)]
      : shown().flatMap(item => item.trajectory.find(point => point[0] > tick)?.[0] ?? []);
    tick = Math.min(max, ...next);
    time.value = String(tick);
    draw();
  };
  focus.onchange = () => { togglePlayback(false); select(); };
  camera.onchange = () => select(false);
  box.addEventListener("toggle", () => { if (!box.open) togglePlayback(false); else draw(); });
  return {
    setWorldCount(count) { worldCount = count; },
    watchLatest() {
      const last = history.at(-1);
      if (!last) return false;
      box.open = true;
      focus.value = last.id;
      camera.value = "city";
      select();
      togglePlayback(true);
      return true;
    },
    perspective() {
      if (camera.value !== "city" || !box.open || box.closest("[hidden]") || !history.length) return null;
      const actorFrame = actorPlayback.get(focus.value)?.sample(tick);
      const items = shown().slice(0, PERSPECTIVE_GHOST_CAP).map(entry =>
        ({ ...entry, pose: actorFrame?.pose ?? sampledPose(entry.trajectory, tick) }));
      return { tick, focused: Boolean(focus.value), items, actorFrame };
    },
    clear(nextMode) {
      history.length = 0;
      actorPlayback.clear();
      while (focus.options.length > 1) focus.remove(1);
      focus.value = "";
      focus.disabled = true;
      camera.value = "map";
      mode = nextMode;
      worldCount = 1;
      togglePlayback(false);
      select();
    },
    add(episode, index, recording) {
      if (!ctx || !Array.isArray(episode?.trajectory) || !episode.trajectory.length) return;
      const id = String(episode.id ?? index);
      if (history.some(item => item.id === id)) return;
      if (recording) actorPlayback.set(id, createActorPlayback(recording));
      history.push({ ...episode, id, index });
      const option = doc.createElement("option");
      option.value = id;
      option.textContent = `Episode ${index} · ${episode.phase}`;
      focus.append(option);
      focus.disabled = false;
      if (history.length > 100) {
        const old = history.shift();
        const selected = focus.value === old.id;
        focus.remove(1);
        if (selected) focus.value = "";
      }
      select(!playing);
    },
  };
}
