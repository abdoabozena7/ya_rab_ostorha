import * as THREE from "three";

const DETAIL_TEXTURE_SIZE = 128;

function noise(x, y, period) {
  const hash = (i, j) => {
    const h = Math.imul((i % period) + 17, 374761393) ^ Math.imul((j % period) + 29, 668265263);
    return ((Math.imul(h ^ (h >>> 13), 1274126177) >>> 8) & 0xFFFFFF) / 0xFFFFFF;
  };
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = THREE.MathUtils.lerp(hash(ix, iy), hash(ix + 1, iy), sx);
  const b = THREE.MathUtils.lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), sx);
  return THREE.MathUtils.lerp(a, b, sy);
}

function makeDetailTexture() {
  const size = DETAIL_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    data[i] = Math.round(255 * (0.65 * noise(x, y, size) + 0.35 * noise(x / 4, y / 4, 32)));
    data[i + 1] = Math.round(255 * (0.66 * noise(x / 16, y / 16, 8) + 0.34 * noise(x / 4, y / 4, 32)));
    data[i + 2] = 0;
    data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.name = "metro-mineral-and-grit-detail";
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

export function createMetroMaterialDetail() {
  let texture;
  const enabled = { value: 0 };

  function apply(material, vertical = false) {
    texture ??= makeDetailTexture();
    const originalCompile = material.onBeforeCompile;
    const originalKey = material.customProgramCacheKey();
    material.customProgramCacheKey = () => `${originalKey}:metro-material-detail:${vertical ? "wall" : "ground"}`;
    material.onBeforeCompile = function (shader, renderer) {
      originalCompile.call(this, shader, renderer);
      shader.uniforms.uMetroDetail = enabled;
      shader.uniforms.tMetroDetail = { value: texture };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vMetroDetailWorld;")
        .replace("#include <project_vertex>", `#include <project_vertex>
          vMetroDetailWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          varying vec3 vMetroDetailWorld;
          uniform sampler2D tMetroDetail;
          uniform float uMetroDetail;`)
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
          if ( uMetroDetail > 0.5 ) {
            float detailDistance = length( vViewPosition );
            vec2 detailUv = vMetroDetailWorld.xz;
            ${vertical ? `
              vec3 wallNormal = inverseTransformDirection( geometryNormal, viewMatrix );
              vec2 wallTangent = wallNormal.zx * vec2( 1.0, -1.0 );
              vec2 wallUv = vec2( dot( detailUv, wallTangent ), vMetroDetailWorld.y );
              // Keep the weathering repeat off the facade's panel grid.
              detailUv = mat2( 0.94, 0.34, -0.34, 0.94 ) * wallUv;
            ` : ""}
            float mineral = texture2D( tMetroDetail, detailUv * ${vertical ? "vec2( 0.18, 0.12 )" : "0.31"} ).g;
            vec2 grainUv = detailUv * 1.4;
            // Oblique surfaces can minify grit even close to the camera.
            vec2 grainFootprint = fwidth( grainUv ) * ${DETAIL_TEXTURE_SIZE}.0;
            float projectedGrain = 1.0 - smoothstep( 1.0, 5.0, max( grainFootprint.x, grainFootprint.y ) );
            float nearGrain = 1.0 - smoothstep( 10.0, 40.0, detailDistance );
            float grain = ( texture2D( tMetroDetail, grainUv ).r - 0.5 ) * nearGrain * projectedGrain;
            float patchFade = 1.0 - smoothstep( 45.0, 130.0, detailDistance );
            float weather = smoothstep( 0.43, 0.81, mineral );
            ${vertical ? "weather *= mix( 1.0, 0.62, smoothstep( 0.4, 3.4, vMetroDetailWorld.y ) );" : ""}
            vec3 stain = ${vertical ? "vec3( 0.70, 0.65, 0.58 )" : "vec3( 0.78, 0.80, 0.83 )"};
            diffuseColor.rgb *= mix( vec3( 1.0 ), stain, weather * patchFade ) *
              ( 1.0 + grain * ${vertical ? "0.14" : "0.08"} );
            roughnessFactor = clamp( roughnessFactor + weather * patchFade * 0.10 + grain * 0.11, 0.08, 1.0 );
          }`);
    };
    material.needsUpdate = true;
  }

  return {
    apply,
    setEnabled(value) { enabled.value = value ? 1 : 0; },
    dispose() { texture?.dispose(); },
  };
}
