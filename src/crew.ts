import * as THREE from 'three';
import { RAPIER, RAGDOLL_GROUPS, FIXED_DT } from './physics';
import { Person, type Palette } from './person';
import type { Cart } from './cart';

/** Something a passenger can throw a can at. */
export interface ThrowTarget {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** How far above `position` to aim. */
  aimHeight: number;
  /** Called when a can lands close enough. Returns the points and label to award. */
  hit?: () => { label: string; points: number } | null;
}

export type CrewEvent =
  | { type: 'joined'; name: string }
  | { type: 'hit'; label: string; points: number };

const PALETTES: Palette[] = [
  { top: 0x2f8f6b, legs: 0x3a3f52, skin: 0xc98e6a, hat: 0xd9a91a },
  { top: 0x6b4fb5, legs: 0x23262e, skin: 0xe9b999, hat: 0x23262e },
  { top: 0xd98a2b, legs: 0x4a5f96, skin: 0x9c6b4a, hat: 0x7a1f24 },
  { top: 0x9aa3ad, legs: 0x2c3a2f, skin: 0xe2ac8c, hat: 0x2f6fb5 },
  { top: 0x1f3a5f, legs: 0x5a4a3a, skin: 0xb98058, hat: 0xc9453c },
  { top: 0xb5456f, legs: 0x2a2c30, skin: 0xe9c0a0, hat: 0x111111 },
];
const NAMES = ['Nico', 'Vale', 'Santi', 'Cami', 'Mati', 'Juli'];

const THROW_SPEED = 19;
const THROW_RANGE = 30;
const THROW_COOLDOWN = 0.55;
const JOIN_RADIUS = 3.2;
const JOIN_MAX_SPEED = 8;

interface Can {
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
  life: number;
  target: ThrowTarget | null;
}

/**
 * The other teens. They hang around the lot smoking; roll past one slowly and they hop
 * into the basket. A passenger throws cans at whatever is nearest in front of the cart.
 */
export class Crew {
  passenger: Person | null = null;
  passengerName = '';
  events: CrewEvent[] = [];

  private waiting: { person: Person; name: string; x: number; z: number }[] = [];
  private cans: Can[] = [];
  private cooldown = 0;
  private canGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.12, 8);
  private canMat = new THREE.MeshStandardMaterial({ color: 0xc9d2da, metalness: 0.5, roughness: 0.3, emissive: 0x30363c });

  constructor(
    private scene: THREE.Scene,
    private world: RAPIER.World,
    private cart: Cart,
    hangouts: { x: number; z: number; yaw: number }[],
  ) {
    hangouts.forEach((spot, i) => {
      const person = new Person(scene, world, PALETTES[i % PALETTES.length], true);
      person.root.position.set(spot.x, 0, spot.z);
      person.root.rotation.y = spot.yaw;
      scene.add(person.root);
      this.waiting.push({ person, name: NAMES[i % NAMES.length], x: spot.x, z: spot.z });
    });
  }

  /** One physics step: pick up a passenger, throw, and check cans against their targets. */
  step(wantThrow: boolean, targets: ThrowTarget[]): void {
    const dt = FIXED_DT;
    const cart = this.cart;
    const pos = cart.body.translation();
    this.cooldown -= dt;

    if (!this.passenger && cart.state !== 'crashed' && cart.speed < JOIN_MAX_SPEED && Math.abs(pos.y) < 1.5) {
      const i = this.waiting.findIndex((w) => Math.hypot(w.x - pos.x, w.z - pos.z) < JOIN_RADIUS);
      if (i >= 0) {
        const [who] = this.waiting.splice(i, 1);
        this.passenger = who.person;
        this.passengerName = who.name;
        who.person.pose = 'sit';
        who.person.root.rotation.set(0, 0, 0);
        who.person.root.position.set(0, -0.56, -0.14);
        cart.group.add(who.person.root);
        this.events.push({ type: 'joined', name: who.name });
      }
    }

    if (wantThrow && this.passenger && !this.passenger.ragdolled && this.cooldown <= 0) {
      this.cooldown = THROW_COOLDOWN;
      this.passenger.throwTime = 0.35;
      this.throwCan(targets);
    }

    for (let i = this.cans.length - 1; i >= 0; i--) {
      const can = this.cans[i];
      can.life -= dt;
      if (can.target?.hit) {
        const t = can.body.translation();
        const p = can.target.position;
        if (Math.hypot(t.x - p.x, t.y - p.y - can.target.aimHeight, t.z - p.z) < 1.3) {
          const result = can.target.hit();
          if (result) this.events.push({ type: 'hit', ...result });
          can.target = null;
        }
      }
      if (can.life <= 0) {
        this.world.removeRigidBody(can.body);
        this.scene.remove(can.mesh);
        this.cans.splice(i, 1);
      }
    }
  }

  private throwCan(targets: ThrowTarget[]): void {
    const cart = this.cart;
    // Read the pose from physics, not the mesh, which is only synced once per rendered frame.
    const t = cart.body.translation();
    const r = cart.body.rotation();
    const quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const origin = new THREE.Vector3(0, 0.95, 0.1).applyQuaternion(quat).add(t);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quat).setY(0).normalize();

    // Nearest target that is roughly ahead and on the same level.
    let best: ThrowTarget | null = null;
    let bestDist = THROW_RANGE;
    const to = new THREE.Vector3();
    for (const t of targets) {
      to.copy(t.position).sub(origin);
      const dist = to.length();
      if (dist > bestDist || dist < 1.5 || Math.abs(to.y) > 4) continue;
      if (to.setY(0).normalize().dot(forward) < -0.2) continue;
      best = t;
      bestDist = dist;
    }

    const vel = new THREE.Vector3();
    if (best) {
      // Lead a moving target, then lob the can so gravity brings it down on it.
      const time = bestDist / THROW_SPEED;
      const aim = best.position.clone().addScaledVector(best.velocity, time);
      aim.y += best.aimHeight;
      vel.copy(aim).sub(origin);
      const dy = vel.y;
      vel.setY(0).divideScalar(time);
      vel.y = dy / time + 0.5 * 9.81 * time;
    } else {
      vel.copy(forward).multiplyScalar(THROW_SPEED).setY(4);
    }

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(origin.x, origin.y, origin.z)
        .setLinvel(vel.x, vel.y, vel.z)
        .setAngvel({ x: 12, y: 3, z: 8 })
        .setCcdEnabled(true),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(0.07).setDensity(900).setRestitution(0.4).setFriction(0.6).setCollisionGroups(RAGDOLL_GROUPS),
      body,
    );
    const mesh = new THREE.Mesh(this.canGeo, this.canMat);
    this.scene.add(mesh);
    this.cans.push({ body, mesh, life: 5, target: best });
  }

  /** The cart went down: the passenger goes flying too. */
  bail(velocity: THREE.Vector3): void {
    this.passenger?.bail(velocity);
  }

  recover(): void {
    this.passenger?.recover();
  }

  update(dt: number, time: number): void {
    for (const w of this.waiting) w.person.update(dt, time);
    if (this.passenger) {
      this.passenger.lean = this.cart.lean;
      this.passenger.update(dt, time);
    }
    for (const can of this.cans) {
      const t = can.body.translation();
      const r = can.body.rotation();
      can.mesh.position.set(t.x, t.y, t.z);
      can.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }
}
