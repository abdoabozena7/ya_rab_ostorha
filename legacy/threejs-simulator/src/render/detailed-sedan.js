import { mergeStaticVisual } from './visual-assets.js?v=drive-final';
// Original editable sedan: 4.72 m long, 1.86 m wide, 2.78 m wheelbase.
export function buildDetailedSedan(THREE,car,fallback) {
  const root=new THREE.Group();let body=new THREE.Group();root.name='detailed-sedan';root.position.y=-.42;root.add(body);car.add(root);fallback.visible=false;
  const cabin=new THREE.Group();root.add(cabin);
  const paint=new THREE.MeshPhysicalMaterial({color:0xdbae26,metalness:.55,roughness:.24,clearcoat:1,clearcoatRoughness:.15});
  const dark=new THREE.MeshStandardMaterial({color:0x161b20,roughness:.56});
  const glass=new THREE.MeshPhysicalMaterial({color:0x182d39,metalness:.35,roughness:.12,clearcoat:1});
  const chrome=new THREE.MeshStandardMaterial({color:0xbfc7c9,metalness:.9,roughness:.22});
  const rubber=new THREE.MeshStandardMaterial({color:0x101214,roughness:.92});
  const red=new THREE.MeshStandardMaterial({color:0x9a1719,emissive:0xff1511,emissiveIntensity:.15,roughness:.28});
  const white=new THREE.MeshStandardMaterial({color:0xe4efff,emissive:0xe4efff,emissiveIntensity:.2});
  const reverse=new THREE.MeshStandardMaterial({color:0xbabdb9,emissive:0xffffff,emissiveIntensity:0});
  const indicators=[-1,1].map(()=>new THREE.MeshStandardMaterial({color:0xa7520b,emissive:0xff970a,emissiveIntensity:0}));
  const mesh=(geometry,material,parent=body)=>{const m=new THREE.Mesh(geometry,material);m.castShadow=true;m.receiveShadow=false;parent.add(m);return m;};
  const box=(w,h,l,x,y,z,material,parent=body)=>{const m=mesh(new THREE.BoxGeometry(w,h,l),material,parent);m.position.set(x,y,z);return m;};
  const line=(points,material=dark,r=.012,parent=body)=>mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),Math.max(8,points.length*4),r,5,false),material,parent);
  const quad=(points,material,parent=body)=>{const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(points.flat(),3));g.setIndex([0,1,2,0,2,3]);g.computeVertexNormals();const m=mesh(g,material,parent);m.material.side=THREE.DoubleSide;return m;};
  function shell(rings,material,parent=body) {
    const vertices=[],indices=[];
    for(const [z,w,lo,hi] of rings)for(const [x,y] of [[-w*.8,lo],[-w,lo+(hi-lo)*.25],[-w*.99,hi-(hi-lo)*.17],[-w*.8,hi],[w*.8,hi],[w*.99,hi-(hi-lo)*.17],[w,lo+(hi-lo)*.25],[w*.8,lo]])vertices.push(x,y,z);
    for(let i=0;i<rings.length-1;i++)for(let j=0;j<8;j++) {
      const a=i*8+j,b=(i+1)*8+j,n=(j+1)%8;indices.push(a,b,i*8+n,b,(i+1)*8+n,i*8+n);
    }
    for(let j=1;j<7;j++){indices.push(0,j,j+1);const end=(rings.length-1)*8;indices.push(end,end+j+1,end+j);}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.setIndex(indices);g.computeVertexNormals();return mesh(g,material,parent);
  }
  const profile=[[-2.36,.77,.35,.77],[-2.18,.91,.32,.86],[-1.7,.93,.31,.96],[-.6,.93,.3,1.01],[.6,.92,.3,1.00],[1.55,.92,.32,.85],[2.13,.88,.34,.74],[2.36,.73,.4,.67]];
  const bodyRings=[];
  for(let i=0;i<=80;i++) {
    const z=-2.36+4.72*i/80,b=profile.findIndex(p=>p[0]>=z),j=Math.max(1,b<0?profile.length-1:b),a=profile[j-1],p=profile[j],t=(z-a[0])/(p[0]-a[0]);
    const w=a[1]+(p[1]-a[1])*t,hi=a[3]+(p[3]-a[3])*t;
    let lo=a[2]+(p[2]-a[2])*t;
    for(const wheelZ of [-1.39,1.39]){const d=Math.abs(z-wheelZ);if(d<.40)lo=Math.max(lo,.35+Math.sqrt(.40**2-d*d));}
    bodyRings.push([z,w,Math.min(hi-.055,lo),hi]);
  }
  shell(bodyRings,paint);box(1.44,.13,3.4,0,.33,0,dark);
  // A smoothly tapered cabin, with individual glazing and physical pillars.
  shell([[-1.48,.76,.88,.93],[-.86,.72,.92,1.42],[-.55,.71,.94,1.48],[.44,.68,.94,1.46],[1.14,.76,.86,.92]],paint,cabin);
  quad([[-.65,1.475,.46],[.65,1.475,.46],[.73,.96,1.15],[-.73,.96,1.15]],glass,cabin);
  quad([[.69,1.44,-.89],[-.69,1.44,-.89],[-.73,.985,-1.47],[.73,.985,-1.47]],glass,cabin);
  for(const side of [-1,1]) {
    const x=side*.735;
    quad([[x,.98,-1.29],[side*.705,1.36,-.84],[side*.697,1.415,-.18],[side*.77,.98,-.18]],glass,cabin);
    quad([[side*.77,.98,-.08],[side*.686,1.415,-.08],[side*.661,1.41,.40],[side*.745,.95,1.04]],glass,cabin);
    line([[side*.78,.955,-1.40],[side*.80,.968,-.1],[side*.785,.94,1.12]],chrome,.015);
    // Door gaps follow the side surface, handles and mirrors are separate.
    for(const z of [-1.39,-.13,1.10])line([[side*.89,.85,z],[side*.93,.61,z],[side*.88,.36,z]],dark,.008);
    line([[side*.89,.36,-1.39],[side*.92,.35,-.1],[side*.88,.36,1.1]],dark,.008);
    for(const z of [-.95,.43])box(.04,.043,.20,side*.932,.89,z,chrome);
    const mirror=mesh(new THREE.SphereGeometry(1,16,10),paint);mirror.scale.set(.16,.09,.23);mirror.position.set(side*1.005,1.01,.72);
    box(.15,.035,.05,side*.90,.96,.76,dark);
    const lens=box(.22,.115,.018,side*1.015,1.015,.54,chrome);lens.rotation.y=side*.12;
    box(.07,.025,.22,side*1.1,1.02,.75,indicators[side<0?0:1]);
    line([[side*.75,.77,1.45],[side*.63,.79,1.78],[side*.50,.715,2.24]],dark,.007);
  }
  // Lower grille, splitter, trunk seam, diffuser and twin exhaust tips.
  box(1.22,.19,.045,0,.46,2.30,dark);box(.86,.105,.04,0,.67,2.34,dark);
  for(let i=-5;i<=5;i++)box(.016,.14,.055,i*.1,.46,2.33,chrome);
  box(1.47,.065,.12,0,.31,2.22,dark);box(1.51,.19,.1,0,.39,-2.28,dark);
  line([[-.72,.845,-2.1],[0,.86,-2.15],[.72,.845,-2.1]],dark,.009);
  for(const side of [-1,1]) {
    const exhaust=mesh(new THREE.CylinderGeometry(.062,.062,.15,18),chrome);exhaust.rotation.x=Math.PI/2;exhaust.position.set(side*.61,.32,-2.35);
    box(.42,.095,.04,side*.53,.69,-2.379,red);
    box(.15,.045,.035,side*.43,.608,-2.38,reverse);
    box(.08,.075,.04,side*.715,.69,-2.378,indicators[side<0?0:1]);
    box(.42,.085,.04,side*.49,.607,2.379,white);
    box(.075,.075,.04,side*.685,.607,2.378,indicators[side<0?0:1]);
    for(const off of [-.115,.1]) {
      const bezel=mesh(new THREE.CylinderGeometry(.037,.037,.038,20),chrome);bezel.rotation.x=Math.PI/2;bezel.position.set(side*.49+off,.607,2.405);
      const led=mesh(new THREE.SphereGeometry(.024,12,8),white);led.position.set(side*.49+off,.607,2.425);
    }
    box(.25,.025,.06,side*.59,.752,2.23,white);
    box(.16,.035,.025,side*.6,.428,2.31,white);
  }
  box(.36,.028,.028,0,1.125,-1.20,red);
  // Heated rear screen, wipers, badge, antenna and license plates.
  for(let i=0;i<7;i++){const t=i/8;line([[-.57,1.02+t*.31,-1.34+t*.39],[.57,1.02+t*.31,-1.34+t*.39]],new THREE.MeshStandardMaterial({color:0x756251}),.0025);}
  for(const x of [-.38,.28])line([[x,.951,1.10],[x+.21,1.00,1.03],[x+.40,1.12,.87]],dark,.008);
  const badge=mesh(new THREE.SphereGeometry(.045,12,8),chrome);badge.scale.z=.25;badge.position.set(0,.77,-2.365);
  const antenna=mesh(new THREE.ConeGeometry(.04,.13,12),dark);antenna.position.set(0,1.49,-.67);
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=128;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#e7e5d8';ctx.fillRect(0,0,512,128);ctx.fillStyle='#247497';ctx.fillRect(0,0,512,32);
  ctx.textAlign='center';ctx.font='bold 25px Arial';ctx.fillStyle='white';ctx.fillText('مصر   EGYPT',256,26);ctx.fillStyle='#17242b';ctx.font='bold 57px Arial';ctx.fillText('ق هـ ر  •  ٤٢',256,98);
  const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;
  for(const side of [-1,1]){const plate=mesh(new THREE.PlaneGeometry(.53,.135),new THREE.MeshStandardMaterial({map,roughness:.42}));plate.position.set(0,.56,side*2.368);plate.rotation.y=side<0?Math.PI:0;}
  const wheels=[];
  for(const x of [-.89,.89])for(const z of [-1.39,1.39]) {
    const pivot=new THREE.Group(),spin=new THREE.Group();pivot.position.set(x,.35,z);root.add(pivot);pivot.add(spin);
    const tire=mesh(new THREE.TorusGeometry(.262,.089,14,48),rubber,spin);tire.rotation.y=Math.PI/2;
    const rim=mesh(new THREE.CylinderGeometry(.245,.245,.18,40),chrome,spin);rim.rotation.z=Math.PI/2;
    const well=mesh(new THREE.CylinderGeometry(.208,.208,.186,32),dark,spin);well.rotation.z=Math.PI/2;
    const disc=mesh(new THREE.CylinderGeometry(.165,.165,.19,32),chrome,spin);disc.rotation.z=Math.PI/2;
    for(let spoke=0;spoke<10;spoke++){
      const a=spoke*Math.PI/5,m=box(.196,.035,.19,0,Math.sin(a)*.13,Math.cos(a)*.13,chrome,spin);m.rotation.x=-a;
    }
    const hub=mesh(new THREE.CylinderGeometry(.068,.068,.215,20),chrome,spin);hub.rotation.z=Math.PI/2;
    const caliper=box(.20,.16,.08,0,.015,.145,new THREE.MeshStandardMaterial({color:0xb62c23}),pivot);
    const mergedWheel=mergeStaticVisual(spin);spin.clear();spin.add(mergedWheel);
    wheels.push({pivot,spin,front:z>0});
    // Dark wheel arch and painted fender lip, open below the wheel centre.
    const archPoints=[];for(let i=0;i<=24;i++){const a=i/24*Math.PI;archPoints.push([x*1.035,.35+Math.sin(a)*.39,z+Math.cos(a)*.39]);}
    line(archPoints,dark,.044);line(archPoints,paint,.018);
  }
  const lights=[];
  for(const x of [-.61,.61]) {
    const light=new THREE.SpotLight(0xe4efff,0,65,.43,.45,1.5);light.position.set(x,.72,2.26);
    light.target.position.set(x,0,35);root.add(light,light.target);lights.push(light);
  }
  const cameraMount=new THREE.Group();cameraMount.name='front-camera-mount';cameraMount.position.set(0,1.02,1.2);car.add(cameraMount);
  // Lightweight cockpit landmarks; the dash remains part of the existing car.
  box(1.43,.16,.48,0,.88,.67,dark,root);
  for(const x of [-.46,.46]) {
    box(.48,.15,.48,x,.59,-.45,dark,root);
    box(.48,.58,.12,x,.87,-.68,dark,root);
  }
  const steeringWheel=new THREE.Group();
  steeringWheel.position.set(-.42,1.01,.39);
  root.add(steeringWheel);
  const steeringRim=mesh(new THREE.TorusGeometry(.18,.024,8,28),dark,steeringWheel);
  steeringRim.rotation.x=.25;
  box(.31,.025,.025,0,0,0,chrome,steeringWheel);
  box(.025,.31,.025,0,0,0,chrome,steeringWheel);
  box(.28,.09,.025,0,1.34,.62,dark,root);
  const gaugeCanvas=document.createElement('canvas');gaugeCanvas.width=256;gaugeCanvas.height=96;
  const gaugeContext=gaugeCanvas.getContext('2d'),gaugeTexture=new THREE.CanvasTexture(gaugeCanvas);
  gaugeTexture.colorSpace=THREE.SRGBColorSpace;
  const gauge=mesh(new THREE.PlaneGeometry(.48,.16),new THREE.MeshBasicMaterial({map:gaugeTexture,side:THREE.DoubleSide}),root);
  gauge.position.set(-.42,1.015,.68);gauge.rotation.y=Math.PI;
  let lastGaugeAt=-Infinity;
  const combined=mergeStaticVisual(body);root.remove(body);body=combined;root.add(body);
  const cabinMerged=mergeStaticVisual(cabin);cabin.clear();cabin.add(cabinMerged);
  return {visual:root,cameraMount,setCameraMode(mode){cabin.visible=mode!=='cockpit';body.visible=mode!=='cockpit';},update(dt,speed,steering,braking,state={}) {
    if(dt<=0)return;const v=speed*60;
    const response=1-Math.exp(-dt*8),heights=state.wheelHeights??[0,0,0,0],bounce=heights.reduce((a,b)=>a+b,0)/4;
    body.position.y+=(bounce-body.position.y)*response;
    const roadPitch=(heights[0]+heights[2]-heights[1]-heights[3])/(2*2.78);
    const roadRoll=(heights[2]+heights[3]-heights[0]-heights[1])/(2*1.78);
    body.rotation.x+=((Math.max(-.065,Math.min(.065,-(state.acceleration??0)*.008+roadPitch)))-body.rotation.x)*response;
    body.rotation.z+=((Math.max(-.075,Math.min(.075,(state.lateralAcceleration??0)*.009+roadRoll)))-body.rotation.z)*response;
    cabin.position.copy(body.position);cabin.rotation.copy(body.rotation);
    steeringWheel.rotation.z=steering*8;
    if(state.telemetry&&(state.time??0)-lastGaugeAt>.1) {
      lastGaugeAt=state.time??0;const t=state.telemetry;
      gaugeContext.fillStyle='#121c22';gaugeContext.fillRect(0,0,256,96);
      gaugeContext.fillStyle='#e6d69d';gaugeContext.font='bold 27px monospace';
      gaugeContext.fillText(`${Math.round(Math.abs(t.speedMps)*3.6)} km/h`,8,33);
      gaugeContext.font='18px monospace';gaugeContext.fillText(`${Math.round(t.engineRPM)} rpm  ${t.gear}`,8,60);
      gaugeContext.fillText(`Fuel ${Math.round(t.fuelLevelL/t.fuelCapacityL*100)}%`,8,84);gaugeTexture.needsUpdate=true;
    }
    wheels.forEach((w,i)=>{
      const physical=state.wheels?.[i];
      w.spin.rotation.x=physical?.angleRad??(w.spin.rotation.x+v*dt/.35);
      w.pivot.rotation.y=physical?.steeringAngleRad??(w.front?steering:0);
      w.pivot.position.y=.35+(state.wheelHeights?.[i]??bounce);
    });
    const blink=Math.sin((state.time??0)*Math.PI*3)>0;
    red.emissiveIntensity=braking||state.brake>.08?3:state.lights?.55:.12;
    white.emissiveIntensity=state.lights?3:.22;reverse.emissiveIntensity=speed<-.001?2:0;
    indicators.forEach((m,i)=>{m.emissiveIntensity=blink&&(state.hazards||state.signal===(i===0?'left':'right'))?4:0;});
    lights.forEach(light=>light.intensity=state.lights?5:0);
  }};
}
