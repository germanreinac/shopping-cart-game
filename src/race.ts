import * as THREE from 'three';
import { RAPIER, FIXED_DT, groundBelow } from './physics';
import { buildCartMesh, type Cart } from './cart';
import { Person, type Palette } from './person';
import type { ThrowTarget } from './crew';

export type RaceState = 'idle' | 'countdown' | 'running' | 'finished';

export type RaceEvent =
  | { type: 'count'; text: string }
  | { type: 'checkpoint'; index: number; total: number }
  | { type: 'finish'; place: number; time: number; best: boolean };

const CHECKPOINTS = 8;
const CHECKPOINT_RADIUS = 15;
const CRUISE = 0.5; // rivals amble round the circuit when nobody is racing
const STUN_TIME = 2.6;
const BEST_KEY = 'shopping-cart-game.bestLap';

const RIVALS: { name: string; speed: number; offset: number; accent: number; palette: Palette }[] = [
  { name: 'Toto', speed: 14.2, offset: 2.4, accent: 0x2f8f6b, palette: { top: 0xe8e2d0, legs: 0x23262e, skin: 0xc98e6a, hat: 0x2f8f6b } },
  { name: 'Flor', speed: 15.6, offset: -2.4, accent: 0x6b4fb5, palette: { top: 0x23262e, legs: 0x6b4fb5, skin: 0xe9b999, hat: 0xd9a91a } },
];

const yAxis = new THREE.Vector3(0, 1, 0);
const xAxis = new THREE.Vector3(1, 0, 0);

/** Another teen riding a trolley round the circuit on rails. Can be slowed by a thrown can. */
class Rival implements ThrowTarget {
  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  aimHeight = 0.6;
  /** Distance travelled along the circuit. */
  s = 0;
  lapStart = 0;
  finished = false;
  stun = 0;
  onStunned: (() => void) | null = null;

  private body: RAPIER.RigidBody;
  private group: THREE.Group;
  private person: Person;
  private speed = 0;
  private y = 0;
  private pitch = 0;
  private quat = new THREE.Quaternion();
  private tmpQ = new THREE.Quaternion();

  constructor(
    scene: THREE.Scene,
    private world: RAPIER.World,
    private curve: THREE.CatmullRomCurve3,
    private length: number,
    private def: (typeof RIVALS)[number],
  ) {
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.3, 0.5, 0.5).setTranslation(0, 0.3, 0).setFriction(0.3), this.body);
    this.group = buildCartMesh(def.accent).group;
    scene.add(this.group);
    this.person = new Person(scene, world, def.palette);
    this.person.pose = 'ride';
    this.person.root.position.set(0, -0.04, -0.47);
    this.group.add(this.person.root);
  }

  get name(): string {
    return this.def.name;
  }

  /** Fraction of the current lap completed. */
  get progress(): number {
    return (this.s - this.lapStart) / this.length;
  }

  placeAt(s: number): void {
    this.s = this.lapStart = s;
    this.speed = 0;
    this.stun = 0;
    this.finished = false;
    this.y = this.curve.getPointAt((s % this.length) / this.length).y;
    this.advance(0, 0);
    const t = this.position;
    this.body.setTranslation({ x: t.x, y: t.y, z: t.z }, true);
  }

  hit(): { label: string; points: number } | null {
    if (this.stun > 0) return null;
    this.stun = STUN_TIME;
    this.onStunned?.();
    return { label: `HIT ${this.def.name.toUpperCase()}`, points: 200 };
  }

  /** Move along the circuit. `pace` scales the top speed (0 = hold still). */
  advance(dt: number, pace: number): void {
    const u = (((this.s % this.length) + this.length) % this.length) / this.length;
    const tangent = this.curve.getTangentAt(u);
    const ahead = this.curve.getTangentAt((u + 7 / this.length) % 1);
    // Ease off for corners, and crawl while stunned.
    const corner = Math.max(0.55, 1 - tangent.angleTo(ahead) * 0.8);
    this.stun = Math.max(0, this.stun - dt);
    const target = this.def.speed * pace * corner * (this.stun > 0 ? 0.2 : 1);
    this.speed += Math.max(-9 * dt, Math.min(5 * dt, target - this.speed));
    this.s += this.speed * dt;

    const point = this.curve.getPointAt(u);
    const flat = Math.hypot(tangent.x, tangent.z) || 1;
    const nx = tangent.z / flat, nz = -tangent.x / flat;
    const x = point.x + nx * this.def.offset;
    const z = point.z + nz * this.def.offset;
    const floor = groundBelow(this.world, x, this.y + 1.6, z, 6);
    const prevY = this.y;
    this.y = floor ?? point.y;
    if (this.speed * dt > 1e-4) {
      const slope = Math.atan2(this.y - prevY, this.speed * dt);
      this.pitch += (Math.max(-0.5, Math.min(0.5, slope)) - this.pitch) * Math.min(1, dt * 10);
    }

    const wobble = this.stun > 0 ? Math.sin(this.stun * 14) * 0.7 * (this.stun / STUN_TIME) : 0;
    this.quat.setFromAxisAngle(yAxis, Math.atan2(tangent.x, tangent.z) + wobble);
    this.quat.multiply(this.tmpQ.setFromAxisAngle(xAxis, -this.pitch));
    this.position.set(x, this.y + 0.27, z);
    this.velocity.set((tangent.x / flat) * this.speed, 0, (tangent.z / flat) * this.speed);
    this.body.setNextKinematicTranslation({ x, y: this.y + 0.27, z });
    this.body.setNextKinematicRotation({ x: this.quat.x, y: this.quat.y, z: this.quat.z, w: this.quat.w });
  }

  update(dt: number, time: number): void {
    this.group.position.copy(this.position);
    this.group.quaternion.copy(this.quat);
    this.person.speed = this.speed;
    this.person.lean = this.stun > 0 ? Math.sin(this.stun * 14) : 0;
    this.person.update(dt, time);
  }
}

/**
 * One-lap race round the circuit against two rivals. Outside a race the rivals just
 * cruise the same loop, so there is always someone to throw things at.
 */
export class Race {
  state: RaceState = 'idle';
  time = 0;
  next = 0;
  best: number | null = null;
  events: RaceEvent[] = [];
  readonly rivals: Rival[];
  readonly total = CHECKPOINTS;

  private curve: THREE.CatmullRomCurve3;
  private length: number;
  private checkpoints: THREE.Vector3[] = [];
  private marker: THREE.Group;
  private timer = 0;
  private finishedRivals = 0;
  private startYaw: number;

  constructor(scene: THREE.Scene, world: RAPIER.World, private cart: Cart, circuit: THREE.Vector3[]) {
    this.curve = new THREE.CatmullRomCurve3(circuit, true, 'centripetal');
    this.curve.arcLengthDivisions = 600;
    this.length = this.curve.getLength();
    for (let i = 1; i <= CHECKPOINTS; i++) this.checkpoints.push(this.curve.getPointAt((i / CHECKPOINTS) % 1));
    const tangent = this.curve.getTangentAt(0);
    this.startYaw = Math.atan2(tangent.x, tangent.z);

    this.rivals = RIVALS.map((def) => new Rival(scene, world, this.curve, this.length, def));
    this.rivals.forEach((r, i) => r.placeAt(this.length * (0.3 + i * 0.35)));

    // Beam of light marking the next checkpoint.
    this.marker = new THREE.Group();
    const beamMat = new THREE.MeshBasicMaterial({ color: 0x58ffd0, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 4.4, 20, 1, true), beamMat);
    beam.position.y = 2.2;
    const ring = new THREE.Mesh(new THREE.RingGeometry(CHECKPOINT_RADIUS - 0.5, CHECKPOINT_RADIUS, 48).rotateX(-Math.PI / 2), beamMat.clone());
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.5;
    ring.position.y = 0.05;
    this.marker.add(beam, ring);
    this.marker.visible = false;
    scene.add(this.marker);

    try {
      const saved = Number(localStorage.getItem(BEST_KEY));
      if (saved > 0) this.best = saved;
    } catch {
      // Storage can be unavailable (private windows); the best time just won't persist.
    }
  }

  /** True while the player's controls should be ignored. */
  get locked(): boolean {
    return this.state === 'countdown';
  }

  /** The player's position in the race, 1 = leading. */
  get place(): number {
    const mine = this.next / CHECKPOINTS;
    return 1 + this.rivals.filter((r) => r.finished || r.progress > mine + 0.5 / CHECKPOINTS).length;
  }

  get targets(): ThrowTarget[] {
    return this.rivals;
  }

  /** Start a race from the grid, or abandon the one in progress. */
  toggle(): void {
    if (this.state !== 'idle') {
      this.state = 'idle';
      this.marker.visible = false;
      return;
    }
    const start = this.curve.getPointAt(0);
    this.cart.placeAt(start.x, start.y, start.z, this.startYaw);
    this.cart.addStamina(99); // everyone starts a race with a full pack
    for (const r of this.rivals) r.placeAt(0);
    this.state = 'countdown';
    this.timer = 3;
    this.time = 0;
    this.next = 0;
    this.finishedRivals = 0;
    this.moveMarker();
    this.events.push({ type: 'count', text: '3' });
  }

  step(): void {
    const dt = FIXED_DT;
    if (this.state === 'countdown') {
      const before = Math.ceil(this.timer);
      this.timer -= dt;
      const after = Math.ceil(this.timer);
      if (after !== before) this.events.push({ type: 'count', text: after > 0 ? String(after) : 'GO!' });
      if (this.timer <= 0) this.state = 'running';
    }

    const racing = this.state === 'running' || this.state === 'finished';
    for (const r of this.rivals) {
      r.advance(dt, this.state === 'countdown' ? 0 : racing && !r.finished ? 1 : CRUISE);
      if (racing && !r.finished && r.progress >= 1) {
        r.finished = true;
        if (this.state === 'running') this.finishedRivals++;
      }
    }

    if (this.state === 'running') {
      this.time += dt;
      const p = this.cart.body.translation();
      const c = this.checkpoints[this.next];
      if (Math.hypot(p.x - c.x, p.z - c.z) < CHECKPOINT_RADIUS && Math.abs(p.y - c.y) < 4) {
        this.next++;
        if (this.next >= CHECKPOINTS) {
          const isBest = this.best === null || this.time < this.best;
          if (isBest) {
            this.best = this.time;
            try {
              localStorage.setItem(BEST_KEY, this.time.toFixed(2));
            } catch {
              // See constructor.
            }
          }
          this.events.push({ type: 'finish', place: 1 + this.finishedRivals, time: this.time, best: isBest });
          this.state = 'finished';
          this.timer = 5;
          this.marker.visible = false;
        } else {
          this.events.push({ type: 'checkpoint', index: this.next, total: CHECKPOINTS });
          this.moveMarker();
        }
      }
    } else if (this.state === 'finished') {
      this.timer -= dt;
      if (this.timer <= 0) this.state = 'idle';
    }
  }

  update(dt: number, time: number): void {
    for (const r of this.rivals) r.update(dt, time);
    if (this.marker.visible) this.marker.children[0].rotation.y = time;
  }

  private moveMarker(): void {
    this.marker.position.copy(this.checkpoints[this.next]);
    this.marker.visible = true;
  }
}
