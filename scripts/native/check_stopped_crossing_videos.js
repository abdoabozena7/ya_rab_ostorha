// Only run against real retained results after independently verifying CARLA exit.
async page=>{
  const check=(value,message)=>{if(!value)throw Error(message);};
  await page.getByRole('button',{name:'Start a new drive',exact:true}).waitFor({state:'visible',timeout:30000});
  const state=await page.evaluate(()=>window.crossingNativeEvidence.latest);
  check(state.phase==='COMPLETE'&&state.simulator_stop?.status==='STOPPED'&&state.simulator_stop.process_exited,'No verified completed shutdown');
  check(await page.locator('#missionOutcomes video').count()===3,'Three original exports are required');
  await page.waitForFunction(()=>[...document.querySelectorAll('#missionOutcomes video')].every(v=>v.readyState>=1&&Number.isFinite(v.duration)&&!v.error),{timeout:30000});
  const original=await page.locator('#missionOutcomes video').evaluateAll(videos=>videos.map(v=>({src:v.currentSrc,duration_s:v.duration})));
  await page.locator('#missionOutcomes video').evaluateAll(async videos=>{for(const v of videos){v.muted=true;v.currentTime=0;await v.play();}});
  await page.waitForFunction(()=>[...document.querySelectorAll('#missionOutcomes video')].every(v=>v.currentTime>0));
  await page.locator('#missionOutcomes video').evaluateAll(async videos=>{for(const v of videos){v.currentTime=Math.max(0,v.duration-.15);await v.play();}});
  await page.waitForFunction(()=>[...document.querySelectorAll('#missionOutcomes video')].every(v=>v.currentTime>=v.duration-.05&&!v.error));
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Start a new drive',exact:true}).waitFor({state:'visible',timeout:30000});
  await page.waitForFunction(()=>[...document.querySelectorAll('#missionOutcomes video')].every(v=>v.readyState>=1));
  const restored=await page.evaluate(()=>window.crossingNativeEvidence.latest);
  check(restored.pair_id===state.pair_id&&restored.phase==='COMPLETE','Refresh changed the saved result');
  const after=await page.locator('#missionOutcomes video').evaluateAll(videos=>videos.map(v=>v.currentSrc));
  check(JSON.stringify(original.map(v=>v.src))===JSON.stringify(after),'Refresh changed the original exports');
  await page.locator('#missionOutcomes video').evaluateAll(async videos=>{for(const v of videos){v.muted=true;await v.play();}});
  await page.waitForFunction(()=>[...document.querySelectorAll('#missionOutcomes video')].every(v=>v.currentTime>0&&!v.error));
  const names=await page.locator('#missionOutcomes article h3').allTextContents();
  check(names.join('|')==='Normal|Ya Rab Ostorha','Result names differ from the project title');
  return {scope:'REAL_EXPORTED_MEDIA_BROWSER_PLAYBACK_AFTER_ENGINE_EXIT_AND_REFRESH',pair_id:state.pair_id,
    presentation_id:state.presentation_id,media:original,names,checks:['all_three_start_and_final_frames_play','same_result_after_refresh','all_three_play_again_after_refresh']};
}
