import { describe, expect, it } from 'vitest';

import { createRng } from '../rng.js';
import { demoKey } from '../population/demographics.js';
import { factionId, personId, resourceId, type ResourceId, type PersonId } from '../types.js';
import { createPerson, markDead } from './person.js';
import {
  ageToBand,
  allAlive,
  emptyPersonRegistry,
  getPerson,
  markPersonsDeadByDemographics,
  registerPerson,
  tickAnnualAging,
} from './registry.js';

const makePerson = (id: string, age: number) =>
  createPerson({
    id: personId(id),
    name: `Name ${id}`,
    age,
    sex: 'male',
    class: 'plebeian',
    faction: factionId('faction:test'),
    role: 'soldier',
    bornOnDay: 0,
  });

describe('registry basics', () => {
  it('register / get round-trip', () => {
    const reg = emptyPersonRegistry();
    const p = makePerson('p1', 25);
    registerPerson(reg, p);
    expect(getPerson(reg, personId('p1'))?.id).toBe(personId('p1'));
    expect(getPerson(reg, personId('absent'))).toBeUndefined();
  });

  it('registerPerson replaces an existing record by id', () => {
    const reg = emptyPersonRegistry();
    registerPerson(reg, makePerson('p1', 25));
    registerPerson(reg, makePerson('p1', 99));
    expect(getPerson(reg, personId('p1'))?.age).toBe(99);
  });

  it('allAlive returns true only when every id is alive', () => {
    const reg = emptyPersonRegistry();
    registerPerson(reg, makePerson('p1', 25));
    registerPerson(reg, makePerson('p2', 30));
    expect(allAlive(reg, [personId('p1'), personId('p2')])).toBe(true);
    registerPerson(reg, markDead(makePerson('p2', 30), 100));
    expect(allAlive(reg, [personId('p1'), personId('p2')])).toBe(false);
    // Missing id treated as not alive too.
    expect(allAlive(reg, [personId('p1'), personId('absent')])).toBe(false);
  });
});

describe('tickAnnualAging', () => {
  it('ages every alive Person by one year and returns death count', () => {
    const reg = emptyPersonRegistry();
    registerPerson(reg, makePerson('alive-young', 25));
    registerPerson(reg, makePerson('alive-old', 85));
    registerPerson(reg, markDead(makePerson('already-dead', 60), 50));

    // Determinism check first: same Rng → same outcome.
    const deaths = tickAnnualAging(reg, 365, createRng('age-1'));
    expect(typeof deaths).toBe('number');
    expect(getPerson(reg, personId('alive-young'))?.age).toBe(26);
    // Already-dead is untouched.
    expect(getPerson(reg, personId('already-dead'))?.age).toBe(60);
  });

  it('determinism: same seed produces identical aging outcomes', () => {
    const seed = (): ReturnType<typeof tickAnnualAging> => {
      const reg = emptyPersonRegistry();
      for (let i = 0; i < 50; i++) {
        registerPerson(reg, makePerson(`p-${i}`, 15 + i));
      }
      return tickAnnualAging(reg, 365, createRng('annual-1'));
    };
    const a = seed();
    const b = seed();
    expect(a).toBe(b);
  });
});

describe('ageToBand', () => {
  it.each([
    [0, '0-4'],
    [4, '0-4'],
    [5, '5-9'],
    [9, '5-9'],
    [25, '25-29'],
    [79, '75-79'],
    [80, '80+'],
    [102, '80+'],
  ])('maps age %i → band %s', (age, band) => {
    expect(ageToBand(age)).toBe(band);
  });
});

describe('markPersonsDeadByDemographics', () => {
  const buildUnitRegistry = (
    unitId: string,
    members: ReadonlyArray<{ idSuffix: string; sex: 'male' | 'female'; age: number }>,
  ) => {
    const reg = emptyPersonRegistry();
    for (const m of members) {
      const p = createPerson({
        id: personId(`p-${m.idSuffix}`),
        name: `Name ${m.idSuffix}`,
        age: m.age,
        sex: m.sex,
        class: 'plebeian',
        faction: factionId('faction:t'),
        role: 'soldier',
        bornOnDay: 0,
        unitId,
      });
      registerPerson(reg, p);
    }
    return reg;
  };

  it('marks the correct number of bucket-matching Persons dead and returns their equipment', () => {
    const reg = buildUnitRegistry('unit-1', [
      { idSuffix: 'a', sex: 'male', age: 22 }, // 20-24
      { idSuffix: 'b', sex: 'male', age: 23 }, // 20-24
      { idSuffix: 'c', sex: 'male', age: 32 }, // 30-34
      { idSuffix: 'd', sex: 'female', age: 21 }, // 20-24
    ]);
    const equip = new Map<PersonId, Map<ResourceId, number>>();
    equip.set(personId('p-a'), new Map([[resourceId('goods.gladius'), 1]]));
    equip.set(personId('p-b'), new Map([[resourceId('goods.shield'), 1]]));

    const removed = new Map<string, number>([
      [demoKey('male', '20-24'), 2],
    ]);
    const { deadIds, returnedKit } = markPersonsDeadByDemographics(
      reg,
      equip,
      'unit-1',
      removed,
      createRng('cas-1'),
      400,
    );

    expect(deadIds.length).toBe(2);
    // Both dead Persons are 20-24 males.
    for (const id of deadIds) {
      const p = getPerson(reg, id);
      expect(p?.status).toBe('dead');
      expect(p?.diedOnDay).toBe(400);
      expect(p?.sex).toBe('male');
      expect(ageToBand(p!.age)).toBe('20-24');
    }
    // Their equipment is back in the returned kit and removed from the slot map.
    expect(returnedKit.get(resourceId('goods.gladius'))).toBe(1);
    expect(returnedKit.get(resourceId('goods.shield'))).toBe(1);
    expect(equip.size).toBe(0);
    // Other Persons untouched.
    expect(getPerson(reg, personId('p-c'))?.status).toBe('alive');
    expect(getPerson(reg, personId('p-d'))?.status).toBe('alive');
  });

  it('falls back to other unit Persons when a bucket is exhausted', () => {
    const reg = buildUnitRegistry('unit-2', [
      { idSuffix: 'a', sex: 'male', age: 22 },
      { idSuffix: 'b', sex: 'female', age: 31 },
    ]);
    // Request 2 dead from a bucket that only has 1 member; the second
    // death falls back to any other alive Person in the unit.
    const removed = new Map<string, number>([[demoKey('male', '20-24'), 2]]);
    const { deadIds } = markPersonsDeadByDemographics(
      reg,
      undefined,
      'unit-2',
      removed,
      createRng('fallback'),
      100,
    );
    expect(deadIds.length).toBe(2);
    expect(getPerson(reg, personId('p-a'))?.status).toBe('dead');
    expect(getPerson(reg, personId('p-b'))?.status).toBe('dead');
  });

  it('ignores Persons from other units', () => {
    const reg = emptyPersonRegistry();
    registerPerson(
      reg,
      createPerson({
        id: personId('p-our'),
        name: 'Ours',
        age: 25,
        sex: 'male',
        class: 'plebeian',
        faction: factionId('f'),
        role: 'soldier',
        bornOnDay: 0,
        unitId: 'unit-A',
      }),
    );
    registerPerson(
      reg,
      createPerson({
        id: personId('p-other'),
        name: 'Other',
        age: 25,
        sex: 'male',
        class: 'plebeian',
        faction: factionId('f'),
        role: 'soldier',
        bornOnDay: 0,
        unitId: 'unit-B',
      }),
    );
    markPersonsDeadByDemographics(
      reg,
      undefined,
      'unit-A',
      new Map([[demoKey('male', '25-29'), 5]]),
      createRng('iso'),
      10,
    );
    expect(getPerson(reg, personId('p-our'))?.status).toBe('dead');
    expect(getPerson(reg, personId('p-other'))?.status).toBe('alive');
  });
});
