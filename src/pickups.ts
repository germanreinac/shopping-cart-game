import * as THREE from 'three';
import type { Cart } from './cart';

const RESPAWN = 22;
const REACH = 1.9;
const REFILL = 3;

/** Cigarette packs dotted around the lot. Roll through one to top up your stamina. */
export class Pickups {
  private packs: { group: THREE.Group; home: THREE.Vector3; cooldown: number }[] = [];

  constructor(scene: THREE.Scene, spots: THREE.Vector3[]) {
    const box = new THREE.BoxGeometry(0.34, 0.5, 0.14);
    const lid = new THREE.BoxGeometry(0.345, 0.17, 0.145);
    const white = new THREE.MeshStandardMaterial({ color: 0xf4efe6, emissive: 0x8a8578, roughness: 0.6 });
    const red = new THREE.MeshStandardMaterial({ color: 0xd8342c, emissive: 0x7a1510, roughness: 0.6 });
    for (const spot of spots) {
      const group = new THREE.Group();
      const top = new THREE.Mesh(lid, red);
      top.position.y = 0.17;
      group.add(new THREE.Mesh(box, white), top);
      group.rotation.z = 0.25;
      const home = spot.clone();
      home.y += 0.95;
      group.position.copy(home);
      scene.add(group);
      this.packs.push({ group, home, cooldown: 0 });
    }
  }

  /** Returns how many packs were collected this frame. */
  update(dt: number, time: number, cart: Cart): number {
    let collected = 0;
    const p = cart.group.position;
    for (const pack of this.packs) {
      if (pack.cooldown > 0) {
        pack.cooldown -= dt;
        if (pack.cooldown <= 0) pack.group.visible = true;
        continue;
      }
      pack.group.rotation.y = time * 2;
      pack.group.position.y = pack.home.y + Math.sin(time * 2.4 + pack.home.x) * 0.12;
      if (cart.state !== 'crashed' && Math.hypot(p.x - pack.home.x, p.y + 0.5 - pack.home.y, p.z - pack.home.z) < REACH) {
        cart.addStamina(REFILL);
        pack.cooldown = RESPAWN;
        pack.group.visible = false;
        collected++;
      }
    }
    return collected;
  }
}
