// Isolated browser WebSocket fixture: never sends controls to CARLA.
async (page) => {
  const native=await (await page.request.get('http://127.0.0.1:8000/api/simulation/state')).json();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(state=>{
    state.type='snapshot';state.connected=true;state.controller=false;state.mode='PAUSED';state.error=null;
    state.comparisonDemo={phase:'IDLE',mode:null,results:{}};
    state.comparisonV2={phase:'IDLE',model_available:true,results:{},budget:{remaining_s:1000,recommended_run_allowance_s:600}};
    state.journey={status:'IDLE'};state.recording=false;state.restarting=false;
    window.__uiState=state;window.__uiCommands=[];
    window.WebSocket=class {
      readyState=1;
      constructor(){this.timer=setInterval(()=>{
        state.vehicle.frame++;state.vehicle.timestamp+=.05;state.world.frame=state.vehicle.frame;state.world.timestamp=state.vehicle.timestamp;
        this.onmessage?.({data:JSON.stringify(state)});
      },80);}
      send(json){const command=JSON.parse(json);window.__uiCommands.push(command);state.acknowledged=command.sequence;}
      close(){clearInterval(this.timer);this.readyState=3;}
    };
  },native);
  await page.route('**/api/simulation/perception',route=>route.fulfill({json:{status:'UNAVAILABLE'}}));
  await page.reload();await page.waitForFunction(()=>!document.getElementById('ruleDrivingBtn').disabled);
  await page.locator('#ruleDrivingBtn').click();
  await page.waitForFunction(()=>!document.getElementById('modelDrivingBtn').disabled);
  await page.locator('#modelDrivingBtn').click();
  const commands=await page.evaluate(()=>window.__uiCommands.filter(x=>x.type==='comparison_v2'));
  if(commands.length!==2||commands[0].value.side!=='RULE'||commands[1].value.side!=='MODEL'||commands.some(x=>x.value.operation!=='RUN'))throw Error('Two-button protocol mismatch');
  if(await page.evaluate(()=>window.__uiCommands.some(x=>x.type==='controls')))throw Error('Comparison click sent manual pedals');
  for(const [width,height] of [[1366,768],[900,900],[430,900]]) {
    await page.setViewportSize({width,height});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw Error('Horizontal overflow '+width);
    await page.screenshot({path:`output/playwright/predictive-${width}.png`});
  }
  await page.evaluate(()=>{window.__uiState.comparisonV2.phase='RUNNING';});
  await page.waitForFunction(()=>document.getElementById('ruleDrivingBtn').disabled&&document.getElementById('modelDrivingBtn').disabled);
  if(errors.length)throw Error(errors.join('\n'));
  return {protocol:commands.map(x=>x.value),viewports:[1366,900,430],pageErrors:errors};
}
