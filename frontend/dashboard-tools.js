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
    $('routeBtn').onclick = () => { this.close(); $('routePanel').scrollIntoView({behavior:this.scrollBehavior(),block:'center'}); $('routeMap').focus({preventScroll:true}); };
    $('routeMap').onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); this.open('inGamePhone','routeMap');
      }
    };
    for (const [panel,button] of [['inGamePhone','closePhoneBtn'],['settingsPanel','closeSettingsBtn'],['sensorPanel','closeSensorBtn']])
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
      $('settingsStatus').textContent = 'الصورة الواضحة جاهزة. اضغط طبّق التغييرات لتفعيلها.';
    };
    $('restartGraphicsBtn').onclick = () => {
      const launch = {quality:$('settingQuality').value,resolution:$('settingWindow').value};
      this.restartAfterSave = launch;
      clearControls();
      if (!provider.dashboardAction('settings',{next_launch:launch})) {
        this.restartAfterSave = null; $('restartStatus').textContent = 'استلم التحكم من إعدادات الاتصال أولًا.';
      } else $('restartStatus').textContent = 'حفظ الإعداد ثم إعادة تشغيل المحاكي…';
    };
    $('destinationSearch').oninput = () => { this.selectedPlace = null; this.renderPlaces(); };
    $('chooseDestinationBtn').onclick = () => {
      const text = $('destinationSearch').value.trim();
      const place = this.selectedPlace || this.catalog?.places.find(p => p.name === text || p.id === text);
      if (!place) { $('destinationStatus').textContent = 'اختار وجهة من نتائج البحث أولًا.'; return; }
      this.choose(place.id);
    };
    $('savePlaceBtn').onclick = () => {
      const name = $('savePlaceName').value.trim() || 'مكان محفوظ ' + new Date().toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'});
      clearControls(); provider.dashboardAction('save_place', name);
    };
    $('routeMap').onclick = event => {
      if (!this.project || !this.inverse) return;
      const point = $('routeMap').createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
      const matrix = $('routeMap').getScreenCTM(); if (!matrix) return;
      const nativePoint = point.matrixTransform(matrix.inverse());
      this.choose({location:this.inverse([nativePoint.x,nativePoint.y])});
    };
    for (const button of document.querySelectorAll('[data-drive-key]')) {
      const key = button.dataset.driveKey;
      button.onpointerdown = event => {
        if (button.disabled || !this.options.canInput?.()) return;
        event.preventDefault(); button.setPointerCapture(event.pointerId);
        controls.keys.add(key); this.options.intervene?.(); button.classList.add('held');
      };
      const release = () => { controls.keys.delete(key); button.classList.remove('held'); };
      button.onpointerup = release; button.onpointercancel = release; button.onlostpointercapture = release;
    }
  }

  scrollBehavior() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'; }
  expandCamera(enlarged) {
    $('cameraCard').classList.toggle('camera-expanded',enlarged);
    $('expandCameraBtn').textContent = enlarged ? 'تصغير الصورة' : 'تكبير الصورة';
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
      accepted ? 'بنحسب الطريق من مكان العربية الحالي…' : 'استلم التحكم من إعدادات الاتصال قبل اختيار الوجهة.';
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
      const name = place.favorite ? 'المفضلات ★' : place.id.startsWith('saved-') ? 'أماكنك المحفوظة' :
        place.sector ? place.sector + ' · طريق ' + place.road_id : 'أماكن جاهزة';
      if (!groups.has(name)) groups.set(name,[]);
      groups.get(name).push(place);
    }
    for (const [name, entries] of [...groups].sort(([a],[b]) => Number(b === 'المفضلات ★')-Number(a === 'المفضلات ★'))) {
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
        star.setAttribute('aria-label',(place.favorite ? 'إزالة من المفضلات: ' : 'إضافة للمفضلات: ') + place.name);
        star.disabled = !this.provider.fresh || !this.provider.controller || this.provider.isReplay;
        star.title = star.disabled ? 'استلم التحكم من إعدادات الاتصال أولًا' : 'المفضلات محفوظة بعد إعادة الاتصال';
        star.onclick = () => this.provider.dashboardAction('favorite_place',place.id);
        row.append(button,star); list.append(row);
      }
    }
    if (!places.length) list.textContent = this.catalog ? 'مفيش نتائج. جرّب اسم منطقة أو اختار من الخريطة.' : 'بانتظار خريطة CARLA…';
  }
  fillSettings() {
    const s = this.catalog.settings;
    for (const [id, entries] of [['settingVehicle',s.vehicle_options.map(p => [p.id,p.name])],
      ['settingSpawn',s.spawn_options.map(p => [p.index,p.name])],
      ['settingWeather',[['CUSTOM','مخصص'],...s.weather_presets.map(name => [name,({ClearNoon:'صافٍ — ظهر',CloudyNoon:'غائم — ظهر',WetNoon:'أرض مبللة',WetCloudyNoon:'مبلل وغائم',MidRainyNoon:'مطر متوسط',HardRainNoon:'مطر غزير',SoftRainNoon:'مطر خفيف',ClearSunset:'غروب صافٍ',CloudySunset:'غروب غائم',WetSunset:'غروب وأرض مبللة',HardRainSunset:'غروب ومطر غزير'})[name] || name])]],
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
      settingWeather:s.weather_preset,cameraView:s.camera_view,
      settingMotionBlur:s.camera_motion_blur,settingBloom:s.camera_bloom};
    for (const [id,value] of Object.entries(fields)) $(id).value = value ?? 0;
    $('settingPostprocess').checked = s.camera_postprocess === true;
    for (const [key,id] of Object.entries(weatherFields)) $(id).value = s.weather[key];
    const applied = s.active_launch;
    $('activeGraphics').textContent = applied ? 'المطبّق فعليًا: ' + (applied.quality || 'غير معروف') +
      ' · ' + (applied.resolution || 'دقة غير معروفة') +
      (applied.offscreen ? ' · العرض داخل الداشبورد' : '') : 'إعداد الجرافيكس المطبّق غير متاح.';
    $('effectsNote').textContent = s.camera_effects?.note || '';
    $('weatherApplied').textContent = 'الطقس المطبق: '+s.weather_preset;
    if (!Object.keys(this.catalog.profiles || {}).length) {
      const option = document.createElement('option'); option.textContent = 'بانتظار نتائج قياس الأداء'; $('settingProfile').append(option);
    }
  }
  apply() {
    if (!this.catalog) return;
    const number = id => Number($(id).value), current = this.catalog.settings;
    const data = {weather:Object.fromEntries(Object.entries(weatherFields).map(([key,id]) => [key,number(id)])),
      next_launch:{quality:$('settingQuality').value,resolution:$('settingWindow').value},
      population:{vehicle_count:number('settingTrafficCount'),pedestrian_count:number('settingPedestrianCount'),
        speed_behavior:$('settingTrafficSpeed').value,fast_walk_percent:number('settingFastWalk'),seed:number('settingSeed')}};
    if ($('settingWeather').value !== 'CUSTOM') { delete data.weather; data.weather_preset = $('settingWeather').value; }
    const candidates = {vehicle:$('settingVehicle').value,spawn_index:number('settingSpawn'),
      camera_view:$('cameraView').value,camera_resolution:$('settingResolution').value,
      camera_fov:number('settingFov'),simulation_hz:number('settingHz'),camera_postprocess:$('settingPostprocess').checked,
      camera_motion_blur:number('settingMotionBlur'),camera_bloom:number('settingBloom')};
    for (const [key,value] of Object.entries(candidates)) if (value !== current[key]) data[key] = value;
    this.clearControls();
    $('settingsStatus').textContent = this.provider.dashboardAction('settings',data) ? 'جاري التطبيق الفعلي…' : 'استلم التحكم من إعدادات الاتصال أولًا.';
  }
  disable(id, reason) { const button = $(id); button.disabled = !!reason; button.title = reason || ''; }
  render(state, controllable) {
    const p = this.provider;
    if (this.session !== p.sessionId) {
      this.session = p.sessionId; this.catalog = null; this.selectedPlace = null; this.result = null;
      this.project = this.inverse = null; $('roadGeometry').replaceChildren(); $('routeLine').setAttribute('d','');
      $('mapEmpty').hidden = false;
      $('routeCar').setAttribute('hidden',''); $('routeTarget').setAttribute('hidden','');
    }
    const blocked = p.isReplay ? 'التسجيل للعرض فقط؛ القيادة مقفولة' : p.restarting ? 'جاري إعادة تشغيل CARLA'
      : !p.fresh ? 'بانتظار اتصال حقيقي بـCARLA' : '';
    const ownerBlocked = blocked || (!p.controller ? 'استلم التحكم من إعدادات الاتصال' : '');
    for (const star of document.querySelectorAll('.place-favorite')) {
      star.disabled = !!ownerBlocked;
      star.title = ownerBlocked || 'المفضلات محفوظة بعد إعادة الاتصال';
    }
    const emergency = p.controlMode === 'EMERGENCY_STOP' ? 'أقر إيقاف الطوارئ أولًا' : '';
    this.disable('startDrivingBtn', blocked || emergency);
    this.disable('pauseBtn',ownerBlocked || emergency);
    this.disable('emergencyStopBtn',ownerBlocked);
    this.disable('acknowledgeStopBtn',ownerBlocked);
    $('acknowledgeStopBtn').hidden = !emergency;
    for (const button of document.querySelectorAll('[data-drive-key]')) {
      button.disabled = !controllable; button.title = controllable ? 'اضغط باستمرار' : blocked || emergency || 'فعّل القيادة اليدوية واحتفظ بالتركيز على الداشبورد';
      button.classList.toggle('held',this.controls.keys.has(button.dataset.driveKey));
    }
    for (const id of ['cameraView','chooseDestinationBtn','savePlaceBtn','nativeDisconnectBtn','resetBtn'])
      this.disable(id,ownerBlocked);
    const configurationBlocked = ownerBlocked || (p.recording ? 'أنهِ التسجيل قبل تغيير إعدادات الحساسات' : '');
    this.disable('applySettingsBtn',configurationBlocked);
    this.disable('worldResetBtn',configurationBlocked);
    this.disable('restartGraphicsBtn',configurationBlocked || (state.speedMagnitudeMps > .15 ? 'أوقف العربية أولًا' : ''));
    this.disable('nativeReconnectBtn',p.isReplay ? 'Replay ليس متصلًا بالمحاكي' : p.restarting ? 'جاري إعادة التشغيل' : '');
    this.disable('takeControlBtn',blocked);
    this.disable('drivingMode',blocked || emergency);
    this.disable('clearRouteBtn',ownerBlocked || (!p.route ? 'لا يوجد مسار نشط' : ''));
    $('modeExplanation').textContent = p.isReplay ? 'عرض بيانات وكاميرا من التسجيل؛ القيادة بالمحاكي معطّلة.' :
      'فعّل القيادة، ثم اضغط باستمرار على W أو زر البنزين للتحرك.';
    $('manualHint').textContent = p.isReplay ? 'الكيبورد لا يرسل أوامر قيادة أثناء Replay.' :
      'الكيبورد يعمل داخل الداشبورد. المسار يرشدك فقط؛ أنت تتحكم في العربية.';
    $('drivingInstruction').textContent = blocked || emergency || (!p.controller ? 'صفحة أخرى تتحكم بالعربية. استلم التحكم من الإعدادات.' :
      p.controlMode === 'AUTOMATIC' ? 'الرحلة شغالة. إيقاف القيادة يفرمل؛ أي تدخل منك يسلمك القيادة.'
      : controllable ? 'الكيبورد وأزرار الشاشة جاهزة. اضغط باستمرار للتحكم.' :
        'العربية تحت الأمان. اضغط تفعيل القيادة اليدوية للتحرك.');
    const reasons = {manual_intervention:'استلمت القيادة يدويًا',dashboard_heartbeat_timeout:'انقطع نبض اتصال الداشبورد',
      destination_reached:'وصلت للوجهة والعربية توقفت',collision:'توقفت الرحلة بسبب تصادم',
      controls_released:'تم إيقاف التحكم',operator_stop:'أوقفت القيادة',focus_lost:'الداشبورد فقدت التركيز',
      route_ended_before_destination:'المسار انتهى بعيدًا عن الوجهة؛ اختار الطريق مجددًا',
      page_closed:'صفحة القيادة اتقفلت',ownership_taken:'التحكم انتقل إلى هذه الصفحة',
      fresh_native_session:'جلسة جديدة؛ ابدأ القيادة باختيار صريح'};
    const statuses = {IDLE:'',READY:'الطريق جاهز',STARTING:'جاري بدء الرحلة',RUNNING:'الرحلة التلقائية شغالة',
      PAUSED:'الرحلة متوقفة',ARRIVED:'وصلت',ERROR:'تعذر إكمال الرحلة'};
    $('journeyStatus').textContent = p.route ? (p.isReplay ? 'مسار من التسجيل؛ القيادة معطّلة' :
      p.controlMode === 'AUTOMATIC' ? (statuses[p.journey?.status] || '') +
        (p.journey?.reason ? ' · ' + (reasons[p.journey.reason] || p.journey.reason) : '') :
        'إرشاد يدوي — اتبع المسار بنفسك') : '';
    const population = p.population;
    $('trafficActual').textContent = population?.actual.vehicles ?? '—';
    $('pedestrianActual').textContent = population?.actual.pedestrians ?? '—';
    const health = p.isReplay ? 'أعداد من الفريم المسجل؛ لا يوجد اتصال بـTraffic Manager' : population ? 'TM '+(population.traffic_manager_connected?'متصل':'غير متصل')+
      ' · مشاة نشطون '+population.actual.walkers_active+' · طلب '+population.requested.vehicle_count+' / '+population.requested.pedestrian_count+
      ' · آخر إنشاء NPC '+population.npc_spawned+' · فشل NPC '+population.npc_failed+' / مشاة '+population.walkers_failed+
      ' · إزالات أصلية '+population.vehicles_removed_native+' عربية / '+population.walkers_lost+' مشاة' : 'بانتظار بيانات السكان';
    $('populationHealth').textContent = $('populationApplied').textContent = health;
    $('recordRunBtn').textContent = p.recording ? 'إنهاء تسجيل الرحلة' : 'ابدأ تسجيل الرحلة';
    $('recordRunBtn').dataset.recording = String(!!p.recording);
    $('recordingStatus').textContent = (p.recording ? 'جاري تسجيل الكاميرا وبيانات الحساسات.' : 'التسجيل متوقف.')+(this.recordingPath?' '+this.recordingPath:'');
    for (const id of ['recordRunBtn','clearTrafficBtn','clearPedestriansBtn','resetPopulationBtn','respawnPopulationBtn','applyRadiusBtn','applySceneBtn']) this.disable(id,ownerBlocked);
    this.disable('applyProfileBtn',ownerBlocked || (!Object.keys(this.catalog?.profiles || {}).length ? 'لم تنتهِ قياسات الأداء بعد' : ''));
    if (this.panel === 'sensorPanel') {
      const native = p.nearbyActors;
      $('trafficLightState').textContent = native?.traffic_light?.relevant ?
        'Actor '+native.traffic_light.actor_id+' · '+native.traffic_light.state+' · '+Math.round(native.traffic_light.distance_to_actor_origin_m)+' م إلى أصل الممثل' : 'العربية ليست عند إشارة مرور بحسب CARLA';
      $('nearbyActors').textContent = native ? 'Frame '+native.frame_id+' · Radius '+native.radius_m+' m\n'+native.actors.map(a =>
        a.category+' #'+a.actor_id+' '+a.type+'\n'+a.distance_m.toFixed(1)+' m · relative '+a.relative_position_m.map(v=>v.toFixed(1)).join('/')+' · velocity '+a.velocity_mps.map(v=>v.toFixed(1)).join('/')).join('\n\n') : 'لا توجد بيانات حية';
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
          $('settingsStatus').textContent = 'تم تطبيق التغييرات الحية. الجرافيكس محفوظة لحين إعادة التشغيل.';
          if (this.restartAfterSave) {
            p.dashboardAction('restart_graphics', this.restartAfterSave); this.restartAfterSave = null;
          }
          this.load(true);
        }
        if (result.action === 'save_place') { $('destinationStatus').textContent = 'اتحفظ المكان: ' + result.result.name; this.load(true); }
        if (result.action === 'favorite_place') { $('destinationStatus').textContent = result.result.favorite ? 'الوجهة اتضافت للمفضلات.' : 'الوجهة اتشالت من المفضلات.'; this.load(true); }
        if (result.action === 'destination') $('destinationStatus').textContent = $('mapSelectionStatus').textContent =
          'الطريق جاهز إلى ' + result.result.destination.name + '؛ اتبعه بالقيادة اليدوية.';
        if (result.action === 'recording') this.recordingPath = result.result.path;
        if (result.action === 'population') { $('settingsStatus').textContent = 'تم تحديث السكان؛ العدد الفعلي ظاهر في المدينة الحية.'; this.load(true); }
        if (result.action === 'scene') { $('settingsStatus').textContent = 'تم إنشاء المشهد العادي والطقس ببذرة ثابتة.'; this.load(true); }
        if (result.action === 'world_reset') $('settingsStatus').textContent = 'تم إنشاء الخريطة بإعادة تشغيل CARLA والتحقق منها؛ العربية متوقفة والسكان أزيلوا.';
      }
    }
    const restart = p.restartResult;
    if (restart && JSON.stringify(restart) !== this.restartSeen) {
      this.restartSeen = JSON.stringify(restart);
      const names = {STOPPING:'تنظيف العربية والحساسات',LAUNCHING:'تشغيل CARLA',ROLLING_BACK:'العودة لإعداد الجرافيكس السابق',
        VERIFYING:'التحقق من الصورة والحساسات والأداء',APPLIED:'تم تطبيق الجرافيكس والتحقق منها',
        ROLLED_BACK:'تعذر الإعداد المطلوب؛ رجعنا للإعداد السابق',FAILED:'تعذر تشغيل CARLA'};
      $('restartStatus').textContent = (names[restart.status] || restart.status) + (restart.error ? ' · ' + restart.error : '');
      if (['APPLIED','ROLLED_BACK'].includes(restart.status)) this.load(true);
    }
    this.load();
    $('originPosition').textContent = state.positionWorldM?.map(v => v.toFixed(1)).join(' / ') || 'بانتظار موقع العربية';
    this.renderRoute(p.route, state.positionWorldM);
  }
  renderRoads() {
    const roads = this.catalog?.roads; if (!roads) return;
    const [minX,minY,maxX,maxY] = roads.bounds;
    const scale = Math.min(750/Math.max(1,maxX-minX),280/Math.max(1,maxY-minY));
    const offsetX = (800-(maxX-minX)*scale)/2, offsetY = (330-(maxY-minY)*scale)/2;
    this.project = p => [offsetX+(p[0]-minX)*scale,offsetY+(p[1]-minY)*scale];
    this.inverse = p => [(p[0]-offsetX)/scale+minX,(p[1]-offsetY)/scale+minY,0];
    const path = document.createElementNS(svgNamespace,'path');
    path.setAttribute('d',roads.segments.map(line => 'M'+this.project(line[0]).join(',')+'L'+this.project(line[1]).join(',')).join(' '));
    $('roadGeometry').replaceChildren(path);
    $('mapEmpty').hidden = roads.segments.length > 0;
  }
  renderRoute(route, car) {
    if (!this.project) return;
    const carVisible = this.provider.fresh && !!car;
    $('routeCar').toggleAttribute('hidden',!carVisible);
    if (carVisible) { const [x,y] = this.project(car); $('routeCar').setAttribute('cx',x); $('routeCar').setAttribute('cy',y); }
    $('routeTarget').toggleAttribute('hidden',!route);
    if (!route) {
      $('routeLine').setAttribute('d',''); $('routeDetail').textContent = 'اضغط على طريق في الخريطة أو اختار مكانًا من قائمة الوجهات.';
      $('turnInstruction').textContent = ''; return;
    }
    $('routeLine').setAttribute('d',route.points.map((point,i) => (i?'L':'M')+this.project(point).join(',')).join(' '));
    const [x,y] = this.project(route.destination.location);
    $('routeTarget').setAttribute('cx',x); $('routeTarget').setAttribute('cy',y);
    $('routeDetail').textContent = route.destination.name + ' · ' + Math.round(route.remaining_m) + ' متر متبقية';
    const names = {LEFT:'شمال',RIGHT:'يمين',STRAIGHT:'مستقيم',CHANGELANELEFT:'غيّر الحارة شمال',CHANGELANERIGHT:'غيّر الحارة يمين'};
    $('turnInstruction').textContent = route.next_instruction ? 'الاتجاه القادم: ' +
      (names[route.next_instruction.action] || route.next_instruction.action) : 'اتبع الطريق للوجهة.';
  }
}
