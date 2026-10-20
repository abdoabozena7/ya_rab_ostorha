import {showWorkspace} from './presentation-ui.js';
import {driveState} from './drive-state.js';
import {DetailsNavigation,detailGroups,configurationReason,availableRecordings,recordedConditionsMatch} from './details-state.js';
import {preferredVideo,recordedDriverDescription} from './driver-profile.js';

const $=id=>document.getElementById(id);
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
const selectField=(parent,id,title,options)=>{
  const label=node('label',title),select=node('select');select.id=id;
  for(const [value,text] of options)select.add(new Option(text,value));
  label.append(select);parent.append(label);return select;
};

export function installGuidedDetails(p,tools,trigger){
  const drawer=$('cockpitDetails'),navigation=new DetailsNavigation(),pages=new Map();
  const legacy=node('div');legacy.hidden=true;legacy.id='detailsLegacy';
  drawer.querySelector('h2').id='legacyDetailsTitle';
  legacy.append(...drawer.children);
  for(const id of ['stopSimulatorBtn','resetSimulatorBtn','presentationChoose','resultsTab','presentationReplay','scenariosNav','cockpitToolsNav','settingsBtn','expandCameraBtn'])legacy.append($(id));
  legacy.append(document.querySelector('.presentation-custom'),document.querySelector('.cockpit-camera-tools'));
  const returnToDrive=document.querySelector('.studio-back-to-drive');if(returnToDrive)legacy.append(returnToDrive);
  const header=node('header',null,'guided-details-heading');
  const back=node('button','Close');back.id='detailsBack';back.type='button';
  const title=node('h2','Details');title.id='cockpitDetailsTitle';title.tabIndex=-1;
  const emergency=node('button','Emergency stop','cockpit-dialog-emergency');emergency.type='button';
  emergency.onclick=()=>{close();$('emergencyStopBtn').click();};
  header.append(back,title,emergency);drawer.replaceChildren(header,legacy);
  drawer.classList.add('guided-details');
  const page=(id,heading)=>{const e=node('section');e.dataset.detailsPage=id;e.hidden=true;pages.set(id,{element:e,title:heading});drawer.append(e);return e;};
  const root=page('root','Details');root.className='details-groups';
  for(const [id,label,description] of detailGroups){
    const button=node('button');button.type='button';button.dataset.detailsGroup=id;
    button.append(node('strong',label),node('span',description),node('i','→'));button.onclick=()=>open(id);root.append(button);
  }
  let baseline=new Map(),dirty=new Set(),catalogKey='',mediaKey='',selectedPair=null,historyLoaded=false,opening=false;
  const value=e=>e.type==='checkbox'||e.type==='radio'?e.checked:e.value;
  const inputs=()=>[...drawer.querySelectorAll('input,select,textarea')];
  const capture=()=>new Map(inputs().map(e=>[e,value(e)]));
  const restore=values=>{for(const [e,v] of values)if(e.type==='checkbox'||e.type==='radio')e.checked=v;else e.value=v;};
  const commitDraft=(elements=inputs())=>{
    for(const e of elements){baseline.set(e,value(e));dirty.delete(e);delete e.dataset.detailsDraft;}
  };
  const originalFill=tools.fillSettings.bind(tools);
  tools.fillSettings=()=>{
    const pending=new Map([...dirty].map(e=>[e,value(e)]));originalFill();
    if(drawer.open){baseline=capture();restore(pending);}
  };
  const markDirty=e=>{dirty.add(e);e.dataset.detailsDraft='true';};
  drawer.addEventListener('input',e=>{if(e.target.matches('input,select,textarea'))markDirty(e.target);});
  // These original handlers apply immediately. Stage them until Apply is explicit.
  const staged=[...document.querySelectorAll('#cockpitCameraView,[data-overlay],#safetyEnabled,#safetyController')];
  const applyHandlers=new Map(staged.map(e=>[e,e.onchange]));
  drawer.addEventListener('change',e=>{
    if(e.target.matches('input,select,textarea'))markDirty(e.target);
    if(applyHandlers.has(e.target)){e.stopImmediatePropagation();update();}
  },true);

  const run=page('run','Run setup');
  const runMode=selectField(run,'detailsRunMode','Drive type',[
    ['automatic','Guided comparison'],['custom','Custom drive']]);
  run.append(node('p','Choose your first drive on the main screen. Each attempt records automatically; starting the other drive is explicit.','details-copy'));
  const runSummary=node('dl',null,'details-summary');
  for(const [label,text] of [['Route','Prepared automatically'],['Traffic','Requests 60 vehicles and 100 pedestrians; actual counts are checked'],['Recording','Automatic for both runs']]){
    const row=node('div');row.append(node('dt',label),node('dd',text));runSummary.append(row);
  }
  run.append(runSummary);
  const custom=node('fieldset');custom.id='detailsCustomDrive';custom.append(node('legend','Custom drive'));
  const place=selectField(custom,'detailsDestination','Destination',[['','Use the current destination']]);
  const speedLabel=node('label','Target speed');speedLabel.append($('presentationCustomSpeed'));custom.append(speedLabel);
  const destinationNote=node('p',null,'muted');custom.append(destinationNote);
  const start=node('button','Start driving & recording','primary');start.id='detailsCustomStart';start.type='button';
  start.onclick=()=>{
    if(configurationReason(p))return;
    if(place.value){tools.selectedPlace=tools.catalog?.places.find(v=>v.id===place.value);tools.choose(place.value);}
    else {$('presentationCustomStart').click();close();}
  };
  custom.append(start);run.append(custom);
  // A destination is applied first. Starting remains a separate, explicit step.
  const originalChoose=tools.choose.bind(tools);
  tools.choose=value=>{
    if(configurationReason(p))return false;
    originalChoose(value);return true;
  };

  const view=page('view','View');
  const cameraTools=document.querySelector('.cockpit-camera-tools');
  const cameraLabel=cameraTools.querySelector('label');cameraLabel.querySelector('.sr-only').classList.remove('sr-only');
  cameraLabel.className='';cameraLabel.querySelector('svg').remove();
  view.append(cameraLabel);
  const overlaySettings=cameraTools.querySelector('.cockpit-overlay-settings');
  const overlays=node('fieldset');overlays.append(node('legend','Camera overlays'));
  for(const label of overlaySettings.querySelectorAll('label'))overlays.append(label);
  view.append(overlays);
  const applyView=node('button','Apply view','primary');applyView.type='button';applyView.id='detailsApplyView';
  applyView.onclick=()=>{
    if(configurationReason(p))return;
    for(const e of staged.filter(e=>view.contains(e)&&dirty.has(e)))applyHandlers.get(e)?.call(e,new Event('change'));
    commitDraft([...view.querySelectorAll('input,select')]);
    viewStatus.textContent=tools.cameraChange?.status==='pending'?'Applying camera view…':tools.cameraChange?.status==='failed'?tools.cameraChange.error:'View preferences applied.';
  };
  const viewStatus=node('p',null,'muted');viewStatus.setAttribute('role','status');view.append(applyView,viewStatus);
  const inspect=selectField(view,'detailsInspect','Inspect',[['fullscreen','Fullscreen camera'],['diagnostics','Diagnostics']]);
  const inspectButton=node('button','Open');inspectButton.type='button';
  inspectButton.onclick=()=>{if(inspect.value==='diagnostics')open('diagnostics');else {close();tools.expandCamera(!$('cameraCard').classList.contains('camera-expanded'));}};
  view.append(inspectButton);

  const diagnostics=page('diagnostics','Diagnostics');
  for(const selector of ['#cockpitDetailsStatus','.studio-kpis','#modelVision','.cockpit-summary','.cockpit-gap','.cockpit-ttc','.cockpit-brake','#sensorPanel']){
    const e=document.querySelector(selector);if(e)diagnostics.append(e);
  }
  const embed=e=>{e.hidden=false;e.removeAttribute('role');e.removeAttribute('aria-modal');e.classList.remove('drawer');e.classList.add('details-embedded');};
  embed($('sensorPanel'));
  const diagnosticAction=selectField(diagnostics,'detailsDiagnosticAction','Diagnostic action',[['applyRadiusBtn','Update inspection radius']]);
  const diagnosticApply=node('button','Apply','primary');diagnosticApply.type='button';
  diagnosticApply.onclick=()=>{if(p.fresh&&p.controller&&!p.isReplay)$(diagnosticAction.value).click();};diagnostics.append(diagnosticApply);

  const results=page('results','Results');
  const comparison=selectField(results,'detailsComparison','Saved comparison',[['current','Latest received comparison']]);
  const resultAction=selectField(results,'detailsResultAction','Action',[
    ['view','View results'],['replay','Replay both videos'],['downloadROBOSPHERE','Download Ya Rab Ostorha MP4'],['downloadNORMAL','Download Normal MP4']]);
  const resultNote=node('p',null,'muted');resultNote.setAttribute('role','status');
  const resultOpen=node('button','Open','primary');resultOpen.type='button';resultOpen.id='detailsResultOpen';
  results.append(resultNote,resultOpen);
  const files=new Map();
  let replayRequest=0;
  const currentPair=()=>comparison.value==='current'?p.journeyComparison:selectedPair;
  const reviewBlocked=()=>driveState(p).busy&&!['RESULTS','AWAITING_NEXT'].includes(p.presentation?.status)||['STARTING','RUNNING'].includes(p.journey?.status);
  async function loadHistory(){
    if(historyLoaded)return;historyLoaded=true;
    try{
      const response=await fetch('/output/journey-comparisons/',{cache:'no-store'});
      if(!response.ok)throw new Error('Saved comparison list unavailable.');
      const doc=new DOMParser().parseFromString(await response.text(),'text/html');
      const ids=[...doc.querySelectorAll('a')].map(a=>a.getAttribute('href')).filter(v=>/^[a-f0-9]{32}\.json$/.test(v||''));
      for(const file of ids.reverse())comparison.add(new Option('Saved comparison · '+file.slice(0,8),file.slice(0,32)));
    }catch{resultNote.textContent='Only the latest received comparison is available.';}
  }
  let selection=0;
  comparison.onchange=async()=>{
    const token=++selection;selectedPair=null;resultNote.textContent='Loading saved comparison…';update();
    if(comparison.value==='current'){resultNote.textContent='';return;}
    try{
      const r=await fetch('/output/journey-comparisons/'+comparison.value+'.json',{cache:'no-store'});
      if(!r.ok)throw new Error('Saved comparison unavailable.');
      const pair=await r.json();if(token!==selection)return;
      if(pair.pair_id!==comparison.value||!pair.runs)throw new Error('Saved comparison identity does not match.');
      selectedPair={...pair,conditions_match:recordedConditionsMatch(pair)};
      resultNote.textContent=[3,4,6].includes(pair.version)?'Saved presentation; each original outcome is retained.':'Saved legacy comparison; paired video playback is available for presentations.';
      mediaKey='';update();
    }catch(error){if(token===selection)resultNote.textContent=error.message;}
  };
  resultOpen.onclick=()=>{
    const pair=currentPair();if(!pair||reviewBlocked())return;
    const action=resultAction.value;
    if(action.startsWith('download')){
      const mode=action.slice(8),file=files.get(pair.pair_id+':'+mode);if(!file)return;
      const link=node('a');link.href=file;link.download=pair.pair_id+'-'+mode.toLowerCase()+'.mp4';link.click();return;
    }
    const request=++replayRequest;
    p.presentationPlayback=false;for(const video of document.querySelectorAll('#presentationResults video'))video.pause();
    p.reviewedComparison=comparison.value==='current'?null:pair;
    document.body.classList.toggle('archive-review',![3,4,6].includes(pair.version));
    if(![3,4,6].includes(pair.version))renderLegacy(pair);
    close();showWorkspace('results');
    if(action==='replay'){
      // The regular renderer owns loading and synchronizing the real media.
      let attempts=0;const replay=()=>{
        if(request!==replayRequest||reviewBlocked())return;
        if(++attempts>50){$('presentationPlaybackStatus').textContent='Videos are still loading. Open Details → Results to retry playback.';return;}
        const expected=availableRecordings(pair).map(file=>files.get(pair.pair_id+':'+file.mode));
        const loaded=[...document.querySelectorAll('#presentationResults video')].every(v=>expected.some(path=>v.getAttribute('src')===path));
        if(loaded&&!$('presentationReplay').disabled)$('presentationReplay').click();else setTimeout(replay,200);
      };setTimeout(replay,150);
    }
  };

  const legacyResults=node('section');legacyResults.id='detailsArchivedResults';legacyResults.hidden=true;$('resultsPhase').append(legacyResults);
  function renderLegacy(pair){
    legacyResults.hidden=false;legacyResults.replaceChildren(node('h2','Saved comparison · '+pair.pair_id.slice(0,8)),
      node('p',pair.conditions_match?'Matching initial conditions verified. Reactive traffic can diverge.':'Matching initial conditions were not verified.','muted'));
    for(const [mode,run] of Object.entries(pair.runs)){
      const section=node('article');section.append(node('h3',mode),node('p',recordedDriverDescription(run)),node('p',run.status+' · '+String(run.reason||'').replaceAll('_',' ')));
      const fault=run.stop_diagnostics?.runtime_fault;if(fault)section.append(node('p',fault.exception_type+': '+fault.message));
      const metrics=node('dl',null,'details-summary');
      for(const [label,key,suffix] of [['Contacts','collisions',''],['Distance','distance_m',' m'],['Duration','duration_s',' s']]){
        const row=node('div');row.append(node('dt',label),node('dd',Number.isFinite(run[key])?run[key].toFixed(key==='collisions'?0:1)+suffix:'Not measured'));metrics.append(row);
      }
      section.append(metrics);legacyResults.append(section);
    }
  }
  document.addEventListener('workspacechange',e=>{if(e.detail.phase==='drive')document.body.classList.remove('archive-review');});

  const system=page('system','System');
  const operation=selectField(system,'detailsSystemAction','Operation',[
    ['reset','Reset session'],['gpu','Free GPU'],['settings','Advanced settings'],['research','Research tools']]);
  const operationInfo=node('p',null,'details-copy');
  const operationButton=node('button','Continue','primary');operationButton.type='button';operationButton.id='detailsSystemContinue';
  const descriptions={reset:'Restart CARLA with an empty session. Saved recordings are kept.',gpu:'Close CARLA and release its GPU memory. Saved recordings are kept.',
    settings:'Inspect simulator settings. Changes apply only when you select Apply.',research:'Controlled research tools. These actions can alter the scene or start experiments.'};
  operation.onchange=()=>{operationInfo.textContent=descriptions[operation.value];update();};operationInfo.textContent=descriptions.reset;
  operationButton.onclick=()=>{
    if(operation.value==='settings'||operation.value==='research')open(operation.value);
    else open('confirm');
  };system.append(operationInfo,operationButton);
  const confirm=page('confirm','Confirm operation');const confirmText=node('p',null,'details-copy');
  const confirmButton=node('button',null,'primary');confirmButton.type='button';confirmButton.id='detailsConfirm';
  confirmButton.onclick=()=>{
    if(driveState(p).configurationLocked)return;
    const button=$(operation.value==='gpu'?'stopSimulatorBtn':'resetSimulatorBtn');if(button.disabled)return;
    close();button.click();
  };confirm.append(confirmText,confirmButton);

  const settings=page('settings','Advanced settings');embed($('settingsPanel'));settings.append($('settingsPanel'));
  settings.append($('settingsStatus'));
  const sections=[...$('settingsForm').querySelectorAll(':scope > details'),$('connectionSettings')];
  const sectionPicker=selectField(settings,'detailsSettingsSection','Section',sections.map(e=>[e.id,e.querySelector('summary span,summary').childNodes[0].textContent.trim()]));
  settings.prepend(sectionPicker.parentElement);
  const settingAction=selectField(settings,'detailsSettingAction','Action',[]);
  const settingApply=node('button','Apply','primary');settingApply.type='button';settingApply.id='detailsApplySettings';
  settings.append(settingApply);
  const settingButtons={visibilitySettings:['applyLightingBtn','applyViewDistanceBtn'],cameraSettings:['applySettingsBtn'],
    graphicsSettings:['restartGraphicsBtn'],weatherSettings:['applySettingsBtn'],vehicleSettings:['applySettingsBtn','resetBtn'],
    timingSettings:['applySettingsBtn'],populationSettings:['applySettingsBtn','clearTrafficBtn','clearPedestriansBtn','respawnPopulationBtn','resetPopulationBtn','applyProfileBtn','applySceneBtn'],
    connectionSettings:['takeControlBtn','worldResetBtn','nativeDisconnectBtn']};
  function selectSettings(){
    for(const section of sections){section.hidden=section.id!==sectionPicker.value;section.open=section.id===sectionPicker.value;}
    settingAction.replaceChildren();for(const id of settingButtons[sectionPicker.value])settingAction.add(new Option($(id).textContent,id));
    update();
  }
  sectionPicker.onchange=selectSettings;
  settingApply.onclick=()=>{
    if(configurationReason(p))return;
    const button=$(settingAction.value);if(button.disabled)return;
    button.click();commitDraft([...settings.querySelectorAll('input,select,textarea')]);
  };
  // Original mutators remain authoritative, but only the selected Apply is shown.
  for(const button of settings.querySelectorAll('button:not(#detailsApplySettings)'))button.dataset.detailsLegacyAction='';
  $('settingsPanel').querySelectorAll(':scope > label,:scope > p,:scope > select').forEach(e=>e.dataset.detailsLegacyExtra='');

  const research=page('research','Research tools');
  const researchSource=$('setupPhase');embed(researchSource);research.append(researchSource);
  const researchAction=selectField(research,'detailsResearchAction','Action',[]);
  const researchButtons=[...researchSource.querySelectorAll('button')].filter(b=>!['setupDriveBtn','setupSettings'].includes(b.id));
  researchButtons.forEach((b,i)=>{if(!b.id)b.id='detailsResearchLegacy'+i;researchAction.add(new Option(b.textContent,b.id));b.dataset.detailsLegacyAction='';});
  const researchApply=node('button','Run selected action','primary');researchApply.type='button';researchApply.id='detailsApplyResearch';research.append(researchApply);
  researchApply.onclick=()=>{if(!configurationReason(p)&&!$(researchAction.value)?.disabled){$(researchAction.value)?.click();commitDraft([...research.querySelectorAll('input,select')]);}};
  for(const id of ['setupDriveBtn','setupSettings'])$(id).dataset.detailsLegacyAction='';

  const reason=node('p',null,'details-lock-reason');reason.id='detailsLockReason';reason.setAttribute('role','status');header.after(reason);
  function render(){
    const entry=pages.get(navigation.page);if(!entry)return;
    for(const [id,e] of pages)e.element.hidden=id!==navigation.page;
    title.textContent=entry.title;back.textContent=navigation.page==='root'?'Close':'← Back';
    if(navigation.page==='research')$('setupPhase').hidden=false;
    back.setAttribute('aria-label',navigation.page==='root'?'Close details':'Back');
    drawer.dataset.page=navigation.page;drawer.scrollTop=0;update();title.focus({preventScroll:true});
  }
  function open(id='root'){
    if(!pages.has(id))return;
    if(!drawer.open){
      navigation.reset();baseline=capture();dirty.clear();opening=true;drawer.showModal();opening=false;
      document.body.classList.add('details-open');trigger.setAttribute('aria-expanded','true');
      tools.load();
    }
    if(id!=='root')navigation.open(id);
    if(id==='results')loadHistory();if(id==='settings')selectSettings();render();
  }
  function finishClose(){
    restore(baseline);for(const e of dirty)delete e.dataset.detailsDraft;dirty.clear();navigation.reset();document.body.classList.remove('details-open');
    trigger.setAttribute('aria-expanded','false');trigger.focus({preventScroll:true});
  }
  function close(){if(drawer.open){drawer.close();finishClose();}}
  back.onclick=()=>{if(navigation.page==='root')close();else{navigation.back();render();}};
  drawer.addEventListener('cancel',e=>{e.preventDefault();close();});
  drawer.addEventListener('close',()=>{if(!drawer.open)finishClose();});
  const oldShow=drawer.showModal.bind(drawer);drawer.showModal=()=>{if(opening)oldShow();else open();};
  document.addEventListener('detailsnavigate',e=>open(e.detail.page));
  const originalOpen=tools.open.bind(tools),originalClose=tools.close.bind(tools);
  const destinations={routePanel:'run',inGamePhone:'run',sensorPanel:'diagnostics',settingsPanel:'settings'};
  tools.open=(panel,source)=>{if(destinations[panel]){open(destinations[panel]);if(panel==='routePanel'||panel==='inGamePhone')runMode.value='custom';update();}else originalOpen(panel,source);};
  tools.close=(focus=true)=>{if(drawer.open)close();else originalClose(focus);};
  // Camera and diagnostics links use the same stack, including their old handlers.
  $('cockpitViewDetails').onclick=()=>open('diagnostics');$('cockpitAnalysisLink').onclick=()=>open('diagnostics');

  function update(){
    const state=driveState(p),blocked=configurationReason(p);
    emergency.hidden=!state.emergencyVisible;emergency.disabled=$('emergencyStopBtn').disabled;
    const editing=['run','view','settings','research','confirm'].includes(navigation.page);
    reason.textContent=editing?blocked:'';reason.hidden=!reason.textContent;
    custom.hidden=runMode.value!=='custom';runSummary.hidden=runMode.value==='custom';
    runMode.onchange=update;
    const key=(tools.catalog?.places||[]).map(v=>v.id).join();
    if(key!==catalogKey){catalogKey=key;const selected=place.value;place.replaceChildren(new Option('Use the current destination',''));
      for(const v of tools.catalog?.places||[])place.add(new Option(v.name,v.id));place.value=selected;}
    destinationNote.textContent=p.route?.destination?.name?'Current route: '+p.route.destination.name:'Choose a destination first, then start the recorded drive.';
    start.textContent=place.value?'Use destination':'Start driving & recording';
    start.disabled=!!blocked||(!place.value&&$('presentationCustomStart').disabled);
    for(const e of [place,$('presentationCustomSpeed')])e.disabled=!!blocked;
    for(const e of view.querySelectorAll('input,#cockpitCameraView'))e.disabled=!!blocked||(e.id==='cockpitCameraView'&&tools.cameraChange?.status==='pending');
    inspect.options[0].textContent=$('cameraCard').classList.contains('camera-expanded')?'Restore camera size':'Fullscreen camera';
    applyView.disabled=!!blocked||!staged.some(e=>view.contains(e)&&dirty.has(e));
    for(const e of settings.querySelectorAll('fieldset'))e.disabled=!!blocked;
    for(const e of research.querySelectorAll('input,select'))e.disabled=!!blocked;
    settingApply.disabled=!!blocked||!settingAction.value||$(settingAction.value)?.disabled;
    researchApply.disabled=!!blocked||!researchAction.value||$(researchAction.value)?.disabled;
    diagnosticApply.disabled=!p.fresh||!p.controller||p.isReplay;
    operationButton.disabled=state.configurationLocked&&['reset','gpu'].includes(operation.value);
    confirmText.textContent=descriptions[operation.value];confirmButton.textContent=operation.value==='gpu'?'Free GPU':'Reset session';
    confirmButton.disabled=state.configurationLocked||$(operation.value==='gpu'?'stopSimulatorBtn':'resetSimulatorBtn').disabled;
    if(!drawer.open||navigation.page!=='results')return;
    const pair=currentPair(),pairKey=pair?.pair_id+':'+JSON.stringify(availableRecordings(pair).map(r=>r.run.recording));
    if(pairKey!==mediaKey){mediaKey=pairKey;
      for(const file of availableRecordings(pair))fetch(file.root+'video-status.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(v=>{
        const filename=preferredVideo(v);if(filename)files.set(pair.pair_id+':'+file.mode,file.root+filename);
      }).catch(()=>{});
    }
    const active=reviewBlocked();
    const action=resultAction.value,download=action.startsWith('download');
    resultOpen.disabled=!pair||active||(action==='replay'&&(![3,4,6].includes(pair.version)||!['ROBOSPHERE','NORMAL'].every(m=>files.has(pair.pair_id+':'+m))))||
      (download&&!files.has(pair.pair_id+':'+action.slice(8)));
    if(active)resultNote.textContent='Finish or stop the current run before opening saved results.';
    else if(pair&&!resultNote.textContent)resultNote.textContent='Original outcomes and failures remain attached to each recording.';
  }
  runMode.onchange=update;place.onchange=update;resultAction.onchange=update;settingAction.onchange=update;researchAction.onchange=update;
  pages.get('root').element.hidden=false;
  return {open,close,update};
}
