import {drawSceneOverlays} from './scene-overlays.js';
// Pure geometry helpers also used by frame/session/camera regression tests.
function matrix(pose) {
  const {roll:r=0,pitch:p=0,yaw:y=0}=pose.rotation_rad||{};
  const cr=Math.cos(r),sr=Math.sin(r),cp=Math.cos(p),sp=Math.sin(p),cy=Math.cos(y),sy=Math.sin(y);
  return [[cp*cy,cy*sp*sr-sy*cr,-cy*sp*cr-sy*sr],
    [cp*sy,sy*sp*sr+cy*cr,-sy*sp*cr+cy*sr],[sp,-cp*sr,cp*cr]];
}
const multiply=(m,v)=>m.map(row=>row.reduce((a,x,i)=>a+x*v[i],0));
export function predictionWorldPoint(point,reference) {
  if(!reference?.position_m)return null;
  return multiply(matrix(reference),[point[0],point[1],point[2]??0]).map((x,i)=>x+reference.position_m[i]);
}
export function projectPrediction(point,reference,camera) {
  if(!reference?.position_m||!camera?.worldTransform?.position_m||!camera.width||!camera.height||!camera.fovDeg)return null;
  const world=predictionWorldPoint([point[0],point[1],point[2]??1],reference);
  const delta=world.map((x,i)=>x-camera.worldTransform.position_m[i]);
  const cm=matrix(camera.worldTransform),local=multiply(cm[0].map((_,i)=>cm.map(row=>row[i])),delta);
  if(local[0]<=.05)return null;
  const f=camera.width/(2*Math.tan(camera.fovDeg*Math.PI/360));
  return [(camera.width-1)/2+f*local[1]/local[0],(camera.height-1)/2-f*local[2]/local[0]];
}
export function predictionMatches(prediction,session,camera) {
  return !!prediction&&prediction.session_id===session&&prediction.coordinate_frame==='EGO_AT_EVALUATION'&&
    Number.isFinite(camera?.timestamp)&&Math.abs(prediction.timestamp_s-camera.timestamp)<=1e-6&&
    (!Number.isFinite(camera.frame)||prediction.evaluation_frame===camera.frame);
}
export function measuredPredictionFresh(prediction,session,timestamp) {
  const age=timestamp-prediction?.timestamp_s;
  return !!prediction&&prediction.session_id===session&&Number.isFinite(age)&&age>=0&&age<=.75;
}
export function forecastCanProject(prediction,session,camera) {
  return measuredPredictionFresh(prediction,session,camera?.timestamp)&&
    prediction.coordinate_frame==='EGO_AT_EVALUATION'&&!!prediction.render_reference?.position_m&&
    !!camera?.worldTransform?.position_m&&Number.isFinite(camera.frame)&&
    Number.isFinite(prediction.evaluation_frame)&&prediction.evaluation_frame<=camera.frame;
}
// Evaluation decision-layer readout. Only measured/calibrated values that the
// supervisor actually published are shown; absent values are omitted.
export function decisionSummary(safety) {
  const decision=safety?.evidence_decision;
  if(!safety?.decision_layer||!decision)return '';
  const parts=[decision.layer==='LEARNED_RISK_CAUTION_V1'?'Learned-risk caution':'Evidence budget',
    String(decision.response||'unknown').replaceAll('_',' ').toLowerCase()];
  if(Number.isFinite(decision.target_speed_mps))parts.push(`limit ${(decision.target_speed_mps*3.6).toFixed(0)} km/h`);
  const people=decision.people||[];
  const risk=people.map(person=>person.risk_3s).filter(Number.isFinite);
  if(risk.length&&decision.risk_status?.status==='READY')
    parts.push(`crossing risk within 3 s ${Math.round(Math.max(...risk)*100)}%${decision.risk_status.experimental?' (experimental model)':''}`);
  const uncertainty=people.map(person=>person.uncertainty_m).filter(Number.isFinite);
  if(uncertainty.length)parts.push(`tracking ±${Math.max(...uncertainty).toFixed(2)} m`);
  if(decision.reason)parts.push(decision.reason);
  return parts.join(' · ');
}
export function remainingForecast(points,age) {
  if(!points?.length||!Number.isFinite(age)||age<0||age>points.at(-1)[0])return [];
  const next=points.findIndex(row=>row[0]>=age);
  if(next<0)return [];
  if(next===0||points[next][0]===age)return points.slice(next);
  const a=points[next-1],b=points[next],f=(age-a[0])/(b[0]-a[0]);
  return [[age,a[1]+f*(b[1]-a[1]),a[2]+f*(b[2]-a[2])],...points.slice(next)];
}
export const visibleModes=prediction=>{
  const confirmed=new Set(prediction.tracks.filter(t=>t.confirmed).map(t=>t.id)),counts=new Map();
  const tracks=new Map(prediction.tracks.map(t=>[t.id,t]));
  return [...(prediction.trajectories||[])].sort((a,b)=>{
    const rank=id=>{const t=tracks.get(id);return t?.class==='person'&&t.semantic_evidence?-1:Math.hypot(...(t?.position_m||[Infinity]));};
    return rank(a.track_id)-rank(b.track_id);
  }).filter(mode=>{
    const n=counts.get(mode.track_id)||0;if(!confirmed.has(mode.track_id)||n>=3)return false;
    counts.set(mode.track_id,n+1);return true;
  });
};

export class PredictionView {
  constructor(provider) {
    this.provider=provider;
    this.observed=null;this.nextAt=0;this.busy=false;this.message='Waiting for measured tracks…';
    this.imagePrediction=null;this.imageRequest=null;this.imageBusy=false;
    const host=document.getElementById('frontCameraView');host.style.position='relative';
    this.canvas=document.createElement('canvas');this.canvas.className='prediction-overlay';this.canvas.setAttribute('aria-hidden','true');
    this.map=document.createElement('canvas');this.map.className='prediction-surroundings';this.map.width=180;this.map.height=180;
    this.map.setAttribute('aria-label','Measured surroundings including outside the camera view');
    this.drawMap(null);
    this.label=document.createElement('p');this.label.className='prediction-label';this.label.setAttribute('role','status');
    host.append(this.canvas,this.map,this.label);
    this.diagnostic=document.createElement('p');this.diagnostic.className='prediction-diagnostic';
    document.getElementById('liveOperationStatus').append(this.diagnostic);
  }
  async pollFrame(camera) {
    const p=this.provider,key=p.sessionId+':'+camera?.frame;
    if(!p.fresh||p.isReplay||!Number.isFinite(camera?.frame)||this.imageBusy||this.imageRequest===key)return;
    this.imageRequest=key;this.imageBusy=true;const session=p.sessionId;
    try {
      const response=await fetch('/api/simulation/prediction?frame_id='+camera.frame,{cache:'no-store',signal:AbortSignal.timeout(1500)});
      const value=await response.json();
      if(p.sessionId===session)this.imagePrediction=value.status==='RUNNING'?value.prediction:null;
    } catch {this.imagePrediction=null;}
    finally {this.imageBusy=false;}
  }
  async poll() {
    if(document.hidden)return;
    const p=this.provider;
    if(!p.fresh||p.isReplay){this.observed=null;return;}
    if(this.busy||performance.now()<this.nextAt)return;
    this.busy=true;this.nextAt=performance.now()+300;
    const session=p.sessionId;
    try {
      const response=await fetch('/api/simulation/prediction',{cache:'no-store',signal:AbortSignal.timeout(2000)});
      if(!response.ok)throw new Error('Prediction observer unavailable');
      const result=await response.json();
      if(p.sessionId!==session||!p.fresh)return;
      this.observed=result.status==='RUNNING'&&result.prediction?.session_id===session?result.prediction:null;
      if(!this.observed)this.message=result.error||'Waiting for measured tracks…';
    } catch(error){this.observed=null;this.message=error.message;}
    finally{this.busy=false;}
  }
  draw(camera) {
    if(this.provider.journey?.driving_mode==='NORMAL'&&this.provider.journey?.status==='RUNNING'){
      this.canvas.hidden=true;this.label.hidden=true;this.map.hidden=true;this.diagnostic.textContent='';
      this.observed=null;this.imagePrediction=null;this.currentPrediction=null;return;
    }
    const main=document.body.classList.contains('sequential-drive')&&!document.querySelector('#cockpitDetails[open]')&&
      !document.querySelector('#unifiedMap.map-expanded');
    const guidedForecast=main&&this.provider.journey?.driving_mode==='ROBOSPHERE'&&this.provider.journey?.status==='RUNNING';
    if(main&&!guidedForecast){
      this.canvas.hidden=true;this.label.hidden=true;
      this.map.hidden=true;
      this.currentPrediction=this.provider.safetySystem?.prediction||null;return;
    }
    if(!guidedForecast){this.poll();this.pollFrame(camera);}
    const p=this.provider, latest=guidedForecast?p.drivingForecast:p.safetySystem?.prediction||this.observed, img=document.getElementById('authoritativeCamera');
    const applied=latest?.applied_decision_prediction;
    const appliedFresh=applied&&measuredPredictionFresh(applied,p.sessionId,p.telemetry?.timestamp??camera?.timestamp);
    const principal=appliedFresh?applied:latest;
    this.currentPrediction=principal;
    // The measured map has its own timestamp. Its layout must not depend on
    // whether this particular RGB frame has an exactly aligned overlay.
    const measured=(p.fresh||p.isReplay)&&measuredPredictionFresh(principal,p.sessionId,p.telemetry?.timestamp??camera?.timestamp)?principal:null;
    this.map.hidden=main;
    const mapKey=[p.sessionId,measured?.timestamp_s,measured?.display_source].join(':');
    if(mapKey!==this.mapKey){this.mapKey=mapKey;this.drawMap(measured);}
    this.label.hidden=!measured||img.hidden;
    if(measured){
      const age=Math.max(0,(p.telemetry?.timestamp??camera.timestamp)-measured.timestamp_s);
      this.message=`${measured.display_source||measured.decision_source} · ${measured.tracks.filter(t=>t.confirmed).length} confirmed tracks · measurement age ${age.toFixed(1)} s. ${measured.model_reason||''}`;
      const conflict=measured.conflict_point;
      const context=appliedFresh?'Applied decision forecast':'Display forecast';
      const supplementary=latest?.supplementary_model_candidates?.length??0;
      this.label.textContent=guidedForecast?(latest.trajectories?.length?'Selected risk forecast · may change':'No risk forecast selected'):(conflict?`${context} · overlap in ${conflict.time_s.toFixed(1)} s`:context)+
        (supplementary?` · ${supplementary} supplementary model candidates`:'');
      this.label.dataset.tone=conflict?'amber':'neutral';
      if(guidedForecast&&latest.visual_version===1)this.label.textContent=`Measured 3D view · ${latest.trajectories?.length||0} possible conflicts`;
    } else this.message=p.fresh?'Waiting for fresh measured motion…':'Motion observations unavailable';
    // Reproject a recent forecast from its measured ego pose into the current
    // camera. Crop elapsed trajectory time; never draw the old object position
    // as though it were a detection in this image. Control age gates are separate.
    const prediction=guidedForecast?latest:predictionMatches(latest,p.sessionId,camera)?latest:this.imagePrediction;
    const ok=(p.fresh||p.isReplay)&&!img.hidden&&(guidedForecast?
      forecastCanProject(prediction,p.sessionId,camera):predictionMatches(prediction,p.sessionId,camera));
    this.canvas.hidden=!ok;
    if(guidedForecast)this.label.hidden=!ok;
    const diagnostic=p.stopDiagnostics;
    this.diagnostic.textContent=[diagnostic?.braking?`${diagnostic.decision_source} · ${diagnostic.reason||'Brake applied'} · sensor age ${(diagnostic.sensor_wall_age_s??0).toFixed(2)} s`:'',
      decisionSummary(p.safetySystem)].filter(Boolean).join(' · ');
    if(!ok)return;
    const bounds=img.getBoundingClientRect(),host=img.parentElement.getBoundingClientRect();
    const scale=Math.min(bounds.width/camera.width,bounds.height/camera.height);
    const width=camera.width*scale,height=camera.height*scale;
    Object.assign(this.canvas.style,{left:bounds.left-host.left+(bounds.width-width)/2+'px',top:bounds.top-host.top+(bounds.height-height)/2+'px',width:width+'px',height:height+'px'});
    if(this.canvas.width!==camera.width||this.canvas.height!==camera.height){this.canvas.width=camera.width;this.canvas.height=camera.height;}
    const ctx=this.canvas.getContext('2d'), conflict=prediction.conflict_point;
    ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
    const red=['STOPPING','BRAKING'].includes(p.safetySystem?.status),color=red?'#D9254F':'#81551B';
    const project=point=>projectPrediction(point,prediction.render_reference,camera);
    // Show ordinary, non-conflicting hypotheses too. Keep modes separate and
    // bound visual density; never invent class boxes for unclassified LiDAR.
    const visible=guidedForecast?(prediction.trajectories||[]).slice(0,1):
      (this.visualOptions?.trajectories===false?[]:visibleModes(prediction)).slice(0,18);
    const age=guidedForecast?Math.max(0,camera.timestamp-prediction.timestamp_s):0;
    const classes=new Map(prediction.tracks.filter(t=>t.semantic_evidence).map(t=>[t.id,t.class]));
    const sceneGeometry=guidedForecast&&prediction.visual_version===1;
    if(sceneGeometry)drawSceneOverlays(ctx,prediction,camera);
    ctx.lineWidth=2;ctx.setLineDash([6,5]);
    for(const mode of sceneGeometry?[]:visible){
      ctx.strokeStyle=classes.get(mode.track_id)==='person'?'#FFB7B2':String(mode.source).includes('TRAJECTRON')?'#b6a6d8':'#83d9df';ctx.beginPath();let begun=false;
      for(const row of remainingForecast(mode.points,age)){const q=project([row[1],row[2],.3]);if(!q){begun=false;continue;}begun?ctx.lineTo(...q):ctx.moveTo(...q);begun=true;}ctx.stroke();
    }
    ctx.setLineDash([]);
    const maneuver=guidedForecast?{selected_path:prediction.selected_path,render_reference:prediction.selected_path_reference,timestamp_s:prediction.selected_path_timestamp_s??prediction.timestamp_s}:p.maneuver;
    const pathAge=camera.timestamp-maneuver?.timestamp_s;
    if(this.visualOptions?.trajectories!==false&&maneuver?.selected_path&&pathAge>=0&&pathAge<=.1+1e-6&&maneuver.render_reference){
      ctx.strokeStyle='#00BA69';ctx.lineWidth=3;ctx.beginPath();let begun=false;
      for(const row of remainingForecast(maneuver.selected_path,pathAge)){const q=projectPrediction([row[1],row[2],.15],maneuver.render_reference,camera);if(!q){begun=false;continue;}begun?ctx.lineTo(...q):ctx.moveTo(...q);begun=true;}ctx.stroke();
    }
    if(conflict&&!guidedForecast&&this.visualOptions?.safety!==false) {
      // Only the selected actual hypothesis; never average incompatible modes.
      ctx.strokeStyle=color;ctx.lineWidth=3;ctx.setLineDash([7,5]);ctx.beginPath();let begun=false;
      for(const row of remainingForecast(conflict.trajectory,age)) {const q=project([row[1],row[2],.3]);if(!q){begun=false;continue;}if(begun)ctx.lineTo(...q);else ctx.moveTo(...q);begun=true;}
      ctx.stroke();ctx.setLineDash([]);
      // A forecast conflict point is not a detected object's 3D bounding box.
      // Mark the supplied point without inventing an object's height or corners.
      const point=project([conflict.point_m[0],conflict.point_m[1],.1]);
      if(point){ctx.strokeStyle=color;ctx.beginPath();ctx.arc(...point,6,0,Math.PI*2);ctx.stroke();}
    }
  }
  drawMap(prediction) {
    const m=this.map.getContext('2d');m.clearRect(0,0,180,180);m.fillStyle='rgba(15,23,42,.88)';m.fillRect(0,0,180,180);
    if(!prediction){m.fillStyle='#cbd5e1';m.font='11px sans-serif';m.fillText('Waiting for motion',24,94);return;}
    const conflict=prediction.conflict_point,color='#f59e0b',visible=visibleModes(prediction);
    const mapPoint=point=>[90+point[1]*3,120-point[0]*3];
    m.strokeStyle='#ffffff24';m.beginPath();m.moveTo(90,0);m.lineTo(90,180);m.moveTo(0,120);m.lineTo(180,120);m.stroke();
    m.fillStyle='#e2e8f0';m.fillRect(86.5,112.5,7,15);
    for(const mode of visible){m.strokeStyle=mode.source.includes('TRAJECTRON')?'#a78bfa99':'#67e8f999';m.setLineDash([3,3]);m.beginPath();mode.points.forEach((row,i)=>{const q=mapPoint([row[1],row[2]]);i?m.lineTo(...q):m.moveTo(...q);});m.stroke();}m.setLineDash([]);
    for(const tr of prediction.tracks) {
      const q=mapPoint(tr.position_m),classified=tr.confirmed&&!!tr.semantic_evidence&&tr.class!=='UNKNOWN';
      m.fillStyle=tr.id===conflict?.track_id?color:classified?'#67e8f9':'#94a3b8';m.strokeStyle=m.fillStyle;
      m.beginPath();m.arc(...q,classified&&tr.class==='person'?3:4,0,Math.PI*2);classified?m.fill():m.stroke();
    }
    if(conflict){m.strokeStyle=color;m.beginPath();conflict.trajectory.forEach((row,i)=>{const q=mapPoint([row[1],row[2]]);i?m.lineTo(...q):m.moveTo(...q);});m.stroke();}
    m.fillStyle='#f8fafc';m.font='10px sans-serif';m.fillText('Measured · 30 m',8,16);
    m.fillText('Hollow = unclassified surface',8,173);
  }
}
