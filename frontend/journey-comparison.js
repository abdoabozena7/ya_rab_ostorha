export const JOURNEY_MODES=['ROBOSPHERE','NORMAL'];
export const modeName=mode=>mode==='NORMAL'?'Normal Mode':'Ya Rab Ostorha Mode';

export function comparisonSummary(data) {
  const runs=data?.runs||{}, count=JOURNEY_MODES.filter(m=>runs[m]&&runs[m].status!=='RUNNING').length;
  const arrived=JOURNEY_MODES.every(m=>runs[m]?.status==='ARRIVED');
  return {count,arrived,title:arrived?'Both journeys complete':count===2?'Two attempts recorded':'Comparison incomplete',
    detail:arrived?data.conditions_match?'Matching setup verified; live traffic can diverge.':'Setup differs or is unverified. Results are separate observations; differences are hidden.':count===2?'One or both journeys ended early. Compare their duration and coverage.':'Run both modes to complete your comparison.'};
}

export function metricValue(run,field,digits=0,suffix='') {
  if(!run||run.samples===0)return '—';
  if(field==='destination_reached')return run.status==='RUNNING'?'In progress':typeof run.destination_reached==='boolean'?run.destination_reached?'Yes':'No':run.status==='ARRIVED'?'Yes':'—';
  if(['collisions','maximum_impulse_ns'].includes(field)&&run.setup?.collision_measurement_available===false)return '—';
  if(field==='harsh_braking_events'&&run.acceleration_samples===0)return '—';
  if(['safety_interventions','safety_intervention_s'].includes(field)&&run.intervention_samples===0)return '—';
  const value=run[field];
  if(['near_misses','high_risk_s','minimum_forward_range_m'].includes(field)&&!run.observed_samples)return '—';
  return Number.isFinite(value)?value.toFixed(digits)+suffix:'—';
}

// A difference is descriptive, only for two arrived runs with useful coverage.
// Never present an intervention as a proven "prevented collision".
export function measuredDifference(data,field) {
  const a=data?.runs?.ROBOSPHERE,b=data?.runs?.NORMAL;
  if(field==='destination_reached'||a?.samples===0||b?.samples===0)return null;
  if(a?.status!=='ARRIVED'||b?.status!=='ARRIVED'||data.conditions_match!==true)return null;
  if(metricValue(a,field)==='—'||metricValue(b,field)==='—')return null;
  if(['collisions','maximum_impulse_ns'].includes(field)&&(a.setup?.collision_measurement_available===false||b.setup?.collision_measurement_available===false))return null;
  if(['near_misses','high_risk_s','minimum_forward_range_m'].includes(field)&&(!Number.isFinite(a.sensor_coverage_percent)||!Number.isFinite(b.sensor_coverage_percent)||Math.min(a.sensor_coverage_percent,b.sensor_coverage_percent)<80))return null;
  return Number.isFinite(a[field])&&Number.isFinite(b[field])?a[field]-b[field]:null;
}
