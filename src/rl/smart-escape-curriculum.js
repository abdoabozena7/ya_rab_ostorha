import { CITY_FAIR_POLICE } from "../core/pako-tactical-police.js";
import { SMART_ESCAPE_CONTROL } from "./pako-smart-escape.js";

export const SMART_ESCAPE_SCENARIOS = Object.freeze([
  "smart-gap-crowd", "smart-crossing-traffic", "smart-static-hazard",
]);

export function smartEscapeCurriculum(base) {
  return { ...base,
    description: `${base.description} Sensor-only smart escape shield; gap, crossing and static-hazard practice. No pretrained policy claim.`,
    stages: base.stages.map(stage => ({ ...stage, policeFairness: CITY_FAIR_POLICE,
      evasiveControl: SMART_ESCAPE_CONTROL, scenarios: [...SMART_ESCAPE_SCENARIOS] })),
  };
}
