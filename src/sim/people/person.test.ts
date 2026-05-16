import { describe, expect, it } from 'vitest';

import { characterId, personId } from '../types.js';
import {
  ageOneYear,
  createPerson,
  isAlive,
  markCaptured,
  markDead,
  markMissing,
  markWounded,
} from './person.js';

const base = (overrides: Partial<Parameters<typeof createPerson>[0]> = {}) =>
  createPerson({
    id: personId('person-1'),
    name: 'Marcus Vibianus',
    age: 30,
    sex: 'male',
    class: 'plebeian',
    faction: 'faction:legio-i' as Parameters<typeof createPerson>[0]['faction'],
    role: 'soldier',
    bornOnDay: 0,
    ...overrides,
  });

describe('createPerson', () => {
  it('produces a default-alive Person with full health', () => {
    const p = base();
    expect(p.status).toBe('alive');
    expect(p.health).toBe(1);
    expect(isAlive(p)).toBe(true);
  });

  it('rejects empty names', () => {
    expect(() => createPerson({ ...base(), name: '' })).toThrow();
  });

  it('rejects negative or fractional age', () => {
    expect(() => base({ age: -1 })).toThrow();
    expect(() => base({ age: 12.5 })).toThrow();
  });

  it('rejects health outside [0, 1]', () => {
    expect(() => base({ health: -0.1 })).toThrow();
    expect(() => base({ health: 1.4 })).toThrow();
  });

  it('records optional unitId and namedCharacterId only when provided', () => {
    const linked = base({
      unitId: 'patrol-1',
      namedCharacterId: characterId('char:gov'),
    });
    expect(linked.unitId).toBe('patrol-1');
    expect(linked.namedCharacterId).toBe(characterId('char:gov'));
    const minimal = base();
    expect(minimal.unitId).toBeUndefined();
    expect(minimal.namedCharacterId).toBeUndefined();
  });
});

describe('status transitions', () => {
  it('markDead records diedOnDay and flips status', () => {
    const dead = markDead(base(), 365);
    expect(dead.status).toBe('dead');
    expect(dead.diedOnDay).toBe(365);
    expect(isAlive(dead)).toBe(false);
  });

  it('markWounded clamps health and sets status', () => {
    const wounded = markWounded(base(), 0.4);
    expect(wounded.status).toBe('wounded');
    expect(wounded.health).toBe(0.4);
    expect(markWounded(base(), 1.5).health).toBe(1);
    expect(markWounded(base(), -0.5).health).toBe(0);
  });

  it('markCaptured and markMissing flip status', () => {
    expect(markCaptured(base()).status).toBe('captured');
    expect(markMissing(base()).status).toBe('missing');
  });
});

describe('ageOneYear', () => {
  it('ages an alive Person by one year when mortality sample misses', () => {
    const p = base({ age: 30 });
    // pDeath at age 31 is 0.012; a sample of 0.5 is well above.
    const aged = ageOneYear(p, 0.5, 100);
    expect(aged.age).toBe(31);
    expect(aged.status).toBe('alive');
  });

  it('marks the Person dead when the mortality sample fires', () => {
    const p = base({ age: 75 });
    // pDeath at age 76 is 0.09; a sample of 0.01 fires.
    const aged = ageOneYear(p, 0.01, 730);
    expect(aged.age).toBe(76);
    expect(aged.status).toBe('dead');
    expect(aged.diedOnDay).toBe(730);
  });

  it('does not touch non-alive Persons', () => {
    const captive = markCaptured(base());
    expect(ageOneYear(captive, 0.001, 99)).toBe(captive);
  });
});
