export function createChaseCamera(THREE, camera) {
  const desired = new THREE.Vector3();
  const target = new THREE.Vector3();
  const look = new THREE.Vector3();
  let initialized = false;
  return {
    reset() { initialized = false; },
    update(car, angle, dt, mode='chase', speed=0, steering=0, frontSensorCamera=null) {
      const forwardX = Math.sin(angle), forwardZ = Math.cos(angle);
      const pace=Math.min(1,Math.abs(speed)*216/50);
      const fov=58+pace*5;
      camera.fov+=(fov-camera.fov)*(1-Math.exp(-2*dt));
      camera.updateProjectionMatrix();
      if (mode==='frontSensor' && frontSensorCamera) {
        frontSensorCamera.updateMatrixWorld(true);
        frontSensorCamera.getWorldPosition(camera.position);
        frontSensorCamera.getWorldQuaternion(camera.quaternion);
        camera.fov=frontSensorCamera.fov;
        camera.updateProjectionMatrix();
        initialized=false;
        return;
      }
      if (mode==='cockpit' || mode==='hood') {
        const offset=mode==='cockpit'?-.34:2.0;
        const eyeX=mode==='cockpit'?-.38:0;
        camera.position.set(car.position.x+forwardX*offset+forwardZ*eyeX,
          car.position.y+(mode==='cockpit'?.77:.88),
          car.position.z+forwardZ*offset-forwardX*eyeX);
        camera.lookAt(car.position.x+forwardX*30,car.position.y+(mode==='cockpit'?.68:.85),
          car.position.z+forwardZ*30);
        initialized=false;
        return;
      }
      if (mode==='front') {
        camera.position.set(car.position.x + forwardX * 2.15, 1.65, car.position.z + forwardZ * 2.15);
        camera.lookAt(car.position.x + forwardX * 25, 1.4, car.position.z + forwardZ * 25);
        initialized = false;
        return;
      }
      const distance=8.2+pace*1.5, lateral=.65+steering*pace*.6;
      desired.set(car.position.x-forwardX*distance+forwardZ*lateral,3.35+pace*.4,car.position.z-forwardZ*distance-forwardX*lateral);
      target.set(car.position.x+forwardX*8,1.2,car.position.z+forwardZ*8);
      if (!initialized) {
        camera.position.copy(desired);
        look.copy(target);
        initialized = true;
      } else {
        camera.position.lerp(desired, 1 - Math.exp(-7 * dt));
        look.lerp(target, 1 - Math.exp(-10 * dt));
      }
      camera.lookAt(look);
    },
  };
}
