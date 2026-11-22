import * as THREE from 'three';

const MAX = 220;

/** Tiny particle pool for tyre sparks, landing dust and boost bursts. */
export class Fx {
  private pos = new Float32Array(MAX * 3);
  private col = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private next = 0;
  private geo = new THREE.BufferGeometry();
  private tint = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.pos.fill(-999);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const points = new THREE.Points(
      this.geo,
      new THREE.PointsMaterial({ size: 0.16, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    points.frustumCulled = false;
    scene.add(points);
  }

  /** Spray `count` particles from a point. `spread` is the random speed added in every direction. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, spread: number, color: number, count: number, life = 0.5): void {
    this.tint.setHex(color);
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      this.pos.set([x, y, z], i * 3);
      this.vel.set(
        [vx + (Math.random() - 0.5) * spread, vy + Math.random() * spread * 0.6, vz + (Math.random() - 0.5) * spread],
        i * 3,
      );
      this.col.set([this.tint.r, this.tint.g, this.tint.b], i * 3);
      this.life[i] = life * (0.6 + Math.random() * 0.6);
    }
  }

  update(dt: number): void {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      if (this.life[i] <= 0) {
        this.pos[j + 1] = -999;
        continue;
      }
      this.vel[j + 1] -= 6 * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}
