// Browser-only verification. Every API mutation and WebSocket is intercepted.
async page=>{
  const root='http://127.0.0.1:8019';
  const workspace='D:\\projects\\Ai\\ya_rab_ostorha';
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  const read=path=>page.evaluate(async path=>{const response=await fetch(path);if(!response.ok)throw Error('Fixture asset unavailable: '+path);return response.text();},root+path);
  const installer=await read('/scripts/verify_guided_mission_ui.js');
  const checks=[];
  const catalog=JSON.parse(await read('/output/guided-ui-20261018/observed-catalog.json'));
  const observed=JSON.parse(await read('/output/guided-ui-20261018/observed-state.json'));
  catalog.presentation_scenarios={default_id:'SUDDEN_PEDESTRIAN_COMPARISON_V1',options:[
    {id:'SUDDEN_PEDESTRIAN_COMPARISON_V1',available:true},
    {id:'EGYPT_URBAN_CHAOS_V1',available:true,native_accepted:false,validation_window_active:true,
      reason:'ISOLATED_BROWSER_FIXTURE_NOT_NATIVE_AUTHORIZATION'}]};
  await (new Function('return ('+installer+')'))()(page,{root,observed,catalog,
    image_path:workspace+'\\public\\assets\\native-preview.jpg'});
  await page.route('**/runs/normal_city/**',route=>{
    const url=new URL(route.request().url()),normal=url.pathname.includes('run_'+'a'.repeat(32));
    if(url.pathname.endsWith('video-status.json'))return route.fulfill({json:{status:'READY',annotation_required:true,
      source:'TEST_FIXTURE',variants:{annotated:{status:'READY',video:'driving-annotated.mp4'}}}});
    if(url.pathname.endsWith('.mp4'))return route.fulfill({path:workspace+'\\output\\egypt-urban-ui\\'+(normal?'normal':'protected')+'\\driving-annotated.mp4',contentType:'video/mp4'});
    return route.fulfill({status:404,body:'Isolated fixture has no native recording'});
  });
  const fixture=async patch=>page.evaluate(patch=>window.setMissionFixture(patch),patch);
  try{
    await page.setViewportSize({width:1440,height:1000});
    await fixture({connected:true,available:true,controller:true,mode:'PAUSED',
      simulatorStart:{status:'READY',available:false},simulatorStop:{status:'IDLE',available:true},
      population:{requested:{vehicle_count:60,pedestrian_count:100},actual:{vehicles:60,pedestrians:100,controllers:100}}});
    await page.locator('#missionScenario').waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('#missionScenario option[value=EGYPT_URBAN_CHAOS_V1]').disabled);
    await page.locator('#missionScenario').selectOption('EGYPT_URBAN_CHAOS_V1');
    await page.waitForFunction(()=>document.getElementById('missionScenarioNotice').textContent.includes('EGYPT_URBAN_CHAOS_V1'));
    let evidence=await page.evaluate(()=>window.missionEvidence());
    check(evidence.commands.some(c=>c.type==='presentation'&&c.value?.operation==='PRELOAD'&&
      c.value.scenario_id==='EGYPT_URBAN_CHAOS_V1'&&c.value.replace===true),'Scenario selection was not independent');
    check((await page.locator('#missionScenarioNotice').textContent()).includes('Native acceptance pending'),'Pending gate hidden');
    checks.push('Independent scenario selection; source-bound default/pending status stays explicit');
    const d={guided:true,automatic_pair:true,id:'fixture-preloaded',preloaded:true,awaiting_choice:true,
      scenario_id:'EGYPT_URBAN_CHAOS_V1',scenario_version:1,speed_kmh:60,seed:123,status:'PREPARING',arm:0,
      modes:['ROBOSPHERE','NORMAL'],prepared_condition_id:'fixture-world'};
    const pageId=evidence.commands.filter(c=>c.type==='presentation').at(-1).value.page_id;
    d.page_id=pageId;
    await fixture({presentation:d});
    await page.waitForFunction(()=>document.getElementById('drivePrimaryAction').getAttribute('aria-busy')==='true');
    check(await page.locator('#drivePrimaryAction').isDisabled(),'Preparing state admitted movement');
    checks.push('Loading remains disabled until native preparation phases finish');
    await fixture({presentation:{...d,status:'CHOOSING'}});
    await page.locator('[name=firstDrive][value=ROBOSPHERE]').check();
    await page.getByRole('button',{name:'Start the protected drive',exact:true}).click();
    evidence=await page.evaluate(()=>window.missionEvidence());
    const start=evidence.commands.findLast(c=>c.type==='presentation'&&c.value?.operation==='START_GUIDED');
    check(start?.value.scenario_id==='EGYPT_URBAN_CHAOS_V1'&&start.value.speed_kmh===60&&
      start.value.first_mode==='ROBOSPHERE','Wrong scenario, driver or speed in admitted command');
    checks.push('Either first-driver choice is separate from the selected 60 km/h experiment');
    const driving={...d,awaiting_choice:false,status:'DRIVING',pair_id:'c'.repeat(32)};
    await fixture({presentation:driving,journey:{status:'RUNNING',driving_mode:'ROBOSPHERE',
      speed_kmh:60,presentation_id:d.id},mode:'AUTOMATIC'});
    await page.getByRole('button',{name:'Emergency stop',exact:true}).click();
    evidence=await page.evaluate(()=>window.missionEvidence());
    check(evidence.commands.some(c=>c.type==='emergency_stop'),'Emergency command was not dispatched');
    await fixture({mode:'EMERGENCY_STOP'});
    await page.getByRole('button',{name:'Release emergency stop',exact:true}).waitFor({state:'visible'});
    checks.push('Visible emergency stop dispatches the canonical command and exposes the held state');
    const run=(mode,id)=>({id,mode,status:'ARRIVED',reason:'destination_reached',destination_reached:true,collisions:0,
      samples:100,observed_samples:100,intervention_samples:100,acceleration_samples:100,distance_m:700,
      duration_s:150,mean_speed_kmh:17,maximum_speed_kmh:58,contact_callbacks:0,
      driver_id:mode==='NORMAL'?'NORMAL_REACTIVE_SENSORS_V1':'ROBOSPHERE_URBAN_MANEUVER_V2',
      driver_profile:{protocol:'EGYPT_COMPLETE_DRIVERS_V1',motion_prediction_used:mode!=='NORMAL'},
      recording:'D:\\browser-only\\runs\\normal_city\\run_'+id.repeat(32),
      setup:{speed_kmh:60,comparison_scenario:{id:'EGYPT_URBAN_CHAOS_V1',protocol:'EGYPT_COMPLETE_DRIVERS_V1',version:1,seed:123}},
      completed_maneuvers:[],scenario_evidence:{events:{},minimum_body_separation_m:1.2},
      maximum_sensor_sim_age_s:0,maximum_sensor_wall_age_s:.1,simulation_wall_ratio:.4,events:[]});
    const pair={version:7,pair_id:driving.pair_id,conditions_match:true,
      manifest:{presentation_id:d.id,comparison_scenario:{id:'EGYPT_URBAN_CHAOS_V1'}},
      scenario_validation:{protocol:'EGYPT_COMPLETE_DRIVERS_V1',passed:false},
      shared_perception:{status:'UNAVAILABLE',reason:'UI-only fixture; no native common-camera evidence'},
      runs:{NORMAL:run('NORMAL','a'),ROBOSPHERE:run('ROBOSPHERE','b')}};
    await fixture({mode:'PAUSED',journey:{status:'ARRIVED'},presentation:{...driving,status:'RESULTS'},journeyComparison:pair});
    await page.waitForFunction(()=>document.body.dataset.mission==='comparison');
    check((await page.locator('#presentationSummary').textContent()).includes('Normal: Destination reached'),'Normal outcome was prescribed as a contact');
    check((await page.locator('#presentationSummary').textContent()).includes('incomplete or failed'),'Fixture was promoted to native acceptance');
    check((await page.locator('.presentation-scenario').first().textContent()).includes('seed 123'),'Scenario metadata missing');
    checks.push('Version 7 results show the supplied Normal-arrival fixture, driver identity, seed, metrics and unaccepted evidence');
    await page.waitForFunction(()=>[...document.querySelectorAll('.presentation-videos video')].every(v=>v.readyState>=2));
    await page.evaluate(()=>Promise.all([...document.querySelectorAll('.presentation-videos video')].map(v=>v.play())));
    await page.waitForFunction(()=>[...document.querySelectorAll('.presentation-videos video')].every(v=>v.ended));
    checks.push('Both new-profile annotated software MP4s decode and play to their actual end');
    await page.getByRole('button',{name:'Finish',exact:true}).click();
    evidence=await page.evaluate(()=>window.missionEvidence());
    check(evidence.commands.some(c=>c.type==='presentation'&&c.value?.operation==='FINISH'),'Finish command missing');
    await fixture({connected:false,available:false,mode:'DISCONNECTED',presentation:{...driving,status:'COMPLETE'},
      simulatorStop:{status:'STOPPED',available:true}});
    await page.reload();
    await page.waitForFunction(()=>document.body.dataset.mission==='comparison');
    await page.waitForFunction(()=>[...document.querySelectorAll('.presentation-videos video')].every(v=>v.readyState>=2));
    await page.evaluate(()=>Promise.all([...document.querySelectorAll('.presentation-videos video')].map(v=>v.play())));
    await page.waitForFunction(()=>[...document.querySelectorAll('.presentation-videos video')].every(v=>v.ended));
    checks.push('Saved results and both videos survive engine-disconnected state, Finish and page reload');
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1000});
      const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
      check(fits,'Results overflow at '+width+'px');
    }
    checks.push('Desktop and 390px results retain horizontal layout containment');
    evidence=await page.evaluate(()=>window.missionEvidence());
    check(evidence.errors.length===0,'Browser errors: '+evidence.errors.join('; '));
    return {scope:'ISOLATED_BROWSER_AND_TEST_FIXTURE_MEDIA_ONLY',native_acceptance:false,
      checks,command_count:evidence.commands.length,api_mutations_intercepted:evidence.requests,browser_errors:evidence.errors};
  }finally{
    await page.evaluate(()=>{for(const video of document.querySelectorAll('video'))video.pause();return window.stopMissionFixture();});
  }
}
