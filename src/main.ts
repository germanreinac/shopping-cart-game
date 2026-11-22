import * as THREE from 'three';
import { initPhysics, FIXED_DT } from './physics';
import { Input, NO_CONTROLS, type Controls } from './input';
import { Cart, TUNE } from './cart';
import { Person } from './person';
import { Crew } from './crew';
import { Race } from './race';
import { Pickups } from './pickups';
import { LightPool } from './lights';
import { Hud, formatTime, ORDINAL } from './hud';
import { buildParkingLot } from './scene/parkingLot';

async function start(): Promise<void> {
  const world = await initPhysics();

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  document.getElementById('app')!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 500);
  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  const lights = new LightPool(scene);
  const lot = buildParkingLot(scene, world, lights);
  const cart = new Cart(world, scene, lot.spawn, lot.kerbHandles, lot.bounds);
  const rider = new Person(scene, world, { top: 0xc9453c, legs: 0x4a5f96, skin: 0xe2ac8c, hat: 0x1d1f26 });
  rider.pose = 'push';
  rider.root.position.set(0, -0.26, -0.95);
  cart.group.add(rider.root);
  const crew = new Crew(scene, world, cart, lot.hangouts);
  const race = new Race(scene, world, cart, lot.circuit);
  const pickups = new Pickups(scene, lot.pickupSpots);
  const input = new Input();
  const hud = new Hud(TUNE.staminaMax);

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
  const coneUp = new THREE.Vector3();
  let camReady = false;

  const award = (label: string, points: number) => {
    if (points <= 0) return;
    score += points;
    hud.popup(`${label} +${points}`);
  };

  const handleEvents = () => {
    for (const ev of cart.events) {
      switch (ev.type) {
        case 'trick':
          award(ev.label, ev.points);
          break;
        case 'land':
          shake = Math.max(shake, 0.12 + ev.strength * 0.3);
          break;
        case 'crash':
          rider.bail(ev.velocity);
          crew.bail(ev.velocity);
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

    for (const ev of crew.events) {
      if (ev.type === 'joined') hud.popup(`${ev.name} hopped in`, 'info');
      else award(ev.label, ev.points);
    }
    crew.events.length = 0;

    for (const ev of race.events) {
      if (ev.type === 'count') hud.popup(ev.text, 'big');
      else if (ev.type === 'checkpoint') hud.popup(`Checkpoint ${ev.index}/${ev.total}`, 'info');
      else {
        hud.popup(`${ORDINAL[ev.place]} · ${formatTime(ev.time)}`, 'big');
        if (ev.best) hud.popup('New best lap', 'info');
        award('RACE', [0, 1500, 700, 300][ev.place] ?? 0);
      }
    }
    race.events.length = 0;
  };

  const stepOnce = (ctl: Controls) => {
    if (ctl.race) {
      rider.recover();
      crew.recover();
      race.toggle();
    }
    const wasCrashed = cart.state === 'crashed';
    cart.step(race.locked ? NO_CONTROLS : ctl);
    crew.step(ctl.throw && !race.locked, race.targets.concat(coneTargets()));
    race.step();
    world.step();
    cart.postStep();
    if (wasCrashed && cart.state !== 'crashed') {
      rider.recover();
      crew.recover();
    }
    handleEvents();
  };

  // Standing cones are throw targets too.
  const zero = new THREE.Vector3();
  const coneTargets = () =>
    lot.cones
      .filter((c) => !c.tipped)
      .map((c) => ({ position: c.mesh.position, velocity: zero, aimHeight: 0 }));

  const updateCamera = (dt: number) => {
    // Follow the direction of travel once moving, otherwise the way the cart points.
    const lv = cart.body.linvel();
    if (cart.state !== 'crashed') {
      if (cart.speed > 2 && cart.fwdSpeed > 0) v.set(lv.x, 0, lv.z).normalize();
      else v.set(0, 0, 1).applyQuaternion(cart.group.quaternion).setY(0).normalize();
      heading.lerp(v, Math.min(1, dt * 3.5)).normalize();
    }
    if (!rider.focus(focus)) focus.copy(cart.group.position);

    const speedK = Math.min(1, cart.speed / 14);
    camGoal.copy(focus).addScaledVector(heading, -(3.6 + speedK * 1.6));
    camGoal.y = focus.y + 1.5;
    if (!camReady) {
      camera.position.copy(camGoal);
      camReady = true;
    }
    camera.position.lerp(camGoal, Math.min(1, dt * 6));
    lookAt.copy(focus).addScaledVector(heading, 2.2);
    lookAt.y = focus.y + 0.65;

    shake = Math.max(0, shake - dt * 1.4);
    const s = shake * shake;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
    camera.lookAt(lookAt);
    camRoll += (-cart.lean * 0.07 * speedK - camRoll) * Math.min(1, dt * 4);
    camera.rotateZ(camRoll + (Math.random() - 0.5) * s * 0.15);
    const fov = 62 + speedK * 16;
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov += (fov - camera.fov) * Math.min(1, dt * 3);
      camera.updateProjectionMatrix();
    }
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
    rider.pose = cart.state === 'riding' ? 'ride' : 'push';
    rider.speed = cart.fwdSpeed;
    rider.lean = cart.lean;
    rider.pitch = cart.pitch;
    rider.update(dt, elapsed);
    crew.update(dt, elapsed);
    race.update(dt, elapsed);
    lot.update(elapsed);
    if (pickups.update(dt, elapsed, cart) > 0) hud.popup('Cigarettes +3', 'info');

    // Knocked-over cones score once, however they went down.
    for (const cone of lot.cones) {
      if (cone.tipped) continue;
      coneUp.set(0, 1, 0).applyQuaternion(cone.mesh.quaternion);
      if (coneUp.y < 0.5) {
        cone.tipped = true;
        award('CONE', 50);
      }
    }

    blob.position.set(cart.group.position.x, cart.groundY + 0.035, cart.group.position.z);
    (blob.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.45 - (cart.group.position.y - cart.groundY) * 0.25);
    updateCamera(dt);
    fill.position.copy(camera.position).setY(camera.position.y + 1.2);
    lights.update(camera.position);
    hud.update({
      state: cart.state,
      score,
      speed: cart.speed,
      pendingLabel: cart.pendingLabel,
      pendingPoints: cart.pendingPoints,
      stamina: cart.stamina,
      staminaMax: TUNE.staminaMax,
      sprinting: cart.sprinting,
      passenger: crew.passenger ? crew.passengerName : '',
      race: race.state,
      raceTime: race.time,
      checkpoint: race.next,
      checkpoints: race.total,
      place: race.place,
      racers: race.rivals.length + 1,
      best: race.best,
    });
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };

  document.getElementById('loading')?.remove();
  // Handy for poking at the game from the browser console.
  (window as unknown as { game: unknown }).game = { cart, world, scene, camera, race, crew, lot, stepOnce, get score() { return score; } };
  requestAnimationFrame(frame);
}

start().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) el.textContent = 'Could not start the game. See the console for details.';
});
