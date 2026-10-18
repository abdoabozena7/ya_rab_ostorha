// Native phases determine actions. Button labels never determine commands.
const preparation={SELECTING:['Preparing your selected car','The world is already prepared. Attaching the camera and checking fresh sensors for this car.'],STOPPING:['Holding the vehicle','Waiting for a full stop and the previous recording to close.'],
  PREPARING:['Preparing your drive','Building the route and native traffic. The live view comes next.'],
  READY:['Checking the starting scene','Checking traffic, camera and sensors before recording.'],
  STARTING:['Starting the recording','The car will move when fresh sensor frames are ready.'],
  FINALIZING:['Saving this attempt','Stopping the car and closing its recording before continuing.'],
  RESTORING:['Preparing the other drive','Rebuilding and checking the same starting scene. Traffic may react differently.'],
  RECOVERING:['Checking the sensors','Waiting for fresh sensor frames and a verified starting scene.']};
export const modeLabel=m=>m==='NORMAL'?'Normal drive':'Protected drive';
export const nextLabel=m=>m==='NORMAL'?'See the solution now':'See the world before our solution';
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
  const base={phase,arm,mode,action:null,label:'',camera:false,choices:false,freeGPU:!!p.simulatorStop?.available&&
    !['STOPPED','STOPPING'].includes(p.simulatorStop?.status)&&!p.isReplay&&!p.simulationStarting&&!p.restarting};
  const state=(screen,title,detail,extra={})=>({...base,screen,title,detail,...extra});
  if(local.shutdownPending||p.simulatorStop?.status==='STOPPING')return state('releasing','Freeing the GPU','Saving recorded data, closing CARLA and verifying its processes have exited.',{freeGPU:false});
  if(p.simulatorStop?.status==='FAILED')return state('fault','CARLA could not close',p.simulatorStop.error||'Open Menu for runtime details.',{action:'FREE_GPU',label:'Retry GPU release'});
  if(p.simulationStarting||local.launchPending&&!p.connected)return state('loading','Starting the simulator','Launching CARLA. The camera and session will connect next.',{freeGPU:false});
  if(p.controlMode==='EMERGENCY_STOP')return state('emergency','Emergency stop is active','The vehicle is held. Release the stop to continue with available session actions.',{action:p.fresh&&p.controller?'RELEASE':null,label:'Release emergency stop'});
  if(p.simulatorStart?.status==='FAILED'&&!p.connected)return state('fault','The simulator could not start',p.simulatorStart.error||p.operationError||'Open Menu to inspect the runtime.',{action:'START_SIMULATION',label:'Try starting simulation',freeGPU:false});
  if(!p.connected)return p.simulatorStop?.status!=='STOPPED'&&guided&&!['COMPLETE','CANCELLED'].includes(phase)?state('fault','Connection interrupted','The drive has been stopped. Reconnect to inspect its saved outcome.',{action:'CONNECT',label:'Reconnect camera & session'}):
    state('welcome','Take the driver’s view.','Watch the same starting scene with and without RULE protection.',{action:'START_SIMULATION',label:'Start simulation',freeGPU:false});
  if(!p.fresh)return state('loading','Connecting the session','Waiting for current camera and vehicle data. Driving remains stopped.');
  if(guided&&p.controller===false&&!d.awaiting_choice&&!['COMPLETE','CANCELLED'].includes(phase))return state('driving','This drive is controlled by another page','You can watch this session, use Emergency stop, or Free GPU to close it.',{camera:phase==='DRIVING'});
  if(local.commandPending)return state('loading','Applying your action','Waiting for the current step to confirm. Recorded outcomes are kept.');
  if(guided&&d.preloaded&&d.awaiting_choice&&phase!=='ERROR'){
    const ready=phase==='CHOOSING';
    const progress=ready?'The shared city is ready and held at its saved start.':preparation[phase]?.[1]||'Preparing the same seeded city for either drive.';
    const actual=p.population?.actual;
    return state('choose',ready?'Which world would you like to see first?':'Your city is preparing',
      progress+(ready&&actual?` Actual: ${actual.vehicles??'unmeasured'} vehicles and ${actual.pedestrians??'unmeasured'} pedestrians.`:' Requests 60 vehicles and 100 pedestrians; actual counts are checked.')+' Normal: Lincoln. Protected: Mercedes.',
      {choices:true,action:ready&&local.firstMode?'START_GUIDED':null,label:local.firstMode==='NORMAL'?'Start the normal drive':'Start the protected drive'});
  }
  if(guided&&preparation[phase])return state('loading',...preparation[phase]);
  if(guided&&d.preloaded&&phase!=='CHOOSING'&&!['DRIVING','AWAITING_NEXT','RESULTS','ERROR','COMPLETE','CANCELLED'].includes(phase))return state('loading','Preparing the shared world','Building a seeded city with a requested 60 vehicles and 100 pedestrians. Both drives use this starting scene.');
  if(guided&&phase==='DRIVING')return state('driving',modeLabel(mode),mode==='NORMAL'?
    'Watch how the car follows the route with obstacle protection off.':'Watch when RULE protection slows or stops the car. Contacts are still possible.',
    {camera:true,action:'NEXT',label:arm===0?nextLabel(mode):'End drive & compare'});
  if(guided&&phase==='AWAITING_NEXT'){
    const run=p.journeyComparison?.pair_id===d.pair_id?p.journeyComparison?.runs?.[mode]:d.runs?.[mode];
    return state('outcome',run?.status==='COLLISION'?`The ${mode==='NORMAL'?'normal':'protected'} drive ended after a contact.`:'First attempt saved.',
      'Review what happened. The other drive starts only when you choose to continue.',{action:'NEXT',label:nextLabel(mode),run});
  }
  if(guided&&phase==='RESULTS')return state('comparison','Your two attempts','These are recorded observations. Matching starts do not mean identical traffic reactions.',{action:'FINISH',label:'Finish'});
  if(guided&&phase==='ERROR')return state('fault','This step needs attention',d.reason||'Open Menu for diagnostics.',{
    action:['STOPPING','PREPARING','READY','RESTORING','RECOVERING','SELECTING'].includes(d.failed_phase)?'RETRY_STEP':null,
    label:d.pair_id?'Retry preparing the other drive':'Retry preparing this drive'});
  if(!guided&&!['IDLE','COMPLETE','CANCELLED','ERROR'].includes(d.status||'IDLE')||['STARTING','RUNNING'].includes(p.journey?.status))
    return state('driving','A drive is in progress','Use Menu to inspect this session, or Free GPU to close it.',{camera:true});
  if(local.preloadRequested&&['IDLE','COMPLETE','CANCELLED'].includes(d.status||'IDLE'))
    return state('loading','Preparing the shared world','The city is loading before you choose a driver. No drive has started.');
  return state('choose','Which world would you like to see first?',
    'One prepared chaos scene. Normal uses a Lincoln; our protected drive uses a Mercedes coupe. Different vehicle physics can affect results.',
    {choices:true,action:local.firstMode?'START_GUIDED':null,label:local.firstMode==='NORMAL'?'Start the normal drive':'Start the protected drive'});
}
