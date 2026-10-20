// Observe the real transport. No API/socket routes, state substitutions or input fabrication.
async page=>{
  await page.addInitScript(()=>{
    const key='crossing-native-browser-evidence';let prior;
    try{prior=JSON.parse(sessionStorage.getItem(key));}catch{}
    const evidence=prior||{scope:'ACTUAL_BROWSER_NATIVE_TRANSPORT',phases:[],commands:[],errors:[],samples:[],vehicles:[]};
    window.crossingNativeEvidence=evidence;
    const save=()=>sessionStorage.setItem(key,JSON.stringify(evidence));
    let snapshotSeen=false;evidence.dom_text_changes ||= [];
    window.addEventListener('DOMContentLoaded',()=>{
      let previous='';
      new MutationObserver(()=>{
        if(!snapshotSeen)return;
        const title=document.querySelector('#missionTitle')?.textContent||'';
        const detail=document.querySelector('#missionDetail')?.textContent||'';
        const phase=evidence.latest?.phase,arm=evidence.latest?.arm;
        const key=JSON.stringify([phase,arm,title,detail]);if(key===previous)return;previous=key;
        evidence.dom_text_changes.push({phase,arm,title,detail});save();
      }).observe(document.body,{childList:true,characterData:true,subtree:true});
    });
    const NativeSocket=window.WebSocket;
    window.WebSocket=class extends NativeSocket{
      constructor(...args){
        super(...args);
        this.addEventListener('message',event=>{
          let data;try{data=JSON.parse(event.data);}catch{return;}
          if(data.type==='error'){evidence.errors.push({source:'SERVER',message:data.error,sequence:data.sequence});save();return;}
          if(data.type!=='snapshot')return;
          snapshotSeen=true;
          const d=data.presentation||{},v=data.vehicle||{},w=data.world||{};
          if(v.actorId&&evidence.vehicles.at(-1)?.actor_id!==v.actorId){
            evidence.vehicles.push({actor_id:v.actorId,frame:v.frame,phase:d.status});save();
          }
          if(data.journeyComparison?.manifest?.blueprint)evidence.comparison_blueprint=data.journeyComparison.manifest.blueprint;
          const previous=evidence.latest;
          evidence.latest={session_id:data.sessionId,presentation_id:d.id,pair_id:data.journeyComparison?.pair_id,
            phase:d.status,arm:d.arm,automatic_pair:d.automatic_pair,connected:data.connected,
            journey_status:data.journey?.status,driving_mode:data.journey?.driving_mode,
            requested_speed_kmh:data.journey?.speed_kmh,simulator_stop:data.simulatorStop,
            frame:v.frame,timestamp_s:v.timestamp??w.timestamp,speed_kmh:v.speedKmh};
          if(['RESULTS','FINISHING','COMPLETE'].includes(d.status))evidence.comparison={pair_id:data.journeyComparison?.pair_id,
            validation:data.journeyComparison?.scenario_validation,runs:Object.fromEntries(Object.entries(data.journeyComparison?.runs||{}).map(([mode,run])=>
              [mode,{id:run.id,status:run.status,reason:run.reason,collisions:run.collisions,distance_m:run.distance_m,duration_s:run.duration_s}]))};
          const phase=[d.id,d.status,d.arm].join(':');
          if(evidence.phases.at(-1)?.key!==phase){evidence.phases.push({key:phase,...evidence.latest});save();}
          if(data.journey?.status==='RUNNING'&&Math.floor(v.timestamp)!==Math.floor(previous?.timestamp_s)){
            evidence.samples.push({mode:data.journey.driving_mode,timestamp_s:v.timestamp,speed_kmh:v.speedKmh});
          }
        });
      }
      send(raw){
        try{
          const value=JSON.parse(raw);
          if(value.type!=='journey_heartbeat'){
            evidence.commands.push({type:value.type,value:value.value,reason:value.reason,sequence:value.sequence,phase:evidence.latest?.phase});save();
          }
        }catch{}
        return super.send(raw);
      }
    };
    window.addEventListener('error',event=>{evidence.errors.push({source:'BROWSER',message:event.message});save();});
    window.addEventListener('unhandledrejection',event=>{evidence.errors.push({source:'PROMISE',message:String(event.reason)});save();});
    window.addEventListener('pagehide',save);
  });
  const current=new URL(page.url());
  const origin=current.protocol==='http:'?current.origin:'http://127.0.0.1:8000';
  await page.goto(origin+'/?verification=actual-crossing');
  return {installed:true,scope:'REAL_TRANSPORT_OBSERVER_NO_SUBSTITUTIONS'};
}
