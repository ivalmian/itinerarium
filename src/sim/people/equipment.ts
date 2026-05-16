/**
 * Per-unit + per-person equipment helpers.
 *
 * See docs/04 §"Person registry for moving units" and docs/03
 * §"Weapon-archetype substitution policy".
 *
 * Two data structures live on each moving unit (Caravan, BanditCamp,
 * BanditParty, Patrol, MigrationColumn):
 *
 *   UnitInventory  = Map<ResourceId, number>
 *     Aggregate count of issued/unissued weapons + armor + shields the
 *     unit holds. Looted gear lands here first; recruitment-time issue
 *     pulls from here to populate per-person slots.
 *
 *   PersonEquip    = Map<PersonId, Map<ResourceId, number>>
 *     Per-Person slot map recording which specific kit each individual
 *     currently carries. Bound items are subtracted from UnitInventory.
 *
 * Equipment per Person is sparse — typically ≤ 4 entries (one melee,
 * one ranged, helmet, body_armor, shield). The substitution priority
 * for what to issue comes from docs/03 §"Weapon-archetype substitution
 * policy".
 */

import type { PersonId, Quantity, ResourceId } from '../types.js';

export type UnitInventory = Map<ResourceId, Quantity>;
export type PersonEquip = Map<PersonId, Map<ResourceId, Quantity>>;

/** Convenience: empty inventory + empty per-person map. */
export const emptyUnitInventory = (): UnitInventory => new Map();
export const emptyPersonEquip = (): PersonEquip => new Map();

/**
 * Issue one unit of `resource` from `inv` to `personId`'s equipment
 * slot. Returns `true` if an item was actually issued (inventory had
 * stock); `false` if the inventory was empty for that resource.
 */
export const issueOne = (
  inv: UnitInventory,
  equip: PersonEquip,
  personId: PersonId,
  resource: ResourceId,
): boolean => {
  const avail = inv.get(resource) ?? 0;
  if (avail < 1) return false;
  inv.set(resource, avail - 1);
  let slot = equip.get(personId);
  if (slot === undefined) {
    slot = new Map<ResourceId, Quantity>();
    equip.set(personId, slot);
  }
  slot.set(resource, (slot.get(resource) ?? 0) + 1);
  return true;
};

/**
 * Return all of `personId`'s equipped items back into the unit
 * inventory (e.g. when the Person dies or is captured). Removes the
 * Person's slot entry. Returns the per-resource quantities returned.
 */
export const returnPersonEquipmentToUnit = (
  inv: UnitInventory,
  equip: PersonEquip,
  personId: PersonId,
): ReadonlyMap<ResourceId, Quantity> => {
  const slot = equip.get(personId);
  if (slot === undefined || slot.size === 0) return new Map();
  const returned = new Map<ResourceId, Quantity>();
  for (const [r, q] of slot) {
    if (q <= 0) continue;
    inv.set(r, (inv.get(r) ?? 0) + q);
    returned.set(r, q);
  }
  equip.delete(personId);
  return returned;
};

/**
 * Sum across the per-Person slot maps to get the total equipped count
 * of `resource`. Useful when comparing UnitInventory (unissued) vs
 * total stock (unissued + issued).
 */
export const totalEquippedForResource = (
  equip: PersonEquip,
  resource: ResourceId,
): number => {
  let total = 0;
  for (const slot of equip.values()) {
    total += slot.get(resource) ?? 0;
  }
  return total;
};

/** Priority orders per docs/03 §"Weapon-archetype substitution policy". */
export const MELEE_PRIORITY: readonly ResourceId[] = [
  'goods.gladius' as ResourceId,
  'goods.hasta' as ResourceId,
  'goods.dagger' as ResourceId,
];

export const RANGED_PRIORITY: readonly ResourceId[] = [
  'goods.bow' as ResourceId,
  'goods.sling' as ResourceId,
  'goods.pilum' as ResourceId,
];

export const DEFENSE_SLOTS: readonly ResourceId[] = [
  'goods.helmet' as ResourceId,
  'goods.body_armor' as ResourceId,
  'goods.shield' as ResourceId,
];

/**
 * Issue a standard soldier kit to `personId` from `inv`: best
 * available melee + best available ranged + one each of helmet,
 * body_armor, shield (if stock permits). Returns the map of what was
 * actually issued (for telemetry and tests).
 */
export const issueStandardKit = (
  inv: UnitInventory,
  equip: PersonEquip,
  personId: PersonId,
): ReadonlyMap<ResourceId, Quantity> => {
  const issued = new Map<ResourceId, Quantity>();
  for (const r of MELEE_PRIORITY) {
    if (issueOne(inv, equip, personId, r)) {
      issued.set(r, 1);
      break;
    }
  }
  for (const r of RANGED_PRIORITY) {
    if (issueOne(inv, equip, personId, r)) {
      issued.set(r, 1);
      break;
    }
  }
  for (const r of DEFENSE_SLOTS) {
    if (issueOne(inv, equip, personId, r)) {
      issued.set(r, 1);
    }
  }
  return issued;
};
