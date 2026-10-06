export function createChaseCamera(THREE, camera) {
  const desired = new THREE.Vector3();
  const target = new THREE.Vector3();
  const look = new THREE.Vector3();
  let initialized = false;
  return {
    reset() { initialized = false; },
    update(car, angle, dt, frontView, speed=0, steering=0) {
      const forwardX = Math.sin(angle), forwardZ = Math.cos(angle);
      const pace=Math.min(1,Math.abs(speed)*216/50);
      const fov=58+pace*5;
      camera.fov+=(fov-camera.fov)*(1-Math.exp(-2*dt));
      camera.updateProjectionMatrix();
      if (frontView) {
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
