import * as THREE from 'three';

export interface LightSite {
  x: number;
  y: number;
  z: number;
  color: number;
  intensity: number;
  distance: number;
  /** Underground lights only shine when the camera is below the surface, and vice versa. */
  underground?: boolean;
  /** Lights inside the supermarket: only on while the camera is in there, when everything else is off. */
  store?: boolean;
}

const smooth = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The lot has far more lamps than a phone GPU can shade at once, so a small fixed pool of
 * real point lights is moved every frame to the lamp sites nearest the camera. Distant
 * lamps are just glow sprites and ground decals.
 */
export class LightPool {
  private sites: (LightSite & { score: number; gain: number })[] = [];
  private lights: THREE.PointLight[] = [];
  /** The z of the shop front; beyond it (more negative) is indoors. Null until there is a shop. */
  storeZ: number | null = null;

  constructor(scene: THREE.Scene, size = 10) {
    for (let i = 0; i < size; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 40, 2);
      scene.add(light);
      this.lights.push(light);
    }
  }

  add(site: LightSite): void {
    this.sites.push({ ...site, score: 0, gain: 0 });
  }

  update(camera: THREE.Vector3): void {
    const below = smooth(-0.8, -3.2, camera.y);
    const inside = this.storeZ === null ? 0 : (1 - below) * smooth(this.storeZ + 2, this.storeZ - 4, camera.z);
    for (const s of this.sites) {
      const d = Math.hypot(s.x - camera.x, s.y - camera.y, s.z - camera.z);
      const zone = s.underground ? below : s.store ? inside : (1 - below) * (1 - inside);
      s.gain = zone * (1 - smooth(40, 58, d));
      s.score = s.gain > 0 ? d : Infinity;
    }
    this.sites.sort((a, b) => a.score - b.score);
    this.lights.forEach((light, i) => {
      const s = this.sites[i];
      if (!s || s.gain <= 0) {
        light.intensity = 0;
        return;
      }
      light.position.set(s.x, s.y, s.z);
      light.color.setHex(s.color);
      light.intensity = s.intensity * s.gain;
      light.distance = s.distance;
    });
  }
}
