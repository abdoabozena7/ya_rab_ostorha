import {driveState} from './drive-state.js';
import {installGuidedDetails} from './guided-details.js';

export function installSequentialDrive(p,tools) {
  const $=id=>document.getElementById(id);
  document.body.classList.add('sequential-drive');
  const actions=document.querySelector('.cockpit-header-actions');
  const primary=document.createElement('button');primary.id='drivePrimaryAction';primary.className='primary';
  const details=document.createElement('button');details.id='driveDetailsAction';details.textContent='Details';
  details.setAttribute('aria-controls','cockpitDetails');details.setAttribute('aria-expanded','false');
  actions.prepend(primary,details);
  const navigator=installGuidedDetails(p,tools,details);
  details.onclick=()=>navigator.open();
  const target={RESTART:'presentationRestart',RESUME:'presentationResume',STOP:'studioManualStop',RELEASE:'acknowledgeStopBtn'};
  primary.onclick=()=>{
    const state=driveState(p);
    if(!state.enabled)return;
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
    primary.disabled=!state.enabled;primary.dataset.action=state.action;
    $('emergencyStopBtn').hidden=!state.emergencyVisible;
    for(const id of ['presentationRestart','presentationResume','studioManualStop','acknowledgeStopBtn','cockpitResumeDrive','replayPauseBtn'])$(id)?.setAttribute('hidden','');
    $('connectionSetupBtn')?.setAttribute('hidden','');
    navigator.update();
  }};
}
