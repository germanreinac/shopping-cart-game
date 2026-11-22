import * as THREE from 'three';
import { RAPIER, RAGDOLL_GROUPS } from './physics';
import type { Cart } from './cart';

interface RagdollPart {
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
  home: THREE.Object3D;
}

/**
 * The teen. While pushing or riding it is just a posed model parented to the cart;
 * on a bail every body part becomes a physics box joined at shoulders, hips and neck.
 */
export class Rider {
  private root = new THREE.Group();
  private torsoPivot = new THREE.Group();
  private torso: THREE.Mesh;
  private head: THREE.Mesh;
  private arms: THREE.Group[] = [];
  private legs: THREE.Group[] = [];
  private limbMeshes: THREE.Mesh[] = [];
  private ragdoll: RagdollPart[] | null = null;
  private stride = 0;

  constructor(private scene: THREE.Scene, private world: RAPIER.World, private cart: Cart) {
    const hoodie = new THREE.MeshStandardMaterial({ color: 0xc9453c, roughness: 0.8 });
    const jeans = new THREE.MeshStandardMaterial({ color: 0x4a5f96, roughness: 0.85 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xe2ac8c, roughness: 0.7 });

    // Hips sit 0.8 m above the feet; the torso pivots there so it can lean.
    this.torsoPivot.position.y = 0.8;
    this.torso = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 0.2), hoodie);
    this.torso.position.y = 0.25;
    this.head = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.24, 0.22), skin);
    this.head.position.y = 0.65;
    const beanie = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.1, 0.24), new THREE.MeshStandardMaterial({ color: 0x1d1f26 }));
    beanie.position.y = 0.1;
    this.head.add(beanie);
    this.torsoPivot.add(this.torso, this.head);

    for (const sx of [1, -1]) {
      const arm = new THREE.Group();
      arm.position.set(sx * 0.23, 0.46, 0);
      const armMesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.1), hoodie);
      armMesh.position.y = -0.23;
      arm.add(armMesh);
      this.torsoPivot.add(arm);
      this.arms.push(arm);

      const leg = new THREE.Group();
      leg.position.set(sx * 0.1, 0.8, 0);
      const legMesh = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.8, 0.13), jeans);
      legMesh.position.y = -0.4;
      leg.add(legMesh);
      this.root.add(leg);
      this.legs.push(leg);
      this.limbMeshes.push(armMesh, legMesh);
    }
    this.root.add(this.torsoPivot);
    cart.group.add(this.root);
  }

  /** World position of the rider's chest: the camera follows this during a bail. */
  focus(target: THREE.Vector3): boolean {
    if (!this.ragdoll) return false;
    const t = this.ragdoll[0].body.translation();
    target.set(t.x, t.y, t.z);
    return true;
  }

  update(dt: number): void {
    if (this.ragdoll) {
      for (const part of this.ragdoll) {
        const t = part.body.translation();
        const r = part.body.rotation();
        part.mesh.position.set(t.x, t.y, t.z);
        part.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      }
      return;
    }

    const cart = this.cart;
    const riding = cart.state === 'riding';
    const k = Math.min(1, dt * 12);
    const lerp = (a: number, b: number) => a + (b - a) * k;

    // Pushing: feet on the ground behind the cart. Riding: standing on the rear frame.
    const targetZ = riding ? -0.47 : -0.95;
    const targetY = riding ? -0.04 : -0.26;
    this.root.position.z = lerp(this.root.position.z, targetZ);
    this.root.position.y = lerp(this.root.position.y, targetY);
    this.root.rotation.z = lerp(this.root.rotation.z, riding ? cart.lean * 0.3 : cart.lean * 0.08);

    let torsoLean: number;
    let armReach: number;
    if (riding) {
      // Counter the cart's pitch a little so a wheelie reads as leaning back.
      torsoLean = 0.25 - cart.pitch * 0.5;
      armReach = -0.9;
      this.stride = 0;
    } else {
      const effort = Math.min(1, Math.abs(cart.fwdSpeed) / 6);
      torsoLean = 0.25 + effort * 0.35;
      armReach = -1.15;
      this.stride += dt * (4 + Math.abs(cart.fwdSpeed) * 2.2) * Math.sign(cart.fwdSpeed || 1);
    }
    this.torsoPivot.rotation.x = lerp(this.torsoPivot.rotation.x, torsoLean);
    const swing = riding ? 0 : Math.sin(this.stride) * Math.min(0.9, Math.abs(cart.fwdSpeed) * 0.18);
    this.legs[0].rotation.x = lerp(this.legs[0].rotation.x, swing);
    this.legs[1].rotation.x = lerp(this.legs[1].rotation.x, -swing);
    for (const arm of this.arms) arm.rotation.x = lerp(arm.rotation.x, armReach - torsoLean);
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
      return { body, mesh, home };
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

  /** Back on your feet behind the cart. */
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
