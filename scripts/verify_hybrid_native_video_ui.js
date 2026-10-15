// Run after the isolated dashboard rehearsal. Dashboard state is synthetic;
// the two MP4s are retained native camera exports selected in a local manifest.
// No command reaches the simulator. This verifies playback, not driving.
async (page)=>{
  await page.setViewportSize({width:1440,height:900});
  const response=await page.request.get('http://127.0.0.1:8012/output/hybrid-driving/native-playback-fixture.json');
  const fixture=await response.json();
  if(fixture.source!=='NATIVE_VIDEO_ISOLATED_DASHBOARD')throw new Error('Expected labelled native video fixture');
  for(const [mode,item] of Object.entries(fixture.videos)){
    if(fixture.transport==='PRODUCTION_HTTP_HANDLER')continue;
    const root='/runs/normal_city/'+item.run_id+'/';
    await page.route('**'+root+'video-status.json',route=>route.fulfill({path:item.status_path,contentType:'application/json'}));
    await page.route('**'+root+'driving.mp4',route=>route.fulfill({path:item.video_path,contentType:'video/mp4'}));
  }
  await page.evaluate(data=>{
    const s=window.__redesign.state;
    s.mode='PAUSED';s.journey={status:'ARRIVED',driving_mode:'HYBRID'};
    s.recording=false;s.vehicle.speedKmh=s.vehicle.speedMps=0;
    s.journeyComparison=data.comparison;
  },fixture);
  await page.locator('#resultsTab').click();
  await page.locator('#hybridResults').waitFor({state:'visible'});
  let measuredSpeedChecks=0;
  for(const [index,mode] of ['BASELINE','HYBRID'].entries()){
    const run=fixture.comparison.runs[mode];
    if(!Number.isFinite(run.maximum_speed_kmh))continue;
    await page.waitForFunction(({index,peak})=>document.querySelectorAll('.hybrid-run-speed')[index]?.textContent.includes('peak '+peak),
      {index,peak:run.maximum_speed_kmh.toFixed(1)});
    const text=await page.locator('.hybrid-run-speed').nth(index).innerText();
    if(!text.includes('peak '+run.maximum_speed_kmh.toFixed(1))||!text.includes('requested '+run.setup.speed_kmh.toFixed(0)))
      throw new Error('Native measured speed and requested speed are not displayed separately: '+mode);
    measuredSpeedChecks++;
  }
  await page.waitForFunction(()=>!document.getElementById('hybridPlayPair').disabled);
  await page.waitForFunction(()=>[...document.querySelectorAll('#hybridResults video')].every(v=>v.readyState>=2&&Number.isFinite(v.duration)));
  const duration=await page.locator('#hybridResults video').evaluateAll(videos=>{
    videos.forEach(v=>{v.muted=true;});return videos.map(v=>v.duration);
  });
  if(Math.abs(duration[0]-duration[1])<1.)throw new Error('Fixture needs journeys of different duration');
  const longer=duration[1]>duration[0]?1:0,shorter=1-longer;
  await page.locator('#hybridPlayPair').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('#hybridResults video')].every(v=>!v.paused));
  await page.locator('#hybridResults video').evaluateAll((videos,indices)=>{
    videos[indices.longer].currentTime=videos[indices.shorter].duration+.3;
  },{longer,shorter});
  await page.waitForFunction(({longer,shorter})=>{
    const v=document.querySelectorAll('#hybridResults video');
    return v[shorter].ended&&!v[longer].paused&&v[longer].currentTime>v[shorter].duration;
  },{longer,shorter});
  const result=await page.locator('#hybridResults video').evaluateAll(videos=>videos.map(v=>({time_s:v.currentTime,duration_s:v.duration,paused:v.paused,ended:v.ended})));
  await page.locator('#hybridResults video').evaluateAll(videos=>videos.forEach(v=>v.pause()));
  await page.screenshot({path:'output/playwright/hybrid-native-video.png',fullPage:true});
  return {source:fixture.source,transport:fixture.transport||'INTERCEPTED_NATIVE_FILES',checks:3+measuredSpeedChecks,durations_s:duration,playback_after_shorter_ended:result,
          qualification:'Native video playback with synthetic dashboard state; not behavioral acceptance'};
}
