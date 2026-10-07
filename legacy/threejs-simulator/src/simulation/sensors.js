export function createSensors(THREE, scene) {
  const angles = [-90, -60, -30, 0, 30, 60, 90];
  const labels = ['L 90°', 'L 60°', 'L 30°', 'FRONT', 'R 30°', 'R 60°', 'R 90°'];
  const range = 220;
  const readings = new Array(angles.length).fill(1);
  const raycaster = new THREE.Raycaster();
  const lines = [];
  const dots = [];
  const bars = [];
  const distances = [];
  let visible = false;

  const rows = document.getElementById('sensorRows');
  for (const [index, label] of labels.entries()) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0x00ff88 })
    );
    scene.add(line);
    lines.push(line);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 8),
      new THREE.MeshPhongMaterial({ color: 0xff2244, emissive: 0xff0000 }));
    dot.visible = false;
    scene.add(dot);
    dots.push(dot);
    const row = document.createElement('div');
    row.className = 'sensor-row';
    row.innerHTML = `<span class="sensor-name">${label}</span><div class="sensor-bar-wrap"><div class="sensor-bar-fill"></div></div><span class="sensor-dist">--</span>`;
    rows.appendChild(row);
    bars[index] = row.querySelector('.sensor-bar-fill');
    distances[index] = row.querySelector('.sensor-dist');
  }

  function update(car, angle, obstacles) {
    const origin = new THREE.Vector3(car.position.x, car.position.y + 0.1, car.position.z);
    const nearby = obstacles.filter(object =>
      Math.hypot(object.position.x-car.position.x,object.position.z-car.position.z)<range+16);
    const boxes=nearby.map(object=>{
      if(object.userData.dynamicActor) {
        const {width=1.1,length=1.1}=object.userData;
        const c=Math.abs(Math.cos(object.rotation.y)),s=Math.abs(Math.sin(object.rotation.y));
        const hx=(c*width+s*length)/2,hz=(s*width+c*length)/2;
        return new THREE.Box3(new THREE.Vector3(object.position.x-hx,0,object.position.z-hz),new THREE.Vector3(object.position.x+hx,2,object.position.z+hz));
      }
      return object.userData.sensorBox??(object.userData.sensorBox=new THREE.Box3().setFromObject(object));
    });
    for (let i = 0; i < angles.length; i++) {
      const heading = angle + THREE.MathUtils.degToRad(angles[i]);
      const direction = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
      raycaster.set(origin, direction);
      raycaster.far = range;
      let hit=null;
      for(const box of boxes) {
        const point=raycaster.ray.intersectBox(box,new THREE.Vector3());
        const distance=point?point.distanceTo(origin):Infinity;
        if(distance<range&&(!hit||distance<hit.distance))hit={distance,point};
      }
      const distance = hit?.distance ?? range;
      readings[i] = distance / range;
      const end = origin.clone().addScaledVector(direction, distance);
      const positions = lines[i].geometry.attributes.position;
      positions.setXYZ(0, origin.x, origin.y + 0.5, origin.z);
      positions.setXYZ(1, end.x, end.y + 0.5, end.z);
      positions.needsUpdate = true;
      lines[i].geometry.computeBoundingSphere();
      const color = readings[i] < 0.25 ? '#ff2244' : readings[i] < 0.55 ? '#ffaa00' : '#00e676';
      lines[i].material.color.set(color);
      lines[i].visible = visible;
      dots[i].visible = Boolean(hit && visible);
      if (hit && visible) dots[i].position.copy(hit.point).setY(hit.point.y + 0.5);
      bars[i].style.width = `${readings[i] * 100}%`;
      bars[i].style.background = color;
      distances[i].textContent = `${Math.round(distance*100)}cm`;
      distances[i].style.color = color;
    }
  }

  function toggle() {
    visible = !visible;
    document.getElementById('sensorBtn').textContent = visible ? 'Debug · on' : 'Debug';
    document.body.classList.toggle('debug-visible', visible);
    for (const line of lines) line.visible = visible;
    for (const dot of dots) dot.visible = false;
  }

  function withoutDebug(render) {
    const objects = [...lines, ...dots];
    const visibility = objects.map((object) => object.visible);
    for (const object of objects) object.visible = false;
    try { render(); }
    finally { objects.forEach((object, index) => { object.visible = visibility[index]; }); }
  }

  return { update, toggle, withoutDebug, readings, range };
}
