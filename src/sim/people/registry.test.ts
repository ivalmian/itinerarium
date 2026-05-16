import { describe, expect, it } from 'vitest';

import { createRng } from '../rng.js';
import { factionId, personId } from '../types.js';
import { createPerson, markDead } from './person.js';
import {
  allAlive,
  emptyPersonRegistry,
  getPerson,
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
