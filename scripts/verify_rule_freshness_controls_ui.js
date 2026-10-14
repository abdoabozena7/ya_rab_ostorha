// Follow-up controls on the updated backend, after a recorded native arrival.
async (page) => {
  const samples=[];
  const state=async()=>await(await page.request.get('http://127.0.0.1:8000/api/simulation/state')).json();
  const wait=async(predicate,label)=>{
    const end=Date.now()+20000;
    while(Date.now()<end){const s=await state();if(predicate(s)){samples.push({label,mode:s.mode,vehicle:s.vehicle,journey:s.journey,latest:s.comparisonV2.latest_attempt,recording:s.recording});return s;}await page.waitForTimeout(150);}
    throw Error('Native control check failed: '+label);
  };
  const initial=await state();
  if(initial.comparisonV2.latest_attempt.status!=='ARRIVED'||initial.mode!=='PAUSED'||initial.recording)throw Error('Full journey must arrive before controls rehearsal');
  await page.getByRole('tab',{name:'Driving',exact:true}).click();
  await page.locator('#startDrivingBtn').click();
  await wait(s=>s.mode==='MANUAL','manual-start');
  await page.keyboard.down('w');
  try{await wait(s=>s.vehicle.speedKmh>1,'native-throttle');}finally{await page.keyboard.up('w');}
  await page.locator('#primaryDriveAction').click();
  await wait(s=>s.mode==='PAUSED'&&s.vehicle.speedKmh<.54,'manual-stop');
  await page.locator('#startDrivingBtn').click();
  await wait(s=>s.mode==='MANUAL','emergency-preparation');
  await page.locator('#emergencyStopBtn').click();
  await wait(s=>s.mode==='EMERGENCY_STOP','emergency-latch');
  await page.waitForTimeout(500);
  if(!(await page.locator('#ruleDrivingBtn').isDisabled()))throw Error('Emergency stop admitted RULE');
  await page.locator('#primaryDriveAction').click();
  await wait(s=>s.mode==='PAUSED','explicit-emergency-acknowledgement');
  const oldActor=(await state()).vehicle.actorId;
  await page.locator('#settingsBtn').click();
  await page.locator('#vehicleSettings>summary').click();
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('#resetBtn').click();
  await wait(s=>s.mode==='PAUSED'&&s.vehicle.actorId!==oldActor&&!s.recording,'native-reset');
  await page.locator('#closeSettingsBtn').click();
  const final=await state();
  if(final.safetySystem.controller!=='RULE'||!final.safetySystem.enabled)throw Error('Reset lost default RULE protection');
  const report={status:'PASS',transport:'actual application controls and native HTTP observations',samples};
  await page.evaluate(r=>window.__freshnessControlsReport=r,report);
  await page.screenshot({path:'output/playwright/rule-freshness-controls.png'});
  return {status:report.status,checks:samples.map(s=>s.label)};
}
