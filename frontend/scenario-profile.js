export const EGYPT_SCENARIO='EGYPT_URBAN_CHAOS_V1';
export const LEGACY_SCENARIO='SUDDEN_PEDESTRIAN_COMPARISON_V1';
export function urbanAvailability(catalog) {
  const option=catalog?.options?.find(option=>option.id===EGYPT_SCENARIO);
  if(!option)return {available:false,suffix:'checking availability',notice:'Egypt urban journey: availability has not been received. Connect to the simulator, then refresh availability.'};
  if(option.available!==true)return {available:false,suffix:'unavailable',notice:
    `Egypt urban journey unavailable: ${option.reason||'Native acceptance is pending'}. `+
    'No active validation window is available. Historical crossing remains available.'};
  return {available:true,suffix:option.native_accepted?'':'validation only',notice:option.native_accepted?
    'Egypt urban journey is available; source-bound native acceptance verified.':
    'Egypt urban journey is available in the active validation window. Native acceptance is pending.'};
}
export const isEgyptScenario=value=>value?.scenario_id===EGYPT_SCENARIO||value?.id===EGYPT_SCENARIO||value?.protocol==='EGYPT_COMPLETE_DRIVERS_V1';
export function scenarioOptions(id) {
  return {scenario_id:id||LEGACY_SCENARIO,scene:'DENSE_CHAOS',speed_kmh:id===EGYPT_SCENARIO?60:120};
}
export function scenarioDriverText(mode,id) {
  return mode==='NORMAL'?'Same Mercedes · reactive sensor braking':id===EGYPT_SCENARIO?
    'Same Mercedes · prediction + moving-traffic maneuvers':'Same Mercedes · sensor braking + prediction';
}
export function completedOvertakes(run) {
  if(!Array.isArray(run?.completed_maneuvers))return null;
  return run.completed_maneuvers.filter(m=>m&&typeof m==='object'&&m.kind==='OVERTAKE'&&m.status==='COMPLETED'&&
    m.measured_clearance===true&&(!m.return_required||m.returned===true)).length;
}
const measured=(value,digits=2,suffix='')=>Number.isFinite(value)?value.toFixed(digits)+suffix:'unmeasured';
export function scenarioRunSummary(run) {
  const scenario=run?.setup?.comparison_scenario;
  if(!isEgyptScenario(scenario))return '';
  const evidence=run.scenario_evidence,events=Object.values(evidence?.events||{});
  const completed=events.filter(e=>e.realized&&e.status==='COMPLETED');
  const count=completedOvertakes(run);
  const waits=Object.entries(run.waiting_reasons_s||{}).map(([reason,seconds])=>`${reason.replaceAll('_',' ')} ${measured(seconds,1,' s')}`);
  return `${EGYPT_SCENARIO} · v${scenario.version??'unrecorded'} · seed ${scenario.seed??'unrecorded'} · ${run.driver_id||'driver unrecorded'}. `+
    `Physical events ${completed.length}/${events.length}${evidence?'':' (not measured yet)'} · completed overtakes ${count??'unmeasured'}. `+
    `Minimum body separation ${measured(evidence?.minimum_body_separation_m,2,' m')} (native scoring only). `+
    `Sensor age sim/wall ${measured(run.maximum_sensor_sim_age_s,3,' s')} / ${measured(run.maximum_sensor_wall_age_s,3,' s')}. `+
    `Missing current sensor scenes ${run.missing_current_sensor_frames??'unmeasured'}. `+
    `Simulation/wall ratio ${measured(run.simulation_wall_ratio)}.`+(waits.length?' Waits: '+waits.join('; '):'');
}
