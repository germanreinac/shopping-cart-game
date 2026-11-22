import * as THREE from 'three';
import { RAPIER, FIXED_DT } from './physics';
import type { Controls } from './input';
import type { Cart } from './cart';
import { Person } from './person';

const RUN_SPEED = 8.5;
const TURN_RATE = 3.4;
const GRAB_REACH = 1.5;
const REGRAB_DELAY = 0.9;

export type PlayerEvent = { type: 'letGo'; cart: Cart } | { type: 'grab'; cart: Cart };

/**
 * You. Usually holding a cart, but you can let go (the cart rolls on with whoever is in
 * the basket), run around on foot, and grab any loose cart you reach.
 */
export class Player {
  /** The cart in hand, or null while on foot. */
  cart: Cart | null;
  /** The cart most recently held. */
  lastCart: Cart;
  readonly person: Person;
  readonly position = new THREE.Vector3();
  yaw = 0;
  /** Running speed while on foot. */
  footSpeed = 0;
  events: PlayerEvent[] = [];

  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;
  private vy = 0;
  private lean = 0;
  private regrab = 0;
  private stamina = 0;

  constructor(private scene: THREE.Scene, world: RAPIER.World, private carts: Cart[], first: Cart) {
    this.person = new Person(scene, world, { top: 0x7a7a45, legs: 0xd9a521, skin: 0xe9a77c, hat: 0x6b2d4a, headwear: 'helmet', bareArms: true, pads: true, shoes: 0x8a3340 });
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -50, 0));
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.5, 0.3).setTranslation(0, 0.8, 0), this.body);
    this.controller = world.createCharacterController(0.04);
    this.controller.enableAutostep(0.35, 0.2, false);
    this.controller.enableSnapToGround(0.4);
    this.controller.setMaxSlopeClimbAngle(Math.PI / 3);
    this.cart = this.lastCart = first;
    this.stamina = first.stamina;
    this.hold(first);
  }

  get onFoot(): boolean {
    return this.cart === null;
  }

  get speed(): number {
    return this.cart ? this.cart.speed : Math.abs(this.footSpeed);
  }

  /** Cigarettes left, wherever they are being carried. */
  get cigarettes(): number {
    return this.cart ? this.cart.stamina : this.stamina;
  }

  addCigarettes(n: number): void {
    if (this.cart) this.cart.addStamina(n);
    else this.stamina += n;
  }

  /** Put the player back on a cart at a given spot (race starts). */
  placeAt(x: number, y: number, z: number, yaw: number): void {
    const cart = this.cart ?? this.lastCart;
    if (!this.cart) this.hold(cart);
    cart.placeAt(x, y, z, yaw);
  }

  /** One physics step. Call before `world.step()`. */
  step(ctl: Controls): void {
    const dt = FIXED_DT;
    this.regrab -= dt;

    if (this.cart) {
      const t = this.cart.body.translation();
      this.position.set(t.x, t.y, t.z);
      if (ctl.letGo && this.cart.state !== 'crashed') this.letGo();
      return;
    }

    // On foot.
    this.lean += (ctl.steer - this.lean) * Math.min(1, dt * 10);
    this.yaw -= this.lean * TURN_RATE * dt;
    const target = ctl.back > 0.1 ? -2 : ctl.push ? RUN_SPEED : 0;
    this.footSpeed += Math.max(-30 * dt, Math.min(22 * dt, target - this.footSpeed));
    this.vy -= 25 * dt;
    this.controller.computeColliderMovement(this.collider, {
      x: Math.sin(this.yaw) * this.footSpeed * dt,
      y: this.vy * dt,
      z: Math.cos(this.yaw) * this.footSpeed * dt,
    });
    const move = this.controller.computedMovement();
    if (this.controller.computedGrounded()) this.vy = 0;
    this.position.x += move.x;
    this.position.y += move.y;
    this.position.z += move.z;
    if (this.position.y < -30) {
      // Fell out of the world somehow: back to the last cart.
      const t = this.lastCart.body.translation();
      this.position.set(t.x, t.y + 1, t.z);
      this.vy = 0;
    }
    this.body.setNextKinematicTranslation(this.position);

    // Grab the first loose, upright cart within reach of its handle.
    for (const cart of this.carts) {
      if (cart.state !== 'loose' || (cart === this.lastCart && this.regrab > 0)) continue;
      const t = cart.body.translation();
      const r = cart.body.rotation();
      if (1 - 2 * (r.x * r.x + r.z * r.z) < 0.7) continue;
      const yaw = Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x));
      const hx = t.x - Math.sin(yaw) * 0.6, hz = t.z - Math.cos(yaw) * 0.6;
      if (Math.hypot(hx - this.position.x, hz - this.position.z) < GRAB_REACH && Math.abs(t.y - this.position.y) < 1.2) {
        this.hold(cart);
        this.events.push({ type: 'grab', cart });
        break;
      }
    }
  }

  update(dt: number, time: number): void {
    const p = this.person;
    if (this.cart) {
      p.pose = this.cart.state === 'riding' ? 'ride' : 'push';
      p.speed = this.cart.fwdSpeed;
      p.lean = this.cart.lean;
      p.pitch = this.cart.pitch;
    } else {
      p.pose = 'run';
      p.speed = this.footSpeed;
      p.lean = this.lean;
      p.root.position.copy(this.position);
      p.root.rotation.set(0, this.yaw, 0);
    }
    p.update(dt, time);
  }

  private letGo(): void {
    const cart = this.cart!;
    const t = cart.body.translation();
    const r = cart.body.rotation();
    this.yaw = Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x));
    // Step off behind the cart and give it a parting shove.
    this.position.set(t.x - Math.sin(this.yaw) * 1.0, cart.groundY, t.z - Math.cos(this.yaw) * 1.0);
    this.footSpeed = Math.max(0, Math.min(RUN_SPEED, cart.fwdSpeed));
    this.vy = 0;
    this.lean = 0;
    this.stamina = cart.stamina;
    const m = cart.body.mass();
    cart.body.applyImpulse({ x: Math.sin(this.yaw) * m * 2.5, y: 0, z: Math.cos(this.yaw) * m * 2.5 }, true);
    cart.release();

    this.scene.add(this.person.root);
    this.person.root.rotation.set(0, this.yaw, 0);
    this.body.setTranslation(this.position, true);
    this.collider.setEnabled(true);
    this.cart = null;
    this.lastCart = cart;
    this.regrab = REGRAB_DELAY;
    this.events.push({ type: 'letGo', cart });
  }

  private hold(cart: Cart): void {
    cart.stamina = this.stamina; // your cigarettes come with you
    this.cart = this.lastCart = cart;
    cart.grab();
    this.collider.setEnabled(false);
    this.footSpeed = 0;
    this.person.root.rotation.set(0, 0, 0);
    this.person.root.position.set(0, -0.26, -0.95);
    cart.group.add(this.person.root);
  }
}
