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
| Run and push (sprints past a jog) / kick-push when riding | hold `W` / `↑` | `RT` or `X` | PUSH |
| Steer / lean / spin in the air | `A` `D` / `←` `→` | left stick | drag left side |
| Hop on, then hop | `Space` | `A` | HOP |
| Wheelie (riding) / brake (pushing) | `S` / `↓` | stick back | drag down |
| Passenger throws a can | `F` | `B` or `RB` | THROW |
| Start or abandon a race | `Enter` | Start | RACE |
| Get back up after a bail | `R` | `Y` | ↺ |

The loop: push to build speed, hop on, land tricks before the cart rolls to a stop, repeat.

- **Cigarettes are stamina.** Sprinting faster than a jog and kick-pushing while riding burn them. They come back slowly on their own; packs around the lot give three at once.
- **Drift:** lean hard at speed and the back end slides. Points build while you hold the slide and bank when you straighten up.
- **Wheelie:** hold back to lift the nose and let go to bank the points. Hold too long and you go over backwards.
- **Air:** kicker ramps, a funbox and a big launch ramp sit in the south-west corner. Steer in the air to spin; 180s and 360s score.
- **Kerb hop:** hop onto or off a kerb island for a bonus. Ride into a kerb at speed without hopping and you tumble.
- **Crew:** teens hang around the lot. Roll past one slowly and they hop in the basket, then throw cans at rival riders (slows them down) and traffic cones.
- **Race:** one lap against two rivals, north up the centre lane, down through the underground level and back. Best lap is saved in the browser.
- **Bails:** tip over, loop out, clip a kerb or slam into something solid and everyone on the cart ragdolls.

## Code

```
src/
  main.ts            renderer, game loop, chase camera
  physics.ts         Rapier world, collision groups, ground raycast
  cart.ts            push, ride, steer, stamina, tricks, bails (tuning constants at the top)
  person.ts          blocky teen: poses and ragdoll (player, passengers, rivals)
  crew.ts            teens who hop in, and can throwing
  race.ts            circuit, rival riders, checkpoints, lap timing
  pickups.ts         cigarette packs
  lights.ts          pool of real lights moved to the lamps nearest the camera
  input.ts           keyboard, gamepad, touch
  hud.ts             score, speed, cigarettes, race status, popups
  scene/parkingLot.ts  car park, ramps, underground level and colliders
public/assets/       Blender .glb models go here later
```

Everything is primitive shapes for now. The feel of the cart is tuned in the `TUNE` block at the top of `src/cart.ts`.

## Deploy

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to `main`. One-time setup: in the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
