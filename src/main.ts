import * as THREE from 'three';
import { initPhysics, FIXED_DT } from './physics';
import { Input, NO_CONTROLS, type Controls } from './input';
import { Cart, TUNE } from './cart';
import { Player } from './player';
import { Crew } from './crew';
import { Race } from './race';
import { Pickups } from './pickups';
import { LightPool } from './lights';
import { Fx } from './fx';
import { Hud, formatTime, ORDINAL } from './hud';
import { buildParkingLot } from './scene/parkingLot';

const SPARE_COLOURS = [0x2f6fb5, 0x2f8f6b, 0xd9a91a, 0x6b4fb5, 0xb5456f, 0x9aa3ad, 0xd98a2b, 0x2f6fb5];

async function start(): Promise<void> {
  const world = await initPhysics();

  // Rendered small and scaled up with hard pixels: the lo-fi, grimy half of the look.
  const RENDER_HEIGHT = 420;
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.domElement.style.imageRendering = 'pixelated';
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  document.getElementById('app')!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 600);
  const resize = () => {
    renderer.setPixelRatio(Math.min(1, RENDER_HEIGHT / window.innerHeight));
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  const lights = new LightPool(scene);
  const lot = buildParkingLot(scene, world, lights);

  // Your cart, plus spare trolleys around the lot that you can switch to.
  const carts = [new Cart(world, scene, lot.spawn, lot.kerbHandles, lot.bounds)];
  lot.cartSpots.forEach((spot, i) => {
    const spare = new Cart(world, scene, spot, lot.kerbHandles, lot.bounds, SPARE_COLOURS[i % SPARE_COLOURS.length]);
    spare.placeAt(spot.x, spot.y, spot.z, spot.yaw);
    carts.push(spare);
  });
  for (const c of carts) c.rails = lot.rails;

  const player = new Player(scene, world, carts, carts[0]);
  const crew = new Crew(scene, world, lot.hangouts);
  const yawOf = (cart: Cart) => {
    const r = cart.body.rotation();
    return Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x));
  };
  const race = new Race(scene, world, {
    position: player.position,
    get speed() { return player.speed; },
    get yaw() { return player.cart ? yawOf(player.cart) : player.yaw; },
    get crashed() { return player.cart?.state === 'crashed'; },
    placeAt: (x, y, z, yaw) => player.placeAt(x, y, z, yaw),
    addCigarettes: (n) => player.addCigarettes(n),
  }, lot.circuit);
  const pickups = new Pickups(scene, lot.pickupSpots);
  const input = new Input();
  const hud = new Hud(TUNE.staminaMax);
  const fx = new Fx(scene);
  const wheel = new THREE.Vector3();

  // Soft blob under the player so they sit on the ground without real shadows.
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(0.62, 20).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }),
  );
  scene.add(blob);

  // Faint fill light that travels with the camera, so the rider is readable between lamp pools.
  const fill = new THREE.PointLight(0xffe2b8, 14, 10, 2);
  scene.add(fill);

  let score = 0;
  let shake = 0;
  let camRoll = 0;
  let fovKick = 0;
  // A cart you let go of with someone in it: how far it gets before stopping scores.
  let sent: { cart: Cart; from: THREE.Vector3; name: string } | null = null;
  const heading = new THREE.Vector3(Math.sin(lot.spawn.yaw), 0, Math.cos(lot.spawn.yaw));
  const focus = new THREE.Vector3();
  const camGoal = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const v = new THREE.Vector3();
  const coneUp = new THREE.Vector3();
  let camReady = false;
  let gapFrom: number | null = null;

  const award = (label: string, points: number) => {
    if (points <= 0) return;
    score += points;
    hud.popup(`${label} +${points}`);
  };

  const endSend = (reason: 'stopped' | 'grabbed' | 'crashed') => {
    if (!sent) return;
    const t = sent.cart.body.translation();
    const metres = Math.round(Math.hypot(t.x - sent.from.x, t.z - sent.from.z));
    if (metres >= 8) award(`SENT ${sent.name.toUpperCase()} ${metres}m${reason === 'crashed' ? ' (CRASH)' : ''}`, metres * (reason === 'crashed' ? 15 : 10));
    sent = null;
  };

  const handleEvents = () => {
    for (const cart of carts) {
      const mine = cart === player.cart;
      for (const ev of cart.events) {
        if (ev.type === 'crash') {
          crew.bail(cart, ev.velocity);
          if (sent?.cart === cart) endSend('crashed');
          if (mine) {
            player.person.bail(ev.velocity);
            shake = Math.max(shake, 0.5);
            hud.popup('BAIL!', 'bail');
          }
          continue;
        }
        if (!mine) continue;
        switch (ev.type) {
          case 'trick':
            award(ev.label, ev.points);
            break;
          case 'land': {
            shake = Math.max(shake, 0.12 + ev.strength * 0.3);
            const p = cart.body.translation();
            fx.emit(p.x, cart.groundY + 0.1, p.z, 0, 0.6, 0, 4 + ev.strength * 4, 0xb8c8d4, 14 + Math.round(ev.strength * 16), 0.45);
            break;
          }
          case 'boost': {
            // Fired out of a drift: punch the camera and leave a burst behind.
            shake = Math.max(shake, 0.15 + ev.strength * 0.2);
            fovKick = 5 + ev.strength * 7;
            const p = cart.body.translation();
            fx.emit(p.x, p.y, p.z, 0, 1, 0, 6, 0xffd166, 24, 0.5);
            hud.popup('BOOST', 'info');
            break;
          }
          case 'hopOn':
            shake = Math.max(shake, 0.08);
            break;
        }
      }
      cart.events.length = 0;
    }

    for (const ev of player.events) {
      if (ev.type === 'letGo') {
        if (crew.passengerCart === ev.cart && crew.passenger) {
          const t = ev.cart.body.translation();
          sent = { cart: ev.cart, from: new THREE.Vector3(t.x, t.y, t.z), name: crew.passengerName };
          hud.popup(`Bye ${crew.passengerName}`, 'info');
        }
      } else {
        if (sent?.cart === ev.cart) endSend('grabbed');
        shake = Math.max(shake, 0.1);
      }
    }
    player.events.length = 0;

    for (const ev of crew.events) {
      if (ev.type === 'joined') hud.popup(`${ev.name} hopped in`, 'info');
      else if (ev.type === 'moved') hud.popup(`${ev.name} climbed across`, 'info');
      else award(ev.label, ev.points);
    }
    crew.events.length = 0;

    for (const ev of race.events) {
      if (ev.type === 'count') hud.popup(ev.text, 'big');
      else if (ev.type === 'lap') hud.popup(ev.lap === ev.laps ? 'Final lap' : `Lap ${ev.lap}/${ev.laps}`, 'info');
      else if (ev.type === 'offCourse') hud.popup('Off course: back on the line', 'info');
      else if (ev.type === 'shove') {
        shake = Math.max(shake, 0.2);
        award(`SHOVED ${ev.name.toUpperCase()}`, race.state === 'running' ? 100 : 0);
      } else {
        hud.popup(`${ORDINAL[ev.place]} of ${ev.racers} · ${formatTime(ev.time)}`, 'big');
        if (ev.best) hud.popup('New best time', 'info');
        award('RACE', [0, 2000, 1200, 700, 300][ev.place] ?? 0);
      }
    }
    race.events.length = 0;
  };

  // Standing cones are throw targets too.
  const zero = new THREE.Vector3();
  const coneTargets = () =>
    lot.cones
      .filter((c) => !c.tipped)
      .map((c) => ({ position: c.mesh.position, velocity: zero, aimHeight: 0 }));

  const stepOnce = (raw: Controls) => {
    if (raw.race) {
      player.person.recover();
      for (const c of carts) crew.recover(c);
      race.toggle();
    }
    const ctl = race.locked ? NO_CONTROLS : raw;
    const crashed = carts.map((c) => c.state === 'crashed');
    player.step(ctl);
    for (const c of carts) c.step(c === player.cart ? ctl : NO_CONTROLS);
    crew.step(player.cart, ctl.throw, race.targets.concat(coneTargets()));
    race.step();
    world.step();
    carts.forEach((c, i) => {
      c.postStep();
      if (crashed[i] && c.state !== 'crashed') {
        crew.recover(c);
        if (c === player.cart) player.person.recover();
      }
    });
    if (sent && sent.cart.speed < 0.4 && sent.cart.grounded >= 2) endSend('stopped');

    // Trench gap: clear the exit ramp's cutting in one jump, either way.
    const mine = player.cart;
    if (mine && mine.state === 'riding') {
      const t = mine.body.translation();
      if (mine.grounded === 0) {
        if (gapFrom === null) gapFrom = t.x;
      } else {
        if (gapFrom !== null && t.z > 40 && t.z < 62 && Math.min(gapFrom, t.x) < 49.5 && Math.max(gapFrom, t.x) > 58.5 && t.y > -1) award('TRENCH GAP', 800);
        gapFrom = null;
      }
    } else gapFrom = null;
    handleEvents();
  };

  const updateCamera = (dt: number) => {
    const cart = player.cart;
    // Follow the direction of travel once moving, otherwise the way you are facing.
    if (cart) {
      if (cart.state !== 'crashed') {
        const lv = cart.body.linvel();
        if (cart.speed > 2 && cart.fwdSpeed > 0) v.set(lv.x, 0, lv.z).normalize();
        else v.set(0, 0, 1).applyQuaternion(cart.group.quaternion).setY(0).normalize();
        heading.lerp(v, Math.min(1, dt * 3.5)).normalize();
      }
      if (!player.person.focus(focus)) focus.copy(cart.group.position);
    } else {
      v.set(Math.sin(player.yaw), 0, Math.cos(player.yaw));
      heading.lerp(v, Math.min(1, dt * 4)).normalize();
      focus.copy(player.position).setY(player.position.y + 0.6);
    }

    const speedK = Math.min(1, player.speed / 20);
    // On a short, wide screen (a phone held sideways) the rider ends up tiny, so the camera
    // sits closer and lower, and the view is narrowed to keep the same width of world in frame.
    const short = Math.max(0, Math.min(1, (620 - window.innerHeight) / 240));
    const close = 1 - short * 0.2;
    camGoal.copy(focus).addScaledVector(heading, -(3.8 + speedK * 2.2) * close);
    camGoal.y = focus.y + 1.5 - short * 0.25;
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
    camRoll += (-(cart?.lean ?? 0) * 0.07 * speedK - camRoll) * Math.min(1, dt * 4);
    camera.rotateZ(camRoll + (Math.random() - 0.5) * s * 0.15);
    fovKick = Math.max(0, fovKick - dt * 14);
    const wide = Math.max(1, camera.aspect / 1.6);
    const base = 62 + speedK * (20 - short * 8) + fovKick;
    const fov = (2 * Math.atan(Math.tan((base * Math.PI) / 360) / wide) * 180) / Math.PI;
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov += (fov - camera.fov) * Math.min(1, dt * 6);
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

    for (const c of carts) c.syncMesh();
    player.update(dt, elapsed);
    crew.update(dt, elapsed);
    race.update(dt, elapsed);
    lot.update(elapsed);

    // Sparks off the back wheels while drifting or grinding.
    const cart = player.cart;
    if (cart && (cart.drifting || cart.grind)) {
      const lv = cart.body.linvel();
      for (const sx of [0.26, -0.26]) {
        wheel.set(sx, -0.22, cart.grind ? 0 : -0.38).applyMatrix4(cart.group.matrixWorld);
        fx.emit(wheel.x, wheel.y, wheel.z, lv.x * 0.25, 1.2, lv.z * 0.25, 2.5, cart.pendingPoints > 60 ? 0xff8a2a : 0xf4efe6, 2, 0.35);
      }
    }
    fx.update(dt);
    if (pickups.update(dt, elapsed, player) > 0) hud.popup('Cigarettes +3', 'info');

    // Knocked-over cones score once, however they went down.
    for (const cone of lot.cones) {
      if (cone.tipped) continue;
      coneUp.set(0, 1, 0).applyQuaternion(cone.mesh.quaternion);
      if (coneUp.y < 0.5) {
        cone.tipped = true;
        award('CONE', 50);
      }
    }

    const floor = cart ? cart.groundY : player.position.y;
    const height = cart ? cart.group.position.y - cart.groundY : 0;
    blob.position.set(cart ? cart.group.position.x : player.position.x, floor + 0.035, cart ? cart.group.position.z : player.position.z);
    (blob.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.45 - height * 0.25);
    updateCamera(dt);
    fill.position.copy(camera.position).setY(camera.position.y + 1.2);
    lights.update(camera.position);
    hud.update({
      state: cart ? cart.state : 'loose',
      onFoot: player.onFoot,
      score,
      speed: player.speed,
      pendingLabel: cart?.pendingLabel ?? '',
      pendingPoints: cart?.pendingPoints ?? 0,
      stamina: player.cigarettes,
      staminaMax: TUNE.staminaMax,
      sprinting: cart?.sprinting ?? false,
      passenger: crew.ridingWith(cart) ? crew.passengerName : '',
      race: race.state,
      raceTime: race.time,
      lap: race.lap,
      laps: race.laps,
      place: race.place,
      racers: race.racers,
      best: race.best,
      turn: race.turn,
    });
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };

  document.getElementById('loading')?.remove();
  // Handy for poking at the game from the browser console.
  (window as unknown as { game: unknown }).game = {
    get cart() { return player.cart ?? player.lastCart; },
    player, carts, world, scene, camera, race, crew, lot, stepOnce,
    get score() { return score; },
  };
  requestAnimationFrame(frame);
}

start().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) el.textContent = 'Could not start the game. See the console for details.';
});
