import * as THREE from 'three';
import { initPhysics, FIXED_DT } from './physics';
import { Input, type Controls } from './input';
import { Cart } from './cart';
import { Rider } from './rider';
import { Hud } from './hud';
import { buildParkingLot } from './scene/parkingLot';

async function start(): Promise<void> {
  const world = await initPhysics();

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  document.getElementById('app')!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 400);
  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  const lot = buildParkingLot(scene, world);
  const cart = new Cart(world, scene, lot.spawn, lot.kerbHandles, lot.bounds);
  const rider = new Rider(scene, world, cart);
  const input = new Input();
  const hud = new Hud();

  // Soft blob under the cart so it sits on the ground without real shadows.
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(0.62, 20).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }),
  );
  scene.add(blob);

  // Faint fill light that travels with the cart, so the rider is readable between lamp pools.
  const fill = new THREE.PointLight(0xffc48a, 16, 10, 2);
  scene.add(fill);

  let score = 0;
  let shake = 0;
  let camRoll = 0;
  const heading = new THREE.Vector3(Math.sin(lot.spawn.yaw), 0, Math.cos(lot.spawn.yaw));
  const focus = new THREE.Vector3();
  const camGoal = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const v = new THREE.Vector3();
  let camReady = false;

  const handleEvents = () => {
    for (const ev of cart.events) {
      switch (ev.type) {
        case 'trick':
          if (ev.points > 0) {
            score += ev.points;
            hud.popup(`${ev.label} +${ev.points}`);
          }
          break;
        case 'land':
          shake = Math.max(shake, 0.12 + ev.strength * 0.3);
          break;
        case 'crash':
          rider.bail(ev.velocity);
          shake = Math.max(shake, 0.5);
          hud.popup('BAIL!', 'bail');
          break;
        case 'tooSlow':
          hud.popup('Build some speed first', 'info');
          break;
        case 'hopOn':
          shake = Math.max(shake, 0.08);
          break;
      }
    }
    cart.events.length = 0;
  };

  const updateCamera = (dt: number) => {
    // Follow the direction of travel once moving, otherwise the way the cart points.
    const lv = cart.body.linvel();
    if (cart.state !== 'crashed') {
      if (cart.speed > 2 && cart.fwdSpeed > 0) v.set(lv.x, 0, lv.z).normalize();
      else v.set(0, 0, 1).applyQuaternion(cart.group.quaternion).setY(0).normalize();
      heading.lerp(v, Math.min(1, dt * 3.5)).normalize();
    }
    if (!rider.focus(focus)) focus.copy(cart.group.position);

    const speedK = Math.min(1, cart.speed / 10);
    camGoal.copy(focus).addScaledVector(heading, -(3.6 + speedK * 1.2));
    camGoal.y = Math.max(0.5, focus.y * 0.5) + 1.25;
    if (!camReady) {
      camera.position.copy(camGoal);
      camReady = true;
    }
    camera.position.lerp(camGoal, Math.min(1, dt * 6));
    lookAt.copy(focus).addScaledVector(heading, 2.2);
    lookAt.y = focus.y * 0.6 + 0.75;

    shake = Math.max(0, shake - dt * 1.4);
    const s = shake * shake;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
    camera.lookAt(lookAt);
    camRoll += (-cart.lean * 0.07 * speedK - camRoll) * Math.min(1, dt * 4);
    camera.rotateZ(camRoll + (Math.random() - 0.5) * s * 0.15);
    const fov = 62 + speedK * 12;
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov += (fov - camera.fov) * Math.min(1, dt * 3);
      camera.updateProjectionMatrix();
    }
  };

  const stepOnce = (ctl: Controls) => {
    const wasCrashed = cart.state === 'crashed';
    cart.step(ctl);
    world.step();
    cart.postStep();
    if (wasCrashed && cart.state !== 'crashed') rider.recover();
    handleEvents();
  };

  let last = performance.now();
  let elapsed = 0;
  let acc = 0;
  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    elapsed += dt;
    acc += dt;
    while (acc >= FIXED_DT) {
      stepOnce(input.sample());
      acc -= FIXED_DT;
    }

    cart.syncMesh();
    rider.update(dt);
    lot.update(elapsed);
    blob.position.set(cart.group.position.x, 0.02, cart.group.position.z);
    (blob.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.45 - cart.group.position.y * 0.25);
    updateCamera(dt);
    fill.position.copy(camera.position).setY(camera.position.y + 1.2);
    hud.update(cart.state, score, cart.speed, cart.pendingPoints);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };

  document.getElementById('loading')?.remove();
  // Handy for poking at the game from the browser console.
  (window as unknown as { game: unknown }).game = { cart, world, scene, camera, stepOnce, get score() { return score; } };
  requestAnimationFrame(frame);
}

start().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) el.textContent = 'Could not start the game. See the console for details.';
});
