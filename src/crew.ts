import * as THREE from 'three';
import { toon } from './style';
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
  | { type: 'moved'; name: string }
  | { type: 'hit'; label: string; points: number };

// Dusty mid-tones with a few saturated pops, after the OlliOlli World sheets.
const PALETTES: Palette[] = [
  { top: 0x8fb3d9, legs: 0xe8c547, skin: 0x8a5a3c, hat: 0xd9a521, headwear: 'cap', bareArms: true, shoes: 0x4f6f96 },
  { top: 0xf1e9e0, legs: 0x4f6f96, skin: 0x7a4a32, hat: 0x2a2030, headwear: 'hair', bareArms: true, shoes: 0x6b2d4a },
  { top: 0xe0456b, legs: 0x3a3340, skin: 0xe9c547, hat: 0xe0456b, headwear: 'helmet', shoes: 0x9bc96b },
  { top: 0x9bc96b, legs: 0x6b2d4a, skin: 0xe9a77c, hat: 0x6b2d4a, headwear: 'beanie', pads: true, shoes: 0xf1e9e0 },
  { top: 0xa9714b, legs: 0x7a7a45, skin: 0xb98058, hat: 0x8fb3d9, headwear: 'cap', bareArms: true, shoes: 0x2a2030 },
  { top: 0xb7a3b5, legs: 0xd9a521, skin: 0xe9a77c, hat: 0x4f6f96, headwear: 'beanie', shoes: 0xe0456b },
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
  /** The cart the passenger is sitting in. It may not be the one you are holding. */
  passengerCart: Cart | null = null;
  passengerName = '';
  events: CrewEvent[] = [];

  private waiting: { person: Person; name: string; x: number; z: number }[] = [];
  private cans: Can[] = [];
  private cooldown = 0;
  private canGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.12, 8);
  private canMat = toon({ color: 0xc9d2da, metalness: 0.5, roughness: 0.3, emissive: 0x30363c });

  constructor(
    private scene: THREE.Scene,
    private world: RAPIER.World,
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

  /** True when the passenger is in the cart you are holding, so they can throw for you. */
  ridingWith(cart: Cart | null): boolean {
    return this.passenger !== null && cart !== null && this.passengerCart === cart;
  }

  /** One physics step: pick up a passenger, throw, and check cans against their targets. */
  step(cart: Cart | null, wantThrow: boolean, targets: ThrowTarget[]): void {
    const dt = FIXED_DT;
    this.cooldown -= dt;

    if (cart && cart.state !== 'crashed') {
      const pos = cart.body.translation();
      if (!this.passenger && cart.speed < JOIN_MAX_SPEED && Math.abs(pos.y) < 1.5) {
        const i = this.waiting.findIndex((w) => Math.hypot(w.x - pos.x, w.z - pos.z) < JOIN_RADIUS);
        if (i >= 0) {
          const [who] = this.waiting.splice(i, 1);
          this.passenger = who.person;
          this.passengerName = who.name;
          who.person.pose = 'sit';
          this.seat(cart);
          this.events.push({ type: 'joined', name: who.name });
        }
      } else if (this.passenger && this.passengerCart && this.passengerCart !== cart && !this.passenger.ragdolled) {
        // You let them roll off in another cart: pull up next to it and they climb across.
        const other = this.passengerCart.body.translation();
        if (this.passengerCart.speed < 4 && Math.hypot(other.x - pos.x, other.y - pos.y, other.z - pos.z) < 2.8) {
          this.seat(cart);
          this.events.push({ type: 'moved', name: this.passengerName });
        }
      }
    }

    if (wantThrow && cart && this.ridingWith(cart) && !this.passenger!.ragdolled && this.cooldown <= 0) {
      this.cooldown = THROW_COOLDOWN;
      this.passenger!.throwTime = 0.35;
      this.throwCan(cart, targets);
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

  private seat(cart: Cart): void {
    this.passengerCart = cart;
    this.passenger!.root.rotation.set(0, 0, 0);
    this.passenger!.root.position.set(0, -0.56, -0.14);
    cart.group.add(this.passenger!.root);
  }

  private throwCan(cart: Cart, targets: ThrowTarget[]): void {
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

  /** A cart went down: if the passenger was in it, they go flying too. */
  bail(cart: Cart, velocity: THREE.Vector3): void {
    if (cart === this.passengerCart) this.passenger?.bail(velocity);
  }

  recover(cart: Cart): void {
    if (cart === this.passengerCart) this.passenger?.recover();
  }

  update(dt: number, time: number): void {
    for (const w of this.waiting) w.person.update(dt, time);
    if (this.passenger) {
      this.passenger.lean = this.passengerCart?.lean ?? 0;
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
