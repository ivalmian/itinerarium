import { describe, expect, it } from 'vitest';

import { personId, resourceId } from '../types.js';
import {
  emptyPersonEquip,
  emptyUnitInventory,
  issueOne,
  issueStandardKit,
  returnPersonEquipmentToUnit,
  totalEquippedForResource,
} from './equipment.js';

const GLADIUS = resourceId('goods.gladius');
const HASTA = resourceId('goods.hasta');
const HELMET = resourceId('goods.helmet');
const BODY_ARMOR = resourceId('goods.body_armor');
const SHIELD = resourceId('goods.shield');
const BOW = resourceId('goods.bow');
const SLING = resourceId('goods.sling');

describe('issueOne', () => {
  it('moves one unit from inventory to a Person slot', () => {
    const inv = emptyUnitInventory();
    inv.set(GLADIUS, 3);
    const equip = emptyPersonEquip();
    expect(issueOne(inv, equip, personId('p1'), GLADIUS)).toBe(true);
    expect(inv.get(GLADIUS)).toBe(2);
    expect(equip.get(personId('p1'))?.get(GLADIUS)).toBe(1);
  });

  it('refuses to issue from empty stock', () => {
    const inv = emptyUnitInventory();
    const equip = emptyPersonEquip();
    expect(issueOne(inv, equip, personId('p1'), GLADIUS)).toBe(false);
    expect(equip.size).toBe(0);
  });
});

describe('returnPersonEquipmentToUnit', () => {
  it('returns all of a Person\'s items to the unit inventory and clears their slot', () => {
    const inv = emptyUnitInventory();
    inv.set(GLADIUS, 1);
    inv.set(SHIELD, 1);
    const equip = emptyPersonEquip();
    issueOne(inv, equip, personId('p1'), GLADIUS);
    issueOne(inv, equip, personId('p1'), SHIELD);
    expect(inv.get(GLADIUS)).toBe(0);
    expect(inv.get(SHIELD)).toBe(0);

    const returned = returnPersonEquipmentToUnit(inv, equip, personId('p1'));
    expect(returned.get(GLADIUS)).toBe(1);
    expect(returned.get(SHIELD)).toBe(1);
    expect(inv.get(GLADIUS)).toBe(1);
    expect(inv.get(SHIELD)).toBe(1);
    expect(equip.get(personId('p1'))).toBeUndefined();
  });

  it('returns an empty map when the Person had no equipment', () => {
    const inv = emptyUnitInventory();
    const equip = emptyPersonEquip();
    const returned = returnPersonEquipmentToUnit(inv, equip, personId('p1'));
    expect(returned.size).toBe(0);
  });
});

describe('issueStandardKit', () => {
  it('issues the preferred melee + ranged + every defense slot when stock allows', () => {
    const inv = emptyUnitInventory();
    inv.set(GLADIUS, 1);
    inv.set(BOW, 1);
    inv.set(HELMET, 1);
    inv.set(BODY_ARMOR, 1);
    inv.set(SHIELD, 1);
    const equip = emptyPersonEquip();
    const issued = issueStandardKit(inv, equip, personId('p1'));
    expect(issued.get(GLADIUS)).toBe(1);
    expect(issued.get(BOW)).toBe(1);
    expect(issued.get(HELMET)).toBe(1);
    expect(issued.get(BODY_ARMOR)).toBe(1);
    expect(issued.get(SHIELD)).toBe(1);
    expect(inv.get(GLADIUS)).toBe(0);
    expect(inv.get(BODY_ARMOR)).toBe(0);
  });

  it('falls back through the melee priority when the primary is out of stock', () => {
    const inv = emptyUnitInventory();
    inv.set(HASTA, 1);
    inv.set(SLING, 1);
    const equip = emptyPersonEquip();
    const issued = issueStandardKit(inv, equip, personId('p1'));
    expect(issued.get(HASTA)).toBe(1);
    expect(issued.get(SLING)).toBe(1);
    expect(issued.has(GLADIUS)).toBe(false);
  });

  it('skips defense slots cleanly when nothing is available', () => {
    const inv = emptyUnitInventory();
    inv.set(GLADIUS, 1);
    const equip = emptyPersonEquip();
    const issued = issueStandardKit(inv, equip, personId('p1'));
    expect(issued.get(GLADIUS)).toBe(1);
    expect(issued.size).toBe(1);
  });
});

describe('totalEquippedForResource', () => {
  it('sums across all Persons', () => {
    const inv = emptyUnitInventory();
    inv.set(GLADIUS, 3);
    const equip = emptyPersonEquip();
    issueOne(inv, equip, personId('p1'), GLADIUS);
    issueOne(inv, equip, personId('p2'), GLADIUS);
    issueOne(inv, equip, personId('p3'), GLADIUS);
    expect(totalEquippedForResource(equip, GLADIUS)).toBe(3);
    expect(totalEquippedForResource(equip, HELMET)).toBe(0);
  });
});
