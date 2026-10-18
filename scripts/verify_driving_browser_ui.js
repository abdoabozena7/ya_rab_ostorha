async page=>{
  await page.evaluate(()=>{
    const evidence={source:'REAL_BROWSER_NATIVE_PRESENTATION',seed:2086914493,
      started_wall_ms:performance.now(),commands:[],errors:[],phases:[],camera_arms:{},long_tasks:[]};
    window.__drivingVerification=evidence;
    window.addEventListener('error',event=>evidence.errors.push({kind:'BROWSER',message:event.message}));
    window.addEventListener('unhandledrejection',event=>evidence.errors.push({kind:'PROMISE',message:String(event.reason)}));
    const original=WebSocket.prototype.send;
    WebSocket.prototype.send=function(payload){
      let value=JSON.parse(payload);
      if(value.type==='presentation'&&value.value?.operation==='RESTART'){
        value={...value,value:{...value.value,seed:evidence.seed}};payload=JSON.stringify(value);
      }
      if(!this.__verificationObserved){
        this.__verificationObserved=true;
        this.addEventListener('message',event=>{
          const state=JSON.parse(event.data);
          if(state.type==='error')evidence.errors.push({kind:'SERVER',message:state.error});
          if(state.type!=='snapshot')return;
          const phase=state.presentation?.status+':'+state.presentation?.arm;
          if(phase!==evidence.phases.at(-1)?.phase)evidence.phases.push({phase,wall_ms:performance.now(),
            presentation_id:state.presentation?.id,pair_id:state.journeyComparison?.pair_id});
          evidence.latest={connected:state.connected,mode:state.mode,presentation_id:state.presentation?.id,
            phase:state.presentation?.status,pair_id:state.journeyComparison?.pair_id,
            journey_status:state.journey?.status,controller:state.controller};
        });
      }
      if(value.type!=='journey_heartbeat')evidence.commands.push({type:value.type,value:value.value,wall_ms:performance.now()});
      return original.call(this,payload);
    };
    if(PerformanceObserver.supportedEntryTypes.includes('longtask')){
      new PerformanceObserver(list=>{
        for(const entry of list.getEntries())evidence.long_tasks.push({wall_ms:entry.startTime,duration_ms:entry.duration});
      }).observe({type:'longtask'});
    }
    setInterval(()=>{
      const data=document.getElementById('authoritativeCamera').dataset.performance;
      if(data){const value=JSON.parse(data);if(value.arm)evidence.camera_arms[value.arm]=value;}
      evidence.videos=[...document.querySelectorAll('#presentationResults video')].map(video=>({source:video.currentSrc,
        time_s:video.currentTime,duration_s:Number.isFinite(video.duration)?video.duration:null,ended:video.ended,
        paused:video.paused,total_frames:video.getVideoPlaybackQuality().totalVideoFrames,
        dropped_frames:video.getVideoPlaybackQuality().droppedVideoFrames}));
    },500);
  });
  return {instrumented:true,seed:2086914493,synthetic_telemetry:false,control_owner:'REAL_DASHBOARD',
    qualification:'Only the supported seed field is supplied on Restart; actual outcomes, media and telemetry are unmodified.'};
}
