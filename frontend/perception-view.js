import {detectionFreshness} from './workspace-state.js';
import {projectPrediction} from './prediction-view.js';
const $=id=>document.getElementById(id);

export class PerceptionView {
  constructor(provider) {
    this.provider=provider;this.busy=false;this.token=null;this.url=null;this.nextAt=0;
    this.overlay=null;
  }
  async drawMotion(result) {
    if(this.overlay)this.overlay.hidden=true;
    const response=await fetch('/api/simulation/prediction?frame_id='+result.frame_id,{cache:'no-store',signal:AbortSignal.timeout(2000)});
    const value=await response.json(),prediction=value.prediction;
    if(!prediction||this.token!==result.image_token||prediction.session_id!==this.provider.sessionId||Math.abs(prediction.timestamp_s-result.timestamp_s)>1e-6)return;
    const pose=prediction.render_reference;
    if(!pose)return;
    // The policy camera is fixed front: use its calibration and this exact
    // image's ego pose. No current camera pose or current forecast is substituted.
    const camera=prediction.front_camera;
    if(!camera||camera.frame!==result.frame_id)return;
    const {width:iw,height:ih}=camera;
    if(!this.overlay){this.overlay=document.createElement('canvas');this.overlay.className='prediction-overlay';this.overlay.setAttribute('aria-hidden','true');
      const host=$('perceptionCamera').parentElement;host.style.position='relative';host.append(this.overlay);}
    const image=$('perceptionCamera'),bounds=image.getBoundingClientRect(),host=image.parentElement.getBoundingClientRect();
    const scale=Math.min(bounds.width/iw,bounds.height/ih),width=iw*scale,height=ih*scale;
    Object.assign(this.overlay.style,{left:bounds.left-host.left+(bounds.width-width)/2+'px',top:bounds.top-host.top+(bounds.height-height)/2+'px',width:width+'px',height:height+'px'});
    this.overlay.width=iw;this.overlay.height=ih;const c=this.overlay.getContext('2d');
    for(const mode of prediction.trajectories||[]){c.strokeStyle=mode.source.includes('TRAJECTRON')?'#a78bfa':'#67e8f9';c.lineWidth=mode.selected?2:1;c.setLineDash([5,4]);c.beginPath();let begun=false;
      for(const row of mode.points){const q=projectPrediction([row[1],row[2],.3],pose,camera);if(!q){begun=false;continue;}begun?c.lineTo(...q):c.moveTo(...q);begun=true;}c.stroke();}
    this.overlay.hidden=false;
  }
  metadata(result) {
    this.result=result;
    const age=detectionFreshness(result,this.provider.telemetry,this.provider.world.fixedDeltaSeconds);
    const uncertain=result.detections.filter(d=>d.classification_status==='UNCERTAIN').length;
    const counts=(result.detections.length-uncertain)+' supported · '+uncertain+' uncertain';
    $('perceptionStatus').textContent=counts+' · '+Math.round(result.inference_ms)+' ms inference';
    $('perceptionFreshness').textContent=age.label+(age.seconds===null ? '' : ' · '+age.seconds.toFixed(2)+' s · '+age.frames+' frames behind');
    $('perceptionFreshness').dataset.tone=age.tone;
    $('detectionSummary').textContent=age.tone==='warning' ? age.label+(age.seconds===null ? '' : ' · '+age.seconds.toFixed(2)+' s') : counts+' · '+age.seconds.toFixed(2)+' s behind';
    $('perceptionFreshness').title='Display delay notice starts at 0.5 simulation seconds. Inference is display only.';
    $('detectionSummary').dataset.tone=age.tone;
    $('perceptionFrame').textContent='Analyzed frame '+result.frame_id+' · t '+result.timestamp_s.toFixed(3)+' s · '+result.model+' · '+result.device;
  }
  clear(reason) {
    this.result=null;
    if(this.url) URL.revokeObjectURL(this.url);
    this.url=this.token=null;$('perceptionCamera').hidden=true;$('perceptionCamera').removeAttribute('src');
    if(this.overlay)this.overlay.hidden=true;
    $('perceptionEmpty').hidden=false;$('perceptionEmpty').textContent=reason;
    $('ocrTexts').replaceChildren();$('perceptionFrame').textContent='';
    $('perceptionFreshness').textContent='';$('perceptionFreshness').dataset.tone='neutral';
    $('detectionSummary').textContent=reason;$('detectionSummary').dataset.tone='neutral';
  }
  async update() {
    if(document.hidden||!$('modelVision').getClientRects().length)return;
    const p=this.provider;
    if(!p.fresh||p.isReplay) {
      $('perceptionStatus').textContent=p.isReplay?'REPLAY · Live inference stopped':'Inference stopped';
      this.clear(p.isReplay?'Live inference stopped during Replay.':'Waiting for connection CARLA.');return;
    }
    if(this.busy||performance.now()<this.nextAt)return;
    this.busy=true;this.nextAt=performance.now()+500;
    const session=p.sessionId;
    try {
      const response=await fetch('/api/simulation/perception?ocr=1',{cache:'no-store',signal:AbortSignal.timeout(3000)});
      if(!response.ok)throw new Error('Could not read inference worker');
      const result=await response.json();
      if(result.status!=='RUNNING') {
        const labels={DEMO_PAUSED:'Comparison demo · YOLO/OCR paused',LOADING:'Loading YOLO and OCR…',WAITING:'Waiting for a frame from this session',UNAVAILABLE:'Inference not installed',STALE:'Inference frame is stale',ERROR:'Inference failed',DISCONNECTED:'Inference stopped'};
        $('perceptionStatus').textContent=labels[result.status]||result.status;
        if(this.token&&this.imageSession===session&&performance.now()-this.imageAt<3000&&['WAITING','STALE','ERROR'].includes(result.status)){
          if(this.overlay)this.overlay.hidden=true;
          $('perceptionFreshness').textContent='Last analyzed frame · waiting for an update';
          $('perceptionFreshness').dataset.tone='warning';return;
        }
        this.clear(result.error||'Waiting for a native analyzed frame');return;
      }
      if(result.session_id!==session||!p.fresh||p.isReplay)return;
      if(result.image_token===this.token){this.metadata(result);return;}
      const image=await fetch('/api/simulation/perception.jpg?token='+encodeURIComponent(result.image_token),{cache:'no-store',signal:AbortSignal.timeout(3000)});
      if(!image.ok||image.headers.get('X-Perception-Token')!==result.image_token)return;
      const blob=await image.blob();
      if(p.sessionId!==session||!p.fresh||p.isReplay)return;
      // Decode before replacing the displayed frame or its matching metadata.
      const nextUrl=URL.createObjectURL(blob);
      try {const decoded=new Image();decoded.src=nextUrl;await decoded.decode();}
      catch(error){URL.revokeObjectURL(nextUrl);throw error;}
      if(p.sessionId!==session||!p.fresh||p.isReplay){URL.revokeObjectURL(nextUrl);return;}
      const previousUrl=this.url;this.url=nextUrl;this.token=result.image_token;
      this.imageSession=session;this.imageAt=performance.now();
      $('perceptionCamera').src=this.url;$('perceptionCamera').hidden=false;$('perceptionEmpty').hidden=true;
      this.metadata(result);
      this.drawMotion(result).catch(()=>{if(this.overlay)this.overlay.hidden=true;});
      if(previousUrl)URL.revokeObjectURL(previousUrl);
      const nlp=result.nlp;
      const rows=(nlp?.items||result.texts).map(item=>{const row=document.createElement('p');row.textContent=(item.raw_text||item.text)+' → '+(item.instruction||'TEXT')+(item.value?': '+item.value:'')+' ('+Math.round(item.confidence*100)+'%)'+(nlp?' · source frame '+nlp.frame_id:'');return row;});
      if(!rows.length){const empty=document.createElement('p');empty.textContent='No text recognized with sufficient confidence in this frame.';rows.push(empty);}
      $('ocrTexts').replaceChildren(...rows);
    } catch(error) { $('perceptionStatus').textContent='Inference unavailable';this.clear(error.message); }
    finally {this.busy=false;}
  }
}
