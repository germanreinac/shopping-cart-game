import * as THREE from 'three';
import { toon, outline } from './style';
import { RAPIER, RAGDOLL_GROUPS } from './physics';

export interface Palette {
  top: number;
  legs: number;
  skin: number;
  hat: number;
}

/** push: running behind a cart. ride: standing on its back. sit: in the basket. idle: hanging around. */
export type Pose = 'push' | 'ride' | 'sit' | 'idle';

interface RagdollPart {
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
}

// Where the feet go, in the cart's local space, for each cart pose.
const SEAT: Record<Exclude<Pose, 'idle'>, [number, number]> = {
  push: [-0.26, -0.95],
  ride: [-0.04, -0.47],
  sit: [-0.56, -0.14],
};

/**
 * A blocky teen. Posed and animated while attached to something; on a bail every body
 * part becomes a physics box joined at shoulders, hips and neck.
 */
export class Person {
  readonly root = new THREE.Group();
  pose: Pose = 'idle';
  /** Animation inputs, set by whoever owns this person. */
  speed = 0;
  lean = 0;
  pitch = 0;
  /** Set > 0 to play a throwing swing. */
  throwTime = 0;

  private torsoPivot = new THREE.Group();
  private torso: THREE.Mesh;
  private head: THREE.Mesh;
  private arms: THREE.Group[] = [];
  private legs: THREE.Group[] = [];
  private limbMeshes: THREE.Mesh[] = [];
  private ragdoll: RagdollPart[] | null = null;
  private stride = Math.random() * 6;
  private ember: THREE.Mesh | null = null;

  constructor(private scene: THREE.Scene, private world: RAPIER.World, palette: Palette, smoker = false) {
    const top = toon({ color: palette.top, roughness: 0.8 });
    const legMat = toon({ color: palette.legs, roughness: 0.85 });
    const skin = toon({ color: palette.skin, roughness: 0.7 });

    // Hips sit 0.8 m above the feet; the torso pivots there so it can lean.
    this.torsoPivot.position.y = 0.8;
    this.torso = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 0.2), top);
    this.torso.position.y = 0.25;
    this.head = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.24, 0.22), skin);
    this.head.position.y = 0.65;
    const hat = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.1, 0.24), toon({ color: palette.hat }));
    hat.position.y = 0.1;
    this.head.add(hat);
    this.torsoPivot.add(this.torso, this.head);

    for (const sx of [1, -1]) {
      const arm = new THREE.Group();
      arm.position.set(sx * 0.23, 0.46, 0);
      const armMesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.1), top);
      armMesh.position.y = -0.23;
      arm.add(armMesh);
      this.torsoPivot.add(arm);
      this.arms.push(arm);

      const leg = new THREE.Group();
      leg.position.set(sx * 0.1, 0.8, 0);
      const legMesh = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.8, 0.13), legMat);
      legMesh.position.y = -0.4;
      leg.add(legMesh);
      this.root.add(leg);
      this.legs.push(leg);
      this.limbMeshes.push(armMesh, legMesh);
    }
    if (smoker) {
      this.ember = new THREE.Mesh(
        new THREE.BoxGeometry(0.035, 0.035, 0.035),
        new THREE.MeshBasicMaterial({ color: 0xff7a2a }),
      );
      this.ember.position.set(0, -0.5, 0.05);
      this.arms[1].add(this.ember);
    }
    this.root.add(this.torsoPivot);
    outline(this.root);
  }

  get ragdolled(): boolean {
    return this.ragdoll !== null;
  }

  /** World position of the chest while ragdolled: the camera follows this during a bail. */
  focus(target: THREE.Vector3): boolean {
    if (!this.ragdoll) return false;
    const t = this.ragdoll[0].body.translation();
    target.set(t.x, t.y, t.z);
    return true;
  }

  update(dt: number, time: number): void {
    if (this.ragdoll) {
      for (const part of this.ragdoll) {
        const t = part.body.translation();
        const r = part.body.rotation();
        part.mesh.position.set(t.x, t.y, t.z);
        part.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      }
      return;
    }

    const k = Math.min(1, dt * 12);
    const lerp = (a: number, b: number) => a + (b - a) * k;
    let torsoLean = 0;
    let armL = 0;
    let armR = 0;
    let legL = 0;
    let legR = 0;
    let roll = 0;

    if (this.pose !== 'idle') {
      const [y, z] = SEAT[this.pose];
      this.root.position.y = lerp(this.root.position.y, y);
      this.root.position.z = lerp(this.root.position.z, z);
      this.root.position.x = lerp(this.root.position.x, 0);
    }

    if (this.pose === 'push') {
      const effort = Math.min(1, Math.abs(this.speed) / 8);
      torsoLean = 0.25 + effort * 0.4;
      armL = armR = -1.15 - torsoLean;
      this.stride += dt * (4 + Math.abs(this.speed) * 1.9) * Math.sign(this.speed || 1);
      legL = Math.sin(this.stride) * Math.min(1, Math.abs(this.speed) * 0.16);
      legR = -legL;
      roll = this.lean * 0.08;
    } else if (this.pose === 'ride') {
      // Counter the cart's pitch a little so a wheelie reads as leaning back.
      torsoLean = 0.25 - this.pitch * 0.5 + Math.min(0.25, Math.abs(this.speed) * 0.015);
      armL = armR = -0.9 - torsoLean;
      roll = this.lean * 0.3;
    } else if (this.pose === 'sit') {
      torsoLean = -0.12;
      legL = legR = -2.05;
      armL = armR = -0.5;
      roll = this.lean * 0.15;
    } else {
      // Idle: shift weight, and take a drag now and then.
      torsoLean = 0.05 + Math.sin(time * 0.7 + this.stride) * 0.03;
      const drag = Math.max(0, Math.sin(time * 0.5 + this.stride * 2) - 0.7) / 0.3;
      armR = -drag * 2.3;
      roll = Math.sin(time * 0.45 + this.stride) * 0.03;
    }

    if (this.throwTime > 0) {
      // Wind up behind the head, then whip forward.
      this.throwTime = Math.max(0, this.throwTime - dt);
      armR = -3.0 + (1 - this.throwTime / 0.35) * 2.4;
    }

    this.root.rotation.z = lerp(this.root.rotation.z, roll);
    this.torsoPivot.rotation.x = lerp(this.torsoPivot.rotation.x, torsoLean);
    this.arms[0].rotation.x = lerp(this.arms[0].rotation.x, armL);
    this.arms[1].rotation.x = this.throwTime > 0 ? armR : lerp(this.arms[1].rotation.x, armR);
    this.legs[0].rotation.x = lerp(this.legs[0].rotation.x, legL);
    this.legs[1].rotation.x = lerp(this.legs[1].rotation.x, legR);
  }

  /** Turn the posed model into a ragdoll flying at `velocity`. */
  bail(velocity: THREE.Vector3): void {
    if (this.ragdoll) return;
    this.root.updateWorldMatrix(true, true);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    const makePart = (home: THREE.Mesh, halfExtents: [number, number, number]): RagdollPart => {
      home.matrixWorld.decompose(pos, quat, scale);
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(pos.x, pos.y, pos.z)
          .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
          .setLinvel(velocity.x * 0.9, Math.max(velocity.y, 0) + 2.6, velocity.z * 0.9)
          .setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 6 })
          .setLinearDamping(0.15)
          .setAngularDamping(1.2)
          .setCcdEnabled(true),
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(...halfExtents)
          .setDensity(350)
          .setFriction(0.9)
          .setRestitution(0.1)
          .setCollisionGroups(RAGDOLL_GROUPS),
        body,
      );
      const mesh = new THREE.Mesh(home.geometry, home.material);
      for (const child of home.children) mesh.add(child.clone());
      this.scene.add(mesh);
      return { body, mesh };
    };

    const torso = makePart(this.torso, [0.17, 0.25, 0.1]);
    const head = makePart(this.head, [0.11, 0.12, 0.11]);
    const parts = [torso, head];
    const join = (part: RagdollPart, onTorso: [number, number, number], onPart: [number, number, number]) => {
      const joint = this.world.createImpulseJoint(
        RAPIER.JointData.spherical(
          { x: onTorso[0], y: onTorso[1], z: onTorso[2] },
          { x: onPart[0], y: onPart[1], z: onPart[2] },
        ),
        torso.body,
        part.body,
        true,
      );
      joint.setContactsEnabled(false);
    };
    join(head, [0, 0.27, 0], [0, -0.13, 0]);
    this.limbMeshes.forEach((limb, i) => {
      const isArm = i % 2 === 0;
      const sx = i < 2 ? 1 : -1;
      const part = makePart(limb, isArm ? [0.05, 0.25, 0.05] : [0.065, 0.4, 0.065]);
      if (isArm) join(part, [sx * 0.23, 0.21, 0], [0, 0.23, 0]);
      else join(part, [sx * 0.1, -0.25, 0], [0, 0.4, 0]);
      parts.push(part);
    });

    this.ragdoll = parts;
    this.root.visible = false;
  }

  /** Back on your feet. */
  recover(): void {
    if (!this.ragdoll) return;
    for (const part of this.ragdoll) {
      this.world.removeRigidBody(part.body);
      this.scene.remove(part.mesh);
    }
    this.ragdoll = null;
    this.root.visible = true;
  }
}
