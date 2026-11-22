import * as THREE from 'three';
import { RAPIER, FIXED_DT, RIVAL_GROUPS, groundBelow } from './physics';
import { buildCartMesh } from './cart';
import { Person, type Palette } from './person';
import type { ThrowTarget } from './crew';

/** What the race needs to know about the player. */
export interface Racer {
  readonly position: THREE.Vector3;
  readonly speed: number;
  readonly yaw: number;
  readonly crashed: boolean;
  placeAt(x: number, y: number, z: number, yaw: number): void;
  addCigarettes(n: number): void;
}

export type RaceState = 'idle' | 'countdown' | 'running' | 'finished';

export type RaceEvent =
  | { type: 'count'; text: string }
  | { type: 'lap'; lap: number; laps: number }
  | { type: 'shove'; name: string }
  | { type: 'offCourse' }
  | { type: 'finish'; place: number; racers: number; time: number; best: boolean };

const LAPS = 2;
const CHECKPOINTS = 8; // per lap
const CHECKPOINT_RADIUS = 15;
const CRUISE = 0.5; // rivals amble round the circuit when nobody is racing
const STUN_TIME = 2.6;
const SHOVE_STUN = 1.1;
const SHOVE_REACH = 1.15;
const BEST_KEY = 'shopping-cart-game.bestRace';
const START_PAD = { x: -7, z: 58, radius: 2.6 };

// Each kid has a different pace and a lane they like. Lanes are metres left/right of the racing line.
const RIVALS: { name: string; speed: number; offset: number; accent: number; palette: Palette }[] = [
  { name: 'Toto', speed: 18.2, offset: 3.2, accent: 0x2f8f6b, palette: { top: 0xe8e2d0, legs: 0x23262e, skin: 0xc98e6a, hat: 0x2f8f6b } },
  { name: 'Flor', speed: 20.6, offset: -1.6, accent: 0x6b4fb5, palette: { top: 0x23262e, legs: 0x6b4fb5, skin: 0xe9b999, hat: 0xd9a91a } },
  { name: 'Rulo', speed: 19.2, offset: -3.2, accent: 0xd98a2b, palette: { top: 0x2f6fb5, legs: 0x3a3f52, skin: 0x9c6b4a, hat: 0xd8342c } },
  { name: 'Mica', speed: 19.9, offset: 1.6, accent: 0xb5456f, palette: { top: 0xd9a91a, legs: 0x2a2c30, skin: 0xe9c0a0, hat: 0xb5456f } },
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
  /** Extra sideways displacement from being shoved; eases back to the lane. */
  private nudge = 0;

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
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.3, 0.5, 0.5).setTranslation(0, 0.3, 0).setFriction(0.3).setCollisionGroups(RIVAL_GROUPS), this.body);
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

  /** Laps completed since the start, as a fraction. */
  get progress(): number {
    return (this.s - this.lapStart) / this.length;
  }

  placeAt(s: number): void {
    this.s = this.lapStart = s;
    this.speed = 0;
    this.stun = 0;
    this.nudge = 0;
    this.finished = false;
    this.y = this.curve.getPointAt((((s % this.length) + this.length) % this.length) / this.length).y;
    this.advance(0, 0);
    const t = this.position;
    this.body.setTranslation({ x: t.x, y: t.y, z: t.z }, true);
  }

  hit(): { label: string; points: number } | null {
    if (this.stun > 0) return null;
    this.stun = STUN_TIME;
    return { label: `HIT ${this.def.name.toUpperCase()}`, points: 200 };
  }

  /** Barged by the player from one side: knocked off line and slowed for a moment. */
  shove(fromX: number, fromZ: number): boolean {
    if (this.stun > 0) return false;
    this.stun = SHOVE_STUN;
    // Which side of our heading the player is on decides which way we get pushed.
    const side = (fromX - this.position.x) * this.velocity.z - (fromZ - this.position.z) * this.velocity.x;
    this.nudge += side > 0 ? -1.4 : 1.4;
    return true;
  }

  /** Move along the circuit. `pace` scales the top speed (0 = hold still). */
  advance(dt: number, pace: number): void {
    const u = (((this.s % this.length) + this.length) % this.length) / this.length;
    const tangent = this.curve.getTangentAt(u);
    const ahead = this.curve.getTangentAt((u + 7 / this.length) % 1);
    // Ease off for corners, and crawl while stunned.
    const corner = Math.max(0.65, 1 - tangent.angleTo(ahead) * 0.8);
    this.stun = Math.max(0, this.stun - dt);
    const target = this.def.speed * pace * corner * (this.stun > 0 ? 0.35 : 1);
    this.nudge *= Math.max(0, 1 - dt * 0.9);
    this.speed += Math.max(-9 * dt, Math.min(5 * dt, target - this.speed));
    this.s += this.speed * dt;

    const point = this.curve.getPointAt(u);
    const flat = Math.hypot(tangent.x, tangent.z) || 1;
    const nx = tangent.z / flat, nz = -tangent.x / flat;
    const lane = Math.max(-3.5, Math.min(3.5, this.def.offset + this.nudge));
    const x = point.x + nx * lane;
    const z = point.z + nz * lane;
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
 * A race round the circuit against the other kids. Outside a race they just cruise the
 * same loop, so there is always someone to shove or throw things at.
 */
export class Race {
  state: RaceState = 'idle';
  time = 0;
  /** Checkpoints passed so far, across all laps. */
  next = 0;
  best: number | null = null;
  events: RaceEvent[] = [];
  readonly rivals: Rival[];
  readonly laps = LAPS;

  private curve: THREE.CatmullRomCurve3;
  private length: number;
  private checkpoints: THREE.Vector3[] = [];
  private marker: THREE.Group;
  private pad: THREE.Mesh;
  private arrows: THREE.InstancedMesh;
  private padArmed = false;
  private timer = 0;
  private finishedRivals = 0;
  private finalPlace = 1;
  private startYaw: number;
  /** How far round the circuit the player is, in metres since the start. */
  private playerS = 0;
  private lostTime = 0;

  constructor(scene: THREE.Scene, world: RAPIER.World, private racer: Racer, circuit: THREE.Vector3[]) {
    this.curve = new THREE.CatmullRomCurve3(circuit, true, 'centripetal');
    this.curve.arcLengthDivisions = 600;
    this.length = this.curve.getLength();
    for (let i = 1; i <= CHECKPOINTS; i++) this.checkpoints.push(this.curve.getPointAt((i / CHECKPOINTS) % 1));
    const tangent = this.curve.getTangentAt(0);
    this.startYaw = Math.atan2(tangent.x, tangent.z);

    this.rivals = RIVALS.map((def) => new Rival(scene, world, this.curve, this.length, def));
    this.rivals.forEach((r, i) => r.placeAt(this.length * (0.15 + i * 0.2)));

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

    // Chevrons painted along the racing line while a race is on, so corners can be read early.
    const chevron = new THREE.Shape();
    chevron.moveTo(0, 0.9);
    chevron.lineTo(1.1, -0.5);
    chevron.lineTo(0.65, -0.5);
    chevron.lineTo(0, 0.3);
    chevron.lineTo(-0.65, -0.5);
    chevron.lineTo(-1.1, -0.5);
    chevron.closePath();
    const count = Math.floor(this.length / 7);
    this.arrows = new THREE.InstancedMesh(
      new THREE.ShapeGeometry(chevron).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x58ffd0, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
      count,
    );
    const m = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const fwdAxis = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < count; i++) {
      const u = i / count;
      const pt = this.curve.getPointAt(u);
      pt.y += 0.09;
      quat.setFromUnitVectors(fwdAxis, this.curve.getTangentAt(u));
      this.arrows.setMatrixAt(i, m.compose(pt, quat, one));
    }
    this.arrows.visible = false;
    scene.add(this.arrows);

    // Start pad: roll into it to line everyone up for a race.
    this.pad = new THREE.Mesh(
      new THREE.CylinderGeometry(START_PAD.radius, START_PAD.radius, 2.6, 28, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x58ffd0, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.pad.position.set(START_PAD.x, 1.3, START_PAD.z);
    scene.add(this.pad);
    const flag = document.createElement('canvas');
    flag.width = 256;
    flag.height = 96;
    const g = flag.getContext('2d')!;
    g.fillStyle = '#58ffd0';
    g.font = 'bold 72px Arial, Helvetica, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('RACE', 128, 52);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(flag), transparent: true, depthWrite: false }));
    label.scale.set(4, 1.5, 1);
    label.position.y = 2.4;
    this.pad.add(label);

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

  get racers(): number {
    return this.rivals.length + 1;
  }

  /** Which lap the player is on, starting at 1. */
  get lap(): number {
    return Math.min(LAPS, Math.floor(this.next / CHECKPOINTS) + 1);
  }

  /** The player's position in the race, 1 = leading. */
  get place(): number {
    if (this.state === 'finished') return this.finalPlace;
    return 1 + this.rivals.filter((r) => r.finished || r.s - r.lapStart > this.playerS + 1.5).length;
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
    this.racer.placeAt(start.x, start.y, start.z, this.startYaw);
    this.racer.addCigarettes(99); // everyone starts a race with a full pack
    // Two rows on the grid: the player is in the middle of the front row.
    this.rivals.forEach((r, i) => r.placeAt(i < 2 ? 0 : -3.5));
    this.state = 'countdown';
    this.timer = 3;
    this.time = 0;
    this.next = 0;
    this.playerS = 0;
    this.lostTime = 0;
    this.finishedRivals = 0;
    this.padArmed = false;
    this.moveMarker();
    this.events.push({ type: 'count', text: '3' });
  }

  step(): void {
    const dt = FIXED_DT;
    const p = this.racer.position;

    if (this.state === 'idle') {
      // The pad only arms once you have rolled out of it, so a race does not restart under you.
      const onPad = Math.hypot(p.x - START_PAD.x, p.z - START_PAD.z) < START_PAD.radius && Math.abs(p.y) < 1.5;
      if (!onPad) this.padArmed = true;
      else if (this.padArmed && !this.racer.crashed) this.toggle();
    } else if (this.state === 'countdown') {
      const before = Math.ceil(this.timer);
      this.timer -= dt;
      const after = Math.ceil(this.timer);
      if (after !== before) this.events.push({ type: 'count', text: after > 0 ? String(after) : 'GO!' });
      if (this.timer <= 0) this.state = 'running';
    }

    const racing = this.state === 'running' || this.state === 'finished';
    if (this.state === 'running') {
      this.trackPlayer(p);
      // Missed a turn or took the wrong level: after a few seconds, put the player back on the line.
      const on = this.at(this.playerS);
      const lost = Math.hypot(on.x - p.x, on.z - p.z) > 24 || Math.abs(on.y - p.y) > 3.2;
      this.lostTime = lost && !this.racer.crashed ? this.lostTime + dt : 0;
      if (this.lostTime > 2.5) {
        const tangent = this.curve.getTangentAt((((this.playerS % this.length) + this.length) % this.length) / this.length);
        this.racer.placeAt(on.x, on.y, on.z, Math.atan2(tangent.x, tangent.z));
        this.lostTime = 0;
        this.events.push({ type: 'offCourse' });
      }
    }
    for (const r of this.rivals) {
      let pace = this.state === 'countdown' ? 0 : racing && !r.finished ? 1 : CRUISE;
      if (this.state === 'running' && !r.finished) {
        // Keep it a race: kids well ahead ease off a little, kids well behind dig in.
        const gap = r.s - r.lapStart - this.playerS;
        pace *= 1 - Math.max(-0.14, Math.min(0.14, gap / 300));
      }
      r.advance(dt, pace);
      if (racing && !r.finished && r.progress >= LAPS) {
        r.finished = true;
        if (this.state === 'running') this.finishedRivals++;
      }
      // Barge into a kid and they get knocked off line instead of you both going down.
      if (this.state !== 'countdown' && !this.racer.crashed && this.racer.speed > 4 &&
        Math.hypot(p.x - r.position.x, p.y - r.position.y, p.z - r.position.z) < SHOVE_REACH && r.shove(p.x, p.z)) {
        this.events.push({ type: 'shove', name: r.name });
      }
    }

    if (this.state === 'running') {
      this.time += dt;
      const c = this.checkpoints[this.next % CHECKPOINTS];
      if (Math.hypot(p.x - c.x, p.z - c.z) < CHECKPOINT_RADIUS && Math.abs(p.y - c.y) < 4) {
        this.next++;
        if (this.next >= CHECKPOINTS * LAPS) {
          const isBest = this.best === null || this.time < this.best;
          if (isBest) {
            this.best = this.time;
            try {
              localStorage.setItem(BEST_KEY, this.time.toFixed(2));
            } catch {
              // See constructor.
            }
          }
          this.finalPlace = 1 + this.finishedRivals;
          this.events.push({ type: 'finish', place: this.finalPlace, racers: this.racers, time: this.time, best: isBest });
          this.state = 'finished';
          this.timer = 5;
          this.marker.visible = false;
        } else {
          if (this.next % CHECKPOINTS === 0) this.events.push({ type: 'lap', lap: this.lap, laps: LAPS });
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
    this.pad.visible = this.state === 'idle';
    this.arrows.visible = this.state === 'countdown' || this.state === 'running';
    this.pad.rotation.y = time * 0.6;
  }

  /** Slide the player's marker forward along the racing line to the point nearest the cart. */
  private trackPlayer(p: { x: number; y: number; z: number }): void {
    const at = (s: number) => this.at(s);
    let here = at(this.playerS);
    let best = Math.hypot(here.x - p.x, here.y - p.y, here.z - p.z);
    for (let i = 0; i < 12; i++) {
      here = at(this.playerS + 1);
      const d = Math.hypot(here.x - p.x, here.y - p.y, here.z - p.z);
      if (d >= best) break;
      best = d;
      this.playerS += 1;
    }
  }

  /**
   * Which way the racing line bends just ahead, relative to where the player is pointing.
   * Radians: positive = it goes left, negative = right. Drives the arrow on the HUD.
   */
  get turn(): number {
    const ahead = this.at(this.playerS + 16 + this.racer.speed * 1.1);
    const p = this.racer.position;
    let diff = Math.atan2(ahead.x - p.x, ahead.z - p.z) - this.racer.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return diff;
  }

  private at(s: number): THREE.Vector3 {
    return this.curve.getPointAt((((s % this.length) + this.length) % this.length) / this.length);
  }

  private moveMarker(): void {
    this.marker.position.copy(this.checkpoints[this.next % CHECKPOINTS]);
    this.marker.visible = true;
  }
}
