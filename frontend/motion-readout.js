const num=(v,unit='',digits=1)=>Number.isFinite(v)?v.toFixed(digits)+unit:'—';
export function motionReadout(p,prediction,vehicle) {
  const m={...prediction?.surroundings,...p.maneuver},age=prediction?vehicle.timestamp-prediction.timestamp_s:null;
  const valid=!!prediction&&prediction.session_id===p.sessionId&&age>=0&&age<=.25;
  const conflict=m?.predicted_conflicts?.[0]||prediction?.conflict_point;
  const insufficient=['UNKNOWN_SPACE','STALE_OBSERVATION','SENSOR_UNAVAILABLE','INVALID_OBSERVATION'].includes(p.safetySystem?.risk);
  const deferred=prediction?.diagnostic_scoring_deferred||prediction?.display_observer_deferred;
  return {valid,state:!valid||insufficient||m?.action==='HOLD'?'Insufficient data':conflict?'Possible intersection':deferred?'Intersection scoring deferred':'No predicted intersection',
    action:p.stopDiagnostics?.braking?(p.stopDiagnostics.decision_source||'RULE')+' BRAKE':m?.action?.replaceAll('_',' ')||'HOLD',
    reason:p.stopDiagnostics?.braking?(p.stopDiagnostics.reason||'Protective brake'):m?.reason?.replaceAll('_',' ')||'Waiting for measured motion',
    values:[['Actual / target',num(vehicle.speedKmh)+' / '+num(m?.target_speed_kmh??p.journey?.speed_kmh)+' km/h'],
      ['Front / rear gap',num(m?.front_gap_m)+' / '+num(m?.rear_gap_m)+' m'],
      ['Front / rear TTC',num(m?.front_ttc_s)+' / '+num(m?.rear_ttc_s)+' s'],
      ['Acceleration',num(vehicle.accelerationMps2,' m/s²')],['Measurement age',num(age,' s',2)],
      ['Inference / planner',num(prediction?.inference_ms,'',0)+' / '+num(m?.planning_ms,'',1)+' ms']]};
}

export function objectReadout(track,prediction,maneuver,speed) {
  if(!track)return 'No measured object selected';
  const [x,y]=track.position_m,[vx,vy]=track.velocity_mps,r=Math.hypot(x,y);
  const moving=Math.hypot(vx,vy),closing=r>.01?-((vx-speed)*x+vy*y)/r:0;
  const c=maneuver?.predicted_conflicts?.find(c=>c.track_id===track.id);
  const assessment=maneuver?.object_assessments?.[track.id]||prediction?.object_assessments?.[track.id];
  const clearance=assessment?.minimum_clearance_m;
  const state=assessment?.status?.replaceAll('_',' ').toLowerCase()||'insufficient data';
  return `${track.class} #${track.id} · ${state} · speed ${num(moving*3.6,' km/h')} · movement ${moving<.3?'stationary':num(Math.atan2(vy,vx)*180/Math.PI,'° relative to ego')} · closing ${num(closing,' m/s')} · minimum clearance ${num(clearance,' m')} · intersection ${num(c?.time_s??assessment?.intersection_time_s,' s')} · gaze unknown`;
}

export function installMotionReadout(p,predictionView) {
  const host=document.createElement('section');host.id='motionReadout';host.setAttribute('aria-label','Motion and maneuver measurements');
  host.innerHTML='<div class="motion-decision"><strong id="motionState">Insufficient data</strong><span id="motionAction"></span></div><dl id="motionNumbers"></dl><details><summary>Objects, prediction quality & alternatives</summary><label for="motionObject">Measured object</label><select id="motionObject"></select><p id="motionObjectData"></p><table><caption>Forecast error against subsequent measured tracks</caption><thead><tr><th>Horizon</th><th>ADE</th><th>FDE</th><th>Inside bound</th><th>Samples</th></tr></thead><tbody id="motionScores"></tbody></table><p id="motionCoverage"></p><p id="motionRejected"></p></details>';
  document.querySelector('.visual-workspace').append(host);
  const $=id=>host.querySelector('#'+id);let signature='',lastUpdate='',lastTracks=[],trackSession=null;
  const text=(el,value)=>{if(el.textContent!==String(value))el.textContent=value;};
  const numbers=motionReadout(p,null,{}).values.map(([label])=>{const d=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;d.append(dt,dd);$('motionNumbers').append(d);return dd;});
  const scores=[1,2,3].map(()=>{const tr=document.createElement('tr'),cells=Array.from({length:5},()=>document.createElement('td'));tr.append(...cells);$('motionScores').append(tr);return cells;});
  return {update(vehicle){
    const prediction=predictionView.currentPrediction,m=p.maneuver,v=motionReadout(p,prediction,vehicle);
    const updateKey=[p.sessionId,vehicle.frame,prediction?.timestamp_s,m?.action,m?.reason,$('motionObject').value,p.motionQuality?.issued].join('|');
    if(updateKey===lastUpdate)return;lastUpdate=updateKey;
    text($('motionState'),v.state);$('motionState').dataset.tone=v.state==='Possible intersection'?'warning':'neutral';
    text($('motionAction'),v.action+' · '+v.reason+(m?.experimental?' · experimental':''));
    v.values.forEach(([,value],i)=>text(numbers[i],value));
    if(trackSession!==p.sessionId){trackSession=p.sessionId;lastTracks=[];}
    if(v.valid)lastTracks=prediction.tracks;
    const tracks=lastTracks,key=tracks.map(t=>t.id+':'+t.class).join();$('motionObject').disabled=!v.valid;
    if(key!==signature){signature=key;const selected=$('motionObject').value;$('motionObject').replaceChildren(...tracks.map(t=>{const o=document.createElement('option');o.value=t.id;o.textContent=t.class+' #'+t.id;return o;}));if(tracks.some(t=>t.id===selected))$('motionObject').value=selected;}
    text($('motionObjectData'),objectReadout(tracks.find(t=>t.id===$('motionObject').value),prediction,m,vehicle.speedMps)+(tracks.length&&!v.valid?' · stale measurement':''));
    const q=p.motionQuality;
    [1,2,3].forEach((h,i)=>{const s=q?.horizons?.[h];[h+' s',num(s?.ade_m,' m',2),num(s?.fde_m,' m',2),num(s?.within_threshold_percent,'%',0),s?.samples??'—'].forEach((value,j)=>text(scores[i][j],value));});
    $('motionCoverage').textContent=`Coverage ${num(q?.coverage_percent,'%')} · unobservable ${q?.unobservable_samples??'—'} · bounds 0.5 m person / 1 m other. These measure track consistency; independent accuracy is pending.`;
    $('motionRejected').textContent=(m?.rejected||[]).map(r=>r.action+': '+r.reason.replaceAll('_',' ')).join(' · ')||'No alternatives rejected';
  }};
}
