// Verify both interfaces and visible retryable errors without launching CARLA.
async(page)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let count=0,release;
  await page.route('**/api/simulation/start',async route=>{
    count++;
    if(count===1)await new Promise(resolve=>release=resolve);
    await route.fulfill({status:503,json:{error:'Test launch failed; retry available'}});
  });
  await page.goto('http://127.0.0.1:8000/?mode=advanced&rehearsal=1');
  await page.waitForFunction(()=>document.getElementById('primaryDriveAction').textContent==='Start the simulation');
  if(await page.locator('#reconnectBtn,#nativeReconnectBtn').count())throw new Error('Separate connection buttons remain');
  await page.locator('#primaryDriveAction').click();
  await page.waitForFunction(()=>document.getElementById('primaryDriveAction').textContent==='Starting the simulation…');
  if(!(await page.locator('#primaryDriveAction').isDisabled()))throw new Error('Starting action remains enabled');
  release();
  await page.waitForFunction(()=>document.getElementById('primaryActionHint').textContent.includes('Test launch failed'));
  if(await page.locator('#primaryDriveAction').isDisabled())throw new Error('Retry remains disabled');
  await page.locator('#interfaceMode').click();
  await page.waitForFunction(()=>document.getElementById('guidedPrimary').textContent==='Start the simulation');
  await page.locator('#guidedPrimary').click();
  await page.waitForFunction(()=>document.getElementById('guidedStatus').textContent.includes('Test launch failed'));
  if(count!==2||errors.length)throw new Error(JSON.stringify({count,errors}));
  return {passed:true,advanced_and_guided:true,pending_disabled:true,failure_visible:true,retry_enabled:true,native_starts:0,errors};
}
