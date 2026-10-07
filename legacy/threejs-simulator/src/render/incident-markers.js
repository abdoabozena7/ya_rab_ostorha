export function createIncidentMarkers(THREE,scene) {
  const root=new THREE.Group();scene.add(root);const markers=new Map();
  const coneGeo=new THREE.ConeGeometry(.22,.65,10),coneMat=new THREE.MeshStandardMaterial({color:0xf79435});
  return {update(events,time) {
    for(const [id,group] of markers)if(!events.some(e=>e.id===id)){root.remove(group);markers.delete(id);}
    for(const event of events) {
      let marker=markers.get(event.id);
      if(!marker) {
        marker=new THREE.Group();
        if(event.type==='roadworks')for(let i=0;i<5;i++) {
          const cone=new THREE.Mesh(coneGeo,coneMat);cone.position.set(1.25,.4,-3+i*1.4);marker.add(cone);
        }
        const lamp=new THREE.Mesh(new THREE.SphereGeometry(.12,8,8),new THREE.MeshBasicMaterial({color:0xffbb30}));
        lamp.position.y=2.2;marker.add(lamp);marker.userData.lamp=lamp;
        root.add(marker);markers.set(event.id,marker);
      }
      marker.position.copy(event.vehicle.group.position);marker.rotation.copy(event.vehicle.group.rotation);
      marker.userData.lamp.visible=Math.sin(time*9)>0;
    }
  }};
}
