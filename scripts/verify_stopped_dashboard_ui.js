// Read-only check against the actual SDK-free stopped host.
async(page)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8000/');
  await page.waitForFunction(()=>document.getElementById('cityStatus')?.textContent==='CARLA — STOPPED');
  if(!(await page.locator('#stopSimulatorBtn').isDisabled()))throw new Error('Stopped action is not disabled');
  const before=await(await page.request.get('http://127.0.0.1:8000/api/simulation/state')).json();
  await page.waitForTimeout(2500);
  const after=await(await page.request.get('http://127.0.0.1:8000/api/simulation/state')).json();
  if(before.simulatorStop.status!=='STOPPED'||after.simulatorStop.status!=='STOPPED'||after.connected)throw new Error('Stopped host did not persist');
  await page.screenshot({path:'output/playwright/carla-stopped.png'});
  if(errors.length)throw new Error(JSON.stringify(errors));
  return {passed:true,http_alive:true,stopped_state_persisted:true,button_disabled:true,errors,native_mutations:0};
}
