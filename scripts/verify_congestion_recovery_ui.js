// Read-only native audit: no lease, controls, route or population changes.
async (page) => {
  const errors=[],checks=[];
  page.on('pageerror',e=>errors.push(e.message));
  const check=(value,message)=>{if(!value)throw new Error(message);checks.push(message);};
  await page.setViewportSize({width:1720,height:914});
  await page.goto('http://127.0.0.1:8000/');
  await page.waitForFunction(()=>document.getElementById('cockpitConnectionText')?.textContent==='CARLA Connected');
  await page.waitForFunction(()=>document.getElementById('cockpitDriverText')?.textContent==='Vehicle held');
  await page.waitForFunction(()=>{const i=document.getElementById('authoritativeCamera');return i&&!i.hidden&&i.naturalWidth>0;});
  const before=await(await page.request.get('http://127.0.0.1:8000/api/simulation/state')).json();
  check(before.provider==='carla'&&before.connected,'Real native CARLA connection');
  check(before.mode==='PAUSED'&&before.vehicle.speedKmh<.1,'Restored vehicle remains stopped');
  check(before.vehicle.brake===1,'Held vehicle applies its real brake');
  check(before.safetySystem.status==='STANDBY','Fresh sensors clear the historical fault without resuming');
  check(!/RULE|MODEL|BC|HYBRID|TRAJECTRON/.test(await page.locator('#cockpitProtectionText').innerText()),'Cockpit status keeps controller internals out of the driver flow');
  check(!Object.keys(before.sensorRegistry).some(n=>['rearDepth','leftDepth','rightDepth'].includes(n)),'Experimental sensing load removed');
  await page.waitForFunction(async frame=>{const s=await(await fetch('/api/simulation/state')).json();return s.vehicle?.frame>frame+4;},before.vehicle.frame);
  const after=await(await page.request.get('http://127.0.0.1:8000/api/simulation/state')).json();
  check(after.mode==='PAUSED'&&after.vehicle.speedKmh<.1,'Camera and telemetry advance while the vehicle stays held');
  check(after.safetySystem.status==='STANDBY','Standby persists across fresh native frames');
  check(errors.length===0,'No browser runtime errors');
  await page.screenshot({path:'output/playwright/recovery-native-final.png'});
  return {passed:true,checks,errors,session:after.sessionId,frames:[before.vehicle.frame,after.vehicle.frame],
    mode:after.mode,safety:after.safetySystem.status,screenshot:'output/playwright/recovery-native-final.png',
    driving_acceptance:false};
}
