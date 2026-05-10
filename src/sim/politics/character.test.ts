import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.js';
import { characterId, factionId } from '../types.js';
import {
  ageOneYear,
  createCharacter,
  generateFullName,
  generateLatinNomen,
  generateLatinPraenomen,
  isAlive,
  LATIN_NOMEN_CHOICES,
  LATIN_PRAENOMEN_FEMALE,
  LATIN_PRAENOMEN_MALE,
  moveTo,
  type NamedCharacter,
} from './character.js';

const baseInput = (): Parameters<typeof createCharacter>[0] => ({
  id: characterId('quintus-vibianus'),
  name: 'Quintus Vibianus',
  age: 40,
  sex: 'male',
  class: 'patrician',
  faction: factionId('vibian-house'),
  location: { q: 0, r: 0 },
});

describe('createCharacter', () => {
  it('populates all required fields and defaults', () => {
    const c = createCharacter(baseInput());
    expect(c.id).toBe(characterId('quintus-vibianus'));
    expect(c.name).toBe('Quintus Vibianus');
    expect(c.age).toBe(40);
    expect(c.sex).toBe('male');
    expect(c.class).toBe('patrician');
    expect(c.faction).toBe(factionId('vibian-house'));
    expect(c.location).toEqual({ q: 0, r: 0 });
    expect(c.status).toBe('alive');
    expect(c.traits).toEqual([]);
    expect(c.role).toBeUndefined();
  });

  it('accepts an optional role', () => {
    const c = createCharacter({ ...baseInput(), role: 'patriarch' });
    expect(c.role).toBe('patriarch');
  });

  it('accepts initial traits', () => {
    const c = createCharacter({ ...baseInput(), traits: ['corrupt', 'generous'] });
    expect(c.traits).toEqual(['corrupt', 'generous']);
  });

  it('rejects empty name', () => {
    expect(() => createCharacter({ ...baseInput(), name: '' })).toThrow();
  });

  it('rejects negative age', () => {
    expect(() => createCharacter({ ...baseInput(), age: -1 })).toThrow();
  });

  it('rejects non-integer age', () => {
    expect(() => createCharacter({ ...baseInput(), age: 5.5 })).toThrow();
  });
});

describe('isAlive', () => {
  it('returns true for alive status', () => {
    const c = createCharacter(baseInput());
    expect(isAlive(c)).toBe(true);
  });

  it('returns false for dead status', () => {
    const c = createCharacter({ ...baseInput(), status: 'dead' });
    expect(isAlive(c)).toBe(false);
  });

  it('captured and missing characters are not "alive" for trade/decision purposes', () => {
    const captured = createCharacter({ ...baseInput(), status: 'captured' });
    const missing = createCharacter({ ...baseInput(), status: 'missing' });
    expect(isAlive(captured)).toBe(false);
    expect(isAlive(missing)).toBe(false);
  });
});

describe('moveTo', () => {
  it('returns a new instance with updated position', () => {
    const c = createCharacter(baseInput());
    const moved = moveTo(c, { q: 5, r: -3 });
    expect(moved.location).toEqual({ q: 5, r: -3 });
    expect(c.location).toEqual({ q: 0, r: 0 });
    expect(moved).not.toBe(c);
  });

  it('preserves all other fields', () => {
    const c = createCharacter({ ...baseInput(), role: 'magistrate', traits: ['just'] });
    const moved = moveTo(c, { q: 1, r: 1 });
    expect(moved.id).toBe(c.id);
    expect(moved.name).toBe(c.name);
    expect(moved.age).toBe(c.age);
    expect(moved.faction).toBe(c.faction);
    expect(moved.role).toBe('magistrate');
    expect(moved.traits).toEqual(['just']);
    expect(moved.status).toBe('alive');
  });
});

describe('ageOneYear', () => {
  it('increments age by 1 for a young adult and keeps them alive almost always', () => {
    const c = createCharacter({ ...baseInput(), age: 30 });
    const rng = createRng('young-aging');
    let alive = 0;
    let totalAge = 0;
    for (let i = 0; i < 1000; i++) {
      const aged = ageOneYear(c, rng);
      expect(aged.age).toBe(31);
      if (aged.status === 'alive') alive++;
      totalAge += aged.age;
    }
    // 30→31 is low-mortality, expect almost everyone to survive a single year.
    expect(alive).toBeGreaterThan(950);
    expect(totalAge).toBe(31 * 1000);
  });

  it('returns a new instance, not mutating the original', () => {
    const c = createCharacter({ ...baseInput(), age: 30 });
    const rng = createRng('immutability');
    const aged = ageOneYear(c, rng);
    expect(aged).not.toBe(c);
    expect(c.age).toBe(30);
  });

  it('a 70-year-old aged 20 years has nearly always died by 90', () => {
    const rng = createRng('elder-mortality');
    let died = 0;
    const N = 200;
    for (let trial = 0; trial < N; trial++) {
      let c = createCharacter({ ...baseInput(), age: 70 });
      const trialRng = rng.derive(`trial-${trial}`);
      for (let y = 0; y < 20 && c.status === 'alive'; y++) {
        c = ageOneYear(c, trialRng);
      }
      if (c.status === 'dead') died++;
    }
    // Roman-era: nearly all 70yo are dead by 90.
    expect(died / N).toBeGreaterThan(0.85);
  });

  it('a dead character is not aged further', () => {
    const c = createCharacter({ ...baseInput(), age: 80, status: 'dead' });
    const rng = createRng('dead-stays-dead');
    const aged = ageOneYear(c, rng);
    expect(aged.status).toBe('dead');
    expect(aged.age).toBe(80);
  });

  it('determinism: same RNG seed → same outcome', () => {
    const c = createCharacter({ ...baseInput(), age: 75 });
    const rngA = createRng('det');
    const rngB = createRng('det');
    let cA = c;
    let cB = c;
    for (let i = 0; i < 20; i++) {
      cA = ageOneYear(cA, rngA);
      cB = ageOneYear(cB, rngB);
    }
    expect(cA.age).toBe(cB.age);
    expect(cA.status).toBe(cB.status);
  });
});

describe('name generators', () => {
  it('generateLatinPraenomen returns a male praenomen for sex=male', () => {
    const rng = createRng('praenomen-m');
    for (let i = 0; i < 100; i++) {
      const n = generateLatinPraenomen(rng, 'male');
      expect(LATIN_PRAENOMEN_MALE).toContain(n);
    }
  });

  it('generateLatinPraenomen returns a female praenomen for sex=female', () => {
    const rng = createRng('praenomen-f');
    for (let i = 0; i < 100; i++) {
      const n = generateLatinPraenomen(rng, 'female');
      expect(LATIN_PRAENOMEN_FEMALE).toContain(n);
    }
  });

  it('generateLatinNomen returns a configured nomen', () => {
    const rng = createRng('nomen');
    for (let i = 0; i < 100; i++) {
      expect(LATIN_NOMEN_CHOICES).toContain(generateLatinNomen(rng));
    }
  });

  it('generateFullName returns "Praenomen Nomen"', () => {
    const rng = createRng('full');
    const name = generateFullName(rng, 'male');
    const [praenomen, nomen, ...rest] = name.split(' ');
    expect(rest).toHaveLength(0);
    expect(praenomen).toBeDefined();
    expect(nomen).toBeDefined();
    expect(LATIN_PRAENOMEN_MALE).toContain(praenomen as string);
    expect(LATIN_NOMEN_CHOICES).toContain(nomen as string);
  });

  it('generateFullName is deterministic for the same RNG state', () => {
    const a = createRng('name-det');
    const b = createRng('name-det');
    for (let i = 0; i < 20; i++) {
      expect(generateFullName(a, 'female')).toBe(generateFullName(b, 'female'));
    }
  });

  it('generates both sexes from the same RNG without crashing', () => {
    const rng = createRng('mixed');
    const names: NamedCharacter['name'][] = [];
    for (let i = 0; i < 20; i++) {
      names.push(generateFullName(rng, i % 2 === 0 ? 'male' : 'female'));
    }
    expect(new Set(names).size).toBeGreaterThan(1);
  });
});

describe('full creation with generated names', () => {
  it('creates a character with a generated name and explicit faction', () => {
    const rng = createRng('integration');
    const name = generateFullName(rng, 'male');
    const c = createCharacter({
      id: characterId('gen-1'),
      name,
      age: 25,
      sex: 'male',
      class: 'plebeian',
      faction: factionId('curia-aquileia'),
      location: { q: 3, r: -2 },
      role: 'merchant',
    });
    expect(c.name).toBe(name);
    expect(c.role).toBe('merchant');
  });
});
