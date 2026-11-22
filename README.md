# Shopping Cart Game

A night-time arcade prototype about messing around with supermarket trolleys in an empty car park, under orange street lights.

![Pushing a trolley across the car park at night](screenshot.png)

Browser game built with Vite, TypeScript, Three.js and Rapier physics.

## Play

```bash
npm install
npm run dev
```

Then open the link Vite prints.

| Action | Keyboard | Gamepad | Touch |
| --- | --- | --- | --- |
| Go: run, then ride and kick along | hold `W` / `↑` | `RT` or `X` | PUSH |
| Steer / drift / spin in the air | `A` `D` / `←` `→` | left stick | drag left side |
| Jump | `Space` | `A` | HOP |
| Wheelie on the ground, backflip in the air | `S` / `↓` | stick back | drag down |
| Let go of the cart | `Q` | `LB` | LET GO |
| Passenger throws a can | `F` | `B` or `RB` | THROW |
| Start or abandon a race | `Enter`, or roll into the green ring | Start | RACE |
| Get back up early after a bail | `R` | `Y` | ↺ |

Hold go and the character runs with the cart, jumps on by themselves once it is moving fast enough, and keeps kicking it along. The handling is arcade, not realistic.

- **Cigarettes are stamina.** Going faster than cruising speed burns them. They come back slowly on their own; packs around the lot give three at once.
- **Steering** is kart-style: the cart goes where it points, tighter at low speed. Tap for a nudge, hold for a full turn.
- **Drift:** hold a hard turn at speed and after a moment the back steps out and the cart turns tighter, throwing sparks. Points build while you hold it; let go and you get a speed boost out of the corner, bigger the longer you held.
- **Wheelie:** hold back to lift the nose and let go to bank the points.
- **Jump:** tap for a short hop, hold for a full one. Pressing just before you land still counts, so hops chain.
- **Air:** jump anywhere, or use the kicker ramps, funbox and big launch ramp in the south-west corner. Steer in the air to spin; 180s and 360s score.
- **Flips:** in the air, hold back for a backflip. For a frontflip, let go of go and press it again while airborne. Let go mid-flip and the cart finishes the rotation for you; land upside down and you bail.
- **Grind:** jump onto one of the pale rails while moving along it and the cart locks on and slides. Steer to spin on the rail, jump to hop off.
- **Let go:** press `Q` and the cart rolls on without you, along with whoever is in the basket. The further your passenger gets before stopping, the more it scores (more if they crash). You carry on on foot.
- **Switch carts:** on foot, run up behind any loose trolley to grab it. Spare trolleys sit around the lot. Pull up beside the cart your passenger ended up in and they climb across.
- **Trench gap:** two big kickers face each other across the underground exit ramp. Clear the cutting in one jump for a bonus.
- **Banked corner:** a ring of wedges in the south-west corner you can carve round.
- **Kerb hop:** jump onto or off a kerb island for a bonus.
- **Crew:** teens hang around the lot. Roll past one slowly and they hop in the basket, then throw cans at rival riders (slows them down) and traffic cones.
- **Race:** roll into the green RACE ring by the start (or press `Enter`) for two laps against four other kids. Chevrons on the ground mark the racing line and an arrow at the top of the screen points where it goes next, turning yellow for sharp corners. Miss a turn and after a few seconds you are put back on the line. Barge into a kid to knock them off line, or have your passenger hit them with a can.
- **Bails:** tip over or slam into something solid and everyone on the cart ragdolls. You are stood back up after a second.

## Look

A mysterious night, after Kentucky Route Zero: a deep teal dark, pale lamps throwing visible cones of light, and beyond the walls only silhouettes: hills, trees, telephone poles, a radio mast with a slow red beacon, one farmhouse with a lit window, and a phone box nobody is ever in. Shading is flat and cartoon with thin ink outlines on characters. It all lives in `src/style.ts`.

## Code

```
src/
  main.ts            renderer, game loop, chase camera
  physics.ts         Rapier world, collision groups, ground raycast
  cart.ts            push, ride, steer, stamina, tricks, bails (tuning constants at the top)
  player.ts          you: holding a cart, or on foot and grabbing another
  person.ts          blocky teen: poses and ragdoll (player, passengers, rivals)
  crew.ts            teens who hop in, and can throwing
  race.ts            circuit, rival riders, checkpoints, lap timing
  pickups.ts         cigarette packs
  fx.ts              particles: drift sparks, landing dust, boost bursts
  lights.ts          pool of real lights moved to the lamps nearest the camera
  style.ts           toon materials, outlines, sky and skyline
  input.ts           keyboard, gamepad, touch
  hud.ts             score, speed, cigarettes, race status, popups
  scene/parkingLot.ts  car park, ramps, underground level and colliders
public/assets/       Blender .glb models go here later
```

Everything is primitive shapes for now. The feel of the cart is tuned in the `TUNE` block at the top of `src/cart.ts`.

## Deploy

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to `main`. One-time setup: in the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
