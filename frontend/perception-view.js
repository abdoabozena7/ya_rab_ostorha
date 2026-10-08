const $=id=>document.getElementById(id);

export class PerceptionView {
  constructor(provider) { this.provider=provider;this.busy=false;this.token=null;this.url=null;this.nextAt=0; }
  metadata(result) {
    $('perceptionStatus').textContent='YOLOv8n + OCR · '+result.device+' · '+Math.round(result.inference_ms)+' ms';
    $('perceptionFrame').textContent='Frame '+result.frame_id+' · t '+result.timestamp_s.toFixed(3)+' · '+
      result.detections.length+' أجسام · أقدم بـ '+Math.max(0,this.provider.telemetry.frame-result.frame_id)+' فريم';
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
      $('perceptionStatus').textContent=p.isReplay?'REPLAY · الكشف الحي متوقف':'الكشف متوقف';
      this.clear(p.isReplay?'الكشف الحي متوقف أثناء Replay.':'بانتظار اتصال CARLA.');return;
    }
    if(this.busy||performance.now()<this.nextAt)return;
    this.busy=true;this.nextAt=performance.now()+500;
    const session=p.sessionId;
    try {
      const response=await fetch('/api/simulation/perception',{cache:'no-store',signal:AbortSignal.timeout(3000)});
      if(!response.ok)throw new Error('تعذر قراءة عامل الكشف');
      const result=await response.json();
      if(result.status!=='RUNNING') {
        const labels={LOADING:'تحميل YOLO وOCR…',WAITING:'بانتظار فريم من الجلسة الحالية',UNAVAILABLE:'الكشف غير مثبت',STALE:'فريم الكشف قديم',ERROR:'تعذر الكشف',DISCONNECTED:'الكشف متوقف'};
        $('perceptionStatus').textContent=labels[result.status]||result.status;
        this.clear(result.error||'بانتظار فريم محلل حقيقي');return;
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
      const rows=result.texts.map(item=>{const row=document.createElement('p');row.textContent=item.text+' ('+Math.round(item.confidence*100)+'%)';return row;});
      if(!rows.length){const empty=document.createElement('p');empty.textContent='لم يُقرأ نص بثقة كافية في هذا الفريم.';rows.push(empty);}
      $('ocrTexts').replaceChildren(...rows);
    } catch(error) { $('perceptionStatus').textContent='الكشف غير متاح';this.clear(error.message); }
    finally {this.busy=false;}
  }
}
