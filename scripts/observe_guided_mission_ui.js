async page=>{
  await page.evaluate(()=>{
    const evidence=window.guidedNative={source:'LIVE_NATIVE_CARLA_BROWSER',commands:[],phases:[],errors:[],latest:null};
    const original=WebSocket.prototype.send;
    WebSocket.prototype.send=function(payload){
      let command=JSON.parse(payload);
      if(command.type==='presentation'&&command.value?.operation==='START_GUIDED'){
        command.value.seed=2086914493;payload=JSON.stringify(command);
      }
      if(!this.guidedObserved){this.guidedObserved=true;this.addEventListener('message',event=>{
        const s=JSON.parse(event.data);if(s.type==='error'){evidence.errors.push(s.error);return;}if(s.type!=='snapshot')return;
        const d=s.presentation||{},phase=d.id+':'+d.status+':'+d.arm;
        if(phase!==evidence.phases.at(-1)?.phase)evidence.phases.push({phase,wall_ms:performance.now(),reason:d.reason});
        evidence.latest={connected:s.connected,session:s.sessionId,mode:s.mode,presentation:d,comparison:s.journeyComparison,
          recordingStatus:s.recordingStatus,vehicle:{speedMps:s.vehicle?.speedMps,frame:s.vehicle?.frame},simulatorStop:s.simulatorStop,simulatorStart:s.simulatorStart};
      });}
      if(!['controls','journey_heartbeat'].includes(command.type))evidence.commands.push(command);
      return original.call(this,payload);
    };
  });return {installed:true};
}
