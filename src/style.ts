import * as THREE from 'three';

/**
 * Art direction: flat, cartoon shading with hard light bands and dark outlines on
 * characters, under a dusky sky. References: Inside (mood, silhouettes, haze) and
 * OlliOlli World (bold flat colour).
 */

let ramp: THREE.DataTexture | null = null;
function toonRamp(): THREE.DataTexture {
  if (ramp) return ramp;
  // Three flat tones: shadow, mid, lit.
  ramp = new THREE.DataTexture(new Uint8Array([120, 185, 255]), 3, 1, THREE.RedFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  return ramp;
}

type ToonParams = THREE.MeshToonMaterialParameters & { roughness?: number; metalness?: number; flatShading?: boolean };

/** Toon material. Accepts (and ignores) the PBR-only settings so call sites stay simple. */
export function toon(params: ToonParams): THREE.MeshToonMaterial {
  const { roughness: _r, metalness: _m, flatShading: _f, ...rest } = params;
  return new THREE.MeshToonMaterial({ gradientMap: toonRamp(), ...rest });
}

const outlineMat = new THREE.MeshBasicMaterial({ color: 0x0b0d1a, side: THREE.BackSide });

/** Adds an inverted-hull ink outline to every mesh under `root`. */
export function outline(root: THREE.Object3D, thickness = 0.014): void {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.userData.outline) meshes.push(o as THREE.Mesh);
  });
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    const size = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
    const hull = new THREE.Mesh(mesh.geometry, outlineMat);
    hull.userData.outline = true;
    // Grow each axis by the same absolute amount so thin limbs get as bold a line as torsos.
    hull.scale.set(1 + (2 * thickness) / size.x, 1 + (2 * thickness) / size.y, 1 + (2 * thickness) / size.z);
    mesh.add(hull);
  }
}

/** Dusk sky: deep blue overhead fading to a warm haze at the horizon, with a moon and stars. */
export function buildSky(scene: THREE.Scene): void {
  const HAZE = 0x4a4470;
  scene.background = new THREE.Color(HAZE);
  scene.fog = new THREE.FogExp2(HAZE, 0.0052);

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(430, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x18245a) },
        mid: { value: new THREE.Color(0x4a4a8c) },
        horizon: { value: new THREE.Color(0xd98a6a) },
      },
      vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 c = mix(horizon, mid, smoothstep(0.0, 0.16, h));
          c = mix(c, top, smoothstep(0.12, 0.6, h));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  dome.renderOrder = -2;
  scene.add(dome);

  const moon = new THREE.Mesh(new THREE.CircleGeometry(16, 32), new THREE.MeshBasicMaterial({ color: 0xfff3d6, fog: false }));
  moon.position.set(-150, 190, -330);
  moon.lookAt(0, 0, 0);
  scene.add(moon);

  const stars = new Float32Array(260 * 3);
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    const a = rand() * Math.PI * 2, e = 0.25 + rand() * 1.2;
    stars.set([Math.cos(a) * Math.cos(e) * 420, Math.sin(e) * 420, Math.sin(a) * Math.cos(e) * 420], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(stars, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xdfe6ff, size: 1.6, sizeAttenuation: false, fog: false })));

  // Soft moonlight so nothing is ever pitch black, plus a cool key light for the toon bands.
  scene.add(new THREE.HemisphereLight(0x8a96e0, 0x4a3a52, 1.25));
  const key = new THREE.DirectionalLight(0xa8b8ff, 0.7);
  key.position.set(-0.45, 1, -0.6);
  scene.add(key);

  // Skyline silhouettes beyond the walls.
  const blockMat = new THREE.MeshBasicMaterial({ color: 0x1a1f45 });
  const windowMat = new THREE.MeshBasicMaterial({ color: 0xffc98a });
  const windowGeo = new THREE.PlaneGeometry(1.6, 2.2);
  for (let i = 0; i < 44; i++) {
    const side = i % 4;
    const along = -190 + rand() * 380;
    const depth = 120 + rand() * 60;
    const w = 16 + rand() * 26, h = 14 + rand() * 46, d = 14 + rand() * 20;
    const block = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), blockMat);
    const [x, z] = side === 0 ? [along, depth] : side === 1 ? [along, -depth - 20] : side === 2 ? [depth, along] : [-depth, along];
    block.position.set(x, h / 2, z);
    block.rotation.y = side < 2 ? 0 : Math.PI / 2;
    scene.add(block);
    for (let k = 0; k < 5; k++) {
      const win = new THREE.Mesh(windowGeo, windowMat);
      const inward = side === 0 ? [0, 0, -1] : side === 1 ? [0, 0, 1] : side === 2 ? [-1, 0, 0] : [1, 0, 0];
      const u = (rand() - 0.5) * (w - 4), v = 4 + rand() * (h - 7);
      win.position.set(x + inward[0] * (d / 2 + 0.1) + (side < 2 ? u : 0), v, z + inward[2] * (d / 2 + 0.1) + (side < 2 ? 0 : u));
      win.lookAt(win.position.x + inward[0], v, win.position.z + inward[2]);
      scene.add(win);
    }
  }
}
