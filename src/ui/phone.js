import { attachVoiceInput } from "../signal_processing/voice.js";

export function mountPhone({ onDestination, getWorld, getPlaces }) {
  const toggle = document.getElementById("phoneToggleBtn"),
    panel = document.getElementById("inGamePhone");
  const input = document.getElementById("destinationInput"),
    status = document.getElementById("phoneStatus");
  const form = document.getElementById("destinationForm"),
    submit = form.querySelector('button[type="submit"]');
  const modelStatus = document.getElementById("phoneModelStatus");
  const voice = attachVoiceInput({
    button: document.getElementById("voiceBtn"),
    input,
    form,
    status,
  });
  let history = [],
    pending = null,
    generation = 0;
  async function health() {
    try {
      const response = await fetch("/api/nlp/health", {
        signal: AbortSignal.timeout(4000),
      });
      const data = await response.json();
      modelStatus.textContent =
        response.ok && data.ready
          ? "Local NLP model ready · experimental"
          : "NLP model offline. Choose a place below.";
    } catch {
      modelStatus.textContent = "NLP model offline. Choose a place below.";
    }
  }
  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) {
      document.getElementById("inspectorPanel").hidden = true;
      document
        .getElementById("inspectorBtn")
        .setAttribute("aria-expanded", "false");
      document.getElementById("settingsPanel").hidden = true;
      document
        .getElementById("settingsBtn")
        .setAttribute("aria-expanded", "false");
      input.focus();
      health();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      toggle.focus();
    }
  });
  function reset() {
    voice.stop();
    generation++;
    pending?.abort();
    pending = null;
    history = [];
    submit.disabled = false;
    submit.textContent = "Send";
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || pending) return;
    const world = getWorld(),
      requestGeneration = generation;
    pending = new AbortController();
    const controller = pending;
    const timeout = setTimeout(() => controller.abort(), 45000);
    submit.disabled = true;
    submit.textContent = "Understanding…";
    status.textContent = "Interpreting destination…";
    try {
      const response = await fetch("/api/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          text,
          environment: world.environment,
          history: history.slice(-6),
        }),
      });
      const result = await response.json();
      if (requestGeneration !== generation || world !== getWorld()) return;
      if (!response.ok)
        throw new Error(result.error ?? "Could not interpret request.");
      let reply = result.message;
      if (result.action === "navigate") {
        const place = getPlaces().find((p) => p.id === result.destination);
        if (!place) throw new Error("Destination is unavailable here.");
        reply = onDestination(place)
          ? `Navigating to ${place.name}.`
          : "No legal route from the current heading.";
      } else if (result.action === "stop") {
        world.command({ type: "stop" });
        reply = "Braking and cancelling the trip.";
      } else if (result.action === "status") {
        reply = world.destination
          ? `Destination: ${world.destination.name}. Speed: ${Math.round(Math.abs(world.player.speed) * 3.6)} km/h.`
          : "No destination selected. Tell me where to go.";
      }
      if (
        (result.action === "clarify" || result.action === "unsupported") &&
        /[؀-ۿ]/u.test(reply)
      )
        reply =
          result.action === "unsupported"
            ? "That request is outside the available destinations and driving controls."
            : "Please clarify which destination or service you need.";
      status.textContent = reply;
      history.push({ role: "user", text }, { role: "assistant", text: reply });
      history = history.slice(-6);
      input.value = "";
    } catch (error) {
      if (requestGeneration === generation)
        status.textContent =
          error.name === "AbortError"
            ? "The request timed out. Choose a place or try again."
            : error.message;
    } finally {
      clearTimeout(timeout);
      if (requestGeneration === generation) {
        pending = null;
        submit.disabled = false;
        submit.textContent = "Send";
      }
    }
  });
  return { reset };
}
