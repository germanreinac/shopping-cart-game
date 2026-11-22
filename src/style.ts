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

const inkCache = new Map<number, THREE.MeshBasicMaterial>();
/** Ink for an outline: a deep, slightly plum version of the fill colour, never pure black. */
function inkFor(fill: THREE.Color): THREE.MeshBasicMaterial {
  const key = fill.getHex();
  let mat = inkCache.get(key);
  if (!mat) {
    const c = fill.clone().multiplyScalar(0.32).lerp(new THREE.Color(0x2a1226), 0.35);
    mat = new THREE.MeshBasicMaterial({ color: c, side: THREE.BackSide });
    inkCache.set(key, mat);
  }
  return mat;
}

/** Adds an inverted-hull ink outline to every mesh under `root` (skips meshes flagged userData.outline). */
export function outline(root: THREE.Object3D, thickness = 0.014): void {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.userData.outline) meshes.push(o as THREE.Mesh);
  });
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    const size = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
    const fill = (mesh.material as THREE.MeshToonMaterial).color ?? new THREE.Color(0x222222);
    const hull = new THREE.Mesh(mesh.geometry, inkFor(fill));
    hull.userData.outline = true;
    // Grow each axis by the same absolute amount so thin limbs get as bold a line as torsos.
    hull.scale.set(1 + (2 * thickness) / size.x, 1 + (2 * thickness) / size.y, 1 + (2 * thickness) / size.z);
    mesh.add(hull);
  }
}

/**
 * Night sky and everything beyond the walls. The mood is Kentucky Route Zero: a deep
 * teal dark, a pale glow on the horizon, silhouettes of hills, trees and telephone poles,
 * and a radio mast blinking far off. Returns a per-frame update for the beacon.
 */
export function buildSky(scene: THREE.Scene): { update(time: number): void } {
  const HAZE = 0x0e2226;
  scene.background = new THREE.Color(HAZE);
  scene.fog = new THREE.FogExp2(HAZE, 0.0068);

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(430, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x03060f) },
        mid: { value: new THREE.Color(0x0b2233) },
        horizon: { value: new THREE.Color(0x55784a) }, // smog: a sour green where the sky meets the land
      },
      vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 c = mix(horizon, mid, smoothstep(0.0, 0.2, h));
          c = mix(c, top, smoothstep(0.15, 0.65, h));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  dome.renderOrder = -2;
  scene.add(dome);

  const moon = new THREE.Mesh(new THREE.CircleGeometry(20, 40), new THREE.MeshBasicMaterial({ color: 0xf4f1dc, fog: false }));
  moon.position.set(-150, 150, -340);
  moon.lookAt(0, 0, 0);
  scene.add(moon);
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const stars = new Float32Array(320 * 3);
  for (let i = 0; i < 320; i++) {
    const a = rand() * Math.PI * 2, e = 0.2 + rand() * 1.3;
    stars.set([Math.cos(a) * Math.cos(e) * 420, Math.sin(e) * 420, Math.sin(a) * Math.cos(e) * 420], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(stars, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xcfe6ee, size: 1.5, sizeAttenuation: false, fog: false })));

  // Moonlight: enough to read shapes by, never enough to feel like day.
  scene.add(new THREE.HemisphereLight(0x6f9bb8, 0x15232e, 1.0));
  const key = new THREE.DirectionalLight(0xa9cde0, 0.6);
  key.position.set(-0.45, 1, -0.9);
  scene.add(key);

  // Hills: two rings of low dark mounds, the nearer one darker.
  const far = new THREE.MeshBasicMaterial({ color: 0x143040 });
  const near = new THREE.MeshBasicMaterial({ color: 0x08141c });
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rand() * 0.2;
    const farHill = new THREE.Mesh(new THREE.ConeGeometry(70 + rand() * 60, 30 + rand() * 40, 7), far);
    farHill.position.set(Math.cos(a) * 330, 8, Math.sin(a) * 330);
    const nearHill = new THREE.Mesh(new THREE.ConeGeometry(50 + rand() * 40, 14 + rand() * 18, 6), near);
    nearHill.position.set(Math.cos(a + 0.12) * 225, 3, Math.sin(a + 0.12) * 225);
    scene.add(farHill, nearHill);
  }

  // Bare trees just beyond the walls.
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.45, 9, 5);
  const crownGeo = new THREE.ConeGeometry(4.2, 11, 6);
  for (let i = 0; i < 46; i++) {
    const a = rand() * Math.PI * 2;
    const r = 132 + rand() * 50;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (z < -100 && Math.abs(x) < 100) continue; // not on top of the shop
    const scale = 0.8 + rand() * 0.9;
    const trunk = new THREE.Mesh(trunkGeo, near);
    trunk.position.set(x, 4.5 * scale, z);
    trunk.scale.setScalar(scale);
    const crown = new THREE.Mesh(crownGeo, near);
    crown.position.set(x, (9 + 4) * scale, z);
    crown.scale.setScalar(scale);
    scene.add(trunk, crown);
  }

  // Telephone poles and sagging wires along the road to the west.
  const poleMat = new THREE.MeshBasicMaterial({ color: 0x050b10 });
  const wirePts: THREE.Vector3[] = [];
  for (let z = -200; z <= 200; z += 40) {
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.5, 16, 0.5), poleMat);
    pole.position.set(-112, 8, z);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(5, 0.35, 0.35), poleMat);
    arm.position.set(-112, 14.6, z);
    scene.add(pole, arm);
    if (z < 200) {
      for (const sx of [-2.2, 2.2]) {
        for (let k = 0; k < 8; k++) {
          const sag = (t: number) => 14.8 - Math.sin(t * Math.PI) * 2.2;
          wirePts.push(new THREE.Vector3(-112 + sx, sag(k / 8), z + (k / 8) * 40), new THREE.Vector3(-112 + sx, sag((k + 1) / 8), z + ((k + 1) / 8) * 40));
        }
      }
    }
  }
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(wirePts), new THREE.LineBasicMaterial({ color: 0x050b10 })));

  // A radio mast far off to the north-east, with a slow red beacon.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 2.4, 120, 4), poleMat);
  mast.position.set(210, 60, -250);
  scene.add(mast);
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff3b30, fog: false });
  for (const y of [120, 80, 40]) {
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(2.2, 8, 6), beaconMat);
    beacon.position.set(210, y, -250);
    scene.add(beacon);
  }

  // One farmhouse with a single lit window, a long way out.
  const house = new THREE.Mesh(new THREE.BoxGeometry(18, 9, 12), near);
  house.position.set(-170, 4.5, 150);
  const gable = new THREE.Mesh(new THREE.ConeGeometry(13, 6, 4), near);
  gable.position.set(-170, 12, 150);
  gable.rotation.y = Math.PI / 4;
  const lit = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 2.6), new THREE.MeshBasicMaterial({ color: 0xffd98a, fog: false }));
  lit.position.set(-160.9, 4.6, 148);
  lit.rotation.y = Math.PI / 2;
  scene.add(house, gable, lit);

  return {
    update(time: number) {
      // Two seconds dark, a slow swell, then dark again.
      const phase = (time % 3.2) / 3.2;
      const glow = Math.max(0, Math.sin(phase * Math.PI * 2 - 1.2));
      beaconMat.color.setRGB(0.15 + glow * 0.85, 0.02 + glow * 0.2, 0.02 + glow * 0.16);
    },
  };
}

/**
 * A spray-paint tag on a wall. The Sludge Life half of the look: crude, wobbly, dripping
 * lettering in sickly colours over the tidy flat world.
 */
export function graffiti(scene: THREE.Scene, text: string, color: string, x: number, y: number, z: number, rotY: number, width: number): void {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  let seed = text.length * 97 + text.charCodeAt(0) * 13;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.font = `900 ${text.length > 7 ? 92 : 120}px "Arial Black", Impact, sans-serif`;
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const total = g.measureText(text).width;
  let penX = (512 - total) / 2;
  for (const ch of text) {
    const w = g.measureText(ch).width;
    g.save();
    g.translate(penX + w / 2, 112 + (rand() - 0.5) * 26);
    g.rotate((rand() - 0.5) * 0.3);
    g.transform(1, 0, -0.18, 1, 0, 0);
    g.lineWidth = 16;
    g.strokeStyle = 'rgba(8,12,10,0.9)';
    g.strokeText(ch, -w / 2, 0);
    g.fillStyle = color;
    g.fillText(ch, -w / 2, 0);
    g.restore();
    // Drips.
    if (rand() > 0.45) {
      g.fillStyle = color;
      const dx = penX + w * (0.25 + rand() * 0.5);
      g.fillRect(dx, 150, 5 + rand() * 4, 30 + rand() * 60);
    }
    penX += w;
  }
  // Overspray speckle.
  g.fillStyle = color;
  for (let i = 0; i < 60; i++) g.fillRect(rand() * 512, rand() * 256, 2, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, width / 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotY;
  scene.add(mesh);
}

/** Factory stacks on the horizon breathing out lit smog, and the green murk it leaves low in the sky. */
export function buildSmog(scene: THREE.Scene): { update(time: number): void } {
  const stackMat = new THREE.MeshBasicMaterial({ color: 0x060d10 });
  const puffMat = new THREE.MeshBasicMaterial({ color: 0x3a5632, transparent: true, opacity: 0.24, fog: false, depthWrite: false });
  const puffs: { mesh: THREE.Mesh; x: number; z: number; phase: number }[] = [];
  for (const [x, z, h] of [[-260, -210, 70], [-235, -230, 52], [250, 190, 64], [140, 300, 48]]) {
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(4, 6.5, h, 8), stackMat);
    stack.position.set(x, h / 2, z);
    scene.add(stack);
    for (let i = 0; i < 5; i++) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(9 + i * 3, 8, 6), puffMat);
      scene.add(mesh);
      puffs.push({ mesh, x, z, phase: i / 5 + (x % 7) * 0.1 });
      mesh.userData.base = h;
    }
  }
  // A band of murk sitting on the horizon.
  const murk = new THREE.Mesh(
    new THREE.CylinderGeometry(420, 420, 60, 40, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x6f8f3a, transparent: true, opacity: 0.08, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  murk.position.y = 26;
  scene.add(murk);
  return {
    update(time: number) {
      for (const p of puffs) {
        const t = (time * 0.035 + p.phase) % 1;
        p.mesh.position.set(p.x + t * 60, p.mesh.userData.base + 6 + t * 46, p.z + t * 18);
        p.mesh.scale.setScalar(0.6 + t * 1.3);
      }
    },
  };
}
