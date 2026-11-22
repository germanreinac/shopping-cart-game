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
| Run and push | hold `W` / `↑` | `RT` or `X` | PUSH |
| Steer / lean | `A` `D` / `←` `→` | left stick | drag left side |
| Hop on, then kerb hop | `Space` | `A` | HOP |
| Wheelie (riding) / brake (pushing) | `S` / `↓` | stick back | drag down |
| Get back up after a bail | `R` | `Y` or Start | ↺ |

The loop: push to build speed, hop on, land tricks before the cart rolls to a stop, repeat.

- **Wheelie:** hold back to lift the nose and let go to bank the points. The higher the nose the faster it scores. Hold too long and you go over backwards.
- **Kerb hop:** hop onto or off a kerb island for a bonus. Ride into a kerb at speed without hopping and you tumble.
- **Bails:** tip over, loop out, clip a kerb or slam into a lamp post or parked car and the rider ragdolls while the cart rolls off.

## Code

```
src/
  main.ts            renderer, game loop, chase camera
  physics.ts         Rapier world, collision groups
  cart.ts            push, ride, steer, tricks, bails (tuning constants at the top)
  rider.ts           posed rider and ragdoll
  input.ts           keyboard, gamepad, touch
  hud.ts             score, speed, popups
  scene/parkingLot.ts  car park block-out and colliders
public/assets/       Blender .glb models go here later
```

Everything is primitive shapes for now. The feel of the cart is tuned in the `TUNE` block at the top of `src/cart.ts`.

## Deploy

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to `main`. One-time setup: in the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.
