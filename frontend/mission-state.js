// Native phases determine actions. Button labels never determine commands.
const preparation={SELECTING:['Preparing your selected car','The world is already prepared. Attaching the camera and checking fresh sensors for this car.'],STOPPING:['Holding the vehicle','Waiting for a full stop and the previous recording to close.'],
  PREPARING:['Preparing your drive','Building the route and native traffic. The live view comes next.'],
  READY:['Checking the starting scene','Checking traffic, camera and sensors before recording.'],
  STARTING:['Starting the recording','The car will move when fresh sensor frames are ready.'],
  FINALIZING:['Saving this attempt','Stopping the car and closing its recording before continuing.'],
  RESTORING:['Preparing the other drive','Rebuilding and checking the same starting scene. Traffic may react differently.'],
  RECOVERING:['Checking the sensors','Waiting for fresh sensor frames and a verified starting scene.']};
export const modeLabel=m=>m==='NORMAL'?'Normal':'يا رب تسترها';
export const nextLabel=m=>m==='NORMAL'?'See predictive driving now':'See reactive sensor driving now';
export function missionFailure(reason){
  if(!reason)return 'Open Menu for diagnostics.';
  if(/presentation_phase_timeout|prepar.*tim.*out/i.test(reason))return 'Preparing this step took too long. Retry the step; recorded attempts remain saved.';
  if(/sensor|observation|freshness|control.*deadline/i.test(reason))return 'Current sensor measurements could not be processed in time. The vehicle stopped safely. Prepare a fresh drive to try again.';
  if(/heartbeat|disconnected|connection|page_closed/i.test(reason))return 'The session connection was lost. Reconnect to inspect the saved attempt, then prepare a fresh drive.';
  if(/recording|export.*fail/i.test(reason))return 'The recording could not finish saving. Its original data is retained. Check storage and retry saving.';
  if(/^interrupted$/i.test(reason))return 'This attempt stopped. Its recorded portion is saved; prepare a fresh drive to continue.';
  return String(reason).replaceAll('_',' ');
}
export function stressSummary(audit){
  if(!audit)return '';
  const vehicles=audit.counts?.vehicles||{},people=audit.counts?.pedestrians||{};
  const pending=audit.motion_measurement_ready===false||audit.series?.motion_samples===0;
  return (pending?'Traffic check incomplete; motion needs another sample.':(audit.sustained_passed??audit.passed)?'Traffic check met the local target.':'Traffic check below the local target.')+
    ` Forward viewing area: ${vehicles.front_frustum_100m??'unmeasured'} vehicles and ${people.front_frustum_100m??'unmeasured'} pedestrians. `+
    (pending?'Motion not measured yet. ':`Moving there: ${vehicles.moving_front_frustum??'unmeasured'} vehicles and ${people.moving_front_frustum??'unmeasured'} pedestrians. `)+
    (audit.series?`Density below target in ${audit.series.density_failures} of ${audit.series.samples} checks. `:'')+'Buildings may hide some actors.';
}
export function missionState(p,local={}) {
  const d=p.presentation||{},guided=!!d.guided,phase=guided?d.status:'IDLE',arm=d.arm||0,mode=d.modes?.[arm]||'NORMAL';
  const initialWorld=['IDLE','COMPLETE','CANCELLED'].includes(phase)||d.preloaded&&d.awaiting_choice;
  const preparingWorld=p.simulationStarting||local.launchPending&&!p.connected||
    d.preloaded&&d.awaiting_choice&&phase!=='CHOOSING'||local.preloadRequested&&!local.pageAdmitted&&['IDLE','COMPLETE','CANCELLED'].includes(phase);
  const driveLabel=local.firstMode==='NORMAL'?'Start the normal drive':local.firstMode==='ROBOSPHERE'?'Start the protected drive':'Start the drive';
  const ownPage=!local.pageId||!d.page_id||d.page_id===local.pageId;
  const base={phase,arm,mode,action:null,label:'',camera:false,choices:false,loadingDrive:false,loadStep:4,freeGPU:ownPage&&!preparingWorld&&!!p.simulatorStop?.available&&
    !['STOPPED','STOPPING'].includes(p.simulatorStop?.status)&&!p.isReplay&&!p.simulationStarting&&!p.restarting};
  const state=(screen,title,detail,extra={})=>({...base,screen,title,detail,...extra});
  const loadingWorld=(title,detail,loadStep=0)=>state('choose',title,detail,{choices:true,label:driveLabel,loadingDrive:true,loadStep,freeGPU:false});
  // A saved result belongs to the comparison, not the native connection.
  if(guided&&!local.newDrive&&['RESULTS','FINISHING','COMPLETE'].includes(phase)&&d.pair_id){
    const finishing=!!(phase==='FINISHING'||p.simulatorStop?.status==='STOPPING'||local.commandPending||local.shutdownPending);
    return state('comparison','Your two recorded drives',phase==='FINISHING'?
      'Preparing both videos before closing the simulator. Your results stay here.':
      phase==='COMPLETE'?'Your recordings are saved. Playback remains available with CARLA closed.':d.finish_error||'Review both recordings, then Finish to close CARLA and free the GPU.',
      {action:finishing?null:p.simulatorStop?.status==='FAILED'?'FREE_GPU':phase==='COMPLETE'?'NEW_DRIVE':'FINISH',label:finishing?'Saving & closing…':p.simulatorStop?.status==='FAILED'?'Retry GPU release':phase==='COMPLETE'?'Start a new drive':d.finish_error?'Retry saving & closing':'Finish',loadingDrive:finishing,freeGPU:false});
  }
  if(local.shutdownPending||p.simulatorStop?.status==='STOPPING')return state('releasing','Freeing the GPU','Saving recorded data, closing CARLA and verifying its processes have exited.',{freeGPU:false});
  if(p.simulatorStop?.status==='FAILED')return state('fault','CARLA could not close',p.simulatorStop.error||'Open Menu for runtime details.',{action:'FREE_GPU',label:'Retry GPU release'});
  if(p.simulationStarting||local.launchPending&&!p.connected)return loadingWorld('Starting the simulator','Launching CARLA. Choose your first drive while the city loads.');
  if(p.controlMode==='EMERGENCY_STOP')return state('emergency','Emergency stop is active','The vehicle is held. Release the stop to continue with available session actions.',{action:p.fresh&&p.controller?'RELEASE':null,label:'Release emergency stop'});
  if(p.simulatorStart?.status==='FAILED'&&!p.connected)return state('fault','The simulator could not start',p.simulatorStart.error||p.operationError||'Open Menu to inspect the runtime.',{action:'START_SIMULATION',label:'Try starting simulation',freeGPU:false});
  if(!p.connected&&p.transportAlive&&guided&&preparation[phase])return state('loading','Preparing your drive',preparation[phase][1],{loadingDrive:true,label:driveLabel});
  if(!p.connected)return p.simulatorStop?.status!=='STOPPED'&&guided&&!['COMPLETE','CANCELLED'].includes(phase)?state('fault','Connection lost','The drive has been stopped. Reconnect to inspect its saved outcome.',{action:'CONNECT',label:'Reconnect camera & session'}):
    state('welcome','Take the driver’s view.','Compare reactive sensor driving and predictive RULE in the same Mercedes.',{action:'START_SIMULATION',label:'Start simulation',freeGPU:false});
  if(!p.fresh)return phase==='DRIVING'?state('driving',modeLabel(mode),'Waiting for fresh camera and vehicle data.',{camera:true}):initialWorld?loadingWorld('Connecting the session','Waiting for current camera and vehicle data. Your drive will be available when the city is ready.'):
    state('loading','Connecting the session','Waiting for current camera and vehicle data. Driving remains stopped.');
  if(local.preloadError)return state('fault','Your fresh drive could not be prepared',local.preloadError,{action:'PREPARE_HERE',label:'Try preparing a fresh drive',freeGPU:false});
  if(local.pageId&&local.preloadRequested&&!local.pageAdmitted&&d.page_id!==local.pageId)
    return loadingWorld('Preparing your fresh drive','Saving and stopping the previous page’s attempt before rebuilding a new starting scene.',1);
  if(!ownPage)return state(phase==='DRIVING'?'driving':'choose','This session is open in another page','The current attempt continues. Preparing a new drive here explicitly saves and stops it.',{camera:phase==='DRIVING',action:'PREPARE_HERE',label:'Prepare a fresh drive here',freeGPU:false});
  if(guided&&p.controller===false&&!d.awaiting_choice&&!['COMPLETE','CANCELLED'].includes(phase))return state('driving','This drive is controlled by another page','You can watch this session, use Emergency stop, or Free GPU to close it.',{camera:phase==='DRIVING'});
  if(local.commandPending&&phase==='CHOOSING')return loadingWorld('Starting your selected drive','Checking the selected car, sensors and recording before moving.',3);
  if(guided&&d.preloaded&&d.awaiting_choice&&phase!=='ERROR'){
    const ready=phase==='CHOOSING';
    const progress=ready?'The shared city is ready and held at its saved start.':preparation[phase]?.[1]||'Preparing the same seeded city for either drive.';
    const actual=p.population?.actual;
    return state('choose',ready?'Which world would you like to see first?':'Your city is preparing',
      progress+(ready&&actual?` Actual: ${actual.vehicles??'unmeasured'} vehicles and ${actual.pedestrians??'unmeasured'} pedestrians.`:' Requests 60 vehicles and 100 pedestrians; actual counts are checked.')+' Both drives: the same Mercedes and sensor rig.',
      {choices:true,action:ready&&local.firstMode?'START_GUIDED':null,label:driveLabel,loadingDrive:!ready,loadStep:ready?4:phase==='READY'?3:phase==='PREPARING'?2:1,freeGPU:ready&&base.freeGPU});
  }
  if(guided&&preparation[phase])return state(d.preloaded&&arm===0&&['SELECTING','READY','STARTING'].includes(phase)?'choose':'loading',
    ['SELECTING','READY','STARTING'].includes(phase)?'Starting your drive':preparation[phase][0],preparation[phase][1],
    {choices:!!d.preloaded&&arm===0&&['SELECTING','READY','STARTING'].includes(phase),loadingDrive:true,
      label:phase==='FINALIZING'?'Saving this drive…':arm===1||phase==='RESTORING'?'Preparing the other drive…':driveLabel});
  if(guided&&d.preloaded&&phase!=='CHOOSING'&&!['DRIVING','AWAITING_NEXT','RESULTS','ERROR','COMPLETE','CANCELLED'].includes(phase))return state('loading','Preparing the shared world','Building a seeded city with a requested 60 vehicles and 100 pedestrians. Both drives use this starting scene.');
  if(guided&&phase==='DRIVING')return state('driving',modeLabel(mode),mode==='NORMAL'?
    'Normal follows the route and signals with reactive sensor braking. Project motion prediction is off.':'The same sensor braking plus predictive RULE. Paths may change; coral: people, cyan: other paths. RL is not active.',
    {camera:true,action:local.commandPending?null:'NEXT',loadingDrive:!!local.commandPending,label:local.commandPending?'Saving this drive…':arm===0?nextLabel(mode):'End drive & compare'});
  if(guided&&phase==='AWAITING_NEXT'){
    const run=p.journeyComparison?.pair_id===d.pair_id?p.journeyComparison?.runs?.[mode]:d.runs?.[mode];
    return state('outcome',run?.status==='COLLISION'?`The ${mode==='NORMAL'?'normal':'protected'} drive ended after a contact.`:'First attempt saved.',
      'Review what happened. The other drive starts only when you choose to continue.',{action:'NEXT',label:nextLabel(mode),run});
  }
  if(guided&&phase==='RESULTS')return state('comparison','Your two attempts','These are recorded observations. Matching starts do not mean identical traffic reactions.',{action:'FINISH',label:'Finish'});
  if(guided&&phase==='ERROR')return state('fault','This step needs attention',missionFailure(d.reason),{
    action:['STOPPING','PREPARING','READY','RESTORING','RECOVERING','SELECTING'].includes(d.failed_phase)?'RETRY_STEP':null,
    label:d.pair_id?'Retry preparing the other drive':'Retry preparing this drive'});
  if(guided&&d.preloaded&&phase==='CANCELLED'&&local.pageAdmitted)return state('fault','This attempt has stopped',
    'Its recorded portion is kept. Prepare a fresh beginning here before starting another drive.',
    {action:'PREPARE_HERE',label:'Prepare a fresh drive here',freeGPU:!!d.prepared_condition_id&&base.freeGPU});
  if(!guided&&!['IDLE','COMPLETE','CANCELLED','ERROR'].includes(d.status||'IDLE')||['STARTING','RUNNING'].includes(p.journey?.status))
    return state('driving','A drive is in progress','Use Menu to inspect this session, or Free GPU to close it.',{camera:true});
  if(local.preloadRequested&&!local.pageAdmitted&&['IDLE','COMPLETE','CANCELLED'].includes(d.status||'IDLE'))
    return loadingWorld('Preparing the shared world','The city is loading before you choose a driver. No drive has started.');
  return state('choose','Which world would you like to see first?',
    'One prepared chaos scene and the same Mercedes. Both use sensor braking; يا رب تسترها adds predictive RULE. RL is not active.',
    {choices:true,action:local.firstMode?'START_GUIDED':null,label:driveLabel});
}
