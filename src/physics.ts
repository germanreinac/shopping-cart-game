import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };

/** Fixed physics timestep. The render loop accumulates time and steps in these increments. */
export const FIXED_DT = 1 / 60;

// Collision groups: (membership << 16) | filter.
const GROUP_CART = 0x0002;
const GROUP_RAGDOLL = 0x0004;
/** The player's cart: collides with everything except the ragdoll (which spawns inside it). */
export const CART_GROUPS = (GROUP_CART << 16) | (0xffff & ~GROUP_RAGDOLL);
/** Ragdoll parts: collide with everything except the player's cart. */
export const RAGDOLL_GROUPS = (GROUP_RAGDOLL << 16) | (0xffff & ~GROUP_CART);
/** Wheel raycasts: roll over everything except ragdoll parts. */
export const WHEEL_RAY_GROUPS = (0xffff << 16) | (0xffff & ~GROUP_RAGDOLL);

export async function initPhysics(): Promise<RAPIER.World> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;
  return world;
}

/** Adds a fixed box collider. Sizes are half-extents. Returns the collider. */
export function addStaticBox(
  world: RAPIER.World,
  x: number, y: number, z: number,
  hx: number, hy: number, hz: number,
  friction = 0.8,
): RAPIER.Collider {
  const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
    .setTranslation(x, y, z)
    .setFriction(friction);
  return world.createCollider(desc);
}

/** Height of the fixed ground under a point, or null if nothing is within `maxDist` below it. */
export function groundBelow(world: RAPIER.World, x: number, y: number, z: number, maxDist = 6): number | null {
  const ray = new RAPIER.Ray({ x, y, z }, { x: 0, y: -1, z: 0 });
  const hit = world.castRay(ray, maxDist, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
  return hit ? y - hit.timeOfImpact : null;
}
