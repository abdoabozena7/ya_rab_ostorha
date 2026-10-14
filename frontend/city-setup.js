import {trafficPreparationReason} from './traffic-preparation.js';
import {showWorkspace} from './presentation-ui.js';

export const CITY_PRESETS = {
  CALM: {chaos_percent:0,vehicle_count:20,pedestrian_count:15,crossing_percent:5,driver_behavior:'NORMAL',light_compliance_percent:100,speed_behavior:'NORMAL'},
  BUSY: {chaos_percent:45,vehicle_count:40,pedestrian_count:30,crossing_percent:30,driver_behavior:'BUSY',light_compliance_percent:80,speed_behavior:'NORMAL'},
  CHAOTIC: {chaos_percent:85,vehicle_count:50,pedestrian_count:35,crossing_percent:60,driver_behavior:'UNREGULATED',light_compliance_percent:35,speed_behavior:'FAST'}
};

export function cityPopulation(base, values) {
  const result = {...base,...values};
  for (const [key,max] of Object.entries({vehicle_count:75,pedestrian_count:50,chaos_percent:100,crossing_percent:60,seed:2147483647,light_compliance_percent:100})) {
    if (!Number.isInteger(result[key]) || result[key]<0 || result[key]>max) throw new Error(`${key}: choose a whole value from 0 to ${max}.`);
  }
  if (!['SLOW','NORMAL','FAST'].includes(result.speed_behavior)) throw new Error('Choose a traffic pace.');
  return result;
}

export function installCitySetup(p, preparation, tools, startJourney) {
  const $=id=>document.getElementById(id);
  const panel=document.createElement('section'); panel.className='city-setup';
  panel.setAttribute('aria-label','Live city setup');
  panel.innerHTML=`<div class="city-setup-heading"><div><h3>Live city</h3><p class="muted">Prepare traffic, choose a route, then drive.</p></div><div class="city-presets" aria-label="City presets"><button data-city-preset="CALM">Calm</button><button data-city-preset="BUSY">Busy</button><button data-city-preset="CHAOTIC">Chaotic</button></div></div>
  <div class="city-setup-columns"><fieldset><legend>Traffic & people</legend>
    <label for="cityChaos">Chaos <output id="cityChaosValue">0%</output></label><input id="cityChaos" type="range" min="0" max="100" step="5" value="0"><p class="field-hint">More lane changes, varied speeds and less orderly drivers.</p>
    <div class="city-field-pair"><div><label for="cityVehicles">Traffic vehicles</label><input id="cityVehicles" type="number" min="0" max="75" value="25"></div><div><label for="cityWalkers">Pedestrians</label><input id="cityWalkers" type="number" min="0" max="50" value="20"></div></div>
    <label for="cityCrossing">Road crossing <output id="cityCrossingValue">5%</output></label><input id="cityCrossing" type="range" min="0" max="60" step="5" value="5">
    <div class="city-field-pair"><div><label for="cityTrafficPace">Traffic pace</label><select id="cityTrafficPace"><option value="SLOW">Relaxed</option><option value="NORMAL">Normal</option><option value="FAST">Fast</option></select></div><div><label for="cityCompliance">Light compliance %</label><input id="cityCompliance" type="number" min="0" max="100" value="90"></div></div>
    <label for="citySeed">City seed</label><div class="city-seed-row"><input id="citySeed" type="number" min="0" max="2147483647" value="42"><button id="cityShuffle" aria-label="Choose a new city seed">Shuffle</button></div>
  </fieldset><fieldset><legend>Your drive</legend>
    <label>Protection configuration</label><div class="city-mode-buttons" role="group" aria-label="Driving protection"><button id="cityNormalMode" aria-pressed="false">Disable RULE</button><button id="citySafetyMode" aria-pressed="false">Enable RULE</button></div><p id="cityModeStatus" class="field-hint" role="status"></p>
    <label for="cityDrivePace">Destination driving pace</label><select id="cityDrivePace"><option value="20">Normal · 20 km/h</option><option value="25">Responsive · 25 km/h</option><option value="30">Brisk · 30 km/h</option></select><p class="field-hint">Target speed; road limits and live obstacles still apply.</p>
    <label>Destination</label><strong id="cityRouteName">Choose a destination</strong><button id="cityChooseRoute">Choose route on map ↗</button>
    <div class="city-start-actions"><button id="cityApply" class="primary">Apply city</button><button id="cityGo">Go to destination ↗</button></div><p id="citySetupStatus" class="muted" role="status"></p>
  </fieldset></div>`;
  const setup=$('setupPhase'); setup.querySelector('.analysis-heading h2').textContent='City & driving setup';
  setup.querySelector('.analysis-heading p').textContent='Direct controls for your next destination journey.';
  setup.querySelector('.analysis-heading').after(panel);
  const advanced=document.createElement('details');advanced.className='setup-advanced';advanced.innerHTML='<summary>Research comparison & graphics</summary>';
  advanced.append(setup.querySelector('.setup-columns'));setup.append(advanced);
  const fields={vehicle_count:'cityVehicles',pedestrian_count:'cityWalkers',chaos_percent:'cityChaos',crossing_percent:'cityCrossing',seed:'citySeed',light_compliance_percent:'cityCompliance',speed_behavior:'cityTrafficPace'};
  let session=null,dirty=false,behavior='NORMAL',error='',modePending=null;
  const describe=()=>{ $('cityChaosValue').value=$('cityChaos').value+'%';$('cityCrossingValue').value=$('cityCrossing').value+'%'; };
  const markDirty=()=>{dirty=true;error='';describe();};
  Object.values(fields).forEach(id=>$(id).oninput=markDirty);
  panel.querySelectorAll('[data-city-preset]').forEach(button=>button.onclick=()=>{
    const values=CITY_PRESETS[button.dataset.cityPreset];behavior=values.driver_behavior;
    for(const [key,id] of Object.entries(fields))if(key in values)$(id).value=values[key];
    markDirty();
  });
  $('cityShuffle').onclick=()=>{const seed=new Uint32Array(1);crypto.getRandomValues(seed);$('citySeed').value=seed[0]%2147483648;markDirty();};
  $('cityApply').onclick=()=>{
    try {
      const values=Object.fromEntries(Object.entries(fields).map(([key,id])=>[key,key==='speed_behavior'?$(id).value:Number($(id).value)]));
      const config=cityPopulation(p.population.requested,{...values,driver_behavior:behavior});
      if(preparation.request(config)) {dirty=false;error='';} else error=p.operationError||'City request was not sent.';
    } catch(e){error=e.message;}
  };
  for(const [id,enabled] of [['cityNormalMode',false],['citySafetyMode',true]])$(id).onclick=()=>{
    if(p.dashboardAction('safety_mode',{enabled,controller:'RULE'}))modePending=enabled;
  };
  $('cityDrivePace').onchange=()=>{ $('journeySpeed').value=$('cityDrivePace').value;$('journeySpeed').dispatchEvent(new Event('change')); };
  $('cityChooseRoute').onclick=()=>tools.open('routePanel','cityChooseRoute');
  $('cityGo').onclick=()=>{startJourney();showWorkspace('drive');};
  return {update(vehicle){
    if(session!==p.sessionId){session=p.sessionId;dirty=false;modePending=null;error='';}
    const current=p.population?.requested;
    if(!dirty && current && !['REQUESTED','APPLYING'].includes(preparation.state?.status)) {
      for(const [key,id] of Object.entries(fields))$(id).value=current[key]??(key==='chaos_percent'?0:$(id).value);
      behavior=current.driver_behavior||'NORMAL';describe();
    }
    const reason=trafficPreparationReason(p,vehicle),locked=!!reason;
    for(const el of panel.querySelectorAll('input,select,[data-city-preset],#cityShuffle,#cityApply,#cityNormalMode,#citySafetyMode')) {
      el.disabled=locked;el.title=reason;
    }
    $('cityChooseRoute').disabled=!p.fresh||p.isReplay||!p.controller||['REQUESTED','APPLYING'].includes(preparation.state?.status);
    if(modePending===p.safetySystem?.enabled || p.operationError)modePending=null;
    $('cityNormalMode').setAttribute('aria-pressed',String(p.safetySystem?.enabled===false));
    $('citySafetyMode').setAttribute('aria-pressed',String(p.safetySystem?.enabled===true));
    $('cityModeStatus').textContent=modePending!==null?'Applying protection choice…':p.safetySystem?.enabled===true?'YA RAB OSTORHA · '+p.safetySystem.controller:p.safetySystem?.enabled===false?'Normal · additional safety OFF':'Waiting for live protection state';
    $('cityGo').disabled=dirty||locked||modePending!==null||$('driveJourneyBtn').disabled;
    $('cityGo').title=dirty?'Apply your city changes first.':reason||$('driveJourneyBtn').title;
    $('cityRouteName').textContent=p.route?.destination?.name||'Choose a destination';
    $('citySetupStatus').textContent=error||p.operationError||(dirty?'Changes ready · Apply city before driving.':reason||preparation.state?.reason||`Live: ${p.population?.actual?.vehicles??'—'} vehicles · ${p.population?.actual?.pedestrians??'—'} pedestrians`);
  }};
}
