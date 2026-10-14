// Compare actual application Results against its new native result, without fixtures.
async (page) => {
  const state=await(await page.request.get('http://127.0.0.1:8000/api/simulation/state')).json();
  const v=state.comparisonV2,result=v.latest_attempt;
  if(v.phase!=='FINISHED'||result.status!=='ARRIVED'||state.recording||state.mode!=='PAUSED')throw Error('Native journey has not arrived and finalized');
  await page.waitForFunction(()=>document.querySelector('#driveState').textContent==='Journey arrived');
  await page.locator('#journeyResultsBtn').click();
  const text=await page.locator('#journeyResults').innerText();
  const fields=[result.recording,'Latest attempt · RULE · ARRIVED','Yes · native arrival check',
    result.outcome_metrics.elapsed_simulation_s.toFixed(2)+' s',result.outcome_metrics.progress_m.toFixed(2)+' m',
    result.metrics.harsh_braking_events.toFixed(0),result.metrics.unnecessary_waiting_s.toFixed(2)+' s'];
  for(const field of fields)if(!text.includes(field))throw Error('Results do not match the new recording: '+field);
  if(result.attempt_id!==v.results.RULE.attempt_id||result.recording!==v.results.RULE.recording)throw Error('UI/result reused an earlier arrival');
  if(!text.includes('Waiting proxy')||!text.includes('MODEL acceptance')||text.includes('NaN'))throw Error('Result limitations are not visible');
  await page.setViewportSize({width:1366,height:900});
  await page.screenshot({path:'output/playwright/native-rule-results.png',fullPage:true});
  const report={status:'PASS',attempt_id:result.attempt_id,recording:result.recording,
    text,checks:['actual Results display new terminal attempt','recording reference matches','duration and progress match','harsh braking and waiting proxy match','limitations remain visible']};
  const journey=await page.evaluate(()=>window.__nativeJourneyEvidence);
  if(!journey||journey.errors.length||journey.commands.filter(c=>c.type==='comparison_v2').length!==1||journey.commands.some(c=>c.type==='controls'))throw Error('Actual application journey evidence invalid');
  await page.evaluate(report=>window.__nativeResultsReport=report,report);
  return {status:'PASS',attempt_id:result.attempt_id,recording:result.recording,checks:report.checks,heartbeats:journey.heartbeats,browser_errors:journey.errors};
}
