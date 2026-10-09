const $=id=>document.getElementById(id);

export class PerceptionView {
  constructor(provider) { this.provider=provider;this.busy=false;this.token=null;this.url=null;this.nextAt=0; }
  metadata(result) {
    $('perceptionStatus').textContent='Nano ONNX 320 + English OCR · '+result.device+' · '+Math.round(result.inference_ms)+' ms';
    $('perceptionFrame').textContent='Frame '+result.frame_id+' · t '+result.timestamp_s.toFixed(3)+' · '+
      result.detections.length+' objects · older by '+Math.max(0,this.provider.telemetry.frame-result.frame_id)+' frame';
  }
  clear(reason) {
    if(this.url) URL.revokeObjectURL(this.url);
    this.url=this.token=null;$('perceptionCamera').hidden=true;$('perceptionCamera').removeAttribute('src');
    $('perceptionEmpty').hidden=false;$('perceptionEmpty').textContent=reason;
    $('ocrTexts').replaceChildren();$('perceptionFrame').textContent='';
  }
  async update() {
    const p=this.provider;
    if(!p.fresh||p.isReplay) {
      $('perceptionStatus').textContent=p.isReplay?'REPLAY · Live inference stopped':'Inference stopped';
      this.clear(p.isReplay?'Live inference stopped during Replay.':'Waiting for connection CARLA.');return;
    }
    if(this.busy||performance.now()<this.nextAt)return;
    this.busy=true;this.nextAt=performance.now()+500;
    const session=p.sessionId;
    try {
      const response=await fetch('/api/simulation/perception',{cache:'no-store',signal:AbortSignal.timeout(3000)});
      if(!response.ok)throw new Error('Could not read inference worker');
      const result=await response.json();
      if(result.status!=='RUNNING') {
        const labels={DEMO_PAUSED:'Comparison demo · YOLO/OCR paused',LOADING:'Loading YOLO and OCR…',WAITING:'Waiting for a frame from this session',UNAVAILABLE:'Inference not installed',STALE:'Inference frame is stale',ERROR:'Inference failed',DISCONNECTED:'Inference stopped'};
        $('perceptionStatus').textContent=labels[result.status]||result.status;
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
      $('perceptionCamera').src=this.url;$('perceptionCamera').hidden=false;$('perceptionEmpty').hidden=true;
      this.metadata(result);
      if(previousUrl)URL.revokeObjectURL(previousUrl);
      const nlp=result.nlp;
      const rows=(nlp?.items||result.texts).map(item=>{const row=document.createElement('p');row.textContent=(item.raw_text||item.text)+' → '+(item.instruction||'TEXT')+(item.value?': '+item.value:'')+' ('+Math.round(item.confidence*100)+'%)'+(nlp?' · source frame '+nlp.frame_id:'');return row;});
      if(!rows.length){const empty=document.createElement('p');empty.textContent='No text recognized with sufficient confidence in this frame.';rows.push(empty);}
      $('ocrTexts').replaceChildren(...rows);
    } catch(error) { $('perceptionStatus').textContent='Inference unavailable';this.clear(error.message); }
    finally {this.busy=false;}
  }
}
