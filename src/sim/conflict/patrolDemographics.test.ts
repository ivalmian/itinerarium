import { describe, expect, it } from 'vitest';
import { actorId, settlementId } from '../types.js';
import { hex } from '../world/hex.js';
import { createRng } from '../rng.js';
import { applyPatrolCasualties, createPatrol } from './patrol.js';
import { campaignerUnit } from './battle.js';
import { demoKey, totalDemographics } from '../population/demographics.js';

const buildPatrol = (count = 12): ReturnType<typeof createPatrol> => {
  const unit = campaignerUnit({
    id: 'patrol:test-1',
    posture: 'attacking',
    count,
    training: 0.7,
    weapons: 0.5,
    armor: 0.3,
    health: 0.95,
    terrainBonus: 0,
  });
  const demo = new Map([
    [demoKey('male', '20-24'), Math.floor(count * 0.5)],
    [demoKey('male', '25-29'), Math.ceil(count * 0.4)],
    [demoKey('male', '30-34'), count - Math.floor(count * 0.5) - Math.ceil(count * 0.4)],
  ]);
  return createPatrol({
    id: 'patrol-test-1',
    kind: 'city_watch',
    ownerActor: actorId('actor:city-corp'),
    basedAt: settlementId('settlement-1'),
    route: [hex(0, 0), hex(1, 0)],
    unit,
    demographics: demo,
  });
};

describe('Patrol demographics', () => {
  it('persists demographics through createPatrol', () => {
    const p = buildPatrol(12);
    expect(totalDemographics(p.demographics)).toBe(12);
  });

  it('createPatrol defensively copies the demographics map', () => {
    const original = new Map([[demoKey('male', '25-29'), 5]]);
    const unit = campaignerUnit({
      id: 'patrol:test-2',
      posture: 'attacking',
      count: 5,
      training: 0.5,
      weapons: 0.5,
      armor: 0.3,
      health: 1,
      terrainBonus: 0,
    });
    const p = createPatrol({
      id: 'patrol-2',
      kind: 'city_watch',
      ownerActor: actorId('a'),
      basedAt: settlementId('s'),
      route: [hex(0, 0)],
      unit,
      demographics: original,
    });
    original.set(demoKey('female', '25-29'), 9);
    expect(p.demographics?.size).toBe(1);
  });
});

describe('applyPatrolCasualties', () => {
  it('drains unit.count and demographics together', () => {
    const p = buildPatrol(12);
    const { patrol: updated, removed } = applyPatrolCasualties(p, 4, createRng('p-cas'));
    expect(updated.unit.count).toBe(8);
    expect(totalDemographics(updated.demographics)).toBe(8);
    let r = 0;
    for (const v of removed.values()) r += v;
    expect(r).toBe(4);
  });

  it('returns same patrol for zero deaths', () => {
    const p = buildPatrol(5);
    const r = applyPatrolCasualties(p, 0, createRng('z'));
    expect(r.patrol).toBe(p);
  });

  it('handles patrols without demographics', () => {
    const unit = campaignerUnit({
      id: 'patrol:nodemo',
      posture: 'attacking',
      count: 6,
      training: 0.5,
      weapons: 0.5,
      armor: 0.3,
      health: 1,
      terrainBonus: 0,
    });
    const p = createPatrol({
      id: 'patrol-nodemo',
      kind: 'city_watch',
      ownerActor: actorId('a'),
      basedAt: settlementId('s'),
      route: [hex(0, 0)],
      unit,
    });
    const { patrol: updated, removed } = applyPatrolCasualties(p, 3, createRng('nd'));
    expect(updated.unit.count).toBe(3);
    expect(removed.size).toBe(0);
    expect(updated.demographics).toBeUndefined();
  });
});
