// A normal-city setup action. This never controls the ego or a research hazard.
export const TRAFFIC_COUNT = 25;
export const PEDESTRIAN_COUNT = 20;
const busyComparison = p => ['RESETTING','RUNNING','STOPPING'].includes(p.comparisonDemo?.phase) || ['QUEUED','RESETTING','RUNNING','STOPPING'].includes(p.comparisonV2?.phase);
const pending = state => ['REQUESTED','APPLYING'].includes(state?.status);
export const routeDestinationKey = route => route?.destination?.location ?
  JSON.stringify([route.destination.map ?? null, route.destination.location]) : null;
export function routeCrowdingReady(p) {
  const c=p.population?.route_crowding;
  return !!c?.active && c.status==='READY' && !!routeDestinationKey(p.route) &&
    routeDestinationKey({destination:c.destination})===routeDestinationKey(p.route) &&
    c.placed_count===p.population.actual?.vehicles && c.target_count===p.population.requested?.vehicle_count &&
    c.seed===p.population.requested?.seed && c.chaos_percent===p.population.requested?.chaos_percent;
}

// Setup completion is different from a circulating fleet's current count.
// Keep the native admission receipt through ordinary removal/replacement,
// while requiring a fresh receipt for another route or crowding operation.
export function routeCrowdingPrepared(p, preparation) {
  const c=p.population?.route_crowding, key=routeDestinationKey(p.route), state=preparation?.state;
  if(!c?.active || !key || routeDestinationKey({destination:c.destination})!==key ||
    c.target_count!==p.population.requested?.vehicle_count || c.seed!==p.population.requested?.seed ||
    c.chaos_percent!==p.population.requested?.chaos_percent || pending(state) || state?.status==='FAILED')return false;
  const result=p.dashboardResult, applied=result?.result?.population, receipt=applied?.route_crowding;
  const confirmed=state?.kind==='route' && state.status==='READY' && state.session_id===p.sessionId &&
    state.destination===key && state.actual_count===c.target_count &&
    preparation.requestedPopulation?.seed===c.seed && preparation.requestedPopulation?.chaos_percent===c.chaos_percent;
  if(confirmed && (result?.action!=='crowd_route' || result.operationId===state.operation_id))return true;
  if(result?.action==='crowd_route' && result.operationId) {
    return result.status==='APPLIED' && receipt?.route_id===c.route_id && receipt.seed===c.seed &&
      receipt.chaos_percent===c.chaos_percent && receipt.target_count===c.target_count &&
      routeCrowdingReady({...p,population:applied}) && applied.traffic_manager_connected===true &&
      Number.isInteger(applied.frame_id) && applied.npc_failed===0 && Array.isArray(applied.errors) && !applied.errors.length;
  }
  return (routeCrowdingReady(p) && p.population.traffic_manager_connected===true && p.population.npc_failed===0 &&
      Array.isArray(p.population.errors) && !p.population.errors.length);
}

export function trafficPrepared(p,preparation) {
  if(p.population?.route_crowding?.active)return routeCrowdingPrepared(p,preparation);
  const state=preparation?.state,request=preparation?.requestedPopulation;
  return state?.status==='READY' && state.session_id===p.sessionId && !!request &&
    Object.entries(request).every(([k,v])=>p.population?.requested?.[k]===v) &&
    p.population?.traffic_manager_connected===true &&
    p.population.actual?.vehicles===request.vehicle_count &&
    p.population.actual?.pedestrians===request.pedestrian_count &&
    p.population.actual?.controllers===request.pedestrian_count &&
    (request.pedestrian_count===0 || p.population.actual?.walkers_active===request.pedestrian_count);
}

export function trafficCommandBlocked(state, type, payload = {}) {
  if (!state || state.status === 'READY' || state.status === 'IDLE') return false;
  if (type === 'controls') {
    const c = payload.controls || {};
    return !(c.throttle === 0 && c.brake === 1 && (c.steering ?? 0) === 0);
  }
  if (['start_driving','start_journey'].includes(type)) return true;
  if (type === 'comparison') return payload.value?.mode !== 'STOP';
  // Keep the completion result attributable to this request while it is pending.
  return pending(state) && ['settings','population','crowd_route','scene','environment','scenario',
    'destination','clear_route','save_place','favorite_place','recording','world_reset',
    'restart_graphics','reset','safety_mode'].includes(type);
}

export function trafficPreparationReason(p, vehicle) {
  if (!p.fresh || !p.connected || p.isReplay) return 'Connect to live CARLA first.';
  if (!p.controller) return 'Take control of this page first.';
  if (p.restarting) return 'Wait for CARLA to reconnect.';
  if (p.recording || busyComparison(p)) return 'Finish the current recording or comparison first.';
  if (p.environment?.mode === 'TRAINING') return 'Return to Living city to prepare normal traffic.';
  if (p.controlMode !== 'PAUSED' || !Number.isFinite(vehicle?.speedMps) || Math.abs(vehicle.speedMps) > .15)
    return 'Stop driving and wait for the vehicle to stop first.';
  if (!p.population?.requested || !p.population?.actual) return 'Waiting for native population data.';
  if (pending(p.trafficPreparation) || p.dashboardResult?.status === 'PENDING') return 'Preparing the world; wait for completion.';
  return '';
}

export class TrafficPreparation {
  constructor(provider, stop, {now = () => performance.now(), timeoutMs = 30_000} = {}) {
    Object.assign(this, {provider, stop, now, timeoutMs});
    this.session = provider.sessionId;
    this.state = null;
  }

  request(requestedPopulation = null, {requireWalkers = true} = {}) {
    const p = this.provider;
    const reason = trafficPreparationReason(p, p.getVehicleState());
    if (reason) { if (!pending(this.state)) p.operationError = reason; return false; }
    // Retain the live seed, walkers, speeds and driver behavior. Only the count changes.
    const population = requestedPopulation ? {...requestedPopulation} : {...p.population.requested,
      vehicle_count: TRAFFIC_COUNT, pedestrian_count: PEDESTRIAN_COUNT, placement:'EGO_SURROUNDING',vehicle_mix:'MIXED'};
    if (!Number.isInteger(population.vehicle_count) || population.vehicle_count < 0 || population.vehicle_count > 75) {
      p.operationError = 'Choose 0–75 traffic vehicles.'; return false;
    }
    this.requestedPopulation = population;
    this.action = 'settings';
    this.completeCity = requireWalkers;
    this.stop('traffic_preparation');
    const previousOperation = p.dashboardResult?.operationId;
    // A previous failed preparation may be retried only by this explicit click.
    p.trafficPreparation = null;
    if (!p.dashboardAction('settings', {population})) {
      this.state = {status:'FAILED',reason:'Traffic request was not sent. Reconnect and try again.',session_id:p.sessionId};
      p.trafficPreparation = this.state;
      return false;
    }
    this.session = p.sessionId;
    this.previousOperation = previousOperation;
    this.started = this.now();
    this.errorBefore = p.operationError;
    this.state = {status:'REQUESTED',requested_count:population.vehicle_count,session_id:p.sessionId,reason:'Preparing traffic; driving is held.'};
    p.trafficPreparation = this.state;
    return true;
  }

  requestRouteCrowding(options = {}) {
    const p=this.provider, reason=trafficPreparationReason(p,p.getVehicleState());
    if(reason){if(!pending(this.state))p.operationError=reason;return false;}
    if(!p.route?.id || !routeDestinationKey(p.route) || p.route.arrived){p.operationError='Choose a destination first.';return false;}
    const seed=options.seed ?? p.population.requested.seed;
    const chaos=options.chaos_percent ?? p.population.requested.chaos_percent ?? 0;
    if(!Number.isInteger(seed)||seed<0||seed>2147483647||!Number.isInteger(chaos)||chaos<0||chaos>100){
      p.operationError='Choose a valid seed and randomness from 0–100%.';return false;
    }
    this.stop('traffic_preparation');
    this.previousOperation=p.dashboardResult?.operationId;
    p.trafficPreparation=null;
    this.action='crowd_route';this.destination=routeDestinationKey(p.route);this.routeId=p.route.id;
    this.completeCity=false;
    this.requestedPopulation={seed,chaos_percent:chaos};
    this.session=p.sessionId;this.started=this.now();
    const sent=p.dashboardAction('crowd_route',{route_id:p.route.id,seed,chaos_percent:chaos});
    this.errorBefore=p.operationError;
    this.state={status:sent?'REQUESTED':'FAILED',kind:'route',destination:this.destination,session_id:p.sessionId,
      reason:sent?'Crowding the selected road; driving is held.':'Road traffic request was not sent. Reconnect and try again.'};
    p.trafficPreparation=this.state;return sent;
  }

  update() {
    const p = this.provider;
    if (this.session !== p.sessionId) {
      this.session = p.sessionId;
      this.state = null;
      p.trafficPreparation = null;
      return;
    }
    // A controlled scenario owns a different actor population. The normal-city
    // request must neither claim success there nor block its own setup workflow.
    if (p.environment?.mode === 'TRAINING') {
      this.state = null;
      p.trafficPreparation = null;
      return;
    }
    if (this.state?.kind==='route' && this.destination!==routeDestinationKey(p.route)) {
      this.state=null;p.trafficPreparation=null;return;
    }
    if (!this.state || this.state.status === 'READY') return;
    const fail = reason => {this.state = {...this.state,status:'FAILED',reason};};
    if (!p.fresh || !p.connected || p.isReplay) fail('Connection lost during preparation. Native completion is unverified.');
    else if (!p.controller) fail('Control moved to another page. Traffic completion is unverified.');
    else if (p.operationError && p.operationError !== this.errorBefore) fail(p.operationError);
    else {
      const result = p.dashboardResult;
      if (result?.action === this.action && result.operationId && result.operationId !== this.previousOperation) {
        if (result.status === 'REJECTED') fail(result.error || 'CARLA rejected traffic preparation.');
        else if (result.status === 'PENDING') this.state = {...this.state,status:'APPLYING'};
        else if (result.status === 'APPLIED') {
          const population = p.population, applied = result.result?.population;
          const frame = p.getVehicleState().frame;
          const crowding=result.result?.crowding;
          const isRoute=this.state.kind==='route';
          const count = isRoute ? crowding?.target_count : this.state.requested_count;
          const completeCity = this.completeCity;
          const valid = Number.isInteger(count) && count>=0 && count<=75 && population?.traffic_manager_connected === true &&
            population.frame_id === frame && Number.isInteger(frame) &&
            Number.isInteger(applied?.frame_id) && population.frame_id >= applied.frame_id &&
            population.requested?.vehicle_count === count && applied?.requested?.vehicle_count === count &&
            Object.entries(this.requestedPopulation).every(([k,v]) => population.requested?.[k] === v && applied?.requested?.[k] === v) &&
            population.actual?.vehicles === count && (isRoute || applied?.actual?.vehicles === count) &&
            (!completeCity || [population,applied].every(v=>v.actual?.pedestrians === this.requestedPopulation.pedestrian_count &&
              v.actual?.controllers === this.requestedPopulation.pedestrian_count && v.walkers_failed === 0)) &&
            population.npc_failed === 0 && applied?.npc_failed === 0 &&
            Array.isArray(population.errors) && population.errors.length === 0 &&
            Array.isArray(applied?.errors) && applied.errors.length === 0;
          const routeValid=!isRoute || routeCrowdingReady(p) && crowding?.route_id===this.routeId &&
            population.route_crowding?.route_id===this.routeId &&
            routeDestinationKey({destination:crowding.destination})===this.destination;
          const awaitingAdmission=isRoute && Number.isInteger(count) && count>0 && count<=75 &&
            population?.traffic_manager_connected===true && Number.isInteger(frame) && Number.isInteger(applied?.frame_id) &&
            population.frame_id>=applied.frame_id && population.requested?.vehicle_count===count && applied.requested?.vehicle_count===count &&
            Object.entries(this.requestedPopulation).every(([k,v])=>population.requested?.[k]===v && applied.requested?.[k]===v) &&
            population.npc_failed===0 && applied.npc_failed===0 && Array.isArray(population.errors) && !population.errors.length &&
            Array.isArray(applied.errors) && !applied.errors.length && crowding?.route_id===this.routeId &&
            population.route_crowding?.route_id===this.routeId &&
            routeDestinationKey({destination:crowding.destination})===this.destination &&
            routeDestinationKey({destination:population.route_crowding.destination})===this.destination;
          if (valid && routeValid && (!completeCity || this.requestedPopulation.pedestrian_count===0 || population.actual?.walkers_active===this.requestedPopulation.pedestrian_count)) this.state = {...this.state,status:'READY',actual_count:count,native_frame:frame,
            operation_id:result.operationId,reason:isRoute?`${count} vehicles placed along your ${Math.round(crowding.route_length_m)} m road. Ready to drive.`:`${count} traffic vehicles confirmed in CARLA at frame ${frame}. Ready to drive.`};
          else if(awaitingAdmission || valid && completeCity || completeCity &&
            population?.admitted?.vehicles===this.requestedPopulation.vehicle_count &&
            population?.admitted?.pedestrians===this.requestedPopulation.pedestrian_count &&
            population.npc_failed===0 && population.walkers_failed===0 && !population.errors?.length &&
            Object.entries(this.requestedPopulation).every(([k,v])=>population.requested?.[k]===v))this.state={...this.state,status:'APPLYING',
            reason:`Waiting for native traffic confirmation: ${population.actual?.vehicles??'—'}/${count} vehicles. Driving stays held.`};
          else fail(`Road traffic preparation incomplete: ${population?.actual?.vehicles ?? 'unknown'}/${count??'unknown'} vehicles. Check simulator details and retry explicitly.`);
        }
      }
      if (pending(this.state) && this.now() - this.started > this.timeoutMs)
        fail('Traffic completion timed out. Driving remains held; no automatic retry.');
    }
    p.trafficPreparation = this.state;
  }
}

export function installTrafficPreparation(provider, stop, doc = document) {
  const preparation = new TrafficPreparation(provider, stop);
  const area = doc.createElement('div');
  area.className = 'traffic-preparation';
  const button = doc.createElement('button');
  button.id = 'prepareTrafficBtn';
  button.type = 'button';
    button.textContent = 'Prepare surrounding traffic';
  const status = doc.createElement('p');
  status.id = 'trafficPreparationStatus';
  status.className = 'muted';
  status.setAttribute('role','status');
  button.setAttribute('aria-describedby',status.id);
  area.append(button,status);
  doc.getElementById('primaryDriveAction').before(area);
  button.onclick = () => preparation.requestRouteCrowding();
  return {
    preparation,
    update(vehicle) {
      preparation.update();
      const reason = trafficPreparationReason(provider,vehicle) || (!provider.route?.destination || provider.route.arrived ? 'Choose a destination first.' : '');
      button.disabled = !!reason;
      button.title = reason;
      button.textContent = pending(preparation.state) ? 'Crowding your road…' : 'Make your road crowded';
      status.textContent = preparation.state?.reason || reason ||
        `Before driving: ${provider.population?.actual?.vehicles ?? '—'} traffic vehicles currently in CARLA.`;
      if (preparation.state?.status === 'READY') status.textContent += ` Current: ${provider.population?.actual?.vehicles ?? '—'}.`;
      const held = preparation.state && preparation.state.status !== 'READY';
      if (held) for (const id of ['primaryDriveAction','startDrivingBtn','startJourneyBtn','phoneJourneyBtn','driveJourneyBtn','demoWithBtn','demoWithoutBtn']) {
        const control = doc.getElementById(id);
        if (control) {control.disabled = true; control.title = preparation.state.reason;}
      }
    }
  };
}
