// Explicitly limited native UI validation: live images and camera settings.
// This does not start a drive, shut down CARLA, or change the safety policy.
async (page) => {
  const errors=[],checks=[];
  page.on('pageerror',error=>errors.push(error.message));
  const check=(value,message)=>{if(!value)throw new Error(message);checks.push(message);};
  await page.setViewportSize({width:1720,height:914});await page.goto('http://127.0.0.1:8000/');
  await page.waitForFunction(()=>document.getElementById('cockpitConnectionText')?.textContent==='CARLA Connected');
  await page.waitForFunction(()=>getComputedStyle(document.getElementById('cameraCard')).display==='grid');
  await page.waitForFunction(()=>{const image=document.getElementById('authoritativeCamera');return image&&!image.hidden&&image.naturalWidth>0;});
  const before=await(await page.request.get('http://127.0.0.1:8000/api/simulation/state')).json();
  check(before.provider==='carla'&&before.connected,'Native CARLA connected');
  check(before.mode==='PAUSED'&&before.vehicle.speedKmh===0,'Native validation begins with vehicle held');
  const catalog=await(await page.request.get('http://127.0.0.1:8000/api/simulation/catalog')).json();
  const originalView=catalog.settings.camera_view;
  const nextView=originalView==='hood'?'chase':'hood';
  const selector=page.locator('#cockpitCameraView');await selector.waitFor({state:'visible'});
  if(await selector.isDisabled()){
    await page.locator('#scenariosNav').click();
    await page.waitForFunction(()=>document.getElementById('guidedPrimary').textContent==='Take Vehicle Control');
    await page.locator('#guidedPrimary').click();await page.waitForFunction(()=>!document.getElementById('cockpitCameraView').disabled);
    await page.locator('[aria-label="Close scenarios"]').click();
  }
  await page.waitForFunction(()=>!document.getElementById('cockpitCameraView').disabled);
  await selector.selectOption(nextView);
  await page.waitForFunction(view=>document.getElementById('cockpitCameraView').value===view&&!document.getElementById('cockpitCameraView').disabled,nextView);
  const changed=await(await page.request.get('http://127.0.0.1:8000/api/simulation/catalog')).json();
  check(changed.settings.camera_view===nextView,'Native camera switch confirmed by catalog');
  await selector.selectOption(originalView);
  await page.waitForFunction(view=>document.getElementById('cockpitCameraView').value===view&&!document.getElementById('cockpitCameraView').disabled,originalView);
  const after=await(await page.request.get('http://127.0.0.1:8000/api/simulation/state')).json();
  check(after.vehicle.frame>before.vehicle.frame,'Live native frame advances');
  check(after.mode==='PAUSED'&&after.vehicle.speedKmh===0,'Vehicle remains held after switching');
  check(after.safetySystem.controller==='RULE','RULE remains the native safety mode');
  check(await page.evaluate(()=>getComputedStyle(document.getElementById('authoritativeCamera')).objectFit==='contain'),'Source camera aspect ratio preserved');
  await page.screenshot({path:'output/playwright/pastel-desktop-native-final.png'});
  check(errors.length===0,'No native browser runtime errors');
  return {passed:true,checks,errors,session:after.sessionId,frames:[before.vehicle.frame,after.vehicle.frame],cameraViews:[originalView,nextView,originalView],mode:after.mode,native_scope:'Live feed, telemetry, map, camera setting and restoration. No journey or safety-driving validation.'};
}
