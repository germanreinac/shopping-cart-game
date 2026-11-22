import * as THREE from 'three';
import { toon, buildSky, outline } from '../style';
import { RAPIER, addStaticBox } from '../physics';
import type { Rail } from '../cart';
import type { LightPool } from '../lights';

export interface Cone {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  tipped: boolean;
}

export interface ParkingLot {
  /** Collider handles of raised kerb islands, used to score kerb hops. */
  kerbHandles: Set<number>;
  spawn: { x: number; z: number; yaw: number };
  /** Half-size of the playable area. */
  bounds: { x: number; z: number };
  /** Closed loop of points the race (and the rival teens) follow, through the underground level. */
  circuit: THREE.Vector3[];
  /** Where teens hang around waiting to hop in your cart. */
  hangouts: { x: number; z: number; yaw: number }[];
  /** Where cigarette packs spawn. */
  pickupSpots: THREE.Vector3[];
  cones: Cone[];
  /** Bars you can grind. */
  rails: Rail[];
  /** Where spare trolleys sit, ready to be grabbed. */
  cartSpots: { x: number; y: number; z: number; yaw: number }[];
  /** Per-frame updates: sign flicker, loose trolleys and cones. */
  update(time: number): void;
}

const LOT_X = 90;
const LOT_Z = 90;
const KERB_HEIGHT = 0.14;
const SODIUM = 0xffd28a; // pale, warm lamp light
const TUBE = 0xd6ffe6;

// Underground level: floor 5 m down, reached by two straight ramps on the east side.
const G = -5;
const SLAB = 0.5;
const GARAGE = { x0: 30, x1: 86, z0: -30, z1: 40 };
const RAMP = { x0: 50, x1: 58 };
const RAMP_IN = { top: -52, bottom: -30 }; // drive south (+z) to go down
const RAMP_OUT = { bottom: 40, top: 62 }; // keep going south to come back up

const ISLAND_ROWS = [-62, -36, -10, 16, 42, 68];
const ISLAND_CENTRES = [-66, -24, 24, 73];
const ISLAND_LENGTH = 26;
const BAY = 2.6;

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
  g.fillStyle = 'rgb(255,255,255)';
  g.fillRect(0, 0, 256, 256);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26; i++) {
    const x = rand() * 256, y = rand() * 256, r = 14 + rand() * 40;
    for (const [ox, oy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]]) {
      const grad = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      grad.addColorStop(0, 'rgba(120,140,160,0.5)');
      grad.addColorStop(0.7, 'rgba(120,140,160,0.45)');
      grad.addColorStop(0.72, 'rgba(120,140,160,0)');
      grad.addColorStop(1, 'rgba(120,140,160,0)');
      g.fillStyle = grad;
      g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
  for (let i = 0; i < 5000; i++) {
    const v = 200 + Math.floor(rand() * 55);
    g.fillStyle = `rgba(${v},${v},${v},0.35)`;
    g.fillRect(rand() * 256, rand() * 256, 1.5, 1.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / 24, 1 / 24);
  return tex;
}

/** Block-out of the supermarket car park at night, with matching static colliders. */
export function buildParkingLot(scene: THREE.Scene, world: RAPIER.World, lights: LightPool): ParkingLot {
  const kerbHandles = new Set<number>();
  const glow = glowTexture();

  const sky = buildSky(scene);

  const concrete = toon({ color: 0x5a6c7c, roughness: 0.85 });
  const darkConcrete = toon({ color: 0x24323f, roughness: 0.9 });
  const kerbMat = toon({ color: 0x6f8290, roughness: 0.8 });
  const yellow = toon({ color: 0xd9a91a, roughness: 0.7 });

  /** A box you can see and hit. Position is the centre, sizes are half-extents. */
  const solid = (x: number, y: number, z: number, hx: number, hy: number, hz: number, mat: THREE.Material, friction = 0.6) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    return addStaticBox(world, x, y, z, hx, hy, hz, friction);
  };

  // ---- Surface: one asphalt sheet with two holes where the ramps go down. ----
  const E = 30; // margin beyond the walls
  const shape = new THREE.Shape();
  shape.moveTo(-LOT_X - E, -LOT_Z - E);
  shape.lineTo(LOT_X + E, -LOT_Z - E);
  shape.lineTo(LOT_X + E, LOT_Z + E);
  shape.lineTo(-LOT_X - E, LOT_Z + E);
  shape.closePath();
  // Shape space is (x, -z): rotating the sheet flat maps y to -z.
  for (const [zA, zB] of [[RAMP_IN.top, RAMP_IN.bottom], [RAMP_OUT.bottom, RAMP_OUT.top]]) {
    const hole = new THREE.Path();
    hole.moveTo(RAMP.x0, -zB);
    hole.lineTo(RAMP.x1, -zB);
    hole.lineTo(RAMP.x1, -zA);
    hole.lineTo(RAMP.x0, -zA);
    hole.closePath();
    shape.holes.push(hole);
  }
  const asphalt = toon({ color: 0x2f4156, map: wetAsphaltTexture() });
  const ground = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2), asphalt);
  scene.add(ground);

  // Matching slab colliders, split around the holes.
  const slab = (x0: number, x1: number, z0: number, z1: number) =>
    addStaticBox(world, (x0 + x1) / 2, -SLAB / 2, (z0 + z1) / 2, (x1 - x0) / 2, SLAB / 2, (z1 - z0) / 2, 0.9);
  slab(-LOT_X - E, RAMP.x0, -LOT_Z - E, LOT_Z + E);
  slab(RAMP.x1, LOT_X + E, -LOT_Z - E, LOT_Z + E);
  slab(RAMP.x0, RAMP.x1, -LOT_Z - E, RAMP_IN.top);
  slab(RAMP.x0, RAMP.x1, RAMP_IN.bottom, RAMP_OUT.bottom);
  slab(RAMP.x0, RAMP.x1, RAMP_OUT.top, LOT_Z + E);

  // ---- Perimeter: low wall you can see, tall wall you cannot. ----
  const wall = (x: number, z: number, hx: number, hz: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, 0.9, hz * 2), darkConcrete);
    mesh.position.set(x, 0.45, z);
    scene.add(mesh);
    addStaticBox(world, x, 3, z, hx, 3, hz, 0.3);
  };
  wall(0, LOT_Z + 0.5, LOT_X + 1, 0.5);
  wall(LOT_X + 0.5, 0, 0.5, LOT_Z);
  wall(-LOT_X - 0.5, 0, 0.5, LOT_Z);

  // ---- Lamps: real light comes from the pool; every lamp also gets a glow and a ground decal. ----
  const poleMat = toon({ color: 0x3a3d44, roughness: 0.6, metalness: 0.4 });
  const lampHeadMat = toon({ color: 0x221a10, emissive: SODIUM, emissiveIntensity: 3 });
  const glowMat = new THREE.SpriteMaterial({ map: glow, color: SODIUM, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85 });
  const lampSpots: [number, number][] = [];
  const lamp = (x: number, z: number) => {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 8, 8), poleMat);
    pole.position.set(x, 4, z);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.6, 10), kerbMat);
    base.position.set(x, 0.3, z);
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 0.4), lampHeadMat);
    head.position.set(x, 7.95, z);
    const sprite = new THREE.Sprite(glowMat);
    sprite.position.set(x, 7.85, z);
    sprite.scale.setScalar(4.5);
    scene.add(pole, base, head, sprite);
    world.createCollider(RAPIER.ColliderDesc.cylinder(4, 0.3).setTranslation(x, 4, z));
    lights.add({ x, y: 7.6, z, color: SODIUM, intensity: 430, distance: 44 });
    lampSpots.push([x, z]);
  };

  // ---- Kerb islands and parking bay lines. The south-west corner is left open for the ramp park. ----
  const lineSlots: [number, number, number][] = [];
  for (const z of ISLAND_ROWS) {
    for (const cx of ISLAND_CENTRES) {
      if (cx < 0 && z > 10) continue;
      const island = new THREE.Mesh(new THREE.BoxGeometry(ISLAND_LENGTH, KERB_HEIGHT, 1.8), kerbMat);
      island.position.set(cx, KERB_HEIGHT / 2, z);
      scene.add(island);
      kerbHandles.add(addStaticBox(world, cx, KERB_HEIGHT / 2, z, ISLAND_LENGTH / 2, KERB_HEIGHT / 2, 0.9, 0.9).handle);
      lamp(cx - 9, z);
      lamp(cx + 9, z);
      for (let k = 0; k <= ISLAND_LENGTH / BAY + 0.01; k++) {
        const lx = cx - ISLAND_LENGTH / 2 + k * BAY;
        lineSlots.push([lx, 0.012, z - 0.9 - 2.5], [lx, 0.012, z + 0.9 + 2.5]);
      }
    }
  }
  for (const [x, z] of [[-38, 44], [-64, 44], [-38, 70], [-64, 70], [-84, 20], [-12, 46], [-12, 68], [-12, 20]]) lamp(x, z);

  // ---- Speed bumps across the west lane ----
  const bumpRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  for (const z of [-23, -49]) {
    const R = 1.2, y = -R + 0.11;
    const bump = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 11, 40, 1), yellow);
    bump.quaternion.copy(bumpRot);
    bump.position.set(-47, y, z);
    scene.add(bump);
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(5.5, R)
        .setTranslation(-47, y, z)
        .setRotation({ x: bumpRot.x, y: bumpRot.y, z: bumpRot.z, w: bumpRot.w })
        .setFriction(0.9),
    );
  }

  // ---- Ramps: wedges that rise along their heading and end in a drop. ----
  const rampMat = toon({ color: 0xb8894a, roughness: 0.75, flatShading: true, side: THREE.DoubleSide });
  const kicker = (x: number, z: number, yaw: number, width: number, length: number, height: number) => {
    const w = width / 2;
    const pts = [-w, 0, 0, w, 0, 0, -w, 0, length, w, 0, length, -w, height, length, w, height, length];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    geo.setIndex([0, 4, 5, 0, 5, 1, 2, 3, 5, 2, 5, 4, 0, 2, 4, 1, 5, 3, 0, 1, 3, 0, 3, 2]);
    const mesh = new THREE.Mesh(geo.toNonIndexed(), rampMat);
    mesh.geometry.computeVertexNormals();
    mesh.position.set(x, 0, z);
    mesh.rotation.y = yaw;
    scene.add(mesh);
    // Yellow lip so the launch edge reads in the dark.
    const lip = new THREE.Mesh(new THREE.BoxGeometry(width, 0.06, 0.18), yellow);
    lip.position.set(0, height + 0.01, length - 0.09);
    mesh.add(lip);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
    if (hull) world.createCollider(hull.setTranslation(x, 0, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(0.9));
  };
  const WEST = -Math.PI / 2, EAST = Math.PI / 2, NORTH = Math.PI;
  kicker(5.5, -4, NORTH, 3.5, 4.5, 1.0); // centre lane, optional line on the race
  kicker(-20, 30, WEST, 4, 5, 1.2);
  // Funbox: up, flat table, down.
  kicker(-42, 30, WEST, 7, 4.5, 1.1);
  solid(-49.5, 0.55, 30, 3, 0.55, 3.5, rampMat, 0.9);
  kicker(-57, 30, EAST, 7, 4.5, 1.1);
  kicker(-40, 58, WEST, 5, 8, 2.2); // the big one
  kicker(-28, 76, WEST, 4, 5, 1.2);
  kicker(20, 58, EAST, 4, 5, 1.2);
  // Gap jump: launch across the exit ramp's trench from either side.
  kicker(39.5, 48, EAST, 4.5, 8, 2.4);
  kicker(68.5, 54.5, WEST, 4.5, 8, 2.4);
  // Banked corner in the south-west: a ring of wedges you can carve round.
  for (let i = 0; i < 6; i++) {
    const a = Math.PI + (i + 0.5) * (Math.PI / 2 / 6); // west round to south
    const rx = Math.cos(a), rz = -Math.sin(a);
    kicker(-72 + rx * 13.5, 72 + rz * 13.5, Math.atan2(rx, rz), 5.2, 4, 1.9);
  }

  // ---- Underground level ----
  const floorMat = toon({ color: 0x3d4c5a, roughness: 0.55 });
  const gcx = (GARAGE.x0 + GARAGE.x1) / 2, gcz = (GARAGE.z0 + GARAGE.z1) / 2;
  const ghx = (GARAGE.x1 - GARAGE.x0) / 2, ghz = (GARAGE.z1 - GARAGE.z0) / 2;
  solid(gcx, G - 0.25, gcz, ghx, 0.25, ghz, floorMat, 0.9);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(ghx * 2, ghz * 2).rotateX(Math.PI / 2), concrete);
  ceiling.position.set(gcx, -SLAB, gcz);
  scene.add(ceiling);
  const wallY = (G - SLAB) / 2, wallH = (-SLAB - G) / 2;
  solid(GARAGE.x0 - 0.25, wallY, gcz, 0.25, wallH, ghz, concrete);
  solid(GARAGE.x1 + 0.25, wallY, gcz, 0.25, wallH, ghz, concrete);
  for (const z of [GARAGE.z0 - 0.25, GARAGE.z1 + 0.25]) {
    solid((GARAGE.x0 + RAMP.x0) / 2, wallY, z, (RAMP.x0 - GARAGE.x0) / 2, wallH, 0.25, concrete);
    solid((RAMP.x1 + GARAGE.x1) / 2, wallY, z, (GARAGE.x1 - RAMP.x1) / 2, wallH, 0.25, concrete);
  }
  // Columns either side of the main aisle.
  for (const x of [38, 46, 62, 70, 78]) for (const z of [-20, -8, 4, 16, 28]) solid(x, wallY, z, 0.3, wallH, 0.3, concrete);
  // Yellow stripe at the foot of each column row, and aisle edge lines.
  for (const x of [RAMP.x0 - 0.5, RAMP.x1 + 0.5]) lineSlots.push([x, G + 0.012, -15], [x, G + 0.012, -5], [x, G + 0.012, 5], [x, G + 0.012, 15], [x, G + 0.012, 25]);
  // Strip lights.
  const tubeMat = toon({ color: 0x111111, emissive: TUBE, emissiveIntensity: 2.5 });
  for (const [x, z] of [[54, -22], [54, -4], [54, 14], [54, 32], [40, -8], [40, 18], [72, -14], [72, 10], [72, 30]]) {
    const tube = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 2.4), tubeMat);
    tube.position.set(x, -SLAB - 0.08, z);
    scene.add(tube);
    lights.add({ x, y: -1.4, z, color: TUBE, intensity: 34, distance: 26, underground: true });
  }

  // The two ramps, their retaining walls, and guard walls round the openings up top.
  const slope = (zA: number, yA: number, zB: number, yB: number) => {
    const dz = zB - zA, dy = yB - yA;
    const len = Math.hypot(dz, dy);
    const angle = Math.atan2(-dy, dz);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle);
    const cx = (RAMP.x0 + RAMP.x1) / 2, w = (RAMP.x1 - RAMP.x0) / 2;
    // Centre sits half a slab below the driving surface, along the slope's normal.
    const cy = (yA + yB) / 2 - Math.cos(angle) * 0.25;
    const cz = (zA + zB) / 2 - Math.sin(angle) * 0.25;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w * 2, 0.5, len), floorMat);
    mesh.position.set(cx, cy, cz);
    mesh.quaternion.copy(q);
    scene.add(mesh);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(w, 0.25, len / 2).setTranslation(cx, cy, cz).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(0.9),
    );
    // Arrows of light down the middle would be nice; a centre line will do for now.
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      const dash = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 1.6), yellow);
      dash.position.set(cx, yA + dy * t + 0.02, zA + dz * t);
      dash.quaternion.copy(q);
      scene.add(dash);
    }
    const z0 = Math.min(zA, zB), z1 = Math.max(zA, zB), zm = (z0 + z1) / 2, hz = (z1 - z0) / 2;
    for (const x of [RAMP.x0 - 0.25, RAMP.x1 + 0.25]) {
      solid(x, G / 2, zm, 0.25, -G / 2, hz, concrete, 0.3); // retaining wall down the trench
      solid(x, 0.5, zm, 0.25, 0.5, hz, darkConcrete, 0.3); // guard wall on the surface
    }
  };
  slope(RAMP_IN.top, 0, RAMP_IN.bottom, G);
  slope(RAMP_OUT.bottom, G, RAMP_OUT.top, 0);

  // Tunnel mouths: a headwall over the deep end of each ramp, with a lit sign on the way in.
  const portal = (z: number, facing: number, label: string) => {
    const cx = (RAMP.x0 + RAMP.x1) / 2;
    solid(cx, 1.3, z + facing * 0.25, 4.5, 1.3, 0.25, darkConcrete, 0.3);
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = '#06140c';
    g.fillRect(0, 0, 512, 128);
    g.fillStyle = '#58ffa0';
    g.font = 'bold 60px Arial, Helvetica, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, 256, 68);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(6.4, 1.6),
      toon({ color: 0x000000, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.6 }),
    );
    sign.position.set(cx, 1.5, z - facing * 0.02);
    if (facing > 0) sign.rotation.y = Math.PI;
    scene.add(sign);
    lights.add({ x: cx, y: 1.8, z: z - facing * 4, color: 0x58ffa0, intensity: 40, distance: 18 });
  };
  portal(RAMP_IN.bottom, 1, 'P  ↓  LEVEL -1');
  portal(RAMP_OUT.bottom, -1, 'NO ENTRY');

  // ---- Bay lines (surface and underground) ----
  const lines = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.12, 5).rotateX(-Math.PI / 2),
    toon({ color: 0xb9b9ae, roughness: 0.7 }),
    lineSlots.length,
  );
  const m4 = new THREE.Matrix4();
  lineSlots.forEach(([x, y, z], i) => lines.setMatrixAt(i, m4.makeTranslation(x, y, z)));
  scene.add(lines);

  // A visible cone of light under every lamp: the haze catching the beam.
  const cones3 = new THREE.InstancedMesh(
    new THREE.ConeGeometry(5.2, 7.7, 24, 1, true).translate(0, -3.85, 0),
    new THREE.MeshBasicMaterial({ color: SODIUM, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.038, depthWrite: false, side: THREE.DoubleSide }),
    lampSpots.length,
  );
  lampSpots.forEach(([x, z], i) => cones3.setMatrixAt(i, m4.makeTranslation(x, 7.85, z)));
  scene.add(cones3);

  // A lone phone box in the far corner, lit from inside. Nobody is ever in it.
  const booth = new THREE.Group();
  const frame = toon({ color: 0x1b2a36 });
  booth.add(new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.12, 1.1), frame));
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.18, 1.2), frame);
  roof.position.y = 2.4;
  booth.add(roof);
  for (const [bx, bz] of [[0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.4, 0.08), frame);
    post.position.set(bx, 1.2, bz);
    booth.add(post);
  }
  const boothGlass = new THREE.Mesh(new THREE.BoxGeometry(0.95, 2.2, 0.95), new THREE.MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.35, depthWrite: false }));
  boothGlass.position.y = 1.2;
  booth.add(boothGlass);
  booth.position.set(-83, 0, -83);
  scene.add(booth);
  addStaticBox(world, -83, 1.2, -83, 0.55, 1.2, 0.55, 0.3);
  lights.add({ x: -83, y: 2, z: -83, color: 0xbfe8ff, intensity: 60, distance: 22 });

  // Soft pool of light on the ground under every lamp, visible from far away.
  const pools = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(26, 26).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: glow, color: SODIUM, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.12, depthWrite: false }),
    lampSpots.length,
  );
  lampSpots.forEach(([x, z], i) => pools.setMatrixAt(i, m4.makeTranslation(x, 0.03, z)));
  scene.add(pools);

  // ---- Parked cars ----
  const carColours = [0x7a1f24, 0x1f3a5f, 0x8a8d91, 0x2a2c30, 0x3d5a45];
  const glass = toon({ color: 0x0b0e14, roughness: 0.15, metalness: 0.6 });
  const car = (x: number, y: number, z: number, ci: number) => {
    const group = new THREE.Group();
    const paint = toon({ color: carColours[ci % carColours.length], roughness: 0.35, metalness: 0.5 });
    const lower = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 4.3), paint);
    lower.position.y = 0.6;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 2.2), glass);
    cabin.position.set(0, 1.25, -0.2);
    group.add(lower, cabin);
    for (const sx of [1, -1]) for (const sz of [1, -1]) {
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.22, 12).rotateZ(Math.PI / 2), glass);
      tyre.position.set(sx * 0.85, 0.32, sz * 1.35);
      group.add(tyre);
    }
    group.position.set(x, y, z);
    scene.add(group);
    addStaticBox(world, x, y + 0.8, z, 0.9, 0.8, 2.15, 0.4);
  };
  /** Centre of bay `k` beside an island, on its north (-1) or south (+1) side. */
  const bay = (cx: number, row: number, k: number, side: number): [number, number] => [cx - ISLAND_LENGTH / 2 + BAY * (k + 0.5), row + side * 3.4];
  const parked: [number, number, number, number][] = [
    [24, -36, 3, 1], [73, -10, 6, -1], [-24, -62, 2, 1], [-66, -36, 7, -1], [24, 42, 5, 1],
    [-24, -10, 1, 1], [73, 68, 8, -1], [24, 16, 8, -1], [-66, -10, 4, 1], [73, -62, 2, 1], [24, -62, 7, -1],
  ];
  parked.forEach(([cx, row, k, side], i) => {
    const [x, z] = bay(cx, row, k, side);
    car(x, 0, z, i);
  });
  car(34, G, -20, 1);
  car(82, G, 8, 3);
  car(34, G, 30, 0);
  car(66, G, -24, 2);

  // ---- Trolley bay with loose trolleys you can crash into ----
  const BAY_X = 12.3, BAY_Z = 19.4;
  const railMat = toon({ color: 0x2f6fb5, roughness: 0.5, metalness: 0.3 });
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
  const cartSpots = [
    { x: BAY_X, y: 0, z: BAY_Z - 1.2, yaw: 0 }, { x: BAY_X, y: 0, z: BAY_Z, yaw: 0 }, { x: BAY_X, y: 0, z: BAY_Z + 1.2, yaw: 0 },
    { x: -30, y: 0, z: 40, yaw: -1.2 }, { x: 62, y: 0, z: -57, yaw: 0.4 }, { x: 60, y: G, z: 12, yaw: 2.2 },
    { x: -70, y: 0, z: -72, yaw: 1.9 }, { x: 30, y: 0, z: 76, yaw: -0.6 },
  ];

  // ---- Rails to grind: hop onto one while moving along it. ----
  const railMat3 = toon({ color: 0xe8e2d0, emissive: 0x4a463c });
  const rails: Rail[] = [];
  const rail = (ax: number, az: number, bx: number, bz: number, ay = 0.55, by = ay, baseY = 0) => {
    const a = new THREE.Vector3(ax, baseY + ay, az), b = new THREE.Vector3(bx, baseY + by, bz);
    rails.push({ a, b });
    const len = a.distanceTo(b);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, len), railMat3);
    bar.position.copy(a).lerp(b, 0.5);
    bar.lookAt(b);
    scene.add(bar);
    const posts = Math.max(2, Math.round(len / 4));
    for (let i = 0; i <= posts; i++) {
      const p = a.clone().lerp(b, i / posts);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, p.y - baseY, 0.07), railMat3);
      post.position.set(p.x, baseY + (p.y - baseY) / 2, p.z);
      scene.add(post);
    }
  };
  rail(-22, 38, -40, 38);
  rail(-18, 8, -46, 8);
  rail(-52, 66, -52, 84, 0.55, 1.2); // rising rail
  rail(-6, 44, -6, 20, 0.55, 0.55);
  rail(42, -18, 42, 20, 0.55, 0.55, G); // underground, between the columns
  rail(60, -80, 84, -80);

  // ---- Traffic cones: knock them over (or have your passenger do it) for points. ----
  const coneGeo = new THREE.ConeGeometry(0.17, 0.6, 10);
  const coneBaseGeo = new THREE.BoxGeometry(0.4, 0.04, 0.4);
  const coneMat = toon({ color: 0xff5a1f, roughness: 0.6, emissive: 0x3a1000 });
  const cones: Cone[] = [];
  const cone = (x: number, y: number, z: number) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y + 0.3, z).setAngularDamping(0.8).setLinearDamping(0.3),
    );
    world.createCollider(RAPIER.ColliderDesc.cone(0.3, 0.2).setMass(2).setFriction(0.8).setRestitution(0.3), body);
    const mesh = new THREE.Group();
    const top = new THREE.Mesh(coneGeo, coneMat);
    const foot = new THREE.Mesh(coneBaseGeo, coneMat);
    foot.position.y = -0.29;
    mesh.add(top, foot);
    scene.add(mesh);
    outline(mesh, 0.03);
    cones.push({ body, mesh, tipped: false });
  };
  for (let x = -18; x >= -68; x -= 10) cone(x, 0, 14 + (Math.abs(x) % 20 === 8 ? 1.5 : -1.5));
  for (const [x, z] of [[26, 36], [32, 38], [38, 36], [-40, 62], [-46, 64]]) cone(x, 0, z);
  for (const [x, z] of [[42, 0], [66, 0], [42, 22], [66, -14], [80, 30]]) cone(x, G, z);

  // ---- Supermarket ----
  const storeZ = -LOT_Z;
  solid(0, 5.5, storeZ - 7, LOT_X + 1, 5.5, 7, toon({ color: 0x16222e, roughness: 0.9 }), 0.3);
  const windows = new THREE.Mesh(
    new THREE.PlaneGeometry(96, 3.2),
    toon({ color: 0x0c1016, emissive: 0xbcd6ff, emissiveIntensity: 0.9 }),
  );
  windows.position.set(0, 2.0, storeZ + 0.02);
  scene.add(windows);
  for (let x = -48; x <= 48; x += 4) {
    const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.4, 0.1), darkConcrete);
    mullion.position.set(x, 2.0, storeZ + 0.05);
    scene.add(mullion);
  }
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(104, 0.3, 3.5), toon({ color: 0x1f3a4a, roughness: 0.6 }));
  canopy.position.set(0, 4.2, storeZ + 1.7);
  scene.add(canopy);
  for (const x of [-36, -12, 12, 36]) lights.add({ x, y: 2.6, z: storeZ + 3.5, color: 0xbcd6ff, intensity: 170, distance: 30 });

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
      sg.fillStyle = lit ? '#fff0c8' : '#2a2a26';
      sg.fillText(TEXT[i], 70 + i * 88.5, 68);
    }
    signTex.needsUpdate = true;
  };
  drawSign(true);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(44, 5.5),
    toon({ color: 0x000000, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 2.2 }),
  );
  sign.position.set(0, 7.6, storeZ + 0.05);
  scene.add(sign);
  lights.add({ x: 0, y: 7.5, z: storeZ + 5, color: 0xfff0c8, intensity: 200, distance: 46 });

  // ---- Race circuit: north up the centre lane, east along the shop front, down through the
  // underground level, back up, and west along the south wall to the start. ----
  const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const circuit = [
    P(0, 0, 60), P(0, 0, 20), P(0, 0, -30), P(0, 0, -62), P(7, 0, -73), P(22, 0, -76), P(40, 0, -76),
    P(50, 0, -71), P(54, 0, -62), P(54, 0, RAMP_IN.top), P(54, G / 2, -41), P(54, G, RAMP_IN.bottom),
    P(54, G, 5), P(54, G, RAMP_OUT.bottom), P(54, G / 2, 51), P(54, 0, RAMP_OUT.top), P(54, 0, 71),
    P(49, 0, 80), P(38, 0, 83), P(14, 0, 83), P(4, 0, 78), P(0, 0, 69),
  ];

  const pickupSpots = [
    P(0, 0, 25), P(-49.5, 1.1, 30), P(-54, 3.0, 58), P(54, G, 5), P(40, G, -14), P(74, G, 22),
    P(30, 0, -76), P(54, 0, 74), P(-47, 0, -36), P(0, 0, -55), P(76, 0, 80), P(-80, 0, -70), P(26, 0, 83),
  ];
  const hangouts = [
    { x: 9.5, z: 57, yaw: -1.9 }, { x: 10.8, z: 58.6, yaw: -2.4 },
    { x: -12, z: -31, yaw: 1.2 }, { x: -13.2, z: -32.6, yaw: 0.7 },
    { x: 61.5, z: -66, yaw: -2.6 }, { x: -30, z: 46, yaw: 0.4 },
  ];

  let flickerOn = true;
  let nextFlicker = 0;
  const sync = (body: RAPIER.RigidBody, obj: THREE.Object3D) => {
    const t = body.translation();
    const r = body.rotation();
    obj.position.set(t.x, t.y, t.z);
    obj.quaternion.set(r.x, r.y, r.z, r.w);
  };
  return {
    kerbHandles,
    spawn: { x: 0, z: 66, yaw: Math.PI },
    bounds: { x: LOT_X, z: LOT_Z },
    circuit,
    hangouts,
    pickupSpots,
    cones,
    rails,
    cartSpots,
    update(time: number) {
      sky.update(time);
      if (time > nextFlicker) {
        flickerOn = !flickerOn;
        nextFlicker = time + (flickerOn ? 0.15 + Math.random() * 2.5 : 0.04 + Math.random() * 0.25);
        drawSign(flickerOn);
      }
      for (const c of cones) if (!c.body.isSleeping()) sync(c.body, c.mesh);
    },
  };
}
