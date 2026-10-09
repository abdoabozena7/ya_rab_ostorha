// Reparent existing controls: the existing driving handlers remain authoritative.
const $=id=>document.getElementById(id);
export function presentationUI(provider) {
  document.documentElement.dataset.appearance='light';
  const ownership=document.createElement('button');ownership.id='ownershipBtn';ownership.textContent='Take control';
  ownership.onclick=()=>provider.takeControl();document.querySelector('.app-header').append(ownership);
  const inspector=$('simulationCenter');
  const old=document.createElement('div');
  while(inspector.firstChild)old.append(inspector.firstChild);
  inspector.innerHTML=`<div class="phase-tabs" role="tablist" aria-label="Presentation steps">
    <button role="tab" id="setupTab" aria-controls="setupPhase" aria-selected="false">01 Setup</button>
    <button role="tab" id="driveTab" aria-controls="drivePhase" aria-selected="true">02 Drive</button>
    <button role="tab" id="resultsTab" aria-controls="resultsPhase" aria-selected="false">03 Results</button></div>
    <section id="setupPhase" role="tabpanel" aria-labelledby="setupTab" hidden>
      <h2>Experiment setup</h2><p class="muted">Each comparison starts from the saved manifest.</p>
      <label for="comparisonScenario">Scenario</label><select id="comparisonScenario"><option value="URBAN_CHAOS">Urban Chaos</option><option value="FRONT_OBSTACLE">Validated Front Obstacle</option></select>
      <label for="comparisonSeed">Scenario seed</label><input id="comparisonSeed" type="number" min="2000" max="2999" value="2589">
      <details open><summary>City and destination</summary><p>40 vehicles + ego · 30 pedestrians</p><p>Town10HD_Opt · UNREGULATED</p><p>20 km/h · 60 simulation seconds · 180 m native route</p><p class="muted">Front Obstacle uses its validated 28 km/h / 14 s recipe.</p></details>
      <details open><summary>Graphics preset</summary><div class="graphics-presets"><button data-preset="LOW">Low</button><button data-preset="BALANCED">Balanced</button><button data-preset="HIGH">High</button><button data-preset="ULTRA">Ultra</button></div><p id="presetApplied" role="status">Reading engine configuration…</p><p class="muted">Low / Epic engine quality · depth 640×360 · motion blur 0. Restart leaves the car stopped.</p></details>
      <details><summary>Weather and advanced settings</summary><p>ClearNoon by default. Weather is fixed between comparison runs.</p><button id="setupSettings">Open simulator settings</button></details>
    </section><section id="drivePhase" role="tabpanel" aria-labelledby="driveTab"><h2>Safety comparison</h2><p class="muted">Restart the same experiment with either controller.</p></section>
    <section id="resultsPhase" role="tabpanel" aria-labelledby="resultsTab" hidden><h2>Measured results</h2><p class="muted">Actual CARLA contacts and progress. Interrupted runs stay in the recording archive.</p></section>`;
  const demo=document.querySelector('.comparison-demo');
  const stop=$('demoStopBtn');stop.textContent='Stop / Reset';document.querySelector('.app-header').append(stop);
  demo.querySelector('.muted').textContent='Each run starts from the same configuration. Traffic may diverge after a safety intervention.';
  $('drivePhase').append(demo);
  const activity=document.createElement('details');activity.innerHTML='<summary>Hazard schedule and activity</summary><pre id="hazardActivity">Waiting for a comparison</pre>';$('drivePhase').append(activity);
  $('resultsPhase').append($('demoResults'));
  const archive=document.createElement('details');archive.innerHTML='<summary>Recording archive</summary><div id="recordingArchive"></div>';$('resultsPhase').append(archive);
  const status=document.createElement('div');status.className='controller-strip';
  for(const id of ['controlMode','safetyStatus'])status.append(old.querySelector('#'+id));
  document.querySelector('.workspace-heading').replaceWith(status);
  const normal=document.createElement('details');normal.className='normal-driving';normal.innerHTML='<summary>Manual driving and destination journey</summary>';
  const research=old.querySelector('[aria-label="Training environment"]');
  const researchDetails=document.createElement('details');researchDetails.innerHTML='<summary>Controlled research tools</summary>';researchDetails.append(research);
  $('sensorPanel').append(researchDetails);
  normal.append(old);$('drivePhase').append(normal);
  $('resultsPhase').append($('recordRunBtn'),$('recordingStatus'));
  $('setupSettings').onclick=()=>$('settingsBtn').click();
  for(const phase of ['setup','drive','results'])$(phase+'Tab').onclick=()=>{
    for(const other of ['setup','drive','results']){
      $(other+'Phase').hidden=other!==phase;$(other+'Tab').setAttribute('aria-selected',String(other===phase));
    }
  };
  inspector.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{
    provider.stopDriving('graphics_preset');
    provider.dashboardAction('restart_graphics',{preset:b.dataset.preset});
  });
  for(const group of [inspector.querySelector('.phase-tabs')]){
    group.onkeydown=event=>{
      const tabs=[...group.querySelectorAll('[role=tab]')];const current=tabs.indexOf(document.activeElement);
      if(current<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
      tabs[next].click();tabs[next].focus();
    };
  }
  // The diagnostic perception panel has its own bounded space below the camera.
  $('cameraCard').append($('perceptionPanel'));
  const resolution=document.createElement('option');resolution.textContent='1280x720';$('settingResolution').append(resolution);
}

export function updatePresentation(provider,state) {
  $('ownershipBtn').hidden=provider.controller;
  const safety=provider.safetySystem;
  if(safety)$('safetyStatus').textContent='Safety '+(safety.enabled?'ON':'OFF')+' · '+safety.controller+' · '+safety.status+' · '+safety.intervention_count+' interventions';
  const demo=provider.comparisonDemo;
  $('hazardActivity').textContent=Object.entries(demo?.hazards||{}).map(([name,v])=>name+': '+v.status+(v.sidewalk_observed_at_s!=null?' · sidewalk observed':'')+(v.road_reentry_observed_at_s!=null?' · road reentry observed':'')).join('\n')||'Waiting for a comparison';
  $('recordingArchive').replaceChildren(...(demo?.archive||[]).slice().reverse().map(item=>{
    const row=document.createElement('p');row.className='archive-row';row.textContent=item.scenario_id+' · '+item.mode+' · '+item.status+'\n'+item.recording;return row;
  }));
  const restart=provider.restartResult;
  $('presetApplied').textContent=($('activeGraphics').textContent || 'Waiting for verified engine settings')+(restart?' · '+restart.status+(restart.error?' · '+restart.error:''):'');
  const busy=['RESETTING','RUNNING','STOPPING'].includes(provider.comparisonDemo?.phase);
  if(busy){
    for(const id of ['startDrivingBtn','startJourneyBtn','phoneJourneyBtn','driveJourneyBtn','journeySpeed']){
      $(id).disabled=true;$(id).title='Stop / Reset the comparison before normal driving';
    }
  }
  $('cameraView').disabled=busy||!provider.controller||!provider.fresh;
  for(const id of ['comparisonScenario','comparisonSeed'])$(id).disabled=busy;
  document.querySelectorAll('[data-preset]').forEach(b=>b.disabled=busy||!provider.controller||Math.abs(state.speedMps??0)>.15);
}
