async page=>{
  const evidence=await page.evaluate(()=>window.missionEvidence());
  const pageId=evidence.commands.find(command=>command.value?.operation==='PRELOAD').value.page_id;
  const checks=[];
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(pageId=>window.setMissionFixture({connected:true,mode:'PAUSED',journey:{status:'IDLE'},
    presentation:{id:'fixture-preloaded',page_id:pageId,status:'CHOOSING',guided:true,preloaded:true,
      awaiting_choice:true,prepared_condition_id:'fixture-world',modes:['NORMAL','ROBOSPHERE']}}),pageId);
  const choices=await page.locator('#missionChoices').innerText();
  if(!choices.includes('Normal · Mercedes')||!choices.includes('same Mercedes')||choices.includes('protection off'))throw Error('Incorrect live driver capabilities');
  checks.push('Both choices identify the same Mercedes, reactive braking and additional predictive RULE');
  const examples=await page.evaluate(async()=>{
    const {previewFrame}=await import('/frontend/preview-story.js');
    return ['NORMAL','ROBOSPHERE'].map(mode=>({mode,contact:[0,2,4,6,8,10].some(time=>previewFrame(mode,time).contact),
      stopped:previewFrame(mode,4).phase,position:previewFrame(mode,4).carX}));
  });
  if(examples.some(example=>example.contact||example.stopped!=='stopped'))throw Error('Scripted comparison forces a failure');
  checks.push('Both illustrated drivers stop without a forced collision');
  await page.screenshot({path:'output/playwright/sensor-comparison-choices.png',fullPage:true});
  await page.evaluate(pageId=>window.setMissionFixture({mode:'AUTOMATIC',
    journey:{status:'RUNNING',driving_mode:'NORMAL',speed_kmh:30},
    stopDiagnostics:{decision_source:'REACTIVE_SENSORS',reason:'Measured obstacle inside braking envelope'},
    presentation:{id:'fixture-preloaded',page_id:pageId,status:'DRIVING',guided:true,preloaded:true,
      modes:['NORMAL','ROBOSPHERE'],arm:0}}),pageId);
  await page.waitForFunction(()=>document.getElementById('missionTelemetry').textContent.includes('REACTIVE_SENSORS'));
  const overlay=page.locator('#frontCameraView > canvas.prediction-overlay').first();
  if(await overlay.isVisible())throw Error('Normal shows project motion predictions');
  await page.getByText('Normal follows the route and signals with reactive sensor braking. Project motion prediction is off.',{exact:true}).waitFor();
  await page.screenshot({path:'output/playwright/sensor-comparison-normal.png',fullPage:true});
  checks.push('Normal explains sensor braking and shows the real brake source without a forecast');
  const historical=await page.evaluate(async()=>{
    const {recordedDriverDescription}=await import('/frontend/driver-profile.js');
    return recordedDriverDescription({mode:'NORMAL'});
  });
  if(!historical.includes('Historical Normal'))throw Error('Historical mode reclassified');
  const after=await page.evaluate(()=>window.missionEvidence());
  if(after.errors.length)throw Error(after.errors.join('\n'));
  return {scope:'ISOLATED_UI_FIXTURE_NOT_NATIVE_DRIVING',checks,examples,errors:after.errors};
}
