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
    $('phoneToggleBtn').onclick = () => this.toggle('inGamePhone','phoneToggleBtn');
    $('mapDestinationsBtn').onclick = () => this.open('inGamePhone','mapDestinationsBtn');
    $('settingsBtn').onclick = () => { this.toggle('settingsPanel','settingsBtn'); this.load(true); };
    $('sensorBtn').onclick = () => this.toggle('sensorPanel','sensorBtn');
    $('routeBtn').onclick = () => { this.close(); $('routePanel').scrollIntoView({behavior:'smooth',block:'center'}); $('routeMap').focus(); };
    for (const [panel,button] of [['inGamePhone','closePhoneBtn'],['settingsPanel','closeSettingsBtn'],['sensorPanel','closeSensorBtn']])
      $(button).onclick = () => this.close();
    $('panelBackdrop').onclick = () => this.close();
    document.addEventListener('keydown', event => {
      if (event.code === 'Escape') {
        if (this.panel) this.close();
        else $('cameraCard').classList.remove('camera-expanded');
      }
      if (event.key === 'Tab' && this.panel) {
        const elements = [...$(this.panel).querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(el => !el.hidden);
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
    $('expandCameraBtn').onclick = () => {
      const enlarged = $('cameraCard').classList.toggle('camera-expanded');
      $('expandCameraBtn').textContent = enlarged ? 'تصغير الصورة' : 'تكبير الصورة';
    };
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

  open(panel, trigger) {
    if (this.panel === panel) return;
    this.close(false);
    if (this.provider.controlMode === 'MANUAL') this.clearControls();
    this.panel = panel; this.panelTrigger = trigger; $(panel).hidden = false;
    $('panelBackdrop').hidden = false;
    $(trigger)?.setAttribute('aria-expanded','true');
    $(panel).querySelector('button')?.focus();
    if (panel === 'inGamePhone') this.load();
  }
  close(returnFocus = true) {
    if (!this.panel) return;
    $(this.panel).hidden = true; $('panelBackdrop').hidden = true;
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
        const row = document.createElement('div'); row.className = 'place-row';
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
    for (const [id, entries] of [['settingVehicle',s.vehicles.map(id => [id,id.replace('vehicle.','')])],
      ['settingSpawn',this.catalog.places.filter(p => p.id.startsWith('road-point-')).map(p => [p.spawn_index,p.name])]]) {
      const select = $(id); select.replaceChildren();
      for (const [value,text] of entries) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
    }
    const fields = {settingVehicle:s.vehicle,settingSpawn:s.spawn_index,settingResolution:s.camera_resolution,
      settingFov:s.camera_fov,settingHz:s.simulation_hz,settingQuality:s.next_launch.quality,
      settingWindow:s.next_launch.resolution,settingTrafficCount:s.traffic_plan.vehicle_count,
      settingTrafficMin:s.traffic_plan.speed_min_kmh,settingTrafficMax:s.traffic_plan.speed_max_kmh,
      settingSeed:s.traffic_plan.seed,cameraView:s.camera_view,
      settingMotionBlur:s.camera_motion_blur,settingBloom:s.camera_bloom};
    for (const [id,value] of Object.entries(fields)) $(id).value = value ?? 0;
    $('settingPostprocess').checked = s.camera_postprocess === true;
    for (const [key,id] of Object.entries(weatherFields)) $(id).value = s.weather[key];
    const applied = s.active_launch;
    $('activeGraphics').textContent = applied ? 'المطبّق فعليًا: ' + (applied.quality || 'غير معروف') +
      ' · ' + (applied.resolution || 'دقة غير معروفة') +
      (applied.offscreen ? ' · العرض داخل الداشبورد' : '') : 'إعداد الجرافيكس المطبّق غير متاح.';
    $('effectsNote').textContent = s.camera_effects?.note || '';
  }
  apply() {
    if (!this.catalog) return;
    const number = id => Number($(id).value), current = this.catalog.settings;
    const data = {weather:Object.fromEntries(Object.entries(weatherFields).map(([key,id]) => [key,number(id)])),
      next_launch:{quality:$('settingQuality').value,resolution:$('settingWindow').value},
      traffic_plan:{vehicle_count:number('settingTrafficCount'),speed_min_kmh:number('settingTrafficMin'),
        speed_max_kmh:number('settingTrafficMax'),seed:number('settingSeed')}};
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
      $('routeCar').setAttribute('hidden',''); $('routeTarget').setAttribute('hidden','');
    }
    const blocked = p.isReplay ? 'التسجيل للعرض فقط؛ القيادة مقفولة' : p.restarting ? 'جاري إعادة تشغيل CARLA'
      : !p.fresh ? 'بانتظار اتصال حقيقي بـCARLA' : '';
    const ownerBlocked = blocked || (!p.controller ? 'استلم التحكم من إعدادات الاتصال' : '');
    const emergency = p.controlMode === 'EMERGENCY_STOP' ? 'أقر إيقاف الطوارئ أولًا' : '';
    this.disable('startDrivingBtn', blocked || emergency);
    this.disable('startJourneyBtn', blocked || emergency ||
      (p.dashboardResult?.action === 'destination' && p.dashboardResult.status === 'REJECTED' ? 'الوجهة مرفوضة؛ اختار نقطة طريق صالحة' : '') ||
      (!p.route ? 'اختار وجهة واعرض الطريق أولًا' : ''));
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
    this.disable('restartGraphicsBtn',configurationBlocked || (state.speedMagnitudeMps > .15 ? 'أوقف العربية أولًا' : ''));
    this.disable('nativeReconnectBtn',p.isReplay ? 'Replay ليس متصلًا بالمحاكي' : p.restarting ? 'جاري إعادة التشغيل' : '');
    this.disable('takeControlBtn',blocked);
    this.disable('drivingMode',blocked || emergency);
    const automatic = $('drivingMode').value === 'AUTOMATIC';
    $('startDrivingBtn').hidden = automatic; $('journeyControls').hidden = !automatic;
    $('modeExplanation').textContent = automatic ? 'اختار وجهة، ثم اضغط ابدأ الرحلة. العربية تتحرك تلقائيًا ويمكنك التدخل في أي وقت.'
      : 'تفعيل القيادة يجهز التحكم؛ العربية تتحرك عندما تضغط W أو زر البنزين.';
    $('drivingInstruction').textContent = blocked || emergency || (!p.controller ? 'صفحة أخرى تتحكم بالعربية. استلم التحكم من الإعدادات.' :
      p.controlMode === 'AUTOMATIC' ? 'الرحلة شغالة. إيقاف القيادة يفرمل؛ أي تدخل منك يسلمك القيادة.'
      : controllable ? 'الكيبورد وأزرار الشاشة جاهزة. اضغط باستمرار للتحكم.' : automatic ?
        (p.route ? 'الطريق جاهز. اضغط ابدأ الرحلة التلقائية للتحرك.' : 'اختار وجهة من القائمة أو الخريطة أولًا.') :
        'العربية تحت الأمان. اضغط تفعيل القيادة اليدوية للتحرك.');
    const reasons = {manual_intervention:'استلمت القيادة يدويًا',dashboard_heartbeat_timeout:'انقطع نبض اتصال الداشبورد',
      destination_reached:'وصلت للوجهة والعربية توقفت',collision:'توقفت الرحلة بسبب تصادم',
      controls_released:'تم إيقاف التحكم',operator_stop:'أوقفت القيادة',focus_lost:'الداشبورد فقدت التركيز',
      route_ended_before_destination:'المسار انتهى بعيدًا عن الوجهة؛ اختار الطريق مجددًا',
      page_closed:'صفحة القيادة اتقفلت',ownership_taken:'التحكم انتقل إلى هذه الصفحة',
      fresh_native_session:'جلسة جديدة؛ ابدأ القيادة باختيار صريح'};
    const statuses = {IDLE:'',READY:'الطريق جاهز',STARTING:'جاري بدء الرحلة',RUNNING:'الرحلة التلقائية شغالة',
      PAUSED:'الرحلة متوقفة',ARRIVED:'وصلت',ERROR:'تعذر إكمال الرحلة'};
    $('journeyStatus').textContent = p.route ? (statuses[p.journey?.status] || '') +
      (p.journey?.reason ? ' · ' + (reasons[p.journey.reason] || p.journey.reason) : '') : '';
    if (p.operationError) $('operationStatus').textContent = p.operationError;
    if (p.dashboardResult && JSON.stringify(p.dashboardResult) !== this.result) {
      const result = p.dashboardResult; this.result = JSON.stringify(result);
      if (result.status === 'REJECTED') {
        $('operationStatus').textContent = $('settingsStatus').textContent = $('destinationStatus').textContent = result.error;
        if (result.action === 'destination') $('mapSelectionStatus').textContent = result.error;
        this.restartAfterSave = null;
      }
      if (result.status === 'APPLIED') {
        if (result.action === 'settings') {
          $('settingsStatus').textContent = 'تم تطبيق التغييرات. الجرافيكس محفوظة لحين إعادة التشغيل والمرور غير مفعّل.';
          if (this.restartAfterSave) {
            p.dashboardAction('restart_graphics', this.restartAfterSave); this.restartAfterSave = null;
          }
          this.load(true);
        }
        if (result.action === 'save_place') { $('destinationStatus').textContent = 'اتحفظ المكان: ' + result.result.name; this.load(true); }
        if (result.action === 'favorite_place') { $('destinationStatus').textContent = result.result.favorite ? 'الوجهة اتضافت للمفضلات.' : 'الوجهة اتشالت من المفضلات.'; this.load(true); }
        if (result.action === 'destination') $('destinationStatus').textContent = $('mapSelectionStatus').textContent =
          'الطريق جاهز إلى ' + result.result.destination.name + '؛ اختار طريقة القيادة لبدء الحركة.';
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
