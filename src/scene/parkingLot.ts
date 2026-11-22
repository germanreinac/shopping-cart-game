import * as THREE from 'three';
import { RAPIER, addStaticBox } from '../physics';
import { buildCartMesh } from '../cart';

export interface ParkingLot {
  /** Collider handles of raised kerb islands, used to score kerb hops. */
  kerbHandles: Set<number>;
  spawn: { x: number; z: number; yaw: number };
  /** Half-size of the playable area. */
  bounds: { x: number; z: number };
  /** Per-frame updates: sign flicker and the loose trolleys. */
  update(time: number): void;
}

const LOT_X = 60;
const LOT_Z = 46;
const ISLAND_ROWS = [-24, 2, 28];
const ISLAND_CENTRES = [-24, 24];
const ISLAND_LENGTH = 30;
const KERB_HEIGHT = 0.14;
const LAMP_OFFSETS = [-10, 10];
const SODIUM = 0xff9838;

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** Blotchy roughness map: the dark patches read as puddles under the lamps. */
function wetAsphaltTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgb(200,200,200)';
  g.fillRect(0, 0, 256, 256);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const x = rand() * 256, y = rand() * 256, r = 14 + rand() * 40;
    for (const [ox, oy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]]) {
      const grad = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      grad.addColorStop(0, 'rgba(40,40,40,0.9)');
      grad.addColorStop(1, 'rgba(40,40,40,0)');
      g.fillStyle = grad;
      g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
  for (let i = 0; i < 5000; i++) {
    const v = 150 + Math.floor(rand() * 100);
    g.fillStyle = `rgba(${v},${v},${v},0.5)`;
    g.fillRect(rand() * 256, rand() * 256, 1.5, 1.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(7, 5);
  return tex;
}

/** Block-out of the supermarket car park at night, with matching static colliders. */
export function buildParkingLot(scene: THREE.Scene, world: RAPIER.World): ParkingLot {
  const kerbHandles = new Set<number>();
  const glow = glowTexture();

  scene.background = new THREE.Color(0x05070e);
  scene.fog = new THREE.FogExp2(0x05070e, 0.011);
  scene.add(new THREE.HemisphereLight(0x3a4a70, 0x120d08, 1.1));

  // ---- Ground ----
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(LOT_X * 2 + 60, LOT_Z * 2 + 60),
    new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 1, roughnessMap: wetAsphaltTexture(), metalness: 0.05 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  addStaticBox(world, 0, -0.5, 0, LOT_X + 30, 0.5, LOT_Z + 30, 0.9);

  // ---- Perimeter: low wall you can see, tall wall you cannot. ----
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2c2f36, roughness: 0.9 });
  const wall = (x: number, z: number, hx: number, hz: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, 0.9, hz * 2), wallMat);
    mesh.position.set(x, 0.45, z);
    scene.add(mesh);
    addStaticBox(world, x, 2, z, hx, 2, hz, 0.3);
  };
  wall(0, LOT_Z + 0.5, LOT_X + 1, 0.5);
  wall(LOT_X + 0.5, 0, 0.5, LOT_Z);
  wall(-LOT_X - 0.5, 0, 0.5, LOT_Z);

  // ---- Kerb islands with sodium lamps, and parking bay lines either side. ----
  const kerbMat = new THREE.MeshStandardMaterial({ color: 0x6d6f73, roughness: 0.8 });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.6, metalness: 0.4 });
  const lampHeadMat = new THREE.MeshStandardMaterial({ color: 0x221a10, emissive: SODIUM, emissiveIntensity: 3 });
  const glowMat = new THREE.SpriteMaterial({ map: glow, color: SODIUM, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85 });

  const lineSlots: [number, number][] = [];
  for (const z of ISLAND_ROWS) {
    for (const cx of ISLAND_CENTRES) {
      const island = new THREE.Mesh(new THREE.BoxGeometry(ISLAND_LENGTH, KERB_HEIGHT, 1.8), kerbMat);
      island.position.set(cx, KERB_HEIGHT / 2, z);
      scene.add(island);
      kerbHandles.add(addStaticBox(world, cx, KERB_HEIGHT / 2, z, ISLAND_LENGTH / 2, KERB_HEIGHT / 2, 0.9, 0.9).handle);

      for (const off of LAMP_OFFSETS) {
        const x = cx + off;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 8, 8), poleMat);
        pole.position.set(x, 4, z);
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.6, 10), kerbMat);
        base.position.set(x, 0.3, z);
        const head = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 0.4), lampHeadMat);
        head.position.set(x, 7.95, z);
        const sprite = new THREE.Sprite(glowMat);
        sprite.position.set(x, 7.85, z);
        sprite.scale.setScalar(4.5);
        const light = new THREE.PointLight(SODIUM, 420, 42, 2);
        light.position.set(x, 7.6, z);
        scene.add(pole, base, head, sprite, light);
        world.createCollider(RAPIER.ColliderDesc.cylinder(4, 0.3).setTranslation(x, 4, z));
      }

      for (let lx = cx - ISLAND_LENGTH / 2; lx <= cx + ISLAND_LENGTH / 2 + 0.01; lx += 2.5) {
        lineSlots.push([lx, z - 0.9 - 2.5], [lx, z + 0.9 + 2.5]);
      }
    }
  }
  const lines = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.12, 5).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xb9b9ae, roughness: 0.7 }),
    lineSlots.length,
  );
  const m4 = new THREE.Matrix4();
  lineSlots.forEach(([x, z], i) => lines.setMatrixAt(i, m4.makeTranslation(x, 0.012, z)));
  scene.add(lines);

  // ---- Speed bumps across the centre lane ----
  const bumpMat = new THREE.MeshStandardMaterial({ color: 0xd9a91a, roughness: 0.7 });
  const bumpRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  for (const z of [15, -11]) {
    const R = 1.2, y = -R + 0.11;
    const bump = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 16, 40, 1), bumpMat);
    bump.quaternion.copy(bumpRot);
    bump.position.set(0, y, z);
    scene.add(bump);
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(8, R)
        .setTranslation(0, y, z)
        .setRotation({ x: bumpRot.x, y: bumpRot.y, z: bumpRot.z, w: bumpRot.w })
        .setFriction(0.9),
    );
  }

  // ---- A few parked cars ----
  const carColours = [0x7a1f24, 0x1f3a5f, 0x8a8d91, 0x2a2c30, 0x3d5a45];
  const cars: [number, number, number][] = [
    [16.5, -19.6, 0], [34, -28.4, 1], [-21.5, -2.4, 2], [-31.5, 6.4, 3], [29, 23.6, 4], [-14, 32.4, 0],
  ];
  const glass = new THREE.MeshStandardMaterial({ color: 0x0b0e14, roughness: 0.15, metalness: 0.6 });
  for (const [x, z, ci] of cars) {
    const car = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ color: carColours[ci], roughness: 0.35, metalness: 0.5 });
    const lower = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 4.3), paint);
    lower.position.y = 0.6;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 2.2), glass);
    cabin.position.set(0, 1.25, -0.2);
    car.add(lower, cabin);
    for (const sx of [1, -1]) for (const sz of [1, -1]) {
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.22, 12).rotateZ(Math.PI / 2), glass);
      tyre.position.set(sx * 0.85, 0.32, sz * 1.35);
      car.add(tyre);
    }
    car.position.set(x, 0, z);
    scene.add(car);
    addStaticBox(world, x, 0.8, z, 0.9, 0.8, 2.15, 0.4);
  }

  // ---- Trolley bay with loose trolleys you can crash into ----
  const BAY_X = 9.75, BAY_Z = 6.2;
  const railMat = new THREE.MeshStandardMaterial({ color: 0x2f6fb5, roughness: 0.5, metalness: 0.3 });
  for (const sx of [1, -1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 4.4), railMat);
    rail.position.set(BAY_X + sx * 0.8, 1.0, BAY_Z);
    scene.add(rail);
    for (const dz of [-2.1, 0, 2.1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.0, 0.07), railMat);
      post.position.set(BAY_X + sx * 0.8, 0.5, BAY_Z + dz);
      scene.add(post);
    }
    addStaticBox(world, BAY_X + sx * 0.8, 0.52, BAY_Z, 0.04, 0.52, 2.2, 0.3);
  }
  const baySign = new THREE.Mesh(new THREE.BoxGeometry(1.67, 0.5, 0.06), railMat);
  baySign.position.set(BAY_X, 2.2, BAY_Z - 2.1);
  scene.add(baySign);
  for (const sx of [1, -1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.4, 0.07), railMat);
    post.position.set(BAY_X + sx * 0.8, 1.7, BAY_Z - 2.1);
    scene.add(post);
  }

  const loose: { body: RAPIER.RigidBody; group: THREE.Group }[] = [];
  for (let i = 0; i < 3; i++) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(BAY_X, 0.4, BAY_Z - 1.2 + i * 1.15).setAngularDamping(0.6).setLinearDamping(0.25),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.27, 0.4, 0.46).setTranslation(0, 0.14, 0).setMass(18).setFriction(0.12).setRestitution(0.2),
      body,
    );
    const { group } = buildCartMesh(0x2f6fb5);
    scene.add(group);
    loose.push({ body, group });
  }

  // ---- Supermarket ----
  const storeZ = -LOT_Z;
  const store = new THREE.Mesh(new THREE.BoxGeometry(LOT_X * 2 + 2, 11, 14), new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.9 }));
  store.position.set(0, 5.5, storeZ - 7);
  scene.add(store);
  addStaticBox(world, 0, 5.5, storeZ - 7, LOT_X + 1, 5.5, 7, 0.3);

  const windows = new THREE.Mesh(
    new THREE.PlaneGeometry(64, 3.2),
    new THREE.MeshStandardMaterial({ color: 0x0c1016, emissive: 0xbcd6ff, emissiveIntensity: 0.9 }),
  );
  windows.position.set(0, 2.0, storeZ + 0.02);
  scene.add(windows);
  for (let x = -32; x <= 32; x += 4) {
    const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.4, 0.1), wallMat);
    mullion.position.set(x, 2.0, storeZ + 0.05);
    scene.add(mullion);
  }
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(70, 0.3, 3.5), new THREE.MeshStandardMaterial({ color: 0x8a1f25, roughness: 0.6 }));
  canopy.position.set(0, 4.2, storeZ + 1.7);
  scene.add(canopy);
  for (const x of [-22, 0, 22]) {
    const spill = new THREE.PointLight(0xbcd6ff, 160, 30, 1.8);
    spill.position.set(x, 2.6, storeZ + 3.5);
    scene.add(spill);
  }

  // Half-broken neon sign: one letter is dead, another flickers.
  const TEXT = 'SUPERMARKET';
  const DEAD = 7, FLICKER = 3;
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 1024;
  signCanvas.height = 128;
  const sg = signCanvas.getContext('2d')!;
  const signTex = new THREE.CanvasTexture(signCanvas);
  signTex.colorSpace = THREE.SRGBColorSpace;
  const drawSign = (flickerOn: boolean) => {
    sg.fillStyle = '#0b0c10';
    sg.fillRect(0, 0, 1024, 128);
    sg.font = 'bold 96px Arial, Helvetica, sans-serif';
    sg.textAlign = 'center';
    sg.textBaseline = 'middle';
    for (let i = 0; i < TEXT.length; i++) {
      const lit = i !== DEAD && (i !== FLICKER || flickerOn);
      sg.fillStyle = lit ? '#ff3b4e' : '#2a1216';
      sg.fillText(TEXT[i], 70 + i * 88.5, 68);
    }
    signTex.needsUpdate = true;
  };
  drawSign(true);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(34, 4.25),
    new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 2.2 }),
  );
  sign.position.set(0, 7.6, storeZ + 0.05);
  scene.add(sign);
  const signLight = new THREE.PointLight(0xff3b4e, 260, 45, 1.8);
  signLight.position.set(0, 7.5, storeZ + 5);
  scene.add(signLight);

  let flickerOn = true;
  let nextFlicker = 0;
  return {
    kerbHandles,
    spawn: { x: 0, z: 38, yaw: Math.PI },
    bounds: { x: LOT_X, z: LOT_Z },
    update(time: number) {
      if (time > nextFlicker) {
        flickerOn = !flickerOn;
        nextFlicker = time + (flickerOn ? 0.15 + Math.random() * 2.5 : 0.04 + Math.random() * 0.25);
        drawSign(flickerOn);
      }
      for (const { body, group } of loose) {
        const t = body.translation();
        const r = body.rotation();
        group.position.set(t.x, t.y, t.z);
        group.quaternion.set(r.x, r.y, r.z, r.w);
      }
    },
  };
}
