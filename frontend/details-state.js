import {driveState} from './drive-state.js';

export const detailGroups=[
  ['run','Run setup','Automatic presentation or a custom drive'],
  ['view','View','Camera, overlays and measured details'],
  ['results','Results','Saved comparisons and recordings'],
  ['system','System','Reset, GPU and research settings'],
];

// Navigation is local UI state. Opening, Back and Close never issue commands.
export class DetailsNavigation {
  constructor(){this.stack=['root'];}
  get page(){return this.stack.at(-1);}
  open(page){if(page!==this.page)this.stack.push(page);}
  back(){if(this.stack.length>1)this.stack.pop();return this.page;}
  reset(){this.stack=['root'];}
}

export function configurationReason(p){
  if(driveState(p).configurationLocked)return 'This run is active. Stop it before changing its setup.';
  if(p.isReplay)return 'Recorded playback is read-only.';
  if(!p.fresh)return 'Connect CARLA before applying changes.';
  if(!p.controller)return 'This page does not own vehicle control.';
  return '';
}

export function availableRecordings(pair){
  return Object.entries(pair?.runs||{}).flatMap(([mode,run])=>{
    const match=String(run.recording||'').replaceAll('\\','/').match(/\/normal_city\/(run_[a-f0-9]{32})$/);
    return match?[{mode,run,root:'/runs/normal_city/'+match[1]+'/'}]:[];
  });
}

export function recordedConditionsMatch(pair){
  const modes=pair.driver_modes||['ROBOSPHERE','NORMAL'];
  const [a,b]=modes.map(m=>pair.runs?.[m]);
  if(!a?.setup||!b?.setup)return false;
  const x=a.setup,y=b.setup;
  const sensorProtocols=['SENSOR_REACTIVE_PREDICTIVE_V1','EGYPT_COMPLETE_DRIVERS_V1'];
  const sensorPair=sensorProtocols.includes(x.protocol)||sensorProtocols.includes(y.protocol);
  if(sensorPair&&x.protocol!==y.protocol)return false;
  if(x.live_speed_changed||y.live_speed_changed)return false;
  const same=(u,v)=>{
    if(u===v)return true;
    if(!u||!v||typeof u!=='object'||typeof v!=='object')return false;
    const keys=Object.keys(u);return keys.length===Object.keys(v).length&&keys.every(k=>Object.hasOwn(v,k)&&same(u[k],v[k]));
  };
  if(!['map','blueprint','destination','speed_kmh','population','weather','actual_population'].every(k=>x[k]!=null&&y[k]!=null&&same(x[k],y[k])))return false;
  if(sensorPair&&!['vehicle_geometry','vehicle_physics','sensor_configuration'].every(key=>x[key]!=null&&y[key]!=null&&same(x[key],y[key])))return false;
  for(const key of ['runtime_rates','render_configuration'])if((x[key]!=null||y[key]!=null)&&(!x[key]||!y[key]||!same(x[key],y[key])))return false;
  if((x.comparison_scenario||y.comparison_scenario)&&!['comparison_scenario','perception_profile'].every(key=>x[key]!=null&&y[key]!=null&&same(x[key],y[key])))return false;
  const valid=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
  if(![x.origin?.location,y.origin?.location,x.origin?.rotation,y.origin?.rotation].every(valid))return false;
  if(Math.hypot(...x.origin.location.map((v,i)=>v-y.origin.location[i]))>.5||x.origin.rotation.some((v,i)=>Math.abs(((v-y.origin.rotation[i]+180)%360+360)%360-180)>1))return false;
  return ![2,3,4,5,6,7].includes(pair.version)||!!x.initial_condition_id&&x.initial_condition_id===y.initial_condition_id&&
    a.initial_condition_audit?.passed===true&&b.initial_condition_audit?.passed===true;
}
