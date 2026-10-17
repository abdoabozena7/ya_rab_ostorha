// Inspect the retained native failure. Never start/retry/replace a drive.
async (page)=>{
  const checks=[];const check=(value,label)=>{if(!value)throw new Error(label);checks.push(label);};
  const response=await page.request.get('http://127.0.0.1:8000/api/simulation/state');
  const state=await response.json();
  check(state.connected&&state.mode==='PAUSED','Native vehicle is connected and held');
  check(state.presentation?.status==='ERROR','Failed dense attempt remains a failure');
  check(state.stopDiagnostics?.runtime_fault?.exception_type==='ControlSceneTimeout','Original native exception remains available');
  check(!state.journeyComparison.runs.NORMAL,'Unexecuted Normal arm is not fabricated');
  const run=state.journeyComparison.runs.ROBOSPHERE;
  check(run.status==='ERROR'&&run.reason==='runtime_failure','Recorded driving outcome retains the runtime failure');
  const root='/runs/normal_city/'+run.recording.replaceAll('\\','/').split('/').at(-1)+'/';
  const status=state.recordingStatus;
  check(status.finalized&&!status.incomplete&&status.dropped_frames===0,'Failed recording finalized without dropped frames');
  const video=await page.request.get('http://127.0.0.1:8000'+root+'video-status.json').then(r=>r.json());
  check(video.status==='READY'&&video.source==='RECORDED_NATIVE_DRIVING_CAMERA','Failed attempt has an actual native MP4');
  check((await page.locator('#presentationStatus').textContent()).includes('control sensors fell behind'),'Presentation exposes the real failure in English');
  check((await page.locator('#presentationDetail').textContent()).includes('one second'),'Failure detail gives its actual timeout and recovery');
  check(await page.getByRole('button',{name:'↻ Restart',exact:true}).isEnabled(),'Restart recovery is available');
  check(!/[\u0600-\u06ff]/.test(await page.locator('body').innerText()),'Visible interface is English');
  for(const width of [1600,390]){
    await page.setViewportSize({width,height:1000});
    check(await page.locator('#presentationControls').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;}),'Recovery controls fit viewport '+width);
    await page.screenshot({path:'output/playwright/route-bypass-native-failure-'+width+'.png',fullPage:true});
  }
  await page.setViewportSize({width:1600,height:1000});
  return {source:'LIVE_NATIVE_CARLA_BROWSER',presentation_id:state.presentation.id,
    pair_id:state.journeyComparison.pair_id,checks:checks.length,labels:checks,
    full_rehearsal_passed:false,normal_recorded:false,playback_verified:false};
}
