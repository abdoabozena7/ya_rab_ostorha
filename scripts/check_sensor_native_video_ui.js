async page=>{
  const close=page.getByRole('button',{name:'Close details',exact:true});
  if(await close.isVisible())await close.click();
  await page.evaluate(()=>window.setMissionFixture({connected:true,available:true,mode:'PAUSED',
    simulatorStop:{available:true,status:'IDLE'},journey:{status:'IDLE'}}));
  await page.waitForFunction(async()=>{
    const evidence=await window.missionEvidence();
    return evidence.commands.some(command=>command.value?.operation==='PRELOAD');
  });
  const origin=new URL(page.url()).origin;
  const reports={NORMAL:'probe-dc3966eb86db41f0b9fbfdd2351ffd04',ROBOSPHERE:'probe-7bf6c7840a6446b495ae7d76794acd7c'};
  const runs={};
  for(const [mode,folder] of Object.entries(reports)){
    const report=await (await page.request.get(origin+'/output/hybrid-driving/'+folder+'/report.json')).json();
    runs[mode]=report.recording.runs[mode];
  }
  const requests=[];
  await page.route('**/runs/normal_city/**',async route=>{
    const url=new URL(route.request().url());
    const response=await route.fetch({url:'http://127.0.0.1:8018'+url.pathname});
    requests.push({path:url.pathname,range:route.request().headers().range||null,status:response.status()});
    await route.fulfill({response});
  });
  const evidence=await page.evaluate(()=>window.missionEvidence());
  const pageId=evidence.commands.find(command=>command.value?.operation==='PRELOAD').value.page_id;
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(({runs,pageId})=>window.setMissionFixture({mode:'PAUSED',journey:{status:'ARRIVED'},
    stopDiagnostics:null,presentation:{id:'fixture-native-playback',page_id:pageId,status:'RESULTS',guided:true,
      modes:['NORMAL','ROBOSPHERE'],arm:1,pair_id:'isolated-native-video'},
    journeyComparison:{version:6,pair_id:'isolated-native-video',conditions_match:false,runs}}),{runs,pageId});
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Menu',exact:true}).click();
  await page.getByRole('button',{name:/Results Saved comparisons and recordings/}).click();
  await page.locator('#detailsResultAction').selectOption('replay');
  await page.locator('#detailsResultOpen').click();
  await page.locator('#presentationResults').waitFor({state:'visible'});
  await page.waitForFunction(()=>[...document.querySelectorAll('#presentationResults video')].every(video=>
    video.getAttribute('src')?.endsWith('driving-annotated.mp4')&&video.readyState>=2));
  const headings=await page.locator('#presentationResults .presentation-videos h3').allTextContents();
  if(!headings.some(text=>text.includes('project motion prediction off'))||!headings.some(text=>text.includes('RL not active')))throw Error('Recorded controller labels missing');
  await page.waitForFunction(()=>[...document.querySelectorAll('#presentationResults video')].every(video=>video.currentTime>.15&&!video.paused));
  const playback=await page.locator('#presentationResults video').evaluateAll(videos=>videos.map(video=>{
    video.pause();return {source:video.getAttribute('src'),time_s:video.currentTime,duration_s:video.duration};
  }));
  await page.screenshot({path:'output/playwright/sensor-native-annotated-playback.png',fullPage:true});
  await page.keyboard.press('Escape');
  if(!await page.getByRole('button',{name:'Menu',exact:true}).isVisible())throw Error('Menu hidden: '+await page.locator('#cockpitDetails').evaluate(element=>JSON.stringify({open:element.open,hidden:element.hidden})));
  await page.getByRole('button',{name:'Menu',exact:true}).click();
  await page.getByRole('button',{name:/Results Saved comparisons and recordings/}).click();
  await page.locator('#detailsResultAction').selectOption('downloadNORMAL');
  const downloading=page.waitForEvent('download');
  await page.locator('#detailsResultOpen').click();
  const download=await downloading;
  if(!download.url().endsWith('driving-annotated.mp4'))throw Error('Download did not select the annotated version');
  if(await close.isVisible())await close.click();
  const mediaPath=new URL(playback[0].source,origin).pathname;
  const range=await page.request.get('http://127.0.0.1:8018'+mediaPath,{headers:{Range:'bytes=0-127'}});
  requests.push({path:mediaPath,range:'bytes=0-127',status:range.status(),kind:'EXPLICIT_HTTP_RANGE_CHECK'});
  if(!requests.some(request=>request.path.endsWith('driving-annotated.mp4')&&request.range&&request.status===206))throw Error('Native annotated range request not exercised');
  return {scope:'NATIVE_CAMERA_VIDEOS_WITH_ISOLATED_UI_STATE_NOT_ANOTHER_DRIVE',
    download_url:download.url(),checks:['Both new native annotated exports play through the production HTTP range handler',
      'Normal MP4 download selects its annotated native export',
      'Recorded capabilities identify reactive Normal and predictive RULE without claiming RL',
      'Independent starts remain labelled unverified in this isolated playback fixture'],headings,playback,requests};
}
