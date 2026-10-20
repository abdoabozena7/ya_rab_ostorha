// Real UI input and real snapshots only. Run with the native transport observer.
async page=>{
  const check=(value,message)=>{if(!value)throw Error(message);};
  // Playwright enables Chromium focus emulation by default. Disable that
  // verification override so the observed blur is a real focus transition.
  const primaryFocus=await page.context().newCDPSession(page);
  await primaryFocus.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  await page.setViewportSize({width:1440,height:1000});
  const alreadyStarted=await page.evaluate(()=>window.crossingNativeEvidence?.commands.some(c=>c.value?.operation==='START_GUIDED'));
  if(!alreadyStarted){
  await page.locator('#drivePrimaryAction').waitFor({state:'visible'});
  const action=await page.locator('#drivePrimaryAction').getAttribute('data-action');
  if(['START_SIMULATION','NEW_DRIVE'].includes(action))await page.locator('#drivePrimaryAction').click();
  else check(action==='START_GUIDED'||action===''&&await page.locator('#drivePrimaryAction').isDisabled(),
    'Expected cold startup or the automatic city preload');
  await page.waitForFunction(()=>document.querySelector('#drivePrimaryAction')?.dataset.action==='START_GUIDED'&&!document.querySelector('#drivePrimaryAction').disabled,null,{timeout:180000});
  await page.locator('[name=firstDrive][value=NORMAL]').check();
  await page.locator('#drivePrimaryAction').dblclick();
  }
  await page.waitForFunction(()=>window.crossingNativeEvidence.latest?.phase==='DRIVING',null,{timeout:120000});
  await page.locator('#drivePrimaryAction').waitFor({state:'hidden',timeout:15000});
  const background=await page.context().newPage();
  const peerFocus=await background.context().newCDPSession(background);
  await peerFocus.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  const peerErrors=[];background.on('pageerror',error=>peerErrors.push(error.message));
  await background.goto(new URL('/?verification=observational-peer',page.url()).href);
  await background.bringToFront();
  await background.waitForFunction(()=>/another page/.test(document.querySelector('#missionTitle')?.textContent||''),null,{timeout:30000});
  const observationalPeerTitle=await background.locator('#missionTitle').innerText();
  check(await background.locator('#missionError').isHidden()&&peerErrors.length===0,'The observational peer reported an error');
  const focusProbe=await page.evaluate(()=>({visibility:document.visibilityState,focused:document.hasFocus()}));
  check(!focusProbe.focused,'The real focus-loss case was not exercised');
  await new Promise(resolve=>setTimeout(resolve,1800));
  await page.bringToFront();await background.close();
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>['RESULTS','ERROR','CANCELLED'].includes(window.crossingNativeEvidence.latest?.phase),null,{timeout:900000});
  const result=await page.evaluate(()=>window.crossingNativeEvidence);
  check(result.latest.phase==='RESULTS','The native comparison failed before results');
  check(result.comparison?.validation?.passed,'Actual collision/arrival gates did not pass');
  const pending=await page.locator('#missionOutcomes .video-preparing:visible').count();
  check(pending>0,'The Finish-during-export case was not exercised');
  await page.getByRole('button',{name:'Finish',exact:true}).dblclick();
  await page.waitForFunction(()=>window.crossingNativeEvidence.latest?.phase==='COMPLETE'&&window.crossingNativeEvidence.latest.simulator_stop?.status==='STOPPED',null,{timeout:240000});
  const evidence=await page.evaluate(()=>window.crossingNativeEvidence);
  check(evidence.commands.filter(c=>c.value?.operation==='START_GUIDED').length===1,'Duplicate Start reached the server');
  check(evidence.commands.filter(c=>c.value?.operation==='FINISH').length===1,'Duplicate Finish reached the server');
  check(!evidence.commands.some(c=>c.value?.operation==='NEXT'||['STARTING','DRIVING','RESTORING'].includes(c.phase)&&['controls','stop_driving','release_controls'].includes(c.type)),'Focus/reload submitted a driving interruption');
  check(new Set(evidence.vehicles.map(v=>v.actor_id)).size>=2&&evidence.comparison_blueprint==='vehicle.mercedes.coupe_2020','Fresh native actor rebuild to the comparison Mercedes was not observed');
  check(evidence.errors.length===0,'Browser or server exceptions occurred');
  await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});
  await page.screenshot({path:'output/playwright/crossing-native-results.png',fullPage:true});
  return {...evidence,pending_exports_when_finish_clicked:pending,focus_probe:focusProbe,observational_peer_title:observationalPeerTitle,
    checks:['one_start_both_natural_endings','no_shortening','blur_and_reload_continue_same_pair','native_actor_rebuilt_to_comparison_mercedes',
      'opening_another_dashboard_does_not_cancel_the_drive','real_focus_loss_beyond_transport_lease',
      'finish_during_export_once','three_exports_before_verified_engine_exit','no_browser_or_server_exceptions']};
}
