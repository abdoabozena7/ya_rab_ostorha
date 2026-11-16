import { distance } from "../core/geometry.js";
import {
  policyAction,
  policyObservation,
  SPEED_ACTIONS,
} from "../core/policy.js";

const $ = (id) => document.getElementById(id);

function routeRemaining(car) {
  if (!car.path.length) return 0;
  let total = distance(
    car,
    car.path[Math.min(car.cursor, car.path.length - 1)],
  );
  for (let i = car.cursor + 1; i < car.path.length; i++)
    total += distance(car.path[i - 1], car.path[i]);
  return total;
}

function metric(label, value) {
  const item = document.createElement("div");
  const title = document.createElement("span");
  const number = document.createElement("strong");
  title.textContent = label;
  number.textContent = value;
  item.append(title, number);
  return item;
}

function drawPipeline(container) {
  // This shows actual data flow. YOLOX is a neural detector; A* selects the
  // route, and the Q-table only adjusts speed when manually enabled.
  container.innerHTML = `
    <svg viewBox="0 0 360 134" role="img" aria-label="Pixels feed YOLOX detection for display; map and congestion feed A-star routing; the route and simulator state feed the safety guard">
      <g stroke="#78a993" stroke-width="1.5" fill="none">
        <path d="M55 30 H92 M158 30 H195 M55 92 H92 M158 92 H195 M259 92 H300"/>
      </g>
      <g fill="#233d33" stroke="#90cbaa" stroke-width="1.5">
        <circle cx="28" cy="30" r="18"/><circle cx="125" cy="30" r="33"/>
        <circle cx="227" cy="30" r="32"/><circle cx="28" cy="92" r="18"/>
        <circle cx="125" cy="92" r="33"/><circle cx="227" cy="92" r="32"/>
        <circle cx="322" cy="92" r="27"/>
      </g>
      <g fill="#e6f3e8" font-size="10" font-family="Arial, sans-serif" text-anchor="middle">
        <text x="28" y="33">PX</text><text x="125" y="27">YOLOX</text><text x="125" y="39">Tiny</text>
        <text x="227" y="27">Boxes</text><text x="227" y="39">only</text>
        <text x="28" y="95">MAP</text><text x="125" y="89">A* +</text><text x="125" y="101">traffic</text>
        <text x="227" y="89">Safety</text><text x="227" y="101">guard</text><text x="322" y="95">Drive</text>
      </g>
    </svg>`;
}

export function createDecisionInspector() {
  const panel = $("inspectorPanel");
  const button = $("inspectorBtn");
  drawPipeline($("decisionGraph"));
  const toggle = (open) => {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      $("inGamePhone").hidden = true;
      $("phoneToggleBtn").setAttribute("aria-expanded", "false");
      $("settingsPanel").hidden = true;
      $("settingsBtn").setAttribute("aria-expanded", "false");
    }
  };
  button.onclick = () => toggle(panel.hidden);
  $("closeInspector").onclick = () => toggle(false);
  function update(world, detection) {
    if (panel.hidden) return;
    const car = world.player;
    const nearby = world.actors.filter(
      (actor) => actor !== car && distance(actor, car) < 25,
    );
    const policyState = world.policy ? policyObservation(world, car) : null;
    const action = policyState ? policyAction(world.policy, policyState) : null;
    $("inspectorMetrics").replaceChildren(
      metric("Route algorithm", "A* + live queue cost"),
      metric("Route remaining", `${routeRemaining(car).toFixed(1)} m`),
      metric("Current decision", car.reason ?? "ready"),
      metric("Blocking actor", car.blockedBy ?? "none"),
      metric("Nearby actors (<25 m)", String(nearby.length)),
      metric(
        "CV detections",
        detection
          ? `${detection.detections.length} · ${detection.latencyMs} ms`
          : "No recent result",
      ),
      metric(
        "Speed policy",
        action == null
          ? "Baseline rule"
          : `Q-table · ${policyState} · ${(SPEED_ACTIONS[action] * 100).toFixed(0)}%`,
      ),
      metric("Interventions", String(world.metrics.interventions)),
      metric("Player wait", `${world.metrics.waitSeconds.toFixed(1)} s`),
      metric("Completed traffic trips", String(world.metrics.trafficTrips)),
      metric(
        "Traffic stopped ≥5 s / ≥20 s",
        `${world.metrics.trafficStoppedOver5} / ${world.metrics.trafficStoppedOver20}`,
      ),
      metric(
        "Longest wait now / this run",
        `${world.metrics.longestCurrentTrafficWait.toFixed(1)} / ${world.metrics.peakTrafficWait.toFixed(1)} s`,
      ),
      metric(
        "Blocking cycles (≥5 s, no red)",
        String(world.metrics.trafficBlockingCycles),
      ),
    );
    const sensors = world.sensors;
    $("sensorReadout").replaceChildren(
      ...sensors.anglesDeg.map((angle, index) => {
        const row = document.createElement("div");
        const label = document.createElement("span");
        const bar = document.createElement("meter");
        label.textContent = `${angle > 0 ? "+" : ""}${angle}° · ${sensors.filteredM[index].toFixed(1)} m`;
        bar.min = 0;
        bar.max = sensors.maxRangeM;
        bar.value = sensors.filteredM[index];
        row.append(label, bar);
        return row;
      }),
    );
  }
  return { update };
}
