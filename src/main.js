import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.152/build/three.module.js';
import { findRoute, hasArrived } from './simulation/pathfinding.js?v=drive-final';
import { loadCarModel } from './render/car-model.js?v=drive-final';
import { createBridge } from './simulation/bridge.js?v=drive-final';
import { createSensors } from './simulation/sensors.js?v=drive-final';
import { updateAstarPanel } from './ui/astar-panel.js?v=drive-final';
import { createTrafficSystem } from './simulation/traffic.js?v=drive-final';
import { createCity } from './render/city.js?v=drive-final';
import { PLACES } from './simulation/places.js?v=drive-final';
import { addPlaceSigns } from './render/place-signs.js?v=drive-final';
import { mountPhone } from './ui/phone.js?v=drive-final';
import { roadLayout, isOnRoad } from './simulation/road-lanes.js?v=drive-final';
import { createPedestrians } from './simulation/pedestrians.js?v=drive-final';
import { createFixedStep, STEP_SECONDS, SPEED_TO_KMH } from './simulation/fixed-step.js?v=drive-final';
import { DevelopmentMockProvider } from './simulation/provider.js';
import { BeamNGProvider } from './simulation/beamng-provider.js';
import { telemetryText } from './ui/telemetry.js';
import { WORLD_EXTENT, surfaceAt, surfaceAhead, roadHeight } from './simulation/road-conditions.js?v=drive-final';
import { leadVehicle, nearbyClearance, motionClear, PLAYER_SIZE, collisionRisk } from './simulation/vehicle-geometry.js?v=drive-final';
import { followingAcceleration, stoppingDistance, safeFollowingSpeed, clamp } from './simulation/longitudinal.js?v=drive-final';
import { buildDrivingPath, followRoute } from './simulation/route-driver.js?v=drive-final';
import { createCinematic } from './render/cinematic.js?v=drive-final';
import { createVehicleAudio } from './render/vehicle-audio.js?v=drive-final';
import { createIncidentMarkers } from './render/incident-markers.js?v=drive-final';
import { createChaseCamera } from './render/chase-camera.js?v=drive-final';
import { createDistrictMap } from './render/district-map.js?v=drive-final';
import { createCameraLabels } from './render/camera-labels.js?v=drive-final';
import { updateVisualLOD } from './render/visual-assets.js?v=drive-final';
import { createFrontFeed } from './render/front-feed.js?v=drive-final';

/* ═══════════════════════════════════════════════════════════════
   SCENE
═══════════════════════════════════════════════════════════════ */
const scene = new THREE.Scene();
const skyCanvas=document.createElement('canvas');skyCanvas.width=2;skyCanvas.height=256;
const skyContext=skyCanvas.getContext('2d'), skyGradient=skyContext.createLinearGradient(0,0,0,256);
skyGradient.addColorStop(0,'#75b8eb');skyGradient.addColorStop(1,'#d5e6ea');
skyContext.fillStyle=skyGradient;skyContext.fillRect(0,0,2,256);
scene.background = new THREE.CanvasTexture(skyCanvas);
scene.background.colorSpace=THREE.SRGBColorSpace;
scene.fog = new THREE.Fog(0xd5e6ea, 160, 350);

let obstacles      = [];
let safetyWarning  = false;
let money          = 0;
let points         = 0;
let expansionLevel = 0;
let frameCount     = 0;
const drivingSettings={cruise:80,throttle:1,brake:1,muted:false};
const equipment={lights:false,signal:null,hazards:false,horn:false};
let dynamics={throttle:0,brake:0,acceleration:0,lateralAcceleration:0};
let currentSurface=surfaceAt(17.5,-40),clearance={gap:Infinity,centimetres:null},plannedSpeed=0;
let drivingPath=[],drivingCursor=0,tripRemaining=0;
let autoSignal=null;
let blockedFrames=0;

let fuel           = 100;
const remoteSimulation=new URLSearchParams(location.search).get('provider')==='beamng';
const simulationProvider = remoteSimulation ? new BeamNGProvider() : new DevelopmentMockProvider();
if(remoteSimulation)simulationProvider.connect();
let vehicleTelemetry = simulationProvider.getVehicleState();
let petrolBunks    = [];
let isRefilling    = false;
let spawnPoint, destination;
let activePlace = PLACES[0];
let namedTripComplete = false;

/* ── AI state ── */
let aiMode            = false;
let fitness           = 0;
let distanceTravelled = 0;
let lastCarPos        = new THREE.Vector3();

/* ── Path ── */
let path         = [];
let pathLines    = [];
let routeVisible = false;
let waypointIdx  = 0;

/* ── Destination collect loop ── */
let destCollecting   = false;

/* Existing route diagnostics remain available from the Route button. */
let stuckTimer=0,colCooldown=0;
let smoothAvoidSteer=0,avoidLockTimer=0,stuckEscapeFrames=0;

const astarPanel=document.getElementById('astarPanel');

/* ═══════════════════════════════════════════════════════════════
   RENDERER
═══════════════════════════════════════════════════════════════ */
let cameraMode = 'chase';
const cameraModes=['chase','cockpit','hood','frontSensor'];
const camera     = new THREE.PerspectiveCamera(58, window.innerWidth/window.innerHeight, 0.1, 400);
const frontCamera = new THREE.PerspectiveCamera(75, 16/9, 0.1, 125);
const districtMap=createDistrictMap(document.getElementById('minimapView'));
const cameraLabels=createCameraLabels(document.getElementById('frontCameraView'),document.getElementById('cvLatency'));
const renderer   = new THREE.WebGLRenderer({ antialias: true });
const frontFeed=createFrontFeed(renderer);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.info.autoReset = false;
renderer.domElement.id = 'gameCanvas';
renderer.domElement.tabIndex = 0;
renderer.domElement.setAttribute('aria-label', 'Driving simulation. WASD or arrow keys to drive. Space to brake.');
document.body.appendChild(renderer.domElement);
const chaseCamera = createChaseCamera(THREE, camera);
const cinematic=createCinematic(THREE,camera);
cinematic.setEnabled(false);
const vehicleAudio=createVehicleAudio();
const incidentMarkers=createIncidentMarkers(THREE,scene);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ═══════════════════════════════════════════════════════════════
   LIGHTING
═══════════════════════════════════════════════════════════════ */
const sun = new THREE.DirectionalLight(0xffedce, 1.15);
sun.position.set(-30,55,-25); sun.castShadow = true;
sun.shadow.mapSize.set(1024,1024);
sun.shadow.camera.near=1; sun.shadow.camera.far=150;
sun.shadow.camera.left=sun.shadow.camera.bottom=-42;
sun.shadow.camera.right=sun.shadow.camera.top=42;
sun.shadow.normalBias=0.05;
sun.shadow.bias=-0.00015;
scene.add(sun, sun.target);
const hemisphere=new THREE.HemisphereLight(0xe3f2ff,0x9e8564,1.05);scene.add(hemisphere);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000,3000),
    new THREE.MeshStandardMaterial({ color:0xc1ac88, roughness:1 }));
ground.rotation.x=-Math.PI/2; ground.position.y=-0.06;
ground.receiveShadow=true; scene.add(ground);

const trafficSystem=createTrafficSystem(THREE,scene,obstacles,()=>expansionLevel,()=>car);
const trafficLights=trafficSystem.lights;
const npcVehicles=trafficSystem.vehicles;
const {initTraffic,createTrafficLights}=trafficSystem;
const getCarTrafficLight=()=>trafficSystem.getCarTrafficLight(car,angle);

/* ═══════════════════════════════════════════════════════════════
   PETROL BUNKS
═══════════════════════════════════════════════════════════════ */
function createPetrolBunks(){
    petrolBunks.forEach(b=>{ scene.remove(b); scene.remove(b.userData.station); }); petrolBunks=[];
    const rng=WORLD_EXTENT+expansionLevel;
    [{x:-rng,z:-rng},{x:rng,z:-rng},{x:-rng,z:rng},{x:rng,z:rng}].forEach(pos=>{
        const g=new THREE.Group();
        g.add(new THREE.Mesh(new THREE.BoxGeometry(12,0.2,9),new THREE.MeshPhongMaterial({color:0xcccccc})));
        const can=new THREE.Mesh(new THREE.BoxGeometry(12,0.35,9),new THREE.MeshPhongMaterial({color:0xff6600}));
        can.position.y=5.5; g.add(can);
        [[-5,-3.5],[5,-3.5],[-5,3.5],[5,3.5]].forEach(([dx,dz])=>{
            const p=new THREE.Mesh(new THREE.CylinderGeometry(0.18,0.18,5.5,8),new THREE.MeshPhongMaterial({color:0x999999}));
            p.position.set(dx,2.75,dz); g.add(p);
        });
        const pump=new THREE.Mesh(new THREE.BoxGeometry(1.2,2,0.7),new THREE.MeshPhongMaterial({color:0xff6600}));
        pump.position.set(0,1,0); g.add(pump);
        const scr=new THREE.Mesh(new THREE.BoxGeometry(0.7,0.5,0.1),
            new THREE.MeshPhongMaterial({color:0x00ffcc,emissive:0x00ffcc,emissiveIntensity:0.6}));
        scr.position.set(0,1.5,0.4); g.add(scr);
        g.position.set(pos.x,0.1,pos.z); scene.add(g);
        const mkr=new THREE.Mesh(new THREE.CylinderGeometry(5,5,0.1,16),
            new THREE.MeshPhongMaterial({transparent:true,opacity:0}));
        mkr.position.set(pos.x,0.5,pos.z); mkr.userData.station=g; scene.add(mkr); petrolBunks.push(mkr);
    });
}
function checkPetrolBunk(){
    if(isRefilling||aiMode) return;
    petrolBunks.forEach(bunk=>{
        if(car.position.distanceTo(bunk.position)<9){
            isRefilling=true; speed=0;
            const fill=prompt('⛽ Petrol Bunk!\nHow much % to fill? (10 ج per 1%)','50');
            const amt=Number(fill);
            if(Number.isInteger(amt)&&amt>0){
                const added=Math.min(amt,Math.ceil(100-fuel));
                const cost=added*10;
                if(money>=cost){fuel=Math.min(100,fuel+added);simulationProvider.setFuelLitres(fuel/100*simulationProvider.fuelCapacity);money-=cost;}
                else alert('Not enough money!');
            }
            setTimeout(()=>{ isRefilling=false; },3000);
        }
    });
}

const {roadNodes,buildCitySegment}=createCity(THREE,scene,obstacles,{initTraffic,createPetrolBunks,createTrafficLights});
buildCitySegment(0);
addPlaceSigns(THREE,scene);

function createSpawn(){
    spawnPoint=new THREE.Mesh(new THREE.CylinderGeometry(2.2,2.2,0.12,32),
        new THREE.MeshPhongMaterial({color:0x0055ff,emissive:0x0033cc,emissiveIntensity:0.5}));
    spawnPoint.position.set(17.5,0.07,-40); spawnPoint.visible=false; scene.add(spawnPoint);
}
function createDestination(place=activePlace){
    if(destination) scene.remove(destination);
    destination=new THREE.Mesh(new THREE.RingGeometry(1.8,2.2,40),
        new THREE.MeshBasicMaterial({color:0xe8c958,transparent:true,opacity:.8,side:THREE.DoubleSide,depthWrite:false}));
    destination.rotation.x=-Math.PI/2;
    destination.position.set(place.x,0.105,place.z); scene.add(destination);
}
createSpawn();

/* ═══════════════════════════════════════════════════════════════
   PLAYER CAR
═══════════════════════════════════════════════════════════════ */
const car=new THREE.Group(); car.position.set(17.5,0.5,-40);
const pedestrianSystem=createPedestrians(THREE,scene,obstacles,()=>car,()=>npcVehicles);
const pedestrians=pedestrianSystem.people;
pedestrianSystem.initPedestrians(WORLD_EXTENT);
trafficSystem.setPedestrians(pedestrians);
const fallbackCar=new THREE.Group(); fallbackCar.name='fallback-car'; car.add(fallbackCar);
const carBody=new THREE.Mesh(new THREE.BoxGeometry(2,0.68,4),new THREE.MeshPhongMaterial({color:0xff2244,shininess:120}));
carBody.castShadow=true; fallbackCar.add(carBody);
const cabin=new THREE.Mesh(new THREE.BoxGeometry(1.62,0.58,2.1),new THREE.MeshPhongMaterial({color:0x1a1a3e,shininess:90}));
cabin.position.set(0,0.63,-0.15); cabin.castShadow=true; fallbackCar.add(cabin);
const wsMat=new THREE.MeshPhongMaterial({color:0x88ccff,transparent:true,opacity:0.55,shininess:200});
const wsF=new THREE.Mesh(new THREE.BoxGeometry(1.55,0.52,0.08),wsMat); wsF.position.set(0,0.63,0.9); fallbackCar.add(wsF);
const wsR=wsF.clone(); wsR.position.set(0,0.63,-1.2); fallbackCar.add(wsR);
const wgeo=new THREE.CylinderGeometry(0.38,0.38,0.28,16);
const wmat=new THREE.MeshPhongMaterial({color:0x111111});
const rmat=new THREE.MeshPhongMaterial({color:0xbbbbbb,shininess:100});
[[-1.12,-0.32,1.45],[1.12,-0.32,1.45],[-1.12,-0.32,-1.45],[1.12,-0.32,-1.45]].forEach(([x,y,z])=>{
    const w=new THREE.Mesh(wgeo,wmat); w.rotation.z=Math.PI/2; w.position.set(x,y,z); w.castShadow=true; fallbackCar.add(w);
    const r=new THREE.Mesh(new THREE.CylinderGeometry(0.22,0.22,0.29,8),rmat); r.rotation.z=Math.PI/2; r.position.set(x,y,z); fallbackCar.add(r);
});
const hmat=new THREE.MeshPhongMaterial({color:0xffffcc,emissive:0xffffaa,emissiveIntensity:1.2});
[-0.65,0.65].forEach(x=>{ const hl=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.22,0.1),hmat); hl.position.set(x,0.05,2.06); fallbackCar.add(hl); });
const tmat=new THREE.MeshPhongMaterial({color:0xff2200,emissive:0xff0000,emissiveIntensity:0.9});
[-0.65,0.65].forEach(x=>{ const tl=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.22,0.1),tmat); tl.position.set(x,0.05,-2.06); fallbackCar.add(tl); });
const bmp=new THREE.Mesh(new THREE.BoxGeometry(2.1,0.22,0.12),new THREE.MeshPhongMaterial({color:0x111111}));
bmp.position.set(0,-0.24,2.06); fallbackCar.add(bmp);
scene.add(car);
let playerVisual=null;
loadCarModel(THREE, car, fallbackCar).then(loaded=>{playerVisual=loaded;});
car.getObjectByName('front-camera-mount').add(frontCamera);
frontCamera.rotation.y=Math.PI;
createDestination();

/* Sensor output is shared with route following and the emergency brake. */
const sensorSystem=createSensors(THREE,scene);
const SR=sensorSystem.readings;
const RAY_LENGTH=sensorSystem.range;

function protectPlayerMotion() {
    const actors=[...npcVehicles,...pedestrians];
    if(!motionClear(car.position,angle,speed,actors,PLAYER_SIZE,.16)) {
        // Swept clearance is preventative, not a measured collision impulse.
        speed=0;dynamics.brake=1;dynamics.throttle=0;safetyWarning=true;
    }
}

function moveWithoutContact(x,z) {
    const oldX=car.position.x, oldZ=car.position.z;
    // Reject crossing the district boundary or a curb instead of teleporting.
    if(!isOnRoad(x,z,WORLD_EXTENT+expansionLevel,aiMode?3.8:3.55)) {
        simulationProvider.recordCollision({speedMps:speed*60,direction:'front',position:{x,z},component:'body'});
        speed=0; safetyWarning=true;
        return false;
    }
    car.position.x=x; car.position.z=z;
    car.updateMatrixWorld(true);
    const carBox=playerBounds();
    for(const obj of obstacles) {
        if(obj.userData.dynamicActor)continue;
        if(Math.hypot(obj.position.x-x,obj.position.z-z)>15) continue;
        const obstacleBox=obj.userData.collisionBox??(obj.userData.collisionBox=new THREE.Box3().setFromObject(obj));
        if(carBox.intersectsBox(obstacleBox)) {
            simulationProvider.recordCollision({speedMps:speed*60,direction:'front',position:{x,z},component:'front'});
            car.position.x=oldX; car.position.z=oldZ;
            speed=0; safetyWarning=true;
            return false;
        }
    }
    return true;
}

// Stable collision envelope, independent of the asynchronously loaded visual.
const playerBox = new THREE.Box3();
function playerBounds() {
    const sin=Math.abs(Math.sin(angle)), cos=Math.abs(Math.cos(angle));
    const halfX=cos*.93+sin*2.36, halfZ=sin*.93+cos*2.36;
    playerBox.min.set(car.position.x-halfX,0.15,car.position.z-halfZ);
    playerBox.max.set(car.position.x+halfX,1.65,car.position.z+halfZ);
    return playerBox;
}

/* ═══════════════════════════════════════════════════════════════
   ★  A* PATHFINDING  — axis-aligned only
═══════════════════════════════════════════════════════════════ */
function planRoute(){
    path=findRoute(roadNodes, car.position, destination.position);
    const roads=roadLayout(WORLD_EXTENT+expansionLevel).roads;
    drivingPath=buildDrivingPath(path,(p,d)=>{
      const axis=Math.abs(d.z)>.5?'z':'x',fixed=axis==='z'?p.x:p.z,along=axis==='z'?p.z:p.x;
      const road=roads.find(r=>r.axis===axis&&Math.abs(r.fixed-fixed)<.1&&along>=r.min&&along<=r.max);
      return road?.sideStreet?1.5:2.5;
    });
    waypointIdx=1;stuckTimer=0;drivingCursor=0;
}
function drawPath(){
    hidePath(); if(!routeVisible||!path.length) return;
    const pts=[new THREE.Vector3(car.position.x,0.5,car.position.z)];
    path.forEach(p=>pts.push(new THREE.Vector3(p.x,0.5,p.z)));
    const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({color:0x00ffff}));
    scene.add(line); pathLines.push(line);
}
function hidePath(){ pathLines.forEach(l=>{ scene.remove(l); l.geometry?.dispose(); }); pathLines=[]; }

/* ═══════════════════════════════════════════════════════════════
   PHYSICS
═══════════════════════════════════════════════════════════════ */
let speed=0, angle=0;
let steering=0, reverseWait=0;
let paused=false, cameraVisible=true;
const simulationClock=createFixedStep();
let keys={};
const isPressed=key=>Boolean(keys[key]);
document.addEventListener('keydown',e=>{
    if(e.target.matches('input, textarea, select, [contenteditable="true"]')) return;
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    keys[e.code]=true;
    vehicleAudio.unlock();
    if(e.code==='KeyH')equipment.horn=true;
    if(e.repeat) return;
    const equipmentKey={KeyL:'lightsBtn',KeyQ:'leftSignalBtn',KeyE:'rightSignalBtn',KeyF:'hazardsBtn'}[e.code];
    if(equipmentKey){e.preventDefault();document.getElementById(equipmentKey).click();}
    if(e.code==='KeyC') { e.preventDefault(); document.getElementById('viewBtn').click(); }
    if(e.code==='KeyP') { e.preventDefault(); document.getElementById('phoneToggleBtn').click(); }
    if(e.code==='Digit1') { e.preventDefault(); setAIMode(!aiMode); }
    if(remoteSimulation&&({KeyR:-1,KeyN:0,KeyG:1}[e.code])!==undefined)
        simulationProvider.setGear({KeyR:-1,KeyN:0,KeyG:1}[e.code]);
    if(e.code==='Escape' && document.getElementById('inGamePhone').hidden) togglePause();
});
document.addEventListener('keyup', e=>{ keys[e.code]=false;if(e.code==='KeyH')equipment.horn=false; });
function clearInput() { keys={};equipment.horn=false;simulationClock.reset();if(remoteSimulation)simulationProvider.releaseControls(); }
window.addEventListener('blur',clearInput);
document.addEventListener('visibilitychange',clearInput);
document.addEventListener('focusin',e=>{
    if(e.target.matches('input, textarea, select')) clearInput();
});

function drivePhysical(automatic) {
    if(automatic&&destCollecting){speed=0;dynamics.throttle=0;dynamics.brake=0;return;}
    const actors=[...npcVehicles,...pedestrians],v=Math.max(0,speed*60);
    const terrain=surfaceAhead(car.position,angle,v);currentSurface=terrain.surface;
    const lead=leadVehicle(car.position,angle,actors);
    const signal=getCarTrafficLight();
    let gap=lead.gap,leadSpeed=lead.velocity;
    if(signal&&signal.state!=='green'&&signal.dist>5&&signal.dist-7<gap){gap=signal.dist-7;leadSpeed=0;}
    // Front ray supplies static geometry; actor following uses oriented hulls.
    const rayGap=SR[3]*RAY_LENGTH-PLAYER_SIZE.length/2;
    if(rayGap<gap&&rayGap<RAY_LENGTH-3){gap=rayGap;leadSpeed=Math.min(leadSpeed,v);}
    let route=null,target=Math.min(drivingSettings.cruise/3.6,terrain.limit);
    if(automatic) {
        if(drivingPath.length<2){planRoute();speed=0;return;}
        route=followRoute(drivingPath,car.position,angle,v,drivingCursor);
        autoSignal=Math.abs(route.steering)>.08?(route.steering>0?'left':'right'):null;
        drivingCursor=route.cursor;tripRemaining=route.remaining;
        waypointIdx=Math.min(path.length-1,Math.floor(drivingCursor/drivingPath.length*path.length));
        target=Math.min(target,route.limit);
    }
    plannedSpeed=Math.min(target,safeFollowingSpeed(gap,leadSpeed,currentSurface.grip));
    const acceleration=followingAcceleration(v,Math.max(.1,target),gap,leadSpeed,{grip:currentSurface.grip});
    const requiredBrake=clamp(-acceleration/(currentSurface.grip*9.81*.92),0,1);
    const forward=isPressed('KeyW')||isPressed('ArrowUp'),backward=isPressed('KeyS')||isPressed('ArrowDown');
    const engine=Math.max(1.1,4.7-v*.045);
    let throttle=automatic?clamp((acceleration+currentSurface.rolling+.00085*v*v)/engine,0,1)*drivingSettings.throttle:forward?drivingSettings.throttle:0;
    let brake=automatic?requiredBrake:backward&&speed>0?drivingSettings.brake:0;
    const risk=collisionRisk(car.position,angle,v,actors,PLAYER_SIZE,1.8);
    const assist=automatic&&(v>plannedSpeed+.7||risk&&risk.ttc<.9);
    if(assist){brake=Math.max(brake,requiredBrake,risk?.ttc<.9?1:0);throttle=0;}
    if(speed<0){throttle=forward?drivingSettings.throttle:0;}
    safetyWarning=Boolean(assist&&brake>.35);
    const beforeAngle=angle;
    const beforeWheelAngles=[...simulationProvider.wheelAngles];
    Object.assign(simulationProvider.state,{speed,angle,steering,reverseWait});
    vehicleTelemetry=simulationProvider.step({
        forward,backward,throttle,brake,handbrake:isPressed('Space'),
        left:isPressed('KeyA')||isPressed('ArrowLeft'),right:isPressed('KeyD')||isPressed('ArrowRight'),
        ...(automatic?{steering:route.steering}:{}),maxKmh:180,surface:currentSurface,
    });
    dynamics=simulationProvider.state;
    ({speed,angle,steering,reverseWait}=dynamics);
    protectPlayerMotion();car.rotation.y=angle;
    if(!moveWithoutContact(car.position.x+Math.sin(angle)*speed,car.position.z+Math.cos(angle)*speed)){
        angle=beforeAngle;car.rotation.y=angle;dynamics.brake=1;dynamics.throttle=0;
    }
    simulationProvider.state.speed=speed;
    if(speed===0){simulationProvider.wheelAngularVelocity.fill(0);simulationProvider.wheelAngles=beforeWheelAngles;}
    vehicleTelemetry=simulationProvider.getVehicleState();
    fuel=100*vehicleTelemetry.fuelLevelL/vehicleTelemetry.fuelCapacityL;
    car.userData.velocity={x:car.position.x-lastCarPos.x,z:car.position.z-lastCarPos.z};
    const moved=car.position.distanceTo(lastCarPos);distanceTravelled+=moved;
    fitness=Math.floor(distanceTravelled*.5)+points*200;
    document.getElementById('fitnessVal').textContent=fitness;
    clearance=nearbyClearance(car.position,angle,actors);
    blockedFrames=speed<.004?blockedFrames+1:0;
    if(automatic&&route.remaining<4&&hasArrived(car.position,destination.position)){checkDestination();return;}
    if(automatic&&destCollecting)showBanner(`وصلت ${activePlace.name}`,'collect');
    else if(safetyWarning)showBanner('فرملة وقائية · مسافة الأمان','red');
    else if(gap<18&&speed*60<5)showBanner('زحمة · متابعة الطابور بهدوء','yellow');
    else if(currentSurface.limit<60)showBanner(`${currentSurface.name} · تهدئة قبل الجزء المتضرر`,'yellow');
    else if(automatic)showBanner(`قيادة آلية · ${Math.round(tripRemaining)} متر متبقي`,'green');
}
function moveCar(){drivePhysical(false);}
function aiDrive(){drivePhysical(true);}

function showBanner(text,cls){
    const b=document.getElementById('aiBanner');
    b.textContent=text; b.className=cls; b.style.display='block';
}

function checkDestination(){
    if(destCollecting||namedTripComplete||!destination) return;
    if(hasArrived(car.position,destination.position)){
        money+=500; points+=1; fitness+=300;

        namedTripComplete=true;
        destCollecting=true;
        speed=0;
        showBanner(`📍 وصلت ${activePlace.name}`,'collect');
    }
}

function updateUI(){
    const kmh=Number.isFinite(vehicleTelemetry.speedMps)?Math.abs(vehicleTelemetry.speedMps)*3.6:null;
    document.querySelector('#mission .eyebrow').textContent=aiMode?'AUTO NAVIGATION':'FREE DRIVE';
    document.getElementById('speedVal').innerText =kmh==null?'—':kmh.toFixed(0);
    document.getElementById('surfaceName').textContent=remoteSimulation?'BeamNG telemetry':currentSurface.name;
    document.getElementById('clearanceValue').textContent=remoteSimulation?'City view: preview only':`أقرب خلوص ${clearance.centimetres??'—'} سم`;
    document.getElementById('stopDistance').textContent=remoteSimulation?'Stopping distance: unmeasured':`مسافة التوقف ${stoppingDistance((kmh??0)/3.6,currentSurface.grip).toFixed(2)} م (estimate)`;
    document.getElementById('throttleMeter').value=vehicleTelemetry.throttle??0;
    document.getElementById('brakeMeter').value=vehicleTelemetry.brake??0;
    const event=trafficSystem.incidents.active[0];
    document.getElementById('incidentStatus').textContent=remoteSimulation?'R reverse · N neutral · G drive':'الطريق مفتوح · مرور طبيعي';
    document.getElementById('gearVal').textContent = vehicleTelemetry.gear??'—';
    document.getElementById('cityStatus').textContent = `${remoteSimulation?'City preview · ':''}1.28 km corridor · ${npcVehicles.length} vehicles · ${pedestrians.length} pedestrians`;
    if(!remoteSimulation)document.getElementById('cameraActivity').lastChild.nodeValue=paused?' PAUSED':' LIVE';
    document.getElementById('moneyVal').innerText =money+' ج';
    document.getElementById('pointVal').innerText =points;
    document.getElementById('fuelVal').innerText  =Number.isFinite(fuel)?Math.floor(fuel)+'%':'—';
    document.getElementById('fuelFill').style.width  =(Number.isFinite(fuel)?Math.floor(fuel):0)+'%';
    document.getElementById('speedFill').style.width =Math.min(100,((kmh??0)/180)*100)+'%';
    const providerLabel=remoteSimulation?(simulationProvider.connected&&!simulationProvider.fresh?'BeamNG telemetry stale':simulationProvider.status):'Development mock · unvalidated physics';
    document.getElementById('simulationState').textContent=paused?'Paused':providerLabel;
    document.getElementById('providerStatus').textContent=providerLabel;
    if(document.body.classList.contains('debug-visible')) {
        document.getElementById('debugTelemetry').textContent=telemetryText(vehicleTelemetry,{
            renderFPS:measuredRenderFPS,remote:remoteSimulation,latencyMs:simulationProvider.latencyMs,
            sensorRates:simulationProvider.sensorRates,sensorErrors:simulationProvider.sensorErrors});
    }
}

/* Traffic HUD */
const tlDotRed   =document.getElementById('tlDotRed');
const tlDotYellow=document.getElementById('tlDotYellow');
const tlDotGreen =document.getElementById('tlDotGreen');
const tlPanel    =document.getElementById('tlPanel');
function updateTrafficHUD(){
    const tlResult=getCarTrafficLight();
    const st=tlResult?tlResult.state:null;
    if(!st){
        tlPanel.style.opacity='0.35';
        tlDotRed.className='tl-dot'; tlDotYellow.className='tl-dot'; tlDotGreen.className='tl-dot';
        if(!aiMode && !safetyWarning) document.getElementById('aiBanner').style.display='none';
        return;
    }
    tlPanel.style.opacity='1';
    tlDotRed.className   ='tl-dot'+(st==='red'   ?' active-red'   :'');
    tlDotYellow.className='tl-dot'+(st==='yellow'?' active-yellow':'');
    tlDotGreen.className ='tl-dot'+(st==='green' ?' active-green' :'');
    if(!aiMode && !safetyWarning){
        const b=document.getElementById('aiBanner');
        b.style.display='block';
        if(st==='red')        { b.textContent='🔴  RED LIGHT — STOP';   b.className='red'; }
        else if(st==='yellow'){ b.textContent='🟡  YELLOW — SLOW DOWN'; b.className='yellow'; }
        else                  { b.textContent='🟢  GREEN — GO';          b.className='green'; }
    }
}

/* ═══════════════════════════════════════════════════════════════
   MODE TOGGLE
═══════════════════════════════════════════════════════════════ */
const modeOverlay =document.getElementById('modeOverlay');
const modeBadge   =document.getElementById('modeBadge');
const aiStatusEl  =document.getElementById('aiStatus');
const fitnessPanel=document.getElementById('fitnessPanel');
const aiToggleBtn =document.getElementById('aiToggleBtn');

function flashOverlay(isAI){
    modeOverlay.textContent=isAI?'🤖  AI DRIVE ACTIVATED':'🕹️  MANUAL MODE';
    modeOverlay.className  =isAI?'show-ai':'show-manual';
    modeOverlay.style.opacity='1';
    setTimeout(()=>{ modeOverlay.style.opacity='0'; },1600);
}
function setAIMode(on){
    if(remoteSimulation)on=false;
    aiMode=on;
    autoSignal=null;
    clearInput(); steering=0; reverseWait=0;
    aiToggleBtn.textContent=on?'Auto':'Manual';
    aiToggleBtn.className  =on?'ctrl-btn ai-on':'ctrl-btn';
    modeBadge.textContent  =on?'AI AUTO':'MANUAL';
    modeBadge.className    =on?'ai':'manual';
    aiStatusEl.className   =on?'ai-mode':'';
    fitnessPanel.style.display=on?'block':'none';
    if(on){
        document.getElementById('missionText').textContent=`Destination · ${activePlace.name}`;
        distanceTravelled=0; fitness=0; stuckTimer=0;
        stuckEscapeFrames=0; smoothAvoidSteer=0; avoidLockTimer=0;
        colCooldown=0; destCollecting=namedTripComplete;dynamics.throttle=0;dynamics.brake=0;
        document.getElementById('fitnessVal').innerText='0';
        routeVisible=false;
        if(speed<0) speed=0;
        planRoute();
    } else {
        routeVisible=false; hidePath();
        document.getElementById('aiBanner').style.display='none';
    }
    flashOverlay(on);
}

mountPhone(place=>{
    activePlace=place;
    namedTripComplete=false;
    destCollecting=false;
    speed=0;
    createDestination(place);
    document.getElementById('missionText').textContent=`Destination · ${place.name}`;
    routeVisible=true;
    if(aiMode){ planRoute(); drawPath(); }
    else setAIMode(true);
});

const bridge=remoteSimulation?{sendFrame(){}}:createBridge({
    renderer,
    readState: ()=>({
        simulationTime:vehicleTelemetry.timestamp,physicsTick:vehicleTelemetry.physicsTick,
        speedKmh: Number((Math.abs(speed)*SPEED_TO_KMH).toFixed(1)),
        fuel: Math.floor(fuel),
        mode: aiMode?'auto':'manual',
        safety: safetyWarning?'emergency-brake':'clear',
        position: {x:Number(car.position.x.toFixed(2)), z:Number(car.position.z.toFixed(2))},
        clearanceCm:clearance.centimetres,
        throttle:Number(dynamics.throttle.toFixed(3)),brake:Number(dynamics.brake.toFixed(3)),
        surface:currentSurface.name,grip:currentSurface.grip,
        stoppingDistanceM:Number(stoppingDistance(Math.abs(speed)*60,currentSurface.grip).toFixed(2)),
        requestedSpeedKmh:drivingSettings.cruise,plannedSpeedKmh:Number((plannedSpeed*3.6).toFixed(1)),
        cinematic:cinematic.active,timeScale:cinematic.scale,cinematicEvents:cinematic.events,equipment,
        tripRemainingM:Math.round(tripRemaining),
        incidents:trafficSystem.incidents.active.map(e=>({id:e.id,type:e.type,remaining:Math.ceil(trafficSystem.incidents.remaining(e))})),
        onRoad: isOnRoad(car.position.x,car.position.z,WORLD_EXTENT+expansionLevel),
        sensorsM: SR.map(value=>Number((value*RAY_LENGTH).toFixed(2))),
        light: getCarTrafficLight()?.state ?? null,
        destination: {id:activePlace.id,x:activePlace.x,z:activePlace.z},
        actors: [...npcVehicles,...pedestrians]
            .filter(actor=>Math.hypot(actor.group.position.x-car.position.x,actor.group.position.z-car.position.z)<45)
            .map(actor=>({
                type:actor.kind??'pedestrian',id:actor.index,
                width:actor.width,length:actor.length,heading:actor.group.rotation.y,
                x:Number(actor.group.position.x.toFixed(2)),
                z:Number(actor.group.position.z.toFixed(2)),
                vx:Number((actor.velocity.x*60).toFixed(2)),
                vz:Number((actor.velocity.z*60).toFixed(2)),
                radius:actor.radius
            }))
    })
});

/* ═══════════════════════════════════════════════════════════════
   ANIMATION LOOP
═══════════════════════════════════════════════════════════════ */
let previousFrameAt=performance.now();
let performanceAt=previousFrameAt, renderedFrames=0, renderFrame=0,measuredRenderFPS=null;
let simulationCost=0,renderCost=0,trafficCost=0,pedestrianCost=0,playerCost=0;
function simulate(){
    const started=performance.now();
    lastCarPos.copy(car.position);
    safetyWarning=false;

    trafficSystem.tickEvents(STEP_SECONDS);
    trafficLights.forEach(tl=>tl.update(1));
    npcVehicles.forEach(v=>{
      const near=Math.hypot(v.group.position.x-car.position.x,v.group.position.z-car.position.z)<70;
      const period=near?2:6;
      if(frameCount%period===v.index%period)v.update(period);
    });
    trafficCost+=(performance.now()-started-trafficCost)*.1;
    const pedestriansStarted=performance.now();
    pedestrians.forEach(person=>{
      const period=Math.hypot(person.group.position.x-car.position.x,person.group.position.z-car.position.z)<55?2:12;
      if(frameCount%period===person.index%period)person.update(frameCount,STEP_SECONDS*period,period);
    });
    pedestrianCost+=(performance.now()-pedestriansStarted-pedestrianCost)*.1;
    const playerStarted=performance.now();
    car.updateMatrixWorld();
    if(frameCount%12===0)sensorSystem.update(car,angle,obstacles);
    if(frameCount%6===0)cinematic.detect(car.position,angle,speed*60,[...npcVehicles,...pedestrians]);
        aiMode && !isPressed('Space') ? aiDrive() : moveCar();

        checkDestination();
        checkPetrolBunk();
    playerCost+=(performance.now()-playerStarted-playerCost)*.1;

        if(routeVisible&&frameCount%15===0){ if(!aiMode) path=findRoute(roadNodes,car.position,destination.position); drawPath(); }
    frameCount++;

    if(destination)destination.material.opacity=.68+Math.sin(frameCount*.04)*.12;
    if(spawnPoint)  spawnPoint.rotation.y-=0.02;
    simulationCost+=(performance.now()-started-simulationCost)*.1;
}

function viewportFor(id) {
    const bounds=document.getElementById(id).getBoundingClientRect();
    return {x:bounds.left,y:window.innerHeight-bounds.bottom,width:bounds.width,height:bounds.height};
}

function animate(timestamp=performance.now()){
    const elapsed=Math.max(0,(timestamp-previousFrameAt)/1000);
    const deltaSeconds=Math.min(0.1,elapsed);
    previousFrameAt=timestamp;
    requestAnimationFrame(animate);
    // Background browser tabs can suspend rAF entirely. Do not count that
    // sleep as a rendered frame or a performance sample.
    if(document.hidden || elapsed>1) {
        performanceAt=timestamp; renderedFrames=0;
        simulationClock.reset();
        document.getElementById('performance').textContent='Measuring FPS…';
        if(document.hidden) return;
    }
    if(remoteSimulation) {
        vehicleTelemetry=simulationProvider.getVehicleState();
        fuel=vehicleTelemetry.fuelCapacityL>0?100*vehicleTelemetry.fuelLevelL/vehicleTelemetry.fuelCapacityL:null;
    }
    if(!remoteSimulation && !paused && !document.hidden) simulationClock.advance(deltaSeconds,simulate);
    else simulationClock.reset();
    renderFrame++;
    if(renderFrame%12===0)updateVisualLOD(scene,car.position);
    if(renderFrame%30===0) {
        for(const actor of [...npcVehicles,...pedestrians]) {
            const nearby=actor.group.position.distanceToSquared(car.position)<60*60;
            actor.group.traverse(part=>{if(part.isMesh) part.castShadow=nearby;});
        }
    }
    if(renderFrame%6===0) {
        updateUI();
        if(!remoteSimulation)updateTrafficHUD();
        updateAstarPanel({routeVisible,path,waypointIdx,destination});
    }
    const displaySteer=steering;
    if(!paused) {
      const simDelta=deltaSeconds*cinematic.scale;
      if(!remoteSimulation)playerVisual?.update(simDelta,speed,displaySteer,dynamics.brake>.08||safetyWarning,{
        ...dynamics,...equipment,signal:equipment.signal??autoSignal,hazards:equipment.hazards||cinematic.active,time:frameCount/60,height:roadHeight(car.position.x,car.position.z),
        wheels:vehicleTelemetry.wheels,
        telemetry:vehicleTelemetry,
        wheelHeights:[[-.89,-1.39],[-.89,1.39],[.89,-1.39],[.89,1.39]].map(([x,z])=>roadHeight(car.position.x+x*Math.cos(angle)+z*Math.sin(angle),car.position.z-x*Math.sin(angle)+z*Math.cos(angle))),
      });
      chaseCamera.update(car,angle,deltaSeconds,cameraMode,speed,displaySteer,frontCamera);
      cinematic.update(deltaSeconds,car,angle);
      incidentMarkers.update(trafficSystem.incidents.active,frameCount/60);
    }
    vehicleAudio.update(speed*60,dynamics.throttle,currentSurface.roughness,equipment.horn,paused||drivingSettings.muted,cinematic.scale);
    sun.position.set(car.position.x-30,55,car.position.z-25);
    sun.target.position.copy(car.position);
    sun.target.updateMatrixWorld();
    if(renderFrame%3===0)districtMap.update(car,angle,WORLD_EXTENT+expansionLevel,path,destination,npcVehicles);

    const cW=window.innerWidth, cH=window.innerHeight;
    const renderStarted=performance.now();
    renderer.info.reset();
    renderer.shadowMap.needsUpdate=renderFrame%2===0;
    renderer.setScissorTest(false);
    renderer.setViewport(0,0,cW,cH);
    // A following vehicle can sit inside the chase camera. Hide only those
    // near-camera visuals for this pass; physics and the front feed keep them.
    const cameraOccluders=cameraMode!=='chase'?[]:npcVehicles.filter(v=>v.group.visible&&Math.hypot(v.group.position.x-camera.position.x,v.group.position.z-camera.position.z)<4.3);
    cameraOccluders.forEach(v=>{v.group.visible=false;});
    playerVisual?.setCameraMode(cameraMode);
    renderer.render(scene,camera);
    playerVisual?.setCameraMode('chase');
    cameraOccluders.forEach(v=>{v.group.visible=true;});
    renderer.setScissorTest(true);
    const frontViewport=viewportFor('frontCameraView');
    if(cameraVisible&&!remoteSimulation) {
        frontFeed.render(timestamp,scene,frontCamera,frontViewport,sensorSystem.withoutDebug,
            ()=>cameraLabels.update(frontCamera,
                document.body.classList.contains('debug-visible')?[...npcVehicles,...pedestrians]:[],obstacles));
    }
    renderer.setScissorTest(false);
    renderCost+=(performance.now()-renderStarted-renderCost)*.1;
    if(cameraVisible && renderFrame%30===0) bridge.sendFrame(frontViewport);
    renderedFrames++;
    if(timestamp-performanceAt>=1000) {
        const fps=renderedFrames*1000/(timestamp-performanceAt);
        measuredRenderFPS=fps;
        document.getElementById('performance').textContent=`${fps.toFixed(0)} FPS · ${(1000/fps).toFixed(1)} ms/frame`;
        document.getElementById('renderStats').textContent=`${renderer.info.render.calls} calls · ${Math.round(renderer.info.render.triangles/1000)}k tris · sim ${simulationCost.toFixed(1)}ms (${trafficCost.toFixed(1)}/${pedestrianCost.toFixed(1)}/${playerCost.toFixed(1)}) · render ${renderCost.toFixed(1)}ms`;
        renderedFrames=0; performanceAt=timestamp;
    }
}

/* ═══════════════════════════════════════════════════════════════
   BUTTONS
═══════════════════════════════════════════════════════════════ */
document.getElementById('viewBtn').onclick  = ()=>{
    cameraMode=cameraModes[(cameraModes.indexOf(cameraMode)+1)%cameraModes.length];
    document.getElementById('viewBtn').textContent=`${{chase:'Chase',cockpit:'Cockpit',hood:'Hood',frontSensor:'Front sensor'}[cameraMode]} view · C`;
    chaseCamera.reset();
};
document.getElementById('routeBtn').onclick = ()=>{
    routeVisible=!routeVisible;
    if(!routeVisible){
        hidePath();
        astarPanel.style.display='none';   // hide A* panel when route hidden
    } else {
        if(!aiMode)path=findRoute(roadNodes, car.position, destination.position);
        drawPath();
    }
};
document.getElementById('sensorBtn').onclick = ()=>{
    if(remoteSimulation)document.body.classList.toggle('debug-visible');else sensorSystem.toggle();
};
aiToggleBtn.onclick = ()=>{ setAIMode(!aiMode); };

function togglePause() {
    paused=!paused;
    clearInput();
    if(remoteSimulation)simulationProvider.setPaused(paused);
    document.getElementById('pauseBtn').textContent=paused?'Resume':'Pause';
    document.getElementById('pauseScreen').hidden=!paused;
    document.getElementById('simulationState').textContent=paused?'Paused':'Live simulation';
}
document.getElementById('pauseBtn').onclick=togglePause;
document.getElementById('resumeBtn').onclick=togglePause;
document.getElementById('hideCameraBtn').onclick=()=>{
    cameraVisible=!cameraVisible;
    document.getElementById('cameraCard').hidden=!cameraVisible;
    document.getElementById('hideCameraBtn').textContent=cameraVisible?'Hide camera':'Show camera';
};
document.getElementById('resetBtn').onclick=()=>{
    if(remoteSimulation){simulationProvider.resetVehicle();return;}
    setAIMode(false);
    speed=0; angle=0; steering=0; reverseWait=0; fuel=100;simulationProvider.resetVehicle();vehicleTelemetry=simulationProvider.getVehicleState();dynamics=simulationProvider.state;cinematic.reset();
    car.position.set(17.5,0.5,-40); car.rotation.y=0;
    namedTripComplete=false; destCollecting=false;
    // Restore agents as well, ensuring the original spawn remains clear.
    initTraffic(); pedestrianSystem.initPedestrians(WORLD_EXTENT+expansionLevel);
    chaseCamera.reset();
    document.getElementById('missionText').textContent='Choose a destination on the phone';
    if(paused) togglePause();
    renderer.domElement.focus();
};

const settingsPanel=document.getElementById('driveSettings');
document.getElementById('driveSettingsBtn').onclick=()=>{
  settingsPanel.hidden=!settingsPanel.hidden;
  document.getElementById('driveSettingsBtn').setAttribute('aria-expanded',String(!settingsPanel.hidden));
};
for(const [id,key,output,divisor,unit] of [['cruiseSpeed','cruise','cruiseOutput',1,' كم/س'],['throttlePressure','throttle','throttleOutput',100,'%'],['brakePressure','brake','brakeOutput',100,'%']]) {
  document.getElementById(id).oninput=e=>{drivingSettings[key]=Number(e.target.value)/divisor;document.getElementById(output).textContent=e.target.value+unit;};
}
document.getElementById('trafficDensity').onchange=e=>trafficSystem.setDensity(Number(e.target.value));
document.getElementById('randomEvents').onchange=e=>trafficSystem.setConditions(e.target.checked);
document.getElementById('cinematicEnabled').onchange=e=>cinematic.setEnabled(e.target.checked);
document.getElementById('muteAudio').onchange=e=>drivingSettings.muted=e.target.checked;
document.getElementById('incidentBtn').onclick=()=>trafficSystem.trigger('braking');
document.getElementById('longTripBtn').onclick=()=>{
  activePlace=PLACES.find(p=>p.id==='north-gate');namedTripComplete=false;destCollecting=false;
  createDestination(activePlace);setAIMode(true);settingsPanel.hidden=true;document.getElementById('driveSettingsBtn').setAttribute('aria-expanded','false');
};
document.getElementById('nearMissBtn').onclick=()=>{
  if(paused)togglePause();
  car.position.set(17.5,.5,350);angle=0;car.rotation.y=0;speed=60/216;steering=0;reverseWait=0;
  dynamics={throttle:0,brake:0,acceleration:0,lateralAcceleration:0};cinematic.reset();chaseCamera.reset();
  trafficSystem.prepareNearMiss();activePlace=PLACES.find(p=>p.id==='north-gate');
  namedTripComplete=false;destCollecting=false;createDestination(activePlace);setAIMode(true);
  sensorSystem.update(car,angle,obstacles);
  settingsPanel.hidden=true;document.getElementById('driveSettingsBtn').setAttribute('aria-expanded','false');
};
function updateEquipmentButtons(){
  document.getElementById('lightsBtn').setAttribute('aria-pressed',String(equipment.lights));
  document.getElementById('leftSignalBtn').setAttribute('aria-pressed',String(equipment.signal==='left'));
  document.getElementById('rightSignalBtn').setAttribute('aria-pressed',String(equipment.signal==='right'));
  document.getElementById('hazardsBtn').setAttribute('aria-pressed',String(equipment.hazards));
}
document.getElementById('lightsBtn').onclick=()=>{equipment.lights=!equipment.lights;updateEquipmentButtons();};
for(const [id,side] of [['leftSignalBtn','left'],['rightSignalBtn','right']])document.getElementById(id).onclick=()=>{equipment.signal=equipment.signal===side?null:side;updateEquipmentButtons();};
document.getElementById('hazardsBtn').onclick=()=>{equipment.hazards=!equipment.hazards;updateEquipmentButtons();};
const hornButton=document.getElementById('hornBtn');
hornButton.onpointerdown=e=>{vehicleAudio.unlock();equipment.horn=true;hornButton.setPointerCapture(e.pointerId);};
hornButton.onpointerup=hornButton.onpointercancel=()=>equipment.horn=false;
hornButton.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();vehicleAudio.unlock();equipment.horn=true;}};
hornButton.onkeyup=()=>equipment.horn=false;
document.addEventListener('pointerdown',()=>vehicleAudio.unlock(),{once:true});
document.getElementById('nightMode').onchange=e=>{
  const night=e.target.checked;sun.intensity=night?.13:1.15;hemisphere.intensity=night?.20:1.05;
  scene.background=night?new THREE.Color(0x142737):new THREE.CanvasTexture(skyCanvas);
  scene.fog.color.setHex(night?0x142737:0xd5e6ea);equipment.lights=night;updateEquipmentButtons();
};
if(remoteSimulation) {
    document.getElementById('aiToggleBtn').disabled=true;
    document.getElementById('longTripBtn').disabled=true;
    document.getElementById('trafficDensity').disabled=true;
    document.querySelector('#minimapBorder .map-caption').textContent='CITY PREVIEW · UNREGISTERED';
    document.getElementById('cameraSource').textContent='BEAMNG RGB';
    document.getElementById('cameraSource').title='Mounted simulator sensor. Camera and city preview use different worlds.';
    document.getElementById('cvLatency').title='Sensor acquisition timestamp, or scenario time at poll if unavailable';
    const image=document.getElementById('authoritativeCamera'),notice=document.getElementById('cameraUnavailable');
    let loading=false,lastCameraReceipt=null,frameURL=null;
    image.onerror=()=>{loading=false;notice.hidden=false;notice.textContent='BeamNG camera unavailable';};
    image.onload=()=>{loading=false;image.hidden=false;notice.hidden=true;};
    setInterval(()=>{
        const active=!paused&&!document.hidden;
        simulationProvider.updateControls({
            throttle:active&&(isPressed('KeyW')||isPressed('ArrowUp'))?drivingSettings.throttle:0,
            brake:!active||isPressed('KeyS')||isPressed('ArrowDown')?drivingSettings.brake:0,
            steering:active?Number(isPressed('KeyA')||isPressed('ArrowLeft'))-Number(isPressed('KeyD')||isPressed('ArrowRight')):0,
            parkingbrake:active&&isPressed('Space')?1:0,
        });
        const frame=simulationProvider.sensorMetadata.frontCamera;
        const fresh=simulationProvider.fresh&&frame?.frameAvailable&&
            simulationProvider.telemetry.receivedMonotonic-frame.receivedMonotonic<.75&&!simulationProvider.sensorErrors.frontCamera;
        document.getElementById('cameraActivity').lastChild.nodeValue=fresh?' LIVE':' STALE';
        if(!fresh){notice.hidden=false;notice.textContent='BeamNG camera unavailable / stale';}
        if(fresh&&cameraVisible&&!loading&&lastCameraReceipt!==frame.receivedMonotonic){
            lastCameraReceipt=frame.receivedMonotonic;loading=true;
            fetch(`/api/simulation/camera.jpg?frame=${lastCameraReceipt}`).then(async response=>{
                if(!response.ok)throw new Error('Camera frame unavailable');
                const blob=await response.blob();
                if(frameURL)URL.revokeObjectURL(frameURL);frameURL=URL.createObjectURL(blob);image.src=frameURL;
                const acquisition=response.headers.get('X-Sensor-Time'),poll=response.headers.get('X-Simulation-Time-At-Poll');
                document.getElementById('cvLatency').textContent=acquisition!=null?`t ${Number(acquisition).toFixed(3)}s`:
                    poll!=null?`poll ${Number(poll).toFixed(3)}s`:'t unavailable';
            }).catch(()=>image.onerror());
        }
        const rate=simulationProvider.sensorRates.frontCamera;
        document.getElementById('cameraFps').textContent=rate==null?'— Hz':`${rate.toFixed(1)} poll Hz`;
        if(!fresh)document.getElementById('cvLatency').textContent='frame stale';
    },50);
    window.addEventListener('pagehide',()=>simulationProvider.close());
}
animate();
