import {driveState} from './drive-state.js';

export function installSequentialDrive(p) {
  const $=id=>document.getElementById(id);
  document.body.classList.add('sequential-drive');
  const drawer=$('cockpitDetails');
  drawer.querySelector('h2').textContent='Drive details';
  drawer.querySelector('.cockpit-dialog-close').setAttribute('aria-label','Close drive details');
  const configuration=document.createElement('section');configuration.className='drive-detail-actions';
  const heading=document.createElement('h3');heading.textContent='Configure & inspect';configuration.append(heading);
  for(const id of ['presentationChoose','scenariosNav','cockpitToolsNav','resultsTab','settingsBtn','stopSimulatorBtn','resetSimulatorBtn','presentationReplay']) {
    const button=$(id);if(button)configuration.append(button);
  }
  const returnToDrive=document.querySelector('.studio-back-to-drive');
  if(returnToDrive)configuration.append(returnToDrive);
  for(const selector of ['.presentation-custom','.cockpit-camera-tools','#expandCameraBtn','.cockpit-summary','.cockpit-gap','.cockpit-ttc','.cockpit-brake']) {
    const node=document.querySelector(selector);if(node)drawer.append(node);
  }
  drawer.querySelector('header').after(configuration);
  $('resultsTab').removeAttribute('role');$('resultsTab').tabIndex=0;
  const mapButton=document.createElement('button');mapButton.textContent='Map & measured surfaces';
  mapButton.onclick=()=>{drawer.close();$('unifiedMapToggle').click();};configuration.append(mapButton);
  const actions=document.querySelector('.cockpit-header-actions');
  const primary=document.createElement('button');primary.id='drivePrimaryAction';primary.className='primary';
  const details=document.createElement('button');details.id='driveDetailsAction';details.textContent='Details';
  details.setAttribute('aria-controls','cockpitDetails');details.setAttribute('aria-expanded','false');
  details.onclick=()=>{drawer.showModal();details.setAttribute('aria-expanded','true');};
  drawer.addEventListener('close',()=>{details.setAttribute('aria-expanded','false');details.focus();});
  configuration.addEventListener('click',e=>{if(e.target.closest('button'))drawer.close();});
  actions.prepend(primary,details);
  const target={RESTART:'presentationRestart',RESUME:'presentationResume',STOP:'studioManualStop',RELEASE:'acknowledgeStopBtn'};
  primary.onclick=()=>{
    const state=driveState(p);
    if(state.action==='PLAYBACK') {
      const videos=[...document.querySelectorAll('#presentationResults video')];
      if(videos.every(v=>v.paused)) {
        for(const v of videos)if(!v.ended)v.play().catch(()=>{});
      } else {
        for(const v of videos)v.pause();
      }
    } else $(target[state.action])?.click();
  };
  return {update(){
    const state=driveState(p);
    primary.textContent={RESTART:'Restart',RESUME:'Resume driving',STOP:'Stop',RELEASE:'Release emergency stop',
      PLAYBACK:[...document.querySelectorAll('#presentationResults video')].every(v=>v.paused)?'Play':'Pause'}[state.action];
    primary.disabled=!state.enabled;
    primary.dataset.action=state.action;
    $('emergencyStopBtn').hidden=state.action==='RELEASE';
    // Legacy controls keep their tested handlers but are never duplicate actions.
    for(const id of ['presentationRestart','presentationResume','studioManualStop','acknowledgeStopBtn','cockpitResumeDrive','replayPauseBtn'])$(id)?.setAttribute('hidden','');
    $('connectionSetupBtn')?.setAttribute('hidden','');
  }};
}
