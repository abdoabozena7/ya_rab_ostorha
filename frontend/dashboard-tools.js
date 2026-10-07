// Native session tools; route rendering is a 2D map of CARLA waypoints.
const $ = id => document.getElementById(id);
const weatherFields = {cloudiness:'settingCloud', precipitation:'settingRain', wetness:'settingWet',
  fog_density:'settingFog', sun_altitude_angle:'settingSun', sun_azimuth_angle:'settingSunAzimuth'};

export class DashboardTools {
  constructor(provider, controls, clearControls) {
    Object.assign(this, {provider, controls, clearControls});
    this.catalog = null; this.loading = false; this.retryAt = 0; this.result = null;
    $('startDrivingBtn').onclick = () => { clearControls(); provider.startDriving(); };
    $('nativeReconnectBtn').onclick = () => { clearControls(); provider.reconnectNative(); provider.connect(); };
    $('nativeDisconnectBtn').onclick = () => { clearControls(); provider.send('disconnect'); };
    for (const button of document.querySelectorAll('[data-drive-key]')) {
      button.onpointerdown = event => {
        if (button.disabled) return;
        event.preventDefault(); button.setPointerCapture(event.pointerId);
        controls.keys.add(button.dataset.driveKey); button.classList.add('held');
      };
      const release = () => { controls.keys.delete(button.dataset.driveKey); button.classList.remove('held'); };
      button.onpointerup = button.onpointercancel = button.onlostpointercapture = release;
    }
    $('settingsBtn').onclick = () => { $('settingsPanel').hidden = !$('settingsPanel').hidden; $('settingsBtn').setAttribute('aria-expanded',String(!$('settingsPanel').hidden)); this.load(true); };
    $('closeSettingsBtn').onclick = () => { $('settingsPanel').hidden = true; $('settingsBtn').setAttribute('aria-expanded','false'); };
    $('settingsForm').onsubmit = event => { event.preventDefault(); this.apply(); };
    $('cameraView').onchange = () => {
      clearControls(); provider.dashboardAction('settings', {camera_view:$('cameraView').value});
    };
    $('expandCameraBtn').onclick = () => {
      const expanded = $('cameraCard').classList.toggle('camera-expanded');
      $('expandCameraBtn').textContent = expanded ? 'Shrink' : 'Enlarge';
    };
    $('chooseDestinationBtn').onclick = () => {
      const name = $('destinationSearch').value.trim();
      const place = this.catalog?.places.find(p => p.name === name || p.id === name);
      if (!place) { $('destinationStatus').textContent = 'اختار مكان من القائمة أو احفظ مكانك باسم جديد.'; return; }
      clearControls();
      if (provider.dashboardAction('destination', place.id)) {
        $('destinationStatus').textContent = 'بنحسب الطريق من خريطة CARLA…';
        $('routePanel').hidden = false;
        $('routeBtn').setAttribute('aria-expanded','true');
      }
    };
    $('savePlaceBtn').onclick = () => {
      clearControls(); provider.dashboardAction('save_place', $('savePlaceName').value.trim());
    };
  }

  async load(force = false) {
    if (this.loading || (!force && (this.catalog || performance.now() < this.retryAt)) || !this.provider.connected || !this.provider.fresh) return;
    this.loading = true;
    try {
      this.catalog = await this.provider.catalog(); this.fillSettings();
      const options = $('placeOptions'); options.replaceChildren();
      for (const place of this.catalog.places) {
        const option = document.createElement('option'); option.value = place.name;
        option.textContent = `Road ${place.road_id} · ${place.map.split('/').at(-1)}`; options.append(option);
      }
      $('settingsStatus').textContent = 'متصل بـCARLA · المرور غير مفعّل';
    } catch (error) { this.retryAt = performance.now()+2000; $('settingsStatus').textContent = error.message; }
    finally { this.loading = false; }
  }

  fillSettings() {
    const s = this.catalog.settings;
    const select = $('settingVehicle'); select.replaceChildren();
    for (const blueprint of s.vehicles) {
      const option = document.createElement('option'); option.value = blueprint;
      option.textContent = blueprint.replace('vehicle.',''); select.append(option);
    }
    const fields = {settingVehicle:s.vehicle, settingSpawn:s.spawn_index, settingResolution:s.camera_resolution,
      settingFov:s.camera_fov, settingHz:s.simulation_hz, settingQuality:s.next_launch.quality,
      settingWindow:s.next_launch.resolution, settingTrafficCount:s.traffic_plan.vehicle_count,
      settingTrafficMin:s.traffic_plan.speed_min_kmh, settingTrafficMax:s.traffic_plan.speed_max_kmh,
      settingSeed:s.traffic_plan.seed, cameraView:s.camera_view};
    for (const [id,value] of Object.entries(fields)) $(id).value = value;
    for (const [key,id] of Object.entries(weatherFields)) $(id).value = s.weather[key];
  }

  apply() {
    if (!this.catalog) return;
    const number = id => Number($(id).value), current = this.catalog.settings;
    const data = {weather:Object.fromEntries(Object.entries(weatherFields).map(([key,id]) => [key,number(id)])),
      next_launch:{quality:$('settingQuality').value, resolution:$('settingWindow').value},
      traffic_plan:{vehicle_count:number('settingTrafficCount'), speed_min_kmh:number('settingTrafficMin'),
        speed_max_kmh:number('settingTrafficMax'), seed:number('settingSeed')}};
    const candidates = {vehicle:$('settingVehicle').value, spawn_index:number('settingSpawn'),
      camera_view:$('cameraView').value, camera_resolution:$('settingResolution').value,
      camera_fov:number('settingFov'), simulation_hz:number('settingHz')};
    for (const [key,value] of Object.entries(candidates)) if (value !== current[key]) data[key] = value;
    this.clearControls();
    $('settingsStatus').textContent = this.provider.dashboardAction('settings', data) ? 'جاري التطبيق على CARLA…' : 'اضغط ابدأ القيادة لاستلام التحكم أولًا.';
  }

  render(state, controllable) {
    const p = this.provider;
    $('startDrivingBtn').disabled = !p.fresh || p.isReplay || p.controlMode === 'EMERGENCY_STOP';
    $('nativeReconnectBtn').disabled = p.isReplay;
    $('nativeDisconnectBtn').disabled = !p.fresh || !p.controller || p.isReplay;
    $('startDrivingBtn').textContent = !p.controller && p.connected ? 'Take control · استلم القيادة' : 'Start driving · ابدأ القيادة';
    for (const b of document.querySelectorAll('[data-drive-key]')) b.disabled = !controllable;
    for (const id of ['cameraView','applySettingsBtn','chooseDestinationBtn','savePlaceBtn']) $(id).disabled = !p.fresh || !p.controller || p.isReplay;
    $('drivingInstruction').textContent = p.isReplay ? 'REPLAY · القيادة مقفولة' : !p.fresh ? 'اتصل بـCARLA. لو الاتصال توقف اضغط Reconnect CARLA.'
      : !p.controller ? 'صفحة أخرى ماسكة التحكم. اضغط استلم القيادة هنا.' : p.controlMode === 'PAUSED' ? 'العربية متوقفة. اضغط ابدأ القيادة، ثم W أو زر البنزين.'
      : p.controlMode === 'EMERGENCY_STOP' ? 'إيقاف طوارئ. أقر الإيقاف ثم استأنف.' : 'القيادة متاحة من هنا. الضغط المستمر يحرك العربية؛ فقدان التركيز يوقف التحكم.';
    if (p.operationError) $('settingsStatus').textContent = p.operationError;
    const result = p.dashboardResult;
    if (result && JSON.stringify(result) !== this.result) {
      this.result = JSON.stringify(result);
      if (result.status === 'REJECTED') {
        $('settingsStatus').textContent = result.error; $('destinationStatus').textContent = result.error;
      } else if (result.status === 'APPLIED') {
        if (result.action === 'settings') { $('settingsStatus').textContent = 'تم التطبيق. الجرافيكس والمرور محفوظان للمرحلة/التشغيل القادم.'; this.load(true); }
        if (result.action === 'save_place') { $('destinationStatus').textContent = 'اتحفظ مكانك: '+result.result.name; this.load(true); }
        if (result.action === 'destination') $('destinationStatus').textContent = 'وجهتك: '+result.result.destination.name;
      }
    }
    this.load();
    $('routeMap').hidden = !p.fresh || !p.route;
    if (p.route && state.positionWorldM) this.renderRoute(p.route, state.positionWorldM);
    else { $('routeDetail').textContent = p.fresh ? 'Choose a destination from Phone.' : 'Route unavailable until CARLA reconnects.'; $('turnInstruction').textContent = ''; }
  }

  renderRoute(route, car) {
    const points = [...route.points, car];
    const xs = points.map(p=>p[0]), ys = points.map(p=>p[1]);
    const minX = Math.min(...xs), maxY = Math.max(...ys);
    const scale = Math.min(270/Math.max(1,Math.max(...xs)-minX),190/Math.max(1,maxY-Math.min(...ys)));
    const project = p=>[15+(p[0]-minX)*scale,15+(maxY-p[1])*scale];
    $('routeLine').setAttribute('d',route.points.map((p,i)=>`${i?'L':'M'}${project(p).join(',')}`).join(' '));
    for (const [id,point] of [['routeCar',car],['routeTarget',route.destination.location]]) {
      const [x,y] = project(point); $(id).setAttribute('cx',x); $(id).setAttribute('cy',y);
    }
    $('routeDetail').textContent = `${route.destination.name} · ${route.arrived?'وصلت':Math.round(route.remaining_m)+' m متبقية'} · Manual driving`;
    const next = route.next_instruction;
    const names = {LEFT:'شمال',RIGHT:'يمين',STRAIGHT:'مستقيم',CHANGELANELEFT:'غيّر الحارة شمال',CHANGELANERIGHT:'غيّر الحارة يمين'};
    $('turnInstruction').textContent = next ? `إرشاد الطريق: ${names[next.action]??next.action}` : 'اتبع الطريق للوجهة.';
  }
}
