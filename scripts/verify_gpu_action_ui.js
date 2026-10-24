// Browser-only fixtures: all API requests and control WebSockets are intercepted.
async page=>{
  const root='http://127.0.0.1:8019',checks=[];
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  const read=async path=>(await page.request.get(root+path)).text();
  const catalog=JSON.parse(await read('/output/guided-ui-20261018/observed-catalog.json'));
  const observed=JSON.parse(await read('/output/guided-ui-20261018/observed-state.json'));
  catalog.presentation_scenarios={default_id:'SUDDEN_PEDESTRIAN_COMPARISON_V1',options:[
    {id:'SUDDEN_PEDESTRIAN_COMPARISON_V1',available:true},
    {id:'EGYPT_URBAN_CHAOS_V1',available:false,native_accepted:false,validation_window_active:false,
      reason:'Twelve source-bound native trips have not been accepted'}]};
  const install=new Function('return ('+await read('/scripts/verify_guided_mission_ui.js')+')')();
  await install(page,{root,observed,catalog,image_path:'D:\\projects\\Ai\\ya_rab_ostorha\\public\\assets\\native-preview.jpg'});
  const fixture=patch=>page.evaluate(patch=>window.setMissionFixture(patch),patch);
  const perf=(patch={})=>({gpu:{name:'Fixture RTX GPU · browser verification',usedMiB:5950,totalMiB:6144,
    utilizationPercent:29,observedAtUnix:Date.now()/1000,...patch},gpuBudget:{limitMiB:4608}});
  const waitStatus=status=>page.waitForFunction(status=>document.getElementById('missionGPU')?.dataset.status===status,status);
  const evidence=()=>page.evaluate(()=>window.missionEvidence());
  const action=page.locator('#drivePrimaryAction'),notice=page.locator('#missionScenarioNotice');
  try{
    await page.setViewportSize({width:1440,height:1000});
    await fixture({connected:true,available:true,controller:true,mode:'PAUSED',performance:perf(),
      simulatorStart:{status:'READY',available:false},simulatorStop:{status:'IDLE',available:true},
      population:{requested:{vehicle_count:60,pedestrian_count:100},actual:{vehicles:60,pedestrians:100,controllers:100}}});
    await waitStatus('critical');
    await page.waitForFunction(()=>document.getElementById('missionScenarioNotice').textContent.includes('No active validation window'));
    check(await page.locator('#missionScenario option[value=EGYPT_URBAN_CHAOS_V1]').isDisabled(),'Unavailable scenario was enabled');
    check((await notice.textContent()).includes('Twelve source-bound native trips'),'Backend availability reason was hidden');
    check((await page.locator('#missionGPU').textContent()).includes('97% VRAM'),'VRAM percentage missing');
    check((await page.locator('#missionGPU').textContent()).includes('29% GPU load'),'GPU utilization confused with VRAM');
    check(await action.isEnabled(),'VRAM pressure incorrectly blocked a native-ready scene');
    await action.focus();
    await fixture({performance:perf()});
    check(await action.evaluate(el=>el===document.activeElement),'Telemetry updates removed keyboard focus from the primary action');
    checks.push('Unavailable Egypt option names the backend gate and missing validation window; 97% VRAM stays separate from 29% GPU load');

    Object.assign(catalog.presentation_scenarios.options[1],{available:true,validation_window_active:true});
    await page.getByRole('button',{name:'Refresh availability',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#missionScenario option[value=EGYPT_URBAN_CHAOS_V1]').disabled);
    await page.locator('#missionScenario').selectOption('EGYPT_URBAN_CHAOS_V1');
    await page.waitForFunction(()=>document.getElementById('missionScenario').value==='EGYPT_URBAN_CHAOS_V1'&&!document.getElementById('drivePrimaryAction').disabled);
    const preload=(await evidence()).commands.filter(c=>c.type==='presentation'&&c.value?.operation==='PRELOAD').at(-1);
    check(preload.value.scenario_id==='EGYPT_URBAN_CHAOS_V1'&&preload.value.replace===true,'Scenario selection was not dispatched independently');
    await page.locator('[name=firstDrive][value=ROBOSPHERE]').check();
    check((await action.textContent())==='Start the protected drive','Driver selection label is wrong');
    checks.push('Refresh availability rechecks the catalog; authorized fixture selection keeps scenario and driver independent');

    const d={guided:true,automatic_pair:true,id:'fixture-preloaded',preloaded:true,awaiting_choice:true,
      page_id:preload.value.page_id,scenario_id:'EGYPT_URBAN_CHAOS_V1',scenario_version:1,speed_kmh:60,
      status:'PREPARING',arm:0,modes:['ROBOSPHERE','NORMAL'],prepared_condition_id:'fixture-world'};
    await fixture({presentation:d,performance:perf({usedMiB:0,utilizationPercent:0})});
    await waitStatus('normal');
    await page.waitForFunction(()=>document.getElementById('drivePrimaryAction').textContent==='Preparing your drive…');
    check(await action.isDisabled(),'Zero VRAM incorrectly admitted native preparation');
    check(await action.getAttribute('aria-busy')==='true','Preparation lacks busy semantics');
    checks.push('Preparation button names its native phase and stays disabled even with zero device usage');

    await fixture({presentation:{...d,status:'CHOOSING'},performance:perf({observedAtUnix:Date.now()/1000-15})});
    await waitStatus('stale');
    check((await page.locator('#missionGPU').textContent()).includes('stale'),'Old data has no stale label');
    check(!(await page.locator('#missionGPU').textContent()).includes('nearly full'),'Stale sample presented as current pressure');
    await fixture({performance:{gpu:null,gpuMonitorError:'Fixture monitor unavailable'}});
    await waitStatus('unavailable');
    check(await page.locator('#missionGPU [role=meter]').isHidden(),'Missing GPU was rendered as a measured meter');
    check((await page.locator('#missionGPU').textContent()).includes('VRAM unmeasured'),'Missing reading became zero');
    checks.push('Stale samples and missing monitor readings stay explicit and never claim current measurements');

    await fixture({performance:perf(),simulatorStop:{status:'STOPPING',available:true}});
    await page.waitForFunction(()=>document.getElementById('drivePrimaryAction').textContent==='Closing CARLA…');
    check(await action.isDisabled(),'Closing CARLA exposes a start action');
    check((await page.locator('#missionGPU').textContent()).includes('confirmed by process exit'),'Shutdown was tied to zero VRAM');
    await fixture({connected:false,available:false,mode:'DISCONNECTED',presentation:{status:'IDLE'},
      simulatorStop:{status:'STOPPED',available:true},performance:perf()});
    await page.waitForFunction(()=>document.getElementById('missionGPU').textContent.includes('CARLA is closed'));
    check((await page.locator('#missionGPU').textContent()).includes('97% VRAM'),'Closing CARLA incorrectly zeroed device usage');
    checks.push('Closing is busy until lifecycle confirmation; remaining all-app VRAM is retained after CARLA exit');

    Object.assign(catalog.presentation_scenarios.options[1],{available:false,validation_window_active:false});
    await fixture({connected:true,available:true,mode:'PAUSED',presentation:{...d,status:'CHOOSING'},
      simulatorStop:{status:'IDLE',available:true},performance:perf()});
    await page.getByRole('button',{name:'Refresh availability',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('drivePrimaryAction').textContent==='Scenario unavailable');
    check(await action.isDisabled(),'An expired validation window left the prepared Egypt start enabled');
    check((await notice.textContent()).includes('No active validation window'),'Expired validation reason missing for selected Egypt scenario');
    checks.push('Refreshed unavailable validation blocks an already prepared Egypt start while leaving historical selection available');
    await fixture({connected:true,available:true,mode:'PAUSED',presentation:{...d,status:'CHOOSING',scenario_id:'SUDDEN_PEDESTRIAN_COMPARISON_V1'},
      simulatorStop:{status:'IDLE',available:true},performance:perf()});
    await page.getByRole('button',{name:'Refresh availability',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#missionScenario option[value=EGYPT_URBAN_CHAOS_V1]').disabled);
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1000});
      await fixture({performance:perf()});
      await waitStatus('critical');
      const layout=await page.evaluate(()=>({fits:document.documentElement.scrollWidth<=innerWidth+1,
        action:document.getElementById('drivePrimaryAction').getBoundingClientRect().toJSON(),
        preview:document.getElementById('missionPreview').getBoundingClientRect().toJSON()}));
      check(layout.fits,'Horizontal overflow at '+width);
      check(layout.action.bottom<layout.preview.top,'Primary action is buried below the illustration');
      await page.screenshot({path:`output/playwright/gpu-action-${width}.png`,fullPage:true});
    }
    await page.emulateMedia({reducedMotion:'reduce'});
    await fixture({presentation:d});
    await page.waitForFunction(()=>document.getElementById('drivePrimaryAction').getAttribute('aria-busy')==='true');
    const animation=await action.evaluate(el=>getComputedStyle(el,'::after').animationName);
    check(animation==='none','Reduced motion leaves spinner animation running');
    checks.push('Desktop and 390px layout fit; action precedes the illustration; reduced motion disables the preparation spinner');
    const result=await evidence();check(result.errors.length===0,'Browser errors: '+result.errors.join('; '));
    return {scope:'ISOLATED_BROWSER_FIXTURES_ONLY',native_acceptance:false,checks,
      api_mutations_intercepted:result.requests,browser_errors:result.errors};
  }finally{await page.evaluate(()=>window.stopMissionFixture());}
}
