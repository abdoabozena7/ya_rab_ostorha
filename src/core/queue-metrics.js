// A closed chain of stopped vehicles is a possible deadlock; a chain ending
// at a moving actor is an ordinary queue.
function findStoppedCycles(stopped) {
  const byId = new Map(stopped.map((actor) => [actor.id, actor]));
  const examined = new Set();
  const cycles = [];
  for (const first of stopped) {
    if (examined.has(first.id)) continue;
    const path = [];
    const index = new Map();
    let actor = first;
    while (actor && !examined.has(actor.id) && !index.has(actor.id)) {
      index.set(actor.id, path.length);
      path.push(actor.id);
      actor = byId.get(actor.blockedBy);
    }
    if (actor && index.has(actor.id))
      cycles.push(path.slice(index.get(actor.id)));
    for (const id of path) examined.add(id);
  }
  return cycles;
}

export function stoppedVehicleCycles(actors, canProceed = () => true) {
  return findStoppedCycles(
    actors.filter(
      (actor) =>
        actor.type === "vehicle" &&
        actor.id !== "player" &&
        actor.speed < 0.15 &&
        actor.wait >= 5 &&
        canProceed(actor),
    ),
  );
}

export function trafficQueueStats(actors, canProceed = () => true) {
  const traffic = actors.filter(
    (actor) => actor.type === "vehicle" && actor.id !== "player",
  );
  const stopped = traffic.filter(
    (actor) => actor.speed < 0.15 && actor.wait >= 5,
  );
  return {
    trafficStoppedOver5: stopped.length,
    trafficStoppedOver20: traffic.filter(
      (actor) => actor.speed < 0.15 && actor.wait >= 20,
    ).length,
    longestCurrentTrafficWait: Math.max(
      0,
      ...traffic.map((actor) => actor.wait),
    ),
    trafficBlockingCycles: findStoppedCycles(stopped.filter(canProceed)).length,
  };
}
