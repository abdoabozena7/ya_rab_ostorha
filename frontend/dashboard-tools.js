const $ = id => document.getElementById(id);
const weatherFields = {cloudiness:'settingCloud', precipitation:'settingRain', wetness:'settingWet',
  fog_density:'settingFog', sun_altitude_angle:'settingSun', sun_azimuth_angle:'settingSunAzimuth'};
const svgNamespace = 'http://www.w3.org/2000/svg';

export class DashboardTools {
  constructor(provider, controls, clearControls, options = {}) {
    Object.assign(this, {provider, controls, clearControls, options});
    this.catalog = null; this.session = null; this.loading = false; this.retryAt = 0;
    this.selectedPlace = null; this.result = null; this.panel = null; this.panelTrigger = null;
    this.restartAfterSave = null; this.restartSeen = null;
    this.recordingPath = '';
    const populationAction = operation => { clearControls(); provider.dashboardAction('population', operation); };
    $('clearTrafficBtn').onclick = () => populationAction('clear_traffic');
    $('clearPedestriansBtn').onclick = () => populationAction('clear_pedestrians');
    $('resetPopulationBtn').onclick = () => populationAction('reset');
    $('respawnPopulationBtn').onclick = () => populationAction('respawn');
    const scenario = operation => { clearControls(); provider.dashboardAction('scenario',{operation}); };
    $('loadScenarioBtn').onclick = () => {
      clearControls(); provider.dashboardAction('scenario',{operation:'load',scenario_type:$('scenarioType').value,
        seed:Number($('scenarioSeed').value),split:$('scenarioSplit').value,difficulty:Number($('scenarioDifficulty').value)});
    };
    $('resetScenarioBtn').onclick = () => scenario('reset');
    $('startScenarioBtn').onclick = () => scenario('start');
    $('stopScenarioBtn').onclick = () => scenario('stop');
    $('livingCityBtn').onclick = () => { clearControls(); provider.dashboardAction('environment','LIVING_CITY'); };
    $('scenarioSplit').onchange = () => { $('scenarioSeed').value = {TRAIN:42,VALIDATION:1042,TEST:2042}[$('scenarioSplit').value]; };
    $('settingWorldProfile').onchange = () => {
      const profile = this.catalog?.urban_world_profiles?.[$('settingWorldProfile').value];
      if (profile) { $('settingTrafficCount').value=profile.vehicle_count; $('settingPedestrianCount').value=profile.pedestrian_count; }
    };
    $('recordRunBtn').onclick = () => { clearControls(); provider.dashboardAction('recording', {enabled:!provider.recording}); };
    $('applyRadiusBtn').onclick = () => provider.dashboardAction('inspector', Number($('nearbyRadius').value));
    $('clearRouteBtn').onclick = () => provider.dashboardAction('clear_route', null);
    $('worldResetBtn').onclick = () => { clearControls(); provider.dashboardAction('world_reset', null); };
    $('applySceneBtn').onclick = () => {
      if (this.catalog?.scenes?.[$('settingScene').value]) {
        clearControls(); provider.dashboardAction('scene',$('settingScene').value);
      }
    };
    $('applyProfileBtn').onclick = () => {
      const profile = this.catalog?.profiles?.[$('settingProfile').value];
      if (profile) { clearControls(); provider.dashboardAction('settings',{population:profile.population}); }
    };
    for (const id of Object.values(weatherFields)) $(id).oninput = () => { $('settingWeather').value = 'CUSTOM'; };
    $('settingWeather').onchange = () => {
      const values = this.catalog?.settings.weather_preset_values?.[$('settingWeather').value];
      if (values) for (const [key,id] of Object.entries(weatherFields)) $(id).value = values[key];
    };
    $('phoneToggleBtn').onclick = () => this.toggle('inGamePhone','phoneToggleBtn');
    $('mapDestinationsBtn').onclick = () => this.open('inGamePhone','mapDestinationsBtn');
    $('settingsBtn').onclick = () => { this.toggle('settingsPanel','settingsBtn'); this.load(true); };
    $('connectionSetupBtn').onclick = () => {
      this.open('settingsPanel','connectionSetupBtn');
      $('connectionSettings').open = true;
      $('connectionSettings').scrollIntoView({block:'start',behavior:this.scrollBehavior()});
      $('connectionSettings').querySelector('summary').focus({preventScroll:true});
      this.load(true);
    };
    $('sensorBtn').onclick = () => this.toggle('sensorPanel','sensorBtn');
    $('routeBtn').onclick = () => this.toggle('routePanel','routeBtn');
    $('miniMapToggle').onclick = () => this.toggle('routePanel','miniMapToggle');
    $('routeMap').onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); this.open('inGamePhone','routeMap');
      }
    };
    for (const [panel,button] of [['inGamePhone','closePhoneBtn'],['settingsPanel','closeSettingsBtn'],['sensorPanel','closeSensorBtn'],['routePanel','closeMapBtn']])
      $(button).onclick = () => this.close();
    $('panelBackdrop').onclick = () => this.close();
    document.addEventListener('keydown', event => {
      if (event.code === 'Escape') {
        if (this.panel) this.close();
        else if ($('cameraCard').classList.contains('camera-expanded')) this.expandCamera(false);
      }
      if (event.key === 'Tab' && this.panel) {
        const elements = [...$(this.panel).querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(el => el.getClientRects().length && !el.closest('[inert]'));
        if (!elements.length) return;
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    $('reconnectBtn').onclick = () => provider.connect();
    $('nativeReconnectBtn').onclick = () => { clearControls(); provider.reconnectNative(); provider.connect(); };
    $('nativeDisconnectBtn').onclick = () => { clearControls(); provider.dashboardAction('disconnect'); };
    $('takeControlBtn').onclick = () => { clearControls(); provider.takeControl(); };
    $('expandCameraBtn').onclick = () => this.expandCamera(!$('cameraCard').classList.contains('camera-expanded'));
    $('cameraView').onchange = () => {
      clearControls(); provider.dashboardAction('settings', {camera_view:$('cameraView').value});
    };
    $('settingsForm').onsubmit = event => { event.preventDefault(); this.apply(); };
    $('cleanImageBtn').onclick = () => {
      $('settingResolution').value = '800x450'; $('settingPostprocess').checked = false;
      $('settingMotionBlur').value = 0; $('settingBloom').value = 0;
      $('settingsStatus').textContent = 'Clear image settings ready. Select Apply changes to activate.';
    };
    $('restartGraphicsBtn').onclick = () => {
      const launch = {quality:$('settingQuality').value,resolution:$('settingWindow').value};
      this.restartAfterSave = launch;
      clearControls();
      if (!provider.dashboardAction('settings',{next_launch:launch})) {
        this.restartAfterSave = null; $('restartStatus').textContent = 'Take control in connection settings first.';
      } else $('restartStatus').textContent = 'Save settings then restart simulator…';
    };
    $('destinationSearch').oninput = () => { this.selectedPlace = null; this.renderPlaces(); };
    $('chooseDestinationBtn').onclick = () => {
      const text = $('destinationSearch').value.trim();
      const place = this.selectedPlace || this.catalog?.places.find(p => p.name === text || p.id === text);
      if (!place) { $('destinationStatus').textContent = 'Choose a destination from the search results first.'; return; }
      this.choose(place.id);
    };
    $('savePlaceBtn').onclick = () => {
      const name = $('savePlaceName').value.trim() || 'Saved place ' + new Date().toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'});
      clearControls(); provider.dashboardAction('save_place', name);
    };
    $('routeMap').onclick = event => {
      if (!this.project || !this.inverse) return;
      const point = $('routeMap').createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
      const matrix = $('routeMap').getScreenCTM(); if (!matrix) return;
      const nativePoint = point.matrixTransform(matrix.inverse());
      this.choose({location:this.inverse([nativePoint.x,nativePoint.y])});
    };

  }

  scrollBehavior() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'; }
  expandCamera(enlarged) {
    $('cameraCard').classList.toggle('camera-expanded',enlarged);
    $('expandCameraBtn').textContent = enlarged ? 'Shrink image' : 'Expand image';
    $('expandCameraBtn').setAttribute('aria-expanded',String(enlarged));
    if (!enlarged) $('expandCameraBtn').focus({preventScroll:true});
  }
  open(panel, trigger) {
    if (this.panel === panel) return;
    this.close(false);
    if (this.provider.controlMode === 'MANUAL') this.clearControls();
    this.panel = panel; this.panelTrigger = trigger; $(panel).hidden = false;
    $('panelBackdrop').hidden = false;
    document.body.classList.add('panel-open');
    for (const element of document.querySelectorAll('.app-header,.workspace,.app-footer,.skip-link')) element.inert = true;
    $(trigger)?.setAttribute('aria-expanded','true');
    $(panel).querySelector('button')?.focus();
    if (panel === 'inGamePhone') this.load();
  }
  close(returnFocus = true) {
    if (!this.panel) return;
    $(this.panel).hidden = true; $('panelBackdrop').hidden = true;
    document.body.classList.remove('panel-open');
    for (const element of document.querySelectorAll('.app-header,.workspace,.app-footer,.skip-link')) element.inert = false;
    $(this.panelTrigger)?.setAttribute('aria-expanded','false');
    if (returnFocus) $(this.panelTrigger)?.focus();
    this.panel = null;
  }
  toggle(panel, trigger) { if (this.panel === panel) this.close(); else this.open(panel,trigger); }

  choose(value) {
    this.clearControls();
    const accepted = this.provider.dashboardAction('destination',value);
    $('destinationStatus').textContent = $('mapSelectionStatus').textContent =
      accepted ? 'Planning from the current vehicle position…' : 'Take control in connection settings before selecting a destination.';
    if (accepted) this.close();
  }
  async load(force = false) {
    if (this.loading || !this.provider.fresh || this.provider.isReplay ||
        !force && (this.catalog || performance.now() < this.retryAt)) return;
    this.loading = true;
    const session = this.provider.sessionId;
    try {
      const catalog = await this.provider.catalog();
      if (session !== this.provider.sessionId || !this.provider.fresh) return;
      this.catalog = catalog; this.fillSettings(); this.renderPlaces(); this.renderRoads();
    } catch (error) { this.retryAt = performance.now()+2000; $('settingsStatus').textContent = error.message; }
    finally { this.loading = false; }
  }
  renderPlaces() {
    const list = $('placeResults'); list.replaceChildren();
    const query = $('destinationSearch').value.trim().toLocaleLowerCase();
    const places = this.catalog?.places.filter(p => p.name.toLocaleLowerCase().includes(query) ||
      String(p.road_id).includes(query)) ?? [];
    const groups = new Map();
    for (const place of places) {
      const name = place.favorite ? 'Favorites ★' : place.id.startsWith('saved-') ? 'Your saved places' :
        place.sector ? place.sector + ' · Road ' + place.road_id : 'Available places';
      if (!groups.has(name)) groups.set(name,[]);
      groups.get(name).push(place);
    }
    for (const [name, entries] of [...groups].sort(([a],[b]) => Number(b === 'Favorites ★')-Number(a === 'Favorites ★'))) {
      const title = document.createElement('div'); title.className = 'place-group'; title.textContent = name; list.append(title);
      for (const place of entries) {
        const button = document.createElement('button'); button.className = 'place-option'; button.type = 'button';
        button.textContent = place.name; button.dataset.placeId = place.id;
        button.classList.toggle('selected',this.selectedPlace?.id === place.id);
        button.onclick = () => {
          this.selectedPlace = place; $('destinationSearch').value = place.name;
          this.renderPlaces(); $('chooseDestinationBtn').focus();
        };
        button.setAttribute('aria-pressed',String(this.selectedPlace?.id === place.id));
        const row = document.createElement('div'); row.className = 'place-row'; row.setAttribute('role','listitem');
        const star = document.createElement('button'); star.type = 'button'; star.className = 'place-favorite';
        star.textContent = place.favorite ? '★' : '☆';
        star.setAttribute('aria-label',(place.favorite ? 'Remove from favorites: ' : 'Add to favorites: ') + place.name);
        star.disabled = !this.provider.fresh || !this.provider.controller || this.provider.isReplay;
        star.title = star.disabled ? 'Take control in connection settings first' : 'Favorites persist after reconnection';
        star.onclick = () => this.provider.dashboardAction('favorite_place',place.id);
        row.append(button,star); list.append(row);
      }
    }
    if (!places.length) list.textContent = this.catalog ? 'No results. Try an area name or select from the map.' : 'Waiting for map CARLA…';
  }
  fillSettings() {
    const s = this.catalog.settings;
    for (const [id, entries] of [['settingVehicle',s.vehicle_options.map(p => [p.id,p.name])],
      ['settingSpawn',s.spawn_options.map(p => [p.index,p.name])],
      ['settingWeather',[['CUSTOM','Custom'],...s.weather_presets.map(name => [name,({ClearNoon:'Clear — Noon',CloudyNoon:'Cloudy — Noon',WetNoon:'Wet ground',WetCloudyNoon:'Wet and cloudy',MidRainyNoon:'Moderate rain',HardRainNoon:'Heavy rain',SoftRainNoon:'Light rain',ClearSunset:'Clear sunset',CloudySunset:'Cloudy sunset',WetSunset:'Wet sunset',HardRainSunset:'Heavy rain sunset'})[name] || name])]],
      ['settingProfile',Object.entries(this.catalog.profiles || {}).map(([name,p]) => [name,name+' · '+p.population.vehicle_count+' / '+p.population.pedestrian_count])]]) {
      const select = $(id), previous = select.value; select.replaceChildren();
      for (const [value,text] of entries) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
      if (id === 'settingProfile' && entries.some(([value]) => value === previous)) select.value = previous;
    }
    const fields = {settingVehicle:s.vehicle,settingSpawn:s.spawn_index,settingResolution:s.camera_resolution,
      settingFov:s.camera_fov,settingHz:s.simulation_hz,settingQuality:s.next_launch.quality,
      settingWindow:s.next_launch.resolution,settingTrafficCount:s.population_saved.vehicle_count,
      settingPedestrianCount:s.population_saved.pedestrian_count,settingTrafficSpeed:s.population_saved.speed_behavior,
      settingFastWalk:s.population_saved.fast_walk_percent,settingSeed:s.population_saved.seed,
      settingDriverBehavior:s.population_saved.driver_behavior ?? 'NORMAL',
      settingCompliance:s.population_saved.light_compliance_percent ?? 90,
      settingCrossing:s.population_saved.crossing_percent ?? 5,
      settingWorldProfile:s.population_saved.world_profile ?? 'TRAINING_DEVELOPMENT',
      settingWeather:s.weather_preset,cameraView:s.camera_view,
      settingMotionBlur:s.camera_motion_blur,settingBloom:s.camera_bloom};
    for (const [id,value] of Object.entries(fields)) $(id).value = value ?? 0;
    $('settingPostprocess').checked = s.camera_postprocess === true;
    for (const [key,id] of Object.entries(weatherFields)) $(id).value = s.weather[key];
    const applied = s.active_launch;
    $('activeGraphics').textContent = applied ? 'Applied: ' + (applied.quality || 'unknown') +
      ' · ' + (applied.resolution || 'unknown resolution') +
      (applied.offscreen ? ' · displayed in dashboard' : '') : 'Applied graphics settings are unavailable.';
    $('effectsNote').textContent = s.camera_effects?.note || '';
    $('weatherApplied').textContent = 'Applied weather: '+s.weather_preset;
    if (!Object.keys(this.catalog.profiles || {}).length) {
      const option = document.createElement('option'); option.textContent = 'Waiting for performance measurements'; $('settingProfile').append(option);
    }
  }
  apply() {
    if (!this.catalog) return;
    const number = id => Number($(id).value), current = this.catalog.settings;
    const data = {weather:Object.fromEntries(Object.entries(weatherFields).map(([key,id]) => [key,number(id)])),
      next_launch:{quality:$('settingQuality').value,resolution:$('settingWindow').value},
      population:{vehicle_count:number('settingTrafficCount'),pedestrian_count:number('settingPedestrianCount'),
        speed_behavior:$('settingTrafficSpeed').value,fast_walk_percent:number('settingFastWalk'),seed:number('settingSeed'),
        driver_behavior:$('settingDriverBehavior').value,light_compliance_percent:number('settingCompliance'),
        crossing_percent:number('settingCrossing'),world_profile:$('settingWorldProfile').value}};
    if ($('settingWeather').value !== 'CUSTOM') { delete data.weather; data.weather_preset = $('settingWeather').value; }
    const candidates = {vehicle:$('settingVehicle').value,spawn_index:number('settingSpawn'),
      camera_view:$('cameraView').value,camera_resolution:$('settingResolution').value,
      camera_fov:number('settingFov'),simulation_hz:number('settingHz'),camera_postprocess:$('settingPostprocess').checked,
      camera_motion_blur:number('settingMotionBlur'),camera_bloom:number('settingBloom')};
    for (const [key,value] of Object.entries(candidates)) if (value !== current[key]) data[key] = value;
    this.clearControls();
    $('settingsStatus').textContent = this.provider.dashboardAction('settings',data) ? 'Applying live settings…' : 'Take control in connection settings first.';
  }
  disable(id, reason) { const button = $(id); button.disabled = !!reason; button.title = reason || ''; }
  render(state, controllable) {
    const p = this.provider;
    if (this.session !== p.sessionId) {
      this.session = p.sessionId; this.catalog = null; this.selectedPlace = null; this.result = null;
      this.project = this.inverse = null; $('roadGeometry').replaceChildren(); $('routeLine').setAttribute('d','');
      $('miniRoadGeometry').replaceChildren();$('miniRouteLine').setAttribute('d','');
      $('miniRouteCar').setAttribute('hidden','');$('miniRouteTarget').setAttribute('hidden','');
      $('mapEmpty').hidden = false;
      $('routeCar').setAttribute('hidden',''); $('routeTarget').setAttribute('hidden','');
    }
    const blocked = p.isReplay ? 'Replay is read-only; driving is disabled' : p.restarting ? 'Restarting CARLA'
      : !p.fresh ? 'Waiting for native connection to CARLA' : '';
    const ownerBlocked = blocked || (!p.controller ? 'Take control in connection settings' : '');
    for (const star of document.querySelectorAll('.place-favorite')) {
      star.disabled = !!ownerBlocked;
      star.title = ownerBlocked || 'Favorites persist after reconnection';
    }
    const emergency = p.controlMode === 'EMERGENCY_STOP' ? 'Acknowledge the emergency stop first' : '';
    this.disable('startDrivingBtn', blocked || emergency);
    const journeyBusy = ['STARTING','RUNNING'].includes(p.journey?.status);
    const destinationPending = p.dashboardResult?.action === 'destination' && p.dashboardResult.status === 'PENDING';
    const journeyBlocked = blocked || emergency || (!p.navigationAvailable ? 'Journeys are unavailable in this mode' : '') ||
      (destinationPending ? 'Planning route…' : '') || (!p.route ? 'Choose a valid destination and show its route first' : '') ||
      (journeyBusy ? 'Journey running; stop it before starting again' : '') ||
      (p.route?.arrived && state.speedMagnitudeMps < .15 ? 'Vehicle is already at the destination; choose another' : '');
    for (const id of ['startJourneyBtn','phoneJourneyBtn','driveJourneyBtn']) this.disable(id,journeyBlocked);
    this.disable('journeySpeed',ownerBlocked || emergency);
    $('journeySpeedApplied').textContent = journeyBusy ? 'Current target speed: '+p.journey.speed_kmh+' km/h; the lower road limit takes priority.' : '5–30 km/h. You can change it during the journey.';
    const resume = p.route && p.journey?.route_id===p.route.id && ['PAUSED','ERROR'].includes(p.journey?.status);
    for (const id of ['startJourneyBtn','driveJourneyBtn']) $(id).textContent = resume ? 'Resume journey to destination' : 'Go to destination';
    $('phoneJourneyBtn').textContent = resume ? 'Resume journey to current destination' : 'Go to current destination';
    $('journeyAvailability').textContent = $('phoneJourneyAvailability').textContent = $('driveJourneyAvailability').textContent = journeyBlocked ||
      'Destination: '+p.route.destination.name+(resume ? ' — saved; resume from your current position.' : ' — Select Go to start the destination journey.');
    this.disable('pauseBtn',ownerBlocked || emergency);
    this.disable('emergencyStopBtn',ownerBlocked);
    this.disable('acknowledgeStopBtn',ownerBlocked);
    $('acknowledgeStopBtn').hidden = !emergency;

    for (const id of ['cameraView','chooseDestinationBtn','savePlaceBtn','nativeDisconnectBtn','resetBtn'])
      this.disable(id,ownerBlocked);
    const configurationBlocked = ownerBlocked || (p.recording ? 'Finish recording before changing sensor settings' : '');
    this.disable('applySettingsBtn',configurationBlocked);
    this.disable('worldResetBtn',configurationBlocked);
    this.disable('restartGraphicsBtn',configurationBlocked || (state.speedMagnitudeMps > .15 ? 'Stop the vehicle first' : ''));
    this.disable('nativeReconnectBtn',p.isReplay ? 'Replay not connected to simulator' : p.restarting ? 'Restarting' : '');
    this.disable('takeControlBtn',blocked);
    this.disable('drivingMode',blocked || emergency);
    this.disable('clearRouteBtn',ownerBlocked || (!p.route ? 'No active route' : ''));
    $('modeExplanation').textContent = p.isReplay ? 'Recorded data and camera; native driving disabled.' :
      'Go drives the vehicle to the destination. Enable manual driving prepares the keyboard for driving.';
    $('manualHint').textContent = p.isReplay ? 'Keyboard sends no driving commands during Replay.' :
      'Keyboard operates in the dashboard. W/A/S/D Take manual control; destination persists until the route is cleared.';
    $('drivingInstruction').textContent = blocked || emergency || (!p.controller ? 'Another page controls the vehicle. Take control in settings.' :
      p.controlMode === 'AUTOMATIC' ? 'Journey running. Stop driving brakes; manual input transfers control to you.'
      : controllable ? 'Keyboard ready. W+Shift increases throttle from 55% to 100%.' :
        'Vehicle held by command safety. Enable manual driving to move.');
    const reasons = {manual_intervention:'Manual control taken',dashboard_heartbeat_timeout:'Dashboard heartbeat lost',
      destination_reached:'Destination reached and vehicle stopped',collision:'Journey stopped after collision',
      controls_released:'Control stopped',operator_stop:'Driving stopped',focus_lost:'Dashboard lost focus',
      route_ended_before_destination:'Route ended far from destination; select the route again',
      page_closed:'Driving page closed',ownership_taken:'Control transferred to this page',
      fresh_native_session:'New session; explicitly choose driving to begin'};
    const statuses = {IDLE:'',READY:'Route ready',STARTING:'Starting journey',RUNNING:'Destination journey running',
      PAUSED:'Journey paused',ARRIVED:'Arrived',ERROR:'Journey could not complete'};
    $('journeyStatus').textContent = p.route ? (p.isReplay ? 'Recorded route; driving disabled' :
      (statuses[p.journey?.status] || 'Route ready') +
      (p.journey?.reason ? ' · ' + (reasons[p.journey.reason] || p.journey.reason) : '')) : '';
    const population = p.population;
    $('trafficActual').textContent = population?.actual.vehicles ?? '—';
    $('pedestrianActual').textContent = population?.actual.pedestrians ?? '—';
    const health = p.isReplay ? 'Recorded frame counts; no connection to Traffic Manager' : population ? 'TM '+(population.traffic_manager_connected?'connected':'disconnected')+
      ' · active walkers '+population.actual.walkers_active+' · requested '+population.requested.vehicle_count+' / '+population.requested.pedestrian_count+
      ' · last spawn NPC '+population.npc_spawned+' · failed NPC '+population.npc_failed+' / walkers '+population.walkers_failed+
      ' · native removals '+population.vehicles_removed_native+' vehicle / '+population.walkers_lost+' walkers' : 'Waiting for population data';
    $('populationHealth').textContent = $('populationApplied').textContent = health;
    const environment = p.environment, training=environment?.mode==='TRAINING';
    $('environmentStatus').textContent = environment ? environment.mode+' · '+environment.scenario_phase+
      (environment.scenario ? ' · '+environment.scenario.scenario_id+' · seed '+environment.scenario.random_seed+' · level '+environment.scenario.difficulty : '') : 'Environment unavailable';
    $('safetyPolicyStatus').textContent = 'Safety interface prepared — no policy connected · control '+(p.controlSource ?? 'unavailable');
    $('policyObservationStatus').textContent = environment?.observation_status ?
      'Observation '+environment.observation_status.status+' · history '+environment.observation_status.history_frames+' · ground truth excluded' : 'Waiting for synchronized policy observations';
    $('scenarioOutcome').textContent = environment?.outcome ? JSON.stringify(environment.outcome,null,2) : 'No outcome yet';
    const scenarioBlocked=ownerBlocked || (p.recording ? 'Finish recording before changing scenario lifecycle' : '');
    this.disable('loadScenarioBtn',scenarioBlocked);
    this.disable('resetScenarioBtn',scenarioBlocked || (!training?'Load a scenario first':''));
    this.disable('startScenarioBtn',ownerBlocked || (environment?.scenario_phase!=='READY'?'Reset or load a ready scenario':''));
    this.disable('stopScenarioBtn',ownerBlocked || (environment?.scenario_phase!=='RUNNING'?'No running scenario':''));
    this.disable('livingCityBtn',scenarioBlocked || (!training?'Living city is already selected':''));
    const local=population?.local_counts;
    if (local) $('populationHealth').textContent += ' · within 120 m: '+local.vehicles_120m+' vehicles / '+local.walkers_120m+' walkers';
    $('recordRunBtn').textContent = p.recording ? 'Stop recording' : 'Start recording';
    $('recordRunBtn').dataset.recording = String(!!p.recording);
    $('recordingStatus').textContent = (p.recording ? 'Recording camera and sensor data.' : 'Recording stopped.')+(this.recordingPath?' '+this.recordingPath:'');
    for (const id of ['recordRunBtn','clearTrafficBtn','clearPedestriansBtn','resetPopulationBtn','respawnPopulationBtn','applyRadiusBtn','applySceneBtn']) this.disable(id,ownerBlocked);
    this.disable('applyProfileBtn',ownerBlocked || (!Object.keys(this.catalog?.profiles || {}).length ? 'Performance measurements are incomplete' : ''));
    if (training) for (const id of ['clearTrafficBtn','clearPedestriansBtn','resetPopulationBtn','respawnPopulationBtn','applySceneBtn','applySettingsBtn','applyProfileBtn'])
      this.disable(id,ownerBlocked || 'Return to Living city before changing world settings');
    if (this.panel === 'sensorPanel') {
      const native = p.nearbyActors;
      $('trafficLightState').textContent = native?.traffic_light?.relevant ?
        'Actor '+native.traffic_light.actor_id+' · '+native.traffic_light.state+' · '+Math.round(native.traffic_light.distance_to_actor_origin_m)+' m to actor origin' : 'Vehicle is not at a traffic light according to CARLA';
      $('nearbyActors').textContent = native ? 'Frame '+native.frame_id+' · Radius '+native.radius_m+' m\n'+native.actors.map(a =>
        a.category+' #'+a.actor_id+' '+a.type+'\n'+a.distance_m.toFixed(1)+' m · relative '+a.relative_position_m.map(v=>v.toFixed(1)).join('/')+' · velocity '+a.velocity_mps.map(v=>v.toFixed(1)).join('/')).join('\n\n') : 'No live data';
    }
    if (p.operationError) {
      $('operationStatus').textContent = p.operationError; this.errorShown = true;
    } else if (this.errorShown) {
      $('operationStatus').textContent = ''; this.errorShown = false;
    }
    if (p.dashboardResult && JSON.stringify(p.dashboardResult) !== this.result) {
      const result = p.dashboardResult; this.result = JSON.stringify(result);
      if (result.status === 'REJECTED') {
        $('operationStatus').textContent = $('settingsStatus').textContent = $('destinationStatus').textContent = result.error;
        if (result.action === 'destination') $('mapSelectionStatus').textContent = result.error;
        this.restartAfterSave = null;
      }
      if (result.status === 'APPLIED') {
        if (result.action === 'settings') {
          $('settingsStatus').textContent = 'Live changes applied. Graphics saved for restart.';
          if (this.restartAfterSave) {
            p.dashboardAction('restart_graphics', this.restartAfterSave); this.restartAfterSave = null;
          }
          this.load(true);
        }
        if (result.action === 'save_place') { $('destinationStatus').textContent = 'Place saved: ' + result.result.name; this.load(true); }
        if (result.action === 'favorite_place') { $('destinationStatus').textContent = result.result.favorite ? 'Destination added to favorites.' : 'Destination removed from favorites.'; this.load(true); }
        if (result.action === 'destination') $('destinationStatus').textContent = $('mapSelectionStatus').textContent =
          'Route ready to ' + result.result.destination.name + '; select Go or drive manually.';
        if (result.action === 'recording') this.recordingPath = result.result.path;
        if (result.action === 'population') { $('settingsStatus').textContent = 'Population updated; actual counts appear in Living city.'; this.load(true); }
        if (result.action === 'scene') { $('settingsStatus').textContent = 'Seeded normal scene and weather applied.'; this.load(true); }
        if (result.action === 'world_reset') $('settingsStatus').textContent = 'Map created by restarting CARLA and verifying; vehicle stopped and population removed.';
      }
    }
    const restart = p.restartResult;
    if (restart && JSON.stringify(restart) !== this.restartSeen) {
      this.restartSeen = JSON.stringify(restart);
      const names = {STOPPING:'Vehicle and sensor cleanup',LAUNCHING:'Start CARLA',ROLLING_BACK:'Restore previous graphics settings',
        VERIFYING:'Inspect images, sensors and performance',APPLIED:'Graphics applied and verified',
        ROLLED_BACK:'Requested settings failed; previous settings restored',FAILED:'Failed to start CARLA'};
      $('restartStatus').textContent = (names[restart.status] || restart.status) + (restart.error ? ' · ' + restart.error : '');
      if (['APPLIED','ROLLED_BACK'].includes(restart.status)) this.load(true);
    }
    this.load();
    $('originPosition').textContent = state.positionWorldM?.map(v => v.toFixed(1)).join(' / ') || 'Waiting for vehicle position';
    this.renderRoute(p.route, state.positionWorldM);
  }
  renderRoads() {
    const roads = this.catalog?.roads; if (!roads) return;
    const [minX,minY,maxX,maxY] = roads.bounds;
    const scale = Math.min(750/Math.max(1,maxX-minX),280/Math.max(1,maxY-minY));
    const offsetX = (800-(maxX-minX)*scale)/2, offsetY = (330-(maxY-minY)*scale)/2;
    $('routeMap').setAttribute('viewBox',[offsetX-15,offsetY-15,(maxX-minX)*scale+30,(maxY-minY)*scale+30].join(' '));
    this.project = p => [offsetX+(p[0]-minX)*scale,offsetY+(p[1]-minY)*scale];
    this.inverse = p => [(p[0]-offsetX)/scale+minX,(p[1]-offsetY)/scale+minY,0];
    const path = document.createElementNS(svgNamespace,'path');
    path.setAttribute('d',roads.segments.map(line => 'M'+this.project(line[0]).join(',')+'L'+this.project(line[1]).join(',')).join(' '));
    $('roadGeometry').replaceChildren(path);
    $('miniRoadGeometry').replaceChildren(path.cloneNode(true));
    this.mapScale = scale;
    $('mapEmpty').hidden = roads.segments.length > 0;
  }
  renderRoute(route, car) {
    if (!this.project) return;
    const carVisible = this.provider.fresh && !!car;
    $('routeCar').toggleAttribute('hidden',!carVisible);
    if (carVisible) { const [x,y] = this.project(car); $('routeCar').setAttribute('cx',x); $('routeCar').setAttribute('cy',y); }
    $('miniRouteCar').toggleAttribute('hidden',!carVisible);
    $('miniRouteTarget').toggleAttribute('hidden',!route);
    if (carVisible) {
      const [x,y] = this.project(car), span = 100*this.mapScale;
      $('miniRouteCar').setAttribute('cx',x); $('miniRouteCar').setAttribute('cy',y);
      $('miniRouteMap').setAttribute('viewBox',[x-span/2,y-span/2,span,span].join(' '));
    }
    $('miniRouteHint').textContent = route ? Math.round(route.remaining_m)+' m · Map' : 'Map';
    $('miniRouteLine').setAttribute('d',route ? route.points.map((point,i)=>(i?'L':'M')+this.project(point).join(',')).join(' ') : '');
    if (route) { const [x,y]=this.project(route.destination.location); $('miniRouteTarget').setAttribute('cx',x); $('miniRouteTarget').setAttribute('cy',y); }
    $('routeTarget').toggleAttribute('hidden',!route);
    if (!route) {
      $('routeLine').setAttribute('d',''); $('routeDetail').textContent = 'Click a road on the map or choose a destination from the list.';
      $('turnInstruction').textContent = ''; return;
    }
    $('routeLine').setAttribute('d',route.points.map((point,i) => (i?'L':'M')+this.project(point).join(',')).join(' '));
    const [x,y] = this.project(route.destination.location);
    $('routeTarget').setAttribute('cx',x); $('routeTarget').setAttribute('cy',y);
    $('routeDetail').textContent = route.destination.name + ' · ' + Math.round(route.remaining_m) + ' m remaining';
    const names = {LEFT:'North',RIGHT:'Right',STRAIGHT:'Straight',CHANGELANELEFT:'Change lane left',CHANGELANERIGHT:'Change lane right'};
    $('turnInstruction').textContent = route.next_instruction ? 'Next direction: ' +
      (names[route.next_instruction.action] || route.next_instruction.action) : 'Follow the route to the destination.';
  }
}
