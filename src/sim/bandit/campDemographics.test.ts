import { describe, expect, it } from 'vitest';
import { actorId, banditCampId } from '../types.js';
import { hex } from '../world/hex.js';
import { createRng } from '../rng.js';
import { applyBanditCasualties, createCamp } from './camp.js';
import { demoKey, totalDemographics } from '../population/demographics.js';

const baseCampWithDemo = (banditCount = 10): ReturnType<typeof createCamp> =>
  createCamp({
    id: banditCampId('camp-demo-1'),
    name: 'Wolfshead',
    hex: hex(0, 0),
    ownerActor: actorId('actor:bandits-1'),
    banditCount,
    hangersOnCount: 4,
    weaponsPerBandit: 0.4,
    armorPerBandit: 0.15,
    averageHealth: 0.85,
    treasury: 0,
    banditDemographics: new Map([
      [demoKey('male', '20-24'), Math.floor(banditCount * 0.6)],
      [demoKey('male', '25-29'), Math.ceil(banditCount * 0.3)],
      [demoKey('female', '25-29'), banditCount - Math.floor(banditCount * 0.6) - Math.ceil(banditCount * 0.3)],
    ]),
    hangersOnDemographics: new Map([
      [demoKey('male', '5-9'), 2],
      [demoKey('female', '5-9'), 2],
    ]),
  });

describe('BanditCamp demographics', () => {
  it('persists demographics through createCamp', () => {
    const c = baseCampWithDemo(10);
    expect(totalDemographics(c.banditDemographics)).toBe(10);
    expect(totalDemographics(c.hangersOnDemographics)).toBe(4);
  });

  it('createCamp defensively copies the demographics map', () => {
    const original = new Map([[demoKey('male', '25-29'), 5]]);
    const c = createCamp({
      id: banditCampId('camp-copy'),
      name: 'Copy',
      hex: hex(0, 0),
      ownerActor: actorId('a'),
      banditCount: 5,
      hangersOnCount: 0,
      weaponsPerBandit: 0,
      armorPerBandit: 0,
      averageHealth: 0.5,
      banditDemographics: original,
    });
    original.set(demoKey('female', '25-29'), 99);
    expect(c.banditDemographics?.size).toBe(1);
  });
});

describe('applyBanditCasualties', () => {
  it('drains banditCount and banditDemographics together', () => {
    const c = baseCampWithDemo(10);
    const { camp: updated, removed } = applyBanditCasualties(c, 4, createRng('drain-1'));
    expect(updated.banditCount).toBe(6);
    expect(totalDemographics(updated.banditDemographics)).toBe(6);
    let totalRemoved = 0;
    for (const v of removed.values()) totalRemoved += v;
    expect(totalRemoved).toBe(4);
    // Hangers-on are not touched by combat losses.
    expect(updated.hangersOnCount).toBe(4);
    expect(totalDemographics(updated.hangersOnDemographics)).toBe(4);
  });

  it('caps deaths at banditCount', () => {
    const c = baseCampWithDemo(3);
    const { camp: updated, removed } = applyBanditCasualties(c, 100, createRng('cap'));
    expect(updated.banditCount).toBe(0);
    let r = 0;
    for (const v of removed.values()) r += v;
    expect(r).toBe(3);
  });

  it('returns the same camp on zero/negative deaths', () => {
    const c = baseCampWithDemo(5);
    const r1 = applyBanditCasualties(c, 0, createRng('z'));
    expect(r1.camp).toBe(c);
    expect(r1.removed.size).toBe(0);
  });

  it('still works on camps without demographics', () => {
    const c = createCamp({
      id: banditCampId('camp-nodemo'),
      name: 'NoDemo',
      hex: hex(0, 0),
      ownerActor: actorId('a'),
      banditCount: 8,
      hangersOnCount: 0,
      weaponsPerBandit: 0,
      armorPerBandit: 0,
      averageHealth: 0.5,
    });
    const { camp: updated, removed } = applyBanditCasualties(c, 3, createRng('nd'));
    expect(updated.banditCount).toBe(5);
    expect(removed.size).toBe(0);
    expect(updated.banditDemographics).toBeUndefined();
  });
});
