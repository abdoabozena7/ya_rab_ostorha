// Read-only checks against the real running dashboard and its native MP4s.
// Does not start, stop, replace or fabricate a drive.
async (page)=>{
  const checks=[];const check=(value,label)=>{if(!value)throw new Error(label);checks.push(label);};
  const state=await page.request.get('http://127.0.0.1:8000/api/state').then(r=>r.json());
  check(state.presentation?.status==='COMPLETE','Native presentation reached COMPLETE');
  check(state.journeyComparison?.version===3,'RULE/Normal presentation retains its independent protocol');
  check(state.presentation.events.some(e=>e.status==='PLAYBACK'),'Native export advanced to actual playback');
  check(state.presentation.events.find(e=>e.status==='COMPLETE').wall_s>state.presentation.events.find(e=>e.status==='PLAYBACK').wall_s,'Completion follows playback');
  const region=page.locator('#presentationResults');await region.waitFor({state:'visible'});
  check(await region.locator('video').count()===2,'Both original recordings are displayed');
  await page.waitForFunction(()=>[...document.querySelectorAll('#presentationResults video')].every(v=>v.readyState>=1),{timeout:30000});
  const videos=await region.locator('video').evaluateAll(v=>v.map(n=>({src:n.currentSrc,duration:n.duration,muted:n.muted})));
  check(videos.every(v=>v.duration>0&&v.muted&&/\/runs\/normal_city\/run_[a-f0-9]{32}\/driving.mp4$/.test(v.src)),'Videos are real native MP4 routes and allow muted autoplay');
  const outcomes=await region.locator('.presentation-outcome').allTextContents();
  const speeds=await region.locator('.presentation-speed').allTextContents();
  for(const [i,mode] of ['ROBOSPHERE','NORMAL'].entries()){
    const run=state.journeyComparison.runs[mode];
    check(speeds[i].includes('peak '+run.maximum_speed_kmh.toFixed(1))&&speeds[i].includes('requested 50'),mode+' shows actual and requested speed separately');
    check(await region.locator('article').nth(i).locator('dd').nth(1).textContent()===String(run.collisions),mode+' contact count matches the native run');
    const root='/runs/normal_city/'+run.recording.replaceAll('\\','/').split('/').at(-1)+'/';
    const status=await page.request.get('http://127.0.0.1:8000'+root+'video-status.json').then(r=>r.json());
    check(status.source==='RECORDED_NATIVE_DRIVING_CAMERA'&&status.status==='READY',mode+' export retains native provenance');
    check(status.alignment_source==='ADMITTED_JOURNEY_START',mode+' playback excludes setup frames');
  }
  check(!/[\u0600-\u06ff]/.test(await page.locator('body').innerText()),'Visible UI is English');
  for(const width of [1600,390]){
    await page.setViewportSize({width,height:1000});
    check(await region.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;}),'Results fit viewport '+width);
    await page.screenshot({path:'output/playwright/presentation-native-results-'+width+'.png',fullPage:true});
  }
  await page.setViewportSize({width:1600,height:1000});
  return {source:'LIVE_NATIVE_CARLA_BROWSER',presentation_id:state.presentation.id,pair_id:state.journeyComparison.pair_id,
    checks:checks.length,outcomes,speeds,videos};
}
