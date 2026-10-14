import {selectedComparison,collisionOutcome} from './workspace-state.js';
const $ = id => document.getElementById(id);
const number = (value,suffix='',digits=1) => Number.isFinite(value) ? value.toFixed(digits)+suffix : 'Not measured';
const node = (tag,cls,text) => {const el=document.createElement(tag); if(cls)el.className=cls; if(text!==undefined)el.textContent=text; return el;};
const modes = ['WITHOUT','WITH'];
const modeLabel = mode => mode==='WITH' ? 'With safety · RULE' : 'Without safety';

export function renderJourneyResults(state, connected) {
  const box=$('journeyResults'); box.replaceChildren();
  box.append(node('h2',null,'Recorded destination journey'),node('p','muted',
    (connected ? 'Saved measurements' : 'Last received saved measurements · connection unavailable')+
    (state?.pair_id ? ' · pair '+state.pair_id.slice(0,8)+' · seed '+state.seed : '')));
  if(state?.latest_attempt) {
    const latest=state.latest_attempt;
    box.append(node('p','latest-journey-attempt',`Latest attempt · ${latest.side || 'Unknown side'} · ${latest.status || 'Not measured'} · ${latest.reason || 'Reason unavailable'}`));
  }
  const results=state?.results || {};
  if(!Object.keys(results).length) box.append(node('p','muted','No completed destination journey received. Interrupted attempts do not establish arrival.'));
  for(const side of ['RULE','MODEL']) {
    const result=results[side]; if(!result) continue;
    const section=node('section','journey-result'); section.dataset.side=side;
    section.append(node('h3',null,side==='RULE' ? 'RULE · saved terminal run' : 'MODEL · experimental saved run'));
    const status=node('p','state-value',result.status || 'Status unavailable');
    status.dataset.tone=result.status==='ARRIVED' ? 'success' : result.collision || result.status==='FAILURE' ? 'danger' : 'warning'; section.append(status);
    section.append(node('p',null,'Destination reached and stopped: '+(result.destination_arrived===true ? 'Yes · native arrival check' : result.destination_arrived===false ? 'No' : 'Not measured')));
    const m=result.metrics || {}, out=result.outcome_metrics || result.outcome?.metrics || {};
    const table=node('table','comparison-table'),body=node('tbody');
    table.append(node('caption','sr-only',side+' recorded journey measurements'));
    for(const [label,value,suffix,digits] of [
      ['Collision episodes',out.collision_count ?? (result.collision===false ? 0 : null),'',0],
      ['Recorded duration',out.elapsed_simulation_s ?? m.duration_s,' s',2],
      ['Route progress',out.progress_m,' m',2],['Distance traveled',out.distance_traveled_m,' m',2],
      ['Minimum clearance',out.minimum_clearance_m,' m',2],
      ['Harsh braking events',m.harsh_braking_events,'',0],
      ['Emergency intervention',m.emergency_intervention_s,' s',2],
      ['Waiting proxy',m.unnecessary_waiting_s,' s',2]]) {
      const row=node('tr'),th=node('th',null,label); th.scope='row'; row.append(th,node('td',null,number(value,suffix,digits))); body.append(row);
    }
    table.append(body); section.append(table,node('p','recording-path',result.recording || 'Recording reference unavailable')); box.append(section);
  }
  box.append(node('p','muted','Waiting is a controller proxy, not all stopped time or a measured unnecessary-delay total. Collision-free arrival does not establish a safe clearance margin. MODEL acceptance and general safety remain unproven.'));
}

export function renderComparison(demo) {
  const {comparison,archived,scope}=selectedComparison(demo),results=comparison?.results||{},box=$('demoResults');
  box.replaceChildren(); $('resultScope').textContent=scope;
  if(!Object.keys(results).length) {
    const empty=node('div','results-empty'); empty.append(node('h3',null,'No recorded comparison yet'),node('p','muted','Run both comparison modes to review collision outcomes, progress and clearance.'));
    const button=node('button','primary','Configure a comparison'); button.onclick=()=>$('comparisonSetupBtn').click(); empty.append(button); box.append(empty);
  } else {
    const outcomes=node('section','collision-outcomes'); outcomes.setAttribute('aria-label','Recorded collision outcomes');
    for(const mode of modes) {
      const outcome=collisionOutcome(results[mode]),column=node('div','collision-outcome'); column.dataset.tone=outcome.tone;
      column.append(node('span','eyebrow',modeLabel(mode)),node('span','outcome-symbol',outcome.symbol),node('h3',null,outcome.label),node('p','muted',results[mode] ? results[mode].completed ? 'Full recorded run' : 'Interrupted recording · result is partial' : 'Complete this mode to compare')); outcomes.append(column);
    }
    box.append(outcomes);
    const clearance=results.WITH?.outcome?.metrics?.minimum_clearance_m;
    if(Number.isFinite(clearance)) {
      const notice=node('p','clearance-context'); notice.dataset.tone=clearance<1 ? 'warning' : 'neutral';
      notice.textContent=(clearance<1 ? '⚠ Close approach' : 'Minimum clearance')+' · '+number(clearance,' m',2)+'. Collision outcome and obstacle clearance are separate measurements. A collision-free run does not establish a safe margin.'; box.append(notice);
    }
    const analysis=node('div','comparison-analysis'),chart=node('section','progress-comparison');
    chart.append(node('h3',null,'Progress along the route'),node('p','muted','Projected distance along the planned route.'));
    const progress=modes.map(mode=>results[mode]?.outcome?.metrics?.progress_m),maximum=Math.max(1,...progress.filter(Number.isFinite));
    modes.forEach((mode,index)=>{
      const row=node('div','comparison-bar-row'),header=node('div','bar-label'); header.append(node('span',null,modeLabel(mode)),node('strong',null,number(progress[index],' m')));
      const track=node('div','comparison-bar-track'),fill=node('div','comparison-bar'); fill.dataset.mode=mode; fill.style.width=Number.isFinite(progress[index]) ? Math.max(0,progress[index])/maximum*100+'%' : '0%'; track.append(fill); row.append(header,track); chart.append(row);
    });
    if(progress.every(Number.isFinite)&&comparison.initial_conditions_match&&modes.every(mode=>results[mode]?.completed)) chart.append(node('p','progress-delta',number(progress[1]-progress[0],' m')+' change in progress with safety'));
    if(!comparison.initial_conditions_match)chart.append(node('p','muted','Starting conditions are not verified as matching. Treat these as separate observations.'));
    analysis.append(chart);
    const metrics=node('section','measured-metrics'); metrics.append(node('h3',null,'Recorded measurements'));
    const table=node('table','comparison-table'); table.append(node('caption','sr-only',scope+'; saved measurements, not live telemetry'));
    const head=node('thead'),header=node('tr'); ['Measurement','Without safety','With RULE'].forEach(label=>{const th=node('th',null,label); th.scope='col'; header.append(th);}); head.append(header); table.append(head);
    const body=node('tbody'),fields=[['Distance traveled','distance_traveled_m',' m'],['Minimum clearance','minimum_clearance_m',' m'],['Safety interventions','safety_intervention_count','',0],['Duration','elapsed_simulation_s',' s'],['Route completion','route_completion','%',0]];
    for(const [label,key,suffix,digits] of fields) {
      const row=node('tr'),th=node('th',null,label); th.scope='row'; row.append(th);
      for(const mode of modes) {let value=results[mode]?.outcome?.metrics?.[key]; if(key==='route_completion'&&Number.isFinite(value))value*=100; row.append(node('td',null,number(value,suffix,digits??1)));} body.append(row);
    }
    table.append(body); metrics.append(table); analysis.append(metrics); box.append(analysis);
    const definitions=node('details','metric-definitions'); definitions.append(node('summary',null,'What these measurements mean'));
    const list=node('dl');
    for(const [term,description] of [['Progress','Distance projected along the planned route; differs from total vehicle movement.'],['Distance traveled','Total measured vehicle movement during the recording.'],['Minimum clearance','Smallest gap between planar vehicle and obstacle bounding boxes; not a certified safety margin.'],['Safety interventions','Reported intervention episodes. RULE applies braking; steering is unavailable in the current rule controller.'],['Not measured','The recording did not provide this value. It is not zero.']])list.append(node('dt',null,term),node('dd',null,description));
    definitions.append(list); box.append(definitions);
    const evidence=node('details','technical-evidence'); evidence.append(node('summary',null,'Technical evidence & recording references'));
    evidence.append(node('p',null,(archived ? 'Archived' : 'Current comparison')+' · '+(comparison.scenario_id||'Scenario unavailable')+' · seed '+(comparison.seed??'—')),node('p',null,'Matching starting conditions: '+(comparison.initial_conditions_match ? 'Verified' : 'Not verified')));
    if(comparison.native_pose_audit)evidence.append(node('pre',null,JSON.stringify(comparison.native_pose_audit,null,2)));
    modes.forEach(mode=>{if(results[mode])evidence.append(node('p','recording-path',modeLabel(mode)+': '+results[mode].recording));});
    evidence.append(node('p','muted','Per-frame intervention traces are saved in telemetry/comparison-controls.jsonl beside each recording. Archived event playback is not provided by this dashboard API.')); box.append(evidence);
  }
  $('recordingArchive').replaceChildren(...(demo?.archive||[]).slice().reverse().map(item=>{
    const row=node('details','archive-row'); row.append(node('summary',null,modeLabel(item.mode)+' · '+String(item.status).replaceAll('_',' ').toLowerCase()),node('p',null,item.scenario_id+' · seed '+(item.seed??'—')),node('p','muted','Progress '+number(item.metrics?.progress_m,' m')+' · '+number(item.metrics?.elapsed_simulation_s,' s')),node('p','recording-path',item.recording)); return row;
  }));
  if(!(demo?.archive||[]).length)$('recordingArchive').append(node('p','muted','No archived recordings.'));
}
