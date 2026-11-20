import * as THREE from "three";

function fallbackVehicle(site, geometries, materials) {
  const root = new THREE.Group();
  root.name = `${site.id}-local-loading-silhouette`;
  const paint = new THREE.MeshStandardMaterial({ color: 0x87908a, roughness: 0.96, metalness: 0 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x353d3c, roughness: 0.94, metalness: 0 });
  materials.add(paint); materials.add(dark);
  const add = (geometry, material, x, y, z) => {
    geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh); return mesh;
  };
  add(new THREE.BoxGeometry(site.width, site.height * 0.42, site.length),
    paint, 0, site.height * 0.43, 0);
  add(new THREE.BoxGeometry(site.width * 0.91, site.height * 0.51, site.length * 0.64),
    paint, 0, site.height * 0.745, -site.length * 0.035);
  add(new THREE.BoxGeometry(site.width * 0.86, site.height * 0.24, site.length * 0.65),
    dark, 0, site.height * 0.73, -site.length * 0.035);
  const radius = site.height * 0.17, thickness = 0.13;
  for (const x of [-1, 1])
    for (const z of [-1, 1]) {
      const wheel = add(new THREE.CylinderGeometry(radius, radius, thickness, 10), dark,
        x * (site.width / 2 - thickness / 2), radius, z * site.length * 0.31);
      wheel.rotation.z = Math.PI / 2;
    }
  return root;
}

function matchRegisteredHull(visual, site) {
  visual.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(visual);
  const size = bounds.getSize(new THREE.Vector3());
  if (![size.x, size.y, size.z].every((n) => Number.isFinite(n) && n > 0))
    throw new Error(`Empty parked asset for ${site.id}`);
  visual.scale.multiply(new THREE.Vector3(site.width / size.x, site.height / size.y, site.length / size.z));
  visual.updateMatrixWorld(true);
  bounds.setFromObject(visual);
  const center = bounds.getCenter(new THREE.Vector3());
  visual.position.add(new THREE.Vector3(-center.x, -bounds.min.y, -center.z));
  visual.updateMatrixWorld(true);
  bounds.setFromObject(visual);
  return {
    minX: bounds.min.x, maxX: bounds.max.x, minZ: bounds.min.z, maxZ: bounds.max.z,
    widthM: bounds.max.x - bounds.min.x, lengthM: bounds.max.z - bounds.min.z,
    heightM: bounds.max.y - bounds.min.y,
    sideErrorM: Math.max(Math.abs(bounds.min.x + site.width / 2),
      Math.abs(bounds.max.x - site.width / 2), Math.abs(bounds.min.z + site.length / 2),
      Math.abs(bounds.max.z - site.length / 2)),
  };
}

/** Reuses the view's asset cache and clone/fit callbacks; never imports the view. */
export function createDistrictProps(world, { loadAsset, fit, assetFor } = {}) {
  const root = new THREE.Group();
  root.name = "egypt-registered-parked-props";
  root.userData.districtProps = true;
  const sites = world.environment === "egypt"
    ? (world.statics ?? []).filter((site) => site.kind === "parked-vehicle") : [];
  const diagnostics = {
    active: world.environment === "egypt", siteIds: sites.map((site) => site.id),
    loaded: 0, pending: sites.length, failed: [], bounds: [], disposed: false,
  };
  const geometries = new Set(), materials = new Set();
  const disposeFallback = (fallback) => {
    fallback.traverse((part) => {
      if (!part.isMesh) return;
      if (geometries.delete(part.geometry)) part.geometry.dispose();
      for (const material of Array.isArray(part.material) ? part.material : [part.material])
        if (materials.delete(material)) material.dispose();
    });
    fallback.removeFromParent();
  };
  const dispose = () => {
    if (diagnostics.disposed) return;
    diagnostics.disposed = true; root.removeFromParent(); root.clear();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    geometries.clear(); materials.clear();
  };
  if (sites.length && (![loadAsset, fit, assetFor].every((callback) => typeof callback === "function")))
    throw new TypeError("District props require the existing asset, fit and assetFor callbacks");
  const jobs = sites.map((site) => {
    const group = new THREE.Group();
    group.name = site.id; group.userData.staticId = site.id;
    group.position.set(site.x, 0.12, site.z);
    group.rotation.y = site.heading ?? 0; root.add(group);
    const fallback = fallbackVehicle(site, geometries, materials);
    group.add(fallback);
    return Promise.resolve().then(async () => {
      const actor = { id: site.id, type: "vehicle", kind: site.vehicleKind, phase: 0 };
      const url = assetFor(actor, "egypt");
      const loaded = await loadAsset(url);
      if (diagnostics.disposed) return;
      const visual = fit(loaded.scene ?? loaded, site.width, site.length, site.height, true);
      visual.name = `${site.id}-registered-asset`;
      const measured = matchRegisteredHull(visual, site);
      if (measured.sideErrorM > 0.15) throw new Error(`Parked footprint mismatch for ${site.id}`);
      visual.traverse((part) => {
        if (part.isMesh) part.castShadow = part.receiveShadow = true;
      });
      group.add(visual); disposeFallback(fallback);
      diagnostics.loaded++;
      diagnostics.bounds.push({ id: site.id, url, ...measured });
    }).catch((error) => {
      diagnostics.failed.push({ id: site.id, error: String(error.message ?? error) });
    }).finally(() => { diagnostics.pending--; });
  });
  const ready = Promise.all(jobs).then(() => diagnostics);
  return { root, diagnostics, dispose, ready };
}
