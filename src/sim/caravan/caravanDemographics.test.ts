import { describe, expect, it } from 'vitest';
import { actorId, caravanId } from '../types.js';
import { createRng } from '../rng.js';
import { applyCrewCasualties, createCaravan, type Caravan, type CrewMember } from './caravan.js';
import { demoKey, totalDemographics } from '../population/demographics.js';

const ownerId = actorId('vibian');

const buildCaravanWithDemo = (overrides?: Partial<CrewMember>): Caravan => {
  const merchantDemo = new Map([[demoKey('male', '30-34'), 1]]);
  const droverDemo = new Map([
    [demoKey('male', '25-29'), 2],
    [demoKey('female', '25-29'), 1],
  ]);
  const guardDemo = new Map([[demoKey('male', '25-29'), 2]]);
  return createCaravan({
    id: caravanId('cara-demo-1'),
    ownerActor: ownerId,
    position: { q: 0, r: 0 },
    crew: [
      { kind: 'merchant', count: 1, weapons: 0, armor: 0, demographics: merchantDemo, ...overrides },
      { kind: 'drover', count: 3, weapons: 0, armor: 0, demographics: droverDemo },
      { kind: 'caravan_guard', count: 2, weapons: 0.4, armor: 0.2, demographics: guardDemo },
    ],
    animals: { mule: 5 },
    vehicles: {},
  });
};

describe('CrewMember demographics', () => {
  it('persists when constructing a caravan', () => {
    const c = buildCaravanWithDemo();
    let total = 0;
    for (const m of c.crew) total += totalDemographics(m.demographics);
    expect(total).toBe(6); // 1 + 3 + 2
  });

  it('demographics sum matches each crew entry count', () => {
    const c = buildCaravanWithDemo();
    for (const m of c.crew) {
      expect(totalDemographics(m.demographics)).toBe(m.count);
    }
  });

  it('createCaravan defensively copies the demographics map', () => {
    const original = new Map([[demoKey('male', '30-34'), 1]]);
    const c = createCaravan({
      id: caravanId('cara-copy'),
      ownerActor: ownerId,
      position: { q: 0, r: 0 },
      crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0, demographics: original }],
      animals: { mule: 1 },
      vehicles: {},
    });
    // Mutate the original; the caravan should not see the change.
    original.set(demoKey('female', '20-24'), 99);
    expect(c.crew[0]?.demographics?.size).toBe(1);
  });

  it('survives a caravan whose CrewMember has no demographics field', () => {
    // Backward compatibility: existing tests with no demographics field
    // should still produce a valid caravan.
    const c = createCaravan({
      id: caravanId('cara-nodemo'),
      ownerActor: ownerId,
      position: { q: 0, r: 0 },
      crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
      animals: { mule: 1 },
      vehicles: {},
    });
    expect(c.crew[0]?.demographics).toBeUndefined();
  });
});

describe('applyCrewCasualties', () => {
  it('drains both count and demographics proportionally', () => {
    const c = buildCaravanWithDemo();
    const initialTotal = c.crew.reduce((acc, m) => acc + m.count, 0);
    const removed = applyCrewCasualties(c, 2, createRng('cas-1'));
    const newTotal = c.crew.reduce((acc, m) => acc + m.count, 0);
    expect(newTotal).toBe(initialTotal - 2);
    // For each remaining crew entry the demographics count should equal
    // the crew count (or undefined if the entry never had demographics).
    for (const m of c.crew) {
      if (m.demographics !== undefined) {
        expect(totalDemographics(m.demographics)).toBe(m.count);
      }
    }
    let removedTotal = 0;
    for (const m of removed.values()) for (const v of m.values()) removedTotal += v;
    expect(removedTotal).toBe(2);
  });

  it('removes zero-count crew entries', () => {
    const c = buildCaravanWithDemo();
    // 6 total — kill all of them.
    applyCrewCasualties(c, 6, createRng('cas-all'));
    expect(c.crew.length).toBe(0);
  });

  it('is a no-op when deaths are zero or negative', () => {
    const c = buildCaravanWithDemo();
    const before = c.crew.map((m) => m.count).join(',');
    applyCrewCasualties(c, 0, createRng('zero'));
    expect(c.crew.map((m) => m.count).join(',')).toBe(before);
    applyCrewCasualties(c, -3, createRng('neg'));
    expect(c.crew.map((m) => m.count).join(',')).toBe(before);
  });

  it('handles caravans with mixed-demographics crew (some entries lacking demographics)', () => {
    const c = createCaravan({
      id: caravanId('cara-mixed'),
      ownerActor: ownerId,
      position: { q: 0, r: 0 },
      crew: [
        { kind: 'merchant', count: 1, weapons: 0, armor: 0 },
        {
          kind: 'caravan_guard',
          count: 2,
          weapons: 0.4,
          armor: 0.2,
          demographics: new Map([[demoKey('male', '25-29'), 2]]),
        },
      ],
      animals: { mule: 1 },
      vehicles: {},
    });
    applyCrewCasualties(c, 2, createRng('mixed'));
    // Merchant taken first (1), then 1 guard.
    expect(c.crew.length).toBe(1);
    expect(c.crew[0]?.kind).toBe('caravan_guard');
    expect(c.crew[0]?.count).toBe(1);
    expect(totalDemographics(c.crew[0]?.demographics)).toBe(1);
  });
});
