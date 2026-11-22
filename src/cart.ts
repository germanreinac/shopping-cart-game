import * as THREE from 'three';
import { RAPIER, FIXED_DT, CART_GROUPS, WHEEL_RAY_GROUPS, groundBelow } from './physics';
import type { Controls } from './input';

export type CartState = 'pushing' | 'riding' | 'crashed';

export type CartEvent =
  | { type: 'hopOn' }
  | { type: 'hopOff' }
  | { type: 'tooSlow' }
  | { type: 'kick' }
  | { type: 'land'; strength: number }
  | { type: 'trick'; label: string; points: number }
  | { type: 'crash'; velocity: THREE.Vector3 };

// ---- Tuning. All SI units (metres, seconds, kilograms). ----
export const TUNE = {
  mass: 60, // cart + rider, kept constant so the suspension behaves the same in every state
  pushAccel: 5.5, // m/s² while running behind the cart
  jogSpeed: 9, // top speed on foot with no cigarettes left
  sprintSpeed: 15.5, // top speed while burning cigarettes
  sprintDrain: 0.4, // cigarettes per second while sprinting
  staminaMax: 5,
  staminaRegen: 0.1, // cigarettes per second when not sprinting
  kickBoost: 1.6, // m/s per kick-push while riding
  kickCost: 0.34, // cigarettes per kick
  kickCooldown: 0.5,
  kickMaxSpeed: 14.5,
  pushBrake: 6.0, // pulling back on the handle while on foot
  pushCoast: 1.6, // jogging to a stop when you let go of push
  rideDrag: 0.4, // rolling resistance while riding (m/s²)
  rideDragQuad: 0.005, // extra drag that grows with speed²
  pushYawTorque: 140, // steering by the handle
  rideYawTorque: 120, // steering by leaning: weaker, so it drifts
  yawDamping: 48,
  airYawTorque: 150, // spinning in the air
  airYawDamping: 18,
  airLevel: 60, // how hard the rider keeps the cart level in the air
  driftCatch: 260, // counter-torque that stops a drift becoming a spin-out
  driftCatchAngle: 0.75, // rad of slip before the catch kicks in
  rearGrip: 0.62,
  wheelieRaiseRate: 0.75, // rad/s the nose climbs while you hold back
  wheelieDropRate: 1.6, // rad/s it comes down when you let go
  wheelieBailPitch: 1.0, // rad: past this you go over backwards
  hopSpeed: 3.7, // vertical take-off speed of a kerb hop
  minHopOnSpeed: 1.2,
  remountSpeed: 2.5, // below this you step off and push again
  tipCrashUp: 0.45, // cart "up" · world up below this = tipped over
  kerbTripSpeed: 4.5, // riding into a kerb faster than this without hopping = bail
  slamCrashDv: 4.5, // horizontal speed lost in one step = hit something solid
};

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
  const steel = new THREE.MeshStandardMaterial({ color: 0xc4ccd4, metalness: 0.35, roughness: 0.35 });
  const plastic = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.9 });

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
    const mat = new THREE.MeshStandardMaterial({
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
  /** Smoothed steer input, for the rider's lean animation. */
  lean = 0;
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
  private kickTimer = 0;
  private airYaw = 0;
  private driftTime = 0;
  private driftPoints = 0;
  private driftGrace = 0;
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
    private bounds: { x: number; z: number },
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
      const isFront = i < 2;
      v.setWheelFrictionSlip(i, isFront ? 0.12 : TUNE.rearGrip);
      v.setWheelSideFrictionStiffness(i, 1);
    });

    const mesh = buildCartMesh();
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

    if (ctl.reset) {
      this.reset();
      return;
    }

    const onWheels = this.grounded >= 2;
    this.sprinting = false;
    const flatLen = Math.hypot(fwd.x, fwd.z);
    fwdFlat.set(fwd.x, 0, fwd.z).multiplyScalar(flatLen > 1e-4 ? 1 / flatLen : 0);

    if (this.state === 'pushing') {
      if (ctl.jump) {
        if (this.fwdSpeed >= TUNE.minHopOnSpeed && onWheels) {
          this.state = 'riding';
          this.stillTime = 0;
          this.events.push({ type: 'hopOn' });
        } else {
          this.events.push({ type: 'tooSlow' });
        }
      } else if (onWheels) {
        let accel = 0;
        if (ctl.back > 0.1) {
          // Dig your heels in; once stopped, drag the cart backwards slowly.
          accel = this.fwdSpeed > -1.5 ? -TUNE.pushBrake * ctl.back : 0;
        } else if (ctl.push) {
          // Past a jog you are sprinting, which burns cigarettes.
          const top = this.stamina > 0 ? TUNE.sprintSpeed : TUNE.jogSpeed;
          accel = TUNE.pushAccel * Math.max(-0.2, Math.min(1, (top - this.fwdSpeed) / 3));
          if (this.fwdSpeed > TUNE.jogSpeed - 0.5 && this.stamina > 0) {
            this.sprinting = true;
            this.stamina = Math.max(0, this.stamina - TUNE.sprintDrain * dt);
          }
        } else if (Math.abs(this.fwdSpeed) > 0.05) {
          accel = -Math.sign(this.fwdSpeed) * Math.min(TUNE.pushCoast, Math.abs(this.fwdSpeed) / dt);
        }
        b.applyImpulse(tmp.copy(fwdFlat).multiplyScalar(m * accel * dt), true);
      }
    } else if (this.state === 'riding') {
      if (ctl.push && this.speed < TUNE.remountSpeed && onWheels) {
        this.state = 'pushing';
        this.events.push({ type: 'hopOff' });
      } else if (
        ctl.push && onWheels && this.kickTimer <= 0 && this.stamina >= TUNE.kickCost &&
        this.fwdSpeed > 0 && this.fwdSpeed < TUNE.kickMaxSpeed
      ) {
        // Kick-push: one foot down to keep the speed up. Costs a bit of a cigarette.
        this.kickTimer = TUNE.kickCooldown;
        this.stamina -= TUNE.kickCost;
        b.applyImpulse(tmp.copy(fwdFlat).multiplyScalar(m * TUNE.kickBoost), true);
        this.events.push({ type: 'kick' });
      }
      if (ctl.jump && onWheels) {
        b.applyImpulse({ x: 0, y: m * TUNE.hopSpeed, z: 0 }, true);
      }
      // Wheelie: holding back raises the nose steadily, letting go drops it.
      // Hold it too long and you go over backwards.
      if (ctl.back > 0.1 && this.grounded >= 1) {
        this.wheelieTarget = Math.min(1.2, Math.max(this.wheelieTarget, this.pitch, 0.1) + TUNE.wheelieRaiseRate * ctl.back * dt);
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

    // Steering: twist the cart. Rear wheels grip, front casters follow.
    if (this.state !== 'crashed') {
      const av = b.angvel();
      if (this.grounded >= 1) {
        const authority = this.state === 'pushing' ? TUNE.pushYawTorque : TUNE.rideYawTorque;
        let torque = -ctl.steer * authority - av.y * TUNE.yawDamping;
        // Drift catch: past a certain slip angle, pull the nose back toward the direction of travel.
        const over = Math.abs(this.slip) - TUNE.driftCatchAngle;
        if (over > 0 && Math.abs(this.slip) < 2.2 && this.speed > 4) torque += Math.sign(this.slip) * over * TUNE.driftCatch;
        b.applyTorqueImpulse({ x: 0, y: torque * dt, z: 0 }, true);
      } else {
        // In the air: spin freely, and keep the cart roughly level so jumps are landable.
        const spin = -ctl.steer * TUNE.airYawTorque - av.y * TUNE.airYawDamping;
        tmp.set(-up.z, 0, up.x).multiplyScalar(TUNE.airLevel); // up × worldUp
        b.applyTorqueImpulse(
          { x: (tmp.x - av.x * 14) * dt, y: spin * dt, z: (tmp.z - av.z * 14) * dt },
          true,
        );
        this.airYaw += av.y * dt;
      }
      this.lean += (ctl.steer - this.lean) * Math.min(1, dt * 8);
    }

    // Catch your breath (slowly) whenever you are not sprinting.
    this.kickTimer -= dt;
    if (!this.sprinting) this.stamina = Math.min(TUNE.staminaMax, this.stamina + TUNE.staminaRegen * dt);

    this.prevVel.copy(vel);
    this.vehicle.updateVehicle(dt, undefined, WHEEL_RAY_GROUPS);
  }

  /** Detect landings, tricks and bails. Call after `world.step()`. */
  postStep(): void {
    const dt = FIXED_DT;
    this.readPose();

    let touchingKerb = false;
    for (let i = 0; i < 4; i++) {
      const ground = this.vehicle.wheelGroundObject(i);
      if (this.vehicle.wheelIsInContact(i) && ground && this.kerbs.has(ground.handle)) touchingKerb = true;
    }
    const frontUp = !this.vehicle.wheelIsInContact(0) && !this.vehicle.wheelIsInContact(1);
    const rearDown = this.vehicle.wheelIsInContact(2) || this.vehicle.wheelIsInContact(3);

    // Riding straight into a kerb at speed without hopping it trips the cart.
    const tripped =
      this.state === 'riding' && touchingKerb && !this.onKerb && this.airTime === 0 && this.speed > TUNE.kerbTripSpeed;

    // Airtime and landings.
    if (this.grounded === 0) {
      if (this.airTime === 0) this.tookOffFromKerb = this.onKerb;
      this.airTime += dt;
    } else {
      if (this.airTime > 0.3) {
        this.events.push({ type: 'land', strength: Math.min(1, this.airTime / 0.9) });
        if (this.state === 'riding' && up.y > 0.8) {
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
      this.airTime = 0;
      this.airYaw = 0;
      this.groundY = this.body.translation().y - 0.27;
      this.onKerb = touchingKerb;
    }

    // Wheelie: front wheels up, rear wheels down. Points bank when the nose comes back down.
    if (this.state === 'riding' && frontUp && rearDown && this.pitch > 0.12 && this.wheelieTarget > 0) {
      // The higher the nose, the faster the points build.
      this.wheelieTime += dt;
      this.wheeliePoints += dt * (60 + 320 * this.pitch);
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

    // Drift: sliding sideways at speed. Points bank when you straighten out.
    const sliding = this.state === 'riding' && this.grounded >= 3 && this.speed > 5.5 && Math.abs(this.slip) > 0.3 && Math.abs(this.slip) < 1.7;
    if (sliding) {
      this.driftTime += dt;
      this.driftGrace = 0.3;
      this.driftPoints += dt * this.speed * Math.abs(this.slip) * 14;
      if (this.wheelieTime === 0) {
        this.pendingPoints = Math.round(this.driftPoints / 10) * 10;
        this.pendingLabel = 'DRIFT';
      }
    } else if (this.driftTime > 0) {
      this.driftGrace -= dt;
      if (this.driftGrace <= 0) {
        const points = Math.round(this.driftPoints / 10) * 10;
        if (this.state === 'riding' && this.driftTime > 0.5 && points > 0) this.events.push({ type: 'trick', label: 'DRIFT', points });
        this.driftTime = 0;
        this.driftPoints = 0;
        if (this.wheelieTime === 0) this.pendingPoints = 0;
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
    if (this.state !== 'crashed') {
      const lost = Math.hypot(this.prevVel.x - vel.x, this.prevVel.z - vel.z);
      const tipped = up.y < TUNE.tipCrashUp;
      const looped = this.state === 'riding' && this.pitch > TUNE.wheelieBailPitch;
      if (tipped || looped || tripped || lost > TUNE.slamCrashDv) {
        if (tripped) {
          // Front wheels stop dead, the back end keeps coming.
          this.body.applyImpulse({ x: -vel.x * 20, y: 90, z: -vel.z * 20 }, true);
          this.body.applyTorqueImpulse(tmp.copy(side).multiplyScalar(45), true);
        }
        this.state = 'crashed';
        this.clearTrick();
        this.events.push({ type: 'crash', velocity: this.prevVel.clone() });
      }
    }
  }

  /** Stand the cart back up where it stopped (or at the spawn point if it left the lot). */
  reset(): void {
    const t = this.body.translation();
    // Step back from the perimeter so you are not stood up inside a wall.
    const x = Math.max(-this.bounds.x + 3, Math.min(this.bounds.x - 3, t.x));
    const z = Math.max(-this.bounds.z + 3, Math.min(this.bounds.z - 3, t.z));
    const floor = groundBelow(this.world, x, t.y + 1.5, z, 8);
    if (floor !== null && this.state === 'crashed') this.placeAt(x, floor, z, this.lastYaw);
    else this.placeAt(this.spawnPose.x, 0, this.spawnPose.z, this.spawnPose.yaw);
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
    this.state = 'pushing';
    this.airTime = 0;
    this.groundY = groundY;
    this.lastYaw = yaw;
    this.clearTrick();
    this.prevVel.set(0, 0, 0);
  }

  private clearTrick(): void {
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
