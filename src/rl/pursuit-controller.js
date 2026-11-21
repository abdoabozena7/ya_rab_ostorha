import { PURSUIT_STOP } from "../core/pursuit-controls.js";
import { getDispatchObservation } from "./gta-pursuit-env.js";
import { guardDispatchAction, requireDispatchScan } from "./pursuit-shield.js";

export function applyFrozenDispatchAction(world, driver) {
  if (driver?.status !== "active") return false;
  try {
    const scan = requireDispatchScan(world);
    if (driver.lastTick === scan.tick) return false;
    const start = performance.now();
    const action = driver.policy.action(getDispatchObservation(world, driver.policy.observation));
    const guarded = guardDispatchAction(world, action);
    driver.inferenceMs = performance.now() - start;
    world.command({ type: "pursuit-drive", action: guarded.action });
    driver.shieldReason = guarded.reason;
    driver.lastTick = scan.tick;
    driver.decisions++;
    return false;
  } catch (error) {
    driver.status = "fault";
    driver.error = error.message;
    driver.policy = null;
    world.command({ type: "pursuit-drive", action: PURSUIT_STOP });
    return true;
  }
}
