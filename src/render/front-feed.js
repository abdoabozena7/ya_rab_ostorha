import * as THREE from 'three';

// Cache the small diagnostic feed at 20 Hz. The main driving view remains rAF.
// Its blit still lands in the original viewport, so the observation API can
// capture exactly the same camera pixels without a second WebGL context.
export function createFrontFeed(renderer) {
  const target=new THREE.WebGLRenderTarget(480,270,{depthBuffer:true});
  const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,2);
  camera.position.z=1;
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshBasicMaterial({map:target.texture,depthTest:false,depthWrite:false,toneMapped:false})));
  let last=-Infinity,started=0,frames=0;
  return {render(timestamp,world,frontCamera,viewport,withoutDebug,onCapture) {
    if(timestamp-last>=50) {
      if(timestamp-last>1000){started=timestamp;frames=0;}
      last=timestamp;frames++;
      renderer.setRenderTarget(target);renderer.setScissorTest(false);renderer.setViewport(0,0,480,270);
      withoutDebug(()=>renderer.render(world,frontCamera));
      renderer.setRenderTarget(null);onCapture();
      if(timestamp-started>=1000){document.getElementById('cameraFps').textContent=`${Math.round(frames*1000/(timestamp-started))} FPS`;started=timestamp;frames=0;}
    }
    renderer.setScissorTest(true);renderer.setScissor(viewport.x,viewport.y,viewport.width,viewport.height);renderer.setViewport(viewport.x,viewport.y,viewport.width,viewport.height);
    renderer.render(scene,camera);
  }};
}
