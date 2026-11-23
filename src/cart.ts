import * as THREE from 'three';
import { toon } from './style';
import { RAPIER, FIXED_DT, CART_GROUPS, WHEEL_RAY_GROUPS, groundBelow } from './physics';
import { NO_CONTROLS, type Controls } from './input';

/** loose: nobody is holding it, it just rolls. */
export type CartState = 'pushing' | 'riding' | 'crashed' | 'loose';

/** A grindable rail: a straight bar from a to b. */
export interface Rail {
  a: THREE.Vector3;
  b: THREE.Vector3;
}

export type CartEvent =
  | { type: 'hopOn' }
  | { type: 'hopOff' }
  | { type: 'tooSlow' }
  | { type: 'boost'; strength: number }
  | { type: 'land'; strength: number }
  | { type: 'trick'; label: string; points: number }
  | { type: 'crash'; velocity: THREE.Vector3 };

// ---- Tuning. All SI units (metres, seconds, kilograms). ----
export const TUNE = {
  mass: 60, // cart + rider, kept constant so the suspension behaves the same in every state
  accel: 7, // m/s² while holding push, on foot or on the cart
  cruiseSpeed: 13, // top speed with no cigarettes left
  sprintSpeed: 21, // top speed while burning cigarettes
  sprintDrain: 0.4, // cigarettes per second while sprinting
  staminaMax: 5,
  staminaRegen: 0.12, // cigarettes per second when not sprinting
  hopOnSpeed: 6, // pushing faster than this, you jump on automatically
  minHopOnSpeed: 1.2, // slowest you can jump on by pressing hop
  remountSpeed: 2.5, // riding slower than this with push held, you step off and run
  pushBrake: 6.0, // pulling back on the handle while on foot
  pushCoast: 1.6, // jogging to a stop when you let go of push
  rideDrag: 0.7, // rolling resistance while riding (m/s²)
  rideDragQuad: 0.004, // extra drag that grows with speed²
  steerAttack: 9, // how fast the steering eases in (per second)
  steerRelease: 14, // and back to centre
  turnRateSlow: 2.7, // rad/s of turning at walking pace
  turnRateFast: 1.35, // rad/s of turning at top speed
  turnSnap: 12, // how quickly the cart reaches the turn rate you asked for
  grip: 11, // how fast sideways sliding is killed (per second); lower = looser
  slickGrip: 0.42, // grip multiplier on the supermarket's polished floor
  turnDrag: 1.5, // m/s² lost in a hard corner
  revertRate: 5, // rad/s the cart swings round when it is rolling backwards
  driftMinSpeed: 8, // need this much speed to start a drift
  driftDelay: 0.35, // seconds of full lock before the back steps out
  driftTurn: 1.45, // drifting turns this much tighter
  driftGrip: 2.6, // grip while drifting: low, so the cart slides
  driftDrag: 2.2, // m/s² lost while sliding
  driftBoostMin: 2, // m/s kick out of a short drift
  driftBoostMax: 6, // and out of a long one (two seconds or more)
  airYawTorque: 150, // spinning in the air
  airYawDamping: 18,
  airLevel: 60, // how hard the rider keeps the cart level in the air
  flipRate: 8, // rad/s of a held flip
  grindMinSpeed: 4, // need this much speed along a rail to lock on
  grindFriction: 0.6, // m/s² lost while grinding
  antiRoll: 900, // keeps all four wheels down in hard corners
  wheelieRaiseRate: 0.9, // rad/s the nose climbs while you hold back
  wheelieDropRate: 1.8, // rad/s it comes down when you let go
  wheelieMaxPitch: 0.8, // rad: the nose stops here, so a held wheelie never loops out
  hopSpeed: 6.6, // vertical take-off speed of a full hop
  hopCutGravity: 16, // extra gravity while rising if you let go of jump early (short hop)
  fallGravity: 5, // extra gravity on the way down, so jumps feel snappy not floaty
  jumpBuffer: 0.14, // seconds a jump press is remembered before landing
  tipCrashUp: 0.45, // cart "up" · world up below this = tipped over
  slamCrashDv: 7, // horizontal speed lost in one step = hit something solid
  recoverTime: 1, // seconds on the floor before you are stood back up automatically
};

const PITCH_INERTIA = 9;
const RAIL_SEAT = 0.14; // how high the cart's origin rides above a rail
const YAW_INERTIA = 8; // matches the collider's mass properties below
const WHEEL_RADIUS = 0.08;
const SUSPENSION_REST = 0.12;
// Front-left, front-right, rear-left, rear-right (forward = +Z, left = +X).
const WHEELS: [number, number, number][] = [
  [0.25, -0.1, 0.38],
  [-0.25, -0.1, 0.38],
  [0.26, -0.1, -0.38],
  [-0.26, -0.1, -0.38],
];

const q = new THREE.Quaternion();
const fwd = new THREE.Vector3();
const up = new THREE.Vector3();
const side = new THREE.Vector3();
const fwdFlat = new THREE.Vector3();
const vel = new THREE.Vector3();
const tmp = new THREE.Vector3();

let meshTexture: THREE.CanvasTexture | null = null;
function wireMeshTexture(): THREE.CanvasTexture {
  if (meshTexture) return meshTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 32, 32);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 32, 5);
  g.fillRect(0, 0, 5, 32);
  meshTexture = new THREE.CanvasTexture(c);
  meshTexture.wrapS = meshTexture.wrapT = THREE.RepeatWrapping;
  meshTexture.magFilter = THREE.NearestFilter;
  return meshTexture;
}

/** Builds the trolley model out of primitives. Origin matches the physics body origin. */
export function buildCartMesh(accent = 0xd8342c): { group: THREE.Group; wheels: THREE.Object3D[] } {
  const group = new THREE.Group();
  const steel = toon({ color: 0xc4ccd4, metalness: 0.35, roughness: 0.35 });
  const plastic = toon({ color: accent, roughness: 0.5 });
  const rubber = toon({ color: 0x18181a, roughness: 0.9 });

  const bar = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material = steel) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    group.add(m);
    return m;
  };

  // Basket: wire-mesh sides and floor, with a solid rim.
  const W = 0.5, H = 0.42, L = 0.86, Y0 = 0.14;
  const panel = (w: number, h: number, repX: number, repY: number) => {
    const tex = wireMeshTexture().clone();
    tex.needsUpdate = true;
    tex.repeat.set(repX, repY);
    const mat = toon({
      color: 0xc4ccd4, metalness: 0.35, roughness: 0.35,
      alphaMap: tex, alphaTest: 0.5, transparent: false, side: THREE.DoubleSide,
    });
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  };
  const left = panel(L, H, 14, 7);
  left.rotation.y = Math.PI / 2;
  left.position.set(W / 2, Y0 + H / 2, 0);
  const right = left.clone();
  right.position.x = -W / 2;
  const front = panel(W, H, 8, 7);
  front.position.set(0, Y0 + H / 2, L / 2);
  const back = front.clone();
  back.position.z = -L / 2;
  const floor = panel(W, L, 8, 14);
  floor.rotation.x = Math.PI / 2;
  floor.position.set(0, Y0, 0);
  group.add(left, right, front, back, floor);

  const T = 0.025;
  for (const y of [Y0, Y0 + H]) {
    bar(T, T, L, W / 2, y, 0);
    bar(T, T, L, -W / 2, y, 0);
    bar(W, T, T, 0, y, L / 2);
    bar(W, T, T, 0, y, -L / 2);
  }
  for (const sx of [1, -1]) for (const sz of [1, -1]) bar(T, H, T, (sx * W) / 2, Y0 + H / 2, (sz * L) / 2);

  // Undercarriage and handle.
  bar(T, T, 0.86, 0.24, -0.02, 0);
  bar(T, T, 0.86, -0.24, -0.02, 0);
  bar(0.5, T, T, 0, -0.02, -0.4);
  bar(0.5, T, T, 0, -0.02, 0.4);
  for (const sx of [1, -1]) {
    bar(T, 0.18, T, sx * 0.24, 0.06, -0.4);
    bar(T, 0.18, T, sx * 0.24, 0.06, 0.38);
    const upright = bar(T, 0.3, T, sx * 0.24, Y0 + H + 0.1, -L / 2 - 0.06);
    upright.rotation.x = 0.45;
  }
  bar(0.56, 0.045, 0.045, 0, Y0 + H + 0.23, -L / 2 - 0.12, plastic);
  bar(0.52, 0.05, 0.03, 0, Y0 + H, L / 2 + 0.01, plastic);

  // Wheels: a pivot per wheel so the game can move and spin them.
  const wheels: THREE.Object3D[] = [];
  const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.04, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  for (const [x, y, z] of WHEELS) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y - SUSPENSION_REST, z);
    const tyre = new THREE.Mesh(wheelGeo, rubber);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.1, 0.02), steel);
    pivot.add(tyre, spoke);
    group.add(pivot);
    wheels.push(pivot);
  }
  return { group, wheels };
}

/**
 * The player's trolley: a Rapier raycast vehicle with fixed rear wheels and free-swivelling
 * front casters. Like a real trolley it is steered by twisting it (handle or body lean),
 * not by turning wheels, which is what gives it the heavy, drifty feel.
 */
export class Cart {
  readonly body: RAPIER.RigidBody;
  readonly group: THREE.Group;
  state: CartState = 'pushing';
  /** Horizontal speed in m/s. */
  speed = 0;
  /** Signed speed along the cart's nose. */
  fwdSpeed = 0;
  /** Nose-up pitch in radians. */
  pitch = 0;
  /** Eased steer input, -1..1. Drives the turn rate and the lean of cart and rider. */
  lean = 0;
  /** True while in a held slide. */
  drifting = false;
  /** True while the player has hold of this cart. Otherwise it rolls on its own. */
  occupied = false;
  /** Polished floor under the wheels: much less grip, so everything slides. */
  slick = false;
  /** Rails this cart can grind. */
  rails: Rail[] = [];
  /** Set while sliding along a rail. */
  grind: { rail: Rail; t: number; v: number; time: number; yaw: number; points: number } | null = null;
  grounded = 0;
  /** Points building up in the trick currently being held, and what it is. */
  pendingPoints = 0;
  pendingLabel = '';
  /** Cigarettes left: burned by sprinting and kick-pushes. */
  stamina = TUNE.staminaMax;
  /** True while burning cigarettes to run faster than a jog. */
  sprinting = false;
  /** Height of the ground last rolled on, for the blob shadow. */
  groundY = 0;
  /** Signed angle between where the cart points and where it is going. */
  slip = 0;
  events: CartEvent[] = [];

  private vehicle: RAPIER.DynamicRayCastVehicleController;
  private wheelMeshes: THREE.Object3D[];
  private prevVel = new THREE.Vector3();
  private airTime = 0;
  private wheelieTime = 0;
  private wheelieTarget = 0;
  private crashTimer = 0;
  private airYaw = 0;
  private driftTime = 0;
  private driftPoints = 0;
  private driftCharge = 0;
  private airPitch = 0;
  private flipArmed = false;
  private grindCooldown = 0;
  private visualRoll = 0;
  private driftDir = 0;
  private jumpBuffer = 0;
  private hopping = false;
  private wheeliePoints = 0;
  private lastYaw = 0;
  private stillTime = 0;
  private onKerb = false;
  private tookOffFromKerb = false;
  private spawnPose: { x: number; z: number; yaw: number };

  constructor(
    private world: RAPIER.World,
    scene: THREE.Scene,
    spawn: { x: number; z: number; yaw: number },
    private kerbs: Set<number>,
    private bounds: { x: number; z: number; north?: number },
    accent = 0xd8342c,
  ) {
    this.spawnPose = spawn;
    const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spawn.yaw);
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, 0.3, spawn.z)
        .setRotation({ x: yawQ.x, y: yawQ.y, z: yawQ.z, w: yawQ.w })
        .setCanSleep(false)
        .setCcdEnabled(true),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.27, 0.3, 0.46)
        .setTranslation(0, 0.26, 0)
        .setMassProperties(TUNE.mass, { x: 0, y: 0.08, z: 0 }, { x: 9, y: 8, z: 5 }, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.35)
        .setRestitution(0.15)
        .setCollisionGroups(CART_GROUPS),
      this.body,
    );

    const v = (this.vehicle = world.createVehicleController(this.body));
    v.indexUpAxis = 1;
    v.setIndexForwardAxis = 2;
    WHEELS.forEach(([x, y, z], i) => {
      v.addWheel({ x, y, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, SUSPENSION_REST, WHEEL_RADIUS);
      v.setWheelSuspensionStiffness(i, 70);
      v.setWheelSuspensionCompression(i, 5);
      v.setWheelSuspensionRelaxation(i, 8);
      v.setWheelMaxSuspensionTravel(i, 0.1);
      v.setWheelMaxSuspensionForce(i, 6000);
      // Front casters swivel freely (almost no sideways grip); rear wheels are fixed.
      v.setWheelFrictionSlip(i, 0.02); // tyres only hold the cart up; grip is handled in step()
      v.setWheelSideFrictionStiffness(i, 1);
    });

    const mesh = buildCartMesh(accent);
    this.group = mesh.group;
    this.wheelMeshes = mesh.wheels;
    scene.add(this.group);
    this.syncMesh();
  }

  /** Apply this step's controls. Call before `world.step()`. */
  step(ctl: Controls): void {
    const dt = FIXED_DT;
    const b = this.body;
    const m = b.mass();
    this.readPose();

    if (!this.occupied) {
      ctl = NO_CONTROLS;
      if (this.state !== 'crashed') this.state = 'loose';
    }
    if (ctl.reset) {
      this.reset();
      return;
    }
    if (this.grind) {
      this.grindStep(ctl);
      return;
    }
    this.tryGrind();

    const onWheels = this.grounded >= 2;
    this.sprinting = false;
    const flatLen = Math.hypot(fwd.x, fwd.z);
    fwdFlat.set(fwd.x, 0, fwd.z).multiplyScalar(flatLen > 1e-4 ? 1 / flatLen : 0);

    // One throttle for both states: on foot it is running, on the cart it is kick-pushing.
    // Past cruising speed it burns cigarettes.
    const braking = this.state === 'pushing' && ctl.back > 0.1;
    if (ctl.push && onWheels && !braking) {
      const top = this.stamina > 0 ? TUNE.sprintSpeed : TUNE.cruiseSpeed;
      // Measured on total speed, so sliding sideways in a drift is not a way to exceed top speed.
      const going = this.fwdSpeed >= 0 ? this.speed : this.fwdSpeed;
      const accel = TUNE.accel * Math.max(-0.2, Math.min(1, (top - going) / 3));
      if (going > TUNE.cruiseSpeed - 0.5 && this.stamina > 0) {
        this.sprinting = true;
        this.stamina = Math.max(0, this.stamina - TUNE.sprintDrain * dt);
      }
      b.applyImpulse(tmp.copy(fwdFlat).multiplyScalar(m * accel * dt), true);
    }

    if (this.state === 'pushing') {
      if (onWheels && (this.fwdSpeed >= TUNE.hopOnSpeed || (ctl.jump && this.fwdSpeed >= TUNE.minHopOnSpeed))) {
        // Going fast enough: jump on the back automatically.
        this.state = 'riding';
        this.stillTime = 0;
        this.events.push({ type: 'hopOn' });
      } else if (onWheels && !ctl.push || braking) {
        let accel = 0;
        if (braking) {
          // Dig your heels in; once stopped, drag the cart backwards slowly.
          accel = this.fwdSpeed > -1.5 ? -TUNE.pushBrake * ctl.back : 0;
        } else if (Math.abs(this.fwdSpeed) > 0.05) {
          accel = -Math.sign(this.fwdSpeed) * Math.min(TUNE.pushCoast, Math.abs(this.fwdSpeed) / dt);
        }
        if (onWheels) b.applyImpulse(tmp.copy(fwdFlat).multiplyScalar(m * accel * dt), true);
      }
    } else if (this.state === 'riding') {
      if (ctl.push && this.speed < TUNE.remountSpeed && onWheels) {
        // Too slow to kick along: step off and run.
        this.state = 'pushing';
        this.events.push({ type: 'hopOff' });
      }
      // Hop, with a short buffer so a press just before landing still counts.
      this.jumpBuffer = ctl.jump ? TUNE.jumpBuffer : this.jumpBuffer - dt;
      if (this.jumpBuffer > 0 && onWheels && vel.y < 2) {
        this.jumpBuffer = 0;
        this.hopping = true;
        b.applyImpulse({ x: 0, y: m * (TUNE.hopSpeed - vel.y), z: 0 }, true);
      }
      // Wheelie: hold back to lift the nose, let go to drop it and bank the points.
      if (ctl.back > 0.1 && this.grounded >= 1) {
        this.wheelieTarget = Math.min(TUNE.wheelieMaxPitch, Math.max(this.wheelieTarget, this.pitch, 0.1) + TUNE.wheelieRaiseRate * ctl.back * dt);
      } else {
        this.wheelieTarget = Math.max(0, this.wheelieTarget - TUNE.wheelieDropRate * dt);
      }
      if (this.wheelieTarget > 0.01 && this.grounded >= 1) {
        const av = b.angvel();
        const pitchRate = -(av.x * side.x + av.y * side.y + av.z * side.z);
        const torque = Math.max(-250, Math.min(520, 1500 * (this.wheelieTarget - this.pitch) - 170 * pitchRate));
        b.applyTorqueImpulse(tmp.copy(side).multiplyScalar(-torque * dt), true);
      }
    }

    // Rolling resistance.
    if (this.state !== 'pushing' && this.grounded >= 1 && this.speed > 0.01) {
      const decel = Math.min(TUNE.rideDrag + TUNE.rideDragQuad * this.speed * this.speed, this.speed / dt);
      b.applyImpulse({ x: (-vel.x / this.speed) * m * decel * dt, y: 0, z: (-vel.z / this.speed) * m * decel * dt }, true);
    }

    // Ease the steering in and out so a tapped key is a nudge and a held key is a full turn.
    const easing = (ctl.steer === 0 || ctl.steer * this.lean < 0 ? TUNE.steerRelease : TUNE.steerAttack) * dt;
    this.lean += Math.max(-easing, Math.min(easing, ctl.steer - this.lean));

    if (this.state !== 'crashed') {
      const av = b.angvel();
      if (this.grounded >= 2) {
        this.updateDrift(ctl, m);

        // Kart-style steering: the cart turns at the rate you ask for, tighter at low speed.
        const k = Math.min(1, this.speed / TUNE.sprintSpeed);
        let want = -this.lean * (TUNE.turnRateSlow + (TUNE.turnRateFast - TUNE.turnRateSlow) * k);
        if (this.drifting) want *= TUNE.driftTurn;
        // Rolling sideways or backwards (after a spin): swing the nose round to face the way you are going.
        else if (Math.abs(this.slip) > 1.1 && this.speed > 3) want += Math.sign(this.slip) * TUNE.revertRate;
        b.applyTorqueImpulse({ x: 0, y: YAW_INERTIA * (want - av.y) * Math.min(1, TUNE.turnSnap * dt), z: 0 }, true);

        // Anti-roll: not realistic, but it keeps hard corners fun instead of fatal.
        // Measured against the ground under the wheels, so banked corners can be ridden.
        let nx = 0, ny = 0, nz = 0;
        for (let i = 0; i < 4; i++) {
          const n = this.vehicle.wheelIsInContact(i) ? this.vehicle.wheelContactNormal(i) : null;
          if (n) { nx += n.x; ny += n.y; nz += n.z; }
        }
        const nLen = Math.hypot(nx, ny, nz) || 1;
        const lean = (side.x * nx + side.y * ny + side.z * nz) / nLen;
        this.flipArmed = false;
        const roll = -(lean * TUNE.antiRoll + (av.x * fwd.x + av.y * fwd.y + av.z * fwd.z) * 120) * dt;
        b.applyTorqueImpulse({ x: fwd.x * roll, y: fwd.y * roll, z: fwd.z * roll }, true);

        // Grip: bleed off sideways speed and turn most of it back into forward speed, so the
        // cart goes where it points without stalling in corners. Drifting just uses less grip.
        const lx = fwdFlat.z, lz = -fwdFlat.x;
        const vf = vel.x * fwdFlat.x + vel.z * fwdFlat.z;
        const vl = vel.x * lx + vel.z * lz;
        const sp = Math.hypot(vf, vl);
        if (sp > 0.05) {
          const grip = (this.drifting ? TUNE.driftGrip : TUNE.grip) * (this.slick ? TUNE.slickGrip : 1);
          const nl = vl * Math.max(0, 1 - grip * dt);
          const scrub = (this.drifting ? TUNE.driftDrag : TUNE.turnDrag) * Math.min(1, Math.abs(vl) / sp) * dt;
          const keep = Math.max(0, sp - scrub);
          const nf = (vf < 0 ? -1 : 1) * Math.sqrt(Math.max(0, keep * keep - nl * nl));
          b.applyImpulse({ x: m * ((nf - vf) * fwdFlat.x + (nl - vl) * lx), y: 0, z: m * ((nf - vf) * fwdFlat.z + (nl - vl) * lz) }, true);
        }
      } else {
        if (this.drifting) this.endDrift(m, false);
        // In the air: spin freely, and keep the cart roughly level so jumps are landable.
        const spin = -ctl.steer * TUNE.airYawTorque - av.y * TUNE.airYawDamping;
        // Flips: hold back for a backflip; let go of push and press it again in the air for a frontflip.
        const pitchRate = -(av.x * side.x + av.y * side.y + av.z * side.z);
        let flip = 0;
        if (this.state === 'riding' && this.grounded === 0) {
          if (ctl.back > 0.3) flip = 1;
          else if (this.flipArmed && ctl.push) flip = -1;
          if (!ctl.push) this.flipArmed = true;
        }
        if (flip !== 0) {
          const kick = -PITCH_INERTIA * (flip * TUNE.flipRate - pitchRate) * Math.min(1, 10 * dt);
          b.applyTorqueImpulse({ x: side.x * kick, y: side.y * kick + spin * dt, z: side.z * kick }, true);
        } else {
          // Hands off: finish the rotation you started, or settle level if you barely began.
          const angle = Math.atan2(fwd.y, up.y);
          const want = Math.abs(angle) > 1 && Math.abs(pitchRate) > 2
            ? Math.sign(pitchRate) * TUNE.flipRate
            : Math.max(-TUNE.flipRate, Math.min(TUNE.flipRate, -7 * angle));
          const settle = -PITCH_INERTIA * (want - pitchRate) * Math.min(1, 10 * dt);
          // Roll is levelled separately, about the cart's own nose.
          const rollRate = av.x * fwd.x + av.y * fwd.y + av.z * fwd.z;
          const roll = (-side.y * TUNE.airLevel - rollRate * 14) * dt;
          b.applyTorqueImpulse(
            { x: side.x * settle + fwd.x * roll, y: side.y * settle + fwd.y * roll + spin * dt, z: side.z * settle + fwd.z * roll },
            true,
          );
        }
        this.airYaw += av.y * dt;
        this.airPitch += pitchRate * dt;
        // Snappier jumps: fall faster than you rise, and a tapped hop is a short hop.
        if (this.grounded === 0) {
          const extra = vel.y < 0 ? TUNE.fallGravity : this.hopping && !ctl.jumpHeld ? TUNE.hopCutGravity : 0;
          b.applyImpulse({ x: 0, y: -m * extra * dt, z: 0 }, true);
        }
      }
    } else if (this.drifting) {
      this.endDrift(m, false);
    }

    // Catch your breath (slowly) whenever you are not sprinting.
    if (!this.sprinting) this.stamina = Math.min(TUNE.staminaMax, this.stamina + TUNE.staminaRegen * dt);

    // Remember the speed after our own pushes and boosts, so only real impacts read as a slam.
    const after = b.linvel();
    this.prevVel.set(after.x, after.y, after.z);
    this.vehicle.updateVehicle(dt, undefined, WHEEL_RAY_GROUPS);
  }

  /** Detect landings, tricks and bails. Call after `world.step()`. */
  postStep(): void {
    const dt = FIXED_DT;
    this.readPose();
    if (this.grind) return;

    let touchingKerb = false;
    for (let i = 0; i < 4; i++) {
      const ground = this.vehicle.wheelGroundObject(i);
      if (this.vehicle.wheelIsInContact(i) && ground && this.kerbs.has(ground.handle)) touchingKerb = true;
    }
    const frontUp = !this.vehicle.wheelIsInContact(0) && !this.vehicle.wheelIsInContact(1);
    const rearDown = this.vehicle.wheelIsInContact(2) || this.vehicle.wheelIsInContact(3);

    // Airtime and landings.
    if (this.grounded === 0) {
      if (this.airTime === 0) this.tookOffFromKerb = this.onKerb;
      this.airTime += dt;
    } else {
      if (this.airTime > 0.3) {
        this.events.push({ type: 'land', strength: Math.min(1, this.airTime / 0.9) });
        if (this.state === 'riding' && up.y > 0.8) {
          const flips = Math.round(Math.abs(this.airPitch) / (Math.PI * 2));
          if (flips >= 1) {
            const kind = this.airPitch > 0 ? 'BACKFLIP' : 'FRONTFLIP';
            const count = ['', '', 'DOUBLE ', 'TRIPLE '][flips] ?? `${flips}x `;
            this.events.push({ type: 'trick', label: count + kind, points: 400 * flips * (flips + 1) });
          }
          const halfTurns = Math.round(Math.abs(this.airYaw) / Math.PI);
          if (halfTurns >= 1) {
            this.events.push({ type: 'trick', label: `${halfTurns * 180} SPIN`, points: 150 * halfTurns * (halfTurns + 1) });
          }
          if (touchingKerb !== this.tookOffFromKerb) {
            this.events.push({ type: 'trick', label: 'KERB HOP', points: 250 });
          } else {
            this.events.push({ type: 'trick', label: 'AIR', points: Math.round(this.airTime * 15) * 10 });
          }
        }
      }
      if (this.airTime > 0) this.hopping = false;
      this.airTime = 0;
      this.airYaw = 0;
      this.airPitch = 0;
      this.groundY = this.body.translation().y - 0.27;
      this.onKerb = touchingKerb;
    }

    // Wheelie: front wheels up, rear wheels down. Points bank when the nose comes back down.
    if (this.state === 'riding' && frontUp && rearDown && this.pitch > 0.12 && this.wheelieTarget > 0) {
      // The higher the nose, the faster the points build.
      this.wheelieTime += dt;
      this.wheeliePoints += dt * (40 + 150 * this.pitch);
      this.pendingPoints = Math.round(this.wheeliePoints / 10) * 10;
      this.pendingLabel = 'WHEELIE';
    } else if (this.wheelieTime > 0 && (this.grounded === 0 || !frontUp)) {
      if (this.state === 'riding' && this.wheelieTime > 0.4 && !frontUp) {
        this.events.push({ type: 'trick', label: 'WHEELIE', points: this.pendingPoints });
      }
      if (!frontUp) {
        this.wheelieTime = 0;
        this.wheeliePoints = 0;
        this.pendingPoints = 0;
      }
    }

    if (this.state === 'riding') {
      // Rolled to a stop: step off.
      this.stillTime = this.speed < 0.5 && this.grounded >= 2 ? this.stillTime + dt : 0;
      if (this.stillTime > 0.5) {
        this.state = 'pushing';
        this.events.push({ type: 'hopOff' });
      }
    }

    // Bails: tipped over, went over backwards, or slammed into something.
    if (this.state === 'crashed') {
      this.autoRecover();
    } else {
      const lost = Math.hypot(this.prevVel.x - vel.x, this.prevVel.z - vel.z);
      // Upside down only counts once you are back near the ground, so flips are allowed.
      let tipped = false;
      if (up.y < TUNE.tipCrashUp) {
        const t = this.body.translation();
        const floor = groundBelow(this.world, t.x, t.y + 0.5, t.z, 3);
        tipped = this.grounded > 0 || (floor !== null && t.y - floor < 0.75);
      }
      const looped = this.state === 'riding' && this.grounded >= 1 && this.pitch > 1.15;
      if (tipped || looped || lost > TUNE.slamCrashDv) {
        this.state = 'crashed';
        this.crashTimer = 0;
        this.clearTrick();
        this.events.push({ type: 'crash', velocity: this.prevVel.clone() });
      }
    }
  }

  /**
   * Drift: hold a hard turn at speed and the back steps out. The longer you hold the slide
   * the more it scores, and letting go fires you out of the corner with a boost.
   */
  private updateDrift(ctl: Controls, m: number): void {
    const dt = FIXED_DT;
    const hard = this.state === 'riding' && Math.abs(this.lean) > 0.85 && Math.abs(ctl.steer) > 0.5 && this.speed > TUNE.driftMinSpeed;
    if (!this.drifting) {
      this.driftCharge = hard ? this.driftCharge + dt : 0;
      if (this.driftCharge > TUNE.driftDelay) {
        this.drifting = true;
        this.driftDir = Math.sign(this.lean);
        this.driftTime = 0;
        this.driftPoints = 0;
      }
      return;
    }
    this.driftTime += dt;
    this.driftPoints += dt * this.speed * 9;
    if (this.wheelieTime === 0) {
      this.pendingPoints = Math.round(this.driftPoints / 10) * 10;
      this.pendingLabel = 'DRIFT';
    }
    const released = Math.abs(ctl.steer) < 0.3 || ctl.steer * this.driftDir < 0;
    if (released || this.speed < TUNE.driftMinSpeed * 0.6 || this.state !== 'riding') this.endDrift(m, released);
  }

  private endDrift(m: number, clean: boolean): void {
    const points = Math.round(this.driftPoints / 10) * 10;
    if (clean && this.driftTime > 0.5) {
      const strength = Math.min(1, this.driftTime / 2);
      const kick = TUNE.driftBoostMin + (TUNE.driftBoostMax - TUNE.driftBoostMin) * strength;
      this.body.applyImpulse({ x: fwdFlat.x * m * kick, y: 0, z: fwdFlat.z * m * kick }, true);
      this.events.push({ type: 'boost', strength });
      if (points > 0) this.events.push({ type: 'trick', label: 'DRIFT', points });
    }
    this.drifting = false;
    this.driftCharge = 0;
    this.driftTime = 0;
    this.driftPoints = 0;
    if (this.wheelieTime === 0) this.pendingPoints = 0;
  }

  /** After a bail, get back up on your own once the dust settles. */
  private autoRecover(): void {
    this.crashTimer += FIXED_DT;
    if (this.crashTimer >= TUNE.recoverTime) this.reset();
  }

  /** Stand the cart back up where it stopped (or at the spawn point if it left the lot). */
  reset(): void {
    const t = this.body.translation();
    // Step back from the perimeter so you are not stood up inside a wall.
    const x = Math.max(-this.bounds.x + 3, Math.min(this.bounds.x - 3, t.x));
    const z = Math.max(-(this.bounds.north ?? this.bounds.z) + 3, Math.min(this.bounds.z - 3, t.z));
    const floor = groundBelow(this.world, x, t.y + 1.5, z, 8);
    if (floor !== null && this.state === 'crashed') {
      // If that would leave you nose-first against a wall, face the other way.
      let yaw = this.lastYaw;
      const ahead = new RAPIER.Ray({ x, y: floor + 0.7, z }, { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) });
      if (this.world.castRay(ahead, 7, true, RAPIER.QueryFilterFlags.ONLY_FIXED)) yaw += Math.PI;
      this.placeAt(x, floor, z, yaw);
    }
    else this.placeAt(this.spawnPose.x, 0, this.spawnPose.z, this.spawnPose.yaw);
  }

  /** The player lets go: the cart rolls on by itself with whoever is in the basket. */
  release(): void {
    if (this.drifting) this.endDrift(this.body.mass(), false);
    this.occupied = false;
    this.grind = null;
    if (this.state !== 'crashed') this.state = 'loose';
    this.wheelieTarget = 0;
    this.pendingPoints = 0;
  }

  /** The player takes hold of this cart. */
  grab(): void {
    this.occupied = true;
    if (this.state !== 'crashed') this.state = 'pushing';
  }

  /** Lock onto a rail if the cart is dropping onto one with enough speed along it. */
  private tryGrind(): void {
    this.grindCooldown -= FIXED_DT;
    if (this.state !== 'riding' || this.grounded !== 0 || vel.y > 1 || this.grindCooldown > 0) return;
    const p = this.body.translation();
    for (const rail of this.rails) {
      const dx = rail.b.x - rail.a.x, dy = rail.b.y - rail.a.y, dz = rail.b.z - rail.a.z;
      const len = Math.hypot(dx, dy, dz);
      const ux = dx / len, uy = dy / len, uz = dz / len;
      const t = (p.x - rail.a.x) * ux + (p.y - rail.a.y) * uy + (p.z - rail.a.z) * uz;
      if (t < 0 || t > len) continue;
      const cx = rail.a.x + ux * t, cy = rail.a.y + uy * t, cz = rail.a.z + uz * t;
      const above = p.y - cy;
      if (Math.hypot(p.x - cx, p.z - cz) > 0.7 || above < -0.1 || above > 0.8) continue;
      const v = vel.x * ux + vel.y * uy + vel.z * uz;
      if (Math.abs(v) < TUNE.grindMinSpeed) continue;
      this.grind = { rail, t, v, time: 0, yaw: Math.atan2(fwd.x, fwd.z), points: 0 };
      if (this.drifting) this.endDrift(this.body.mass(), false);
      return;
    }
  }

  /** Slide along the rail. Steer to spin on it, jump to hop off. */
  private grindStep(ctl: Controls): void {
    const dt = FIXED_DT;
    const g = this.grind!;
    const b = this.body;
    const rail = g.rail;
    const dx = rail.b.x - rail.a.x, dy = rail.b.y - rail.a.y, dz = rail.b.z - rail.a.z;
    const len = Math.hypot(dx, dy, dz);
    const ux = dx / len, uy = dy / len, uz = dz / len;

    this.lean += (ctl.steer - this.lean) * Math.min(1, 9 * dt);
    g.v -= Math.sign(g.v) * TUNE.grindFriction * dt;
    g.t += g.v * dt;
    g.time += dt;
    g.yaw -= this.lean * 5 * dt;
    g.points += dt * Math.abs(g.v) * 12;
    this.pendingPoints = Math.round(g.points / 10) * 10;
    this.pendingLabel = 'GRIND';

    const off = g.t < 0 || g.t > len || Math.abs(g.v) < 1.5;
    const hop = ctl.jump || this.jumpBuffer > 0;
    const t = Math.max(0, Math.min(len, g.t));
    b.setTranslation({ x: rail.a.x + ux * t, y: rail.a.y + uy * t + RAIL_SEAT, z: rail.a.z + uz * t }, true);
    q.setFromAxisAngle(tmp.set(0, 1, 0), g.yaw);
    b.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    b.setAngvel({ x: 0, y: -this.lean * 5, z: 0 }, true);
    b.setLinvel({ x: ux * g.v, y: uy * g.v + (hop ? TUNE.hopSpeed : 0), z: uz * g.v }, true);
    this.prevVel.set(ux * g.v, uy * g.v, uz * g.v);

    if (off || hop) {
      if (g.time > 0.3) this.events.push({ type: 'trick', label: 'GRIND', points: this.pendingPoints });
      this.grind = null;
      this.grindCooldown = 0.35;
      this.jumpBuffer = 0;
      this.hopping = hop;
      this.pendingPoints = 0;
    }
    this.vehicle.updateVehicle(dt, undefined, WHEEL_RAY_GROUPS);
  }

  addStamina(cigarettes: number): void {
    this.stamina = Math.min(TUNE.staminaMax, this.stamina + cigarettes);
  }

  /** Put the cart upright and at rest at a point on the ground, ready to push. */
  placeAt(x: number, groundY: number, z: number, yaw: number): void {
    q.setFromAxisAngle(tmp.set(0, 1, 0), yaw);
    this.body.setTranslation({ x, y: groundY + 0.5, z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.state = this.occupied ? 'pushing' : 'loose';
    this.grind = null;
    this.airTime = 0;
    this.groundY = groundY;
    this.lastYaw = yaw;
    this.clearTrick();
    this.prevVel.set(0, 0, 0);
  }

  private clearTrick(): void {
    this.airPitch = 0;
    this.drifting = false;
    this.driftCharge = 0;
    this.driftTime = 0;
    this.driftPoints = 0;
    this.airYaw = 0;
    this.wheelieTime = 0;
    this.wheeliePoints = 0;
    this.wheelieTarget = 0;
    this.pendingPoints = 0;
  }

  /** Copy the physics pose onto the meshes. Call once per rendered frame. */
  syncMesh(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.group.position.set(t.x, t.y, t.z);
    this.group.quaternion.set(r.x, r.y, r.z, r.w);
    // Lean the model into corners (the physics body stays flat). Sells the weight of the turn.
    const tilt = this.lean * Math.min(1, this.speed / 10) * (this.drifting ? 0.22 : 0.12);
    this.visualRoll += (tilt - this.visualRoll) * 0.25;
    this.group.quaternion.multiply(q.setFromAxisAngle(tmp.set(0, 0, 1), this.visualRoll));
    for (let i = 0; i < 4; i++) {
      const len = this.vehicle.wheelSuspensionLength(i) ?? SUSPENSION_REST;
      const wheel = this.wheelMeshes[i];
      wheel.position.y = WHEELS[i][1] - len;
      wheel.rotation.x = this.vehicle.wheelRotation(i) ?? 0;
    }
  }

  private readPose(): void {
    const r = this.body.rotation();
    q.set(r.x, r.y, r.z, r.w);
    fwd.set(0, 0, 1).applyQuaternion(q);
    up.set(0, 1, 0).applyQuaternion(q);
    side.set(1, 0, 0).applyQuaternion(q);
    const lv = this.body.linvel();
    vel.set(lv.x, lv.y, lv.z);
    this.speed = Math.hypot(vel.x, vel.z);
    const flatLen = Math.hypot(fwd.x, fwd.z) || 1;
    this.fwdSpeed = (vel.x * fwd.x + vel.z * fwd.z) / flatLen;
    this.pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
    // Remember the heading while upright, so a reset faces the way you were going.
    if (this.state !== 'crashed' && up.y > 0.7) this.lastYaw = Math.atan2(fwd.x, fwd.z);
    this.slip = this.speed > 1.5 ? Math.atan2(fwd.z * vel.x - fwd.x * vel.z, fwd.x * vel.x + fwd.z * vel.z) : 0;
    let n = 0;
    for (let i = 0; i < 4; i++) if (this.vehicle.wheelIsInContact(i)) n++;
    this.grounded = n;
  }
}
