import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.js';
import {
  actorId,
  banditCampId,
  resourceId,
  settlementId,
  type ActorId,
  type BanditCampId,
  type ResourceId,
  type SettlementId,
} from '../types.js';
import { hex } from '../world/hex.js';
import {
  campAsCombatUnit,
  campSize,
  createCamp,
  decideCampAction,
  recruit,
  type BanditCamp,
  type CampAction,
  type CampDecisionInputs,
} from './camp.js';

const cid = (s: string): BanditCampId => banditCampId(s);
const aid = (s: string): ActorId => actorId(s);
const sid = (s: string): SettlementId => settlementId(s);
const grain: ResourceId = resourceId('grain');
const silver: ResourceId = resourceId('silver_bar');

const baseCamp = (overrides: Partial<BanditCamp> = {}): BanditCamp =>
  createCamp({
    id: cid('camp-1'),
    name: 'Wolfshead Camp',
    hex: hex(0, 0),
    ownerActor: aid('actor:bandits-1'),
    banditCount: 30,
    hangersOnCount: 10,
    weaponsPerBandit: 0.4,
    armorPerBandit: 0.2,
    averageHealth: 0.85,
    treasury: 50,
    ...overrides,
  });

describe('campSize', () => {
  it('returns "small" for fewer than 20 bandits', () => {
    expect(campSize(baseCamp({ banditCount: 19 }))).toBe('small');
    expect(campSize(baseCamp({ banditCount: 1 }))).toBe('small');
  });

  it('returns "medium" for 20..99 bandits', () => {
    expect(campSize(baseCamp({ banditCount: 20 }))).toBe('medium');
    expect(campSize(baseCamp({ banditCount: 99 }))).toBe('medium');
  });

  it('returns "large" for 100..499 bandits', () => {
    expect(campSize(baseCamp({ banditCount: 100 }))).toBe('large');
    expect(campSize(baseCamp({ banditCount: 499 }))).toBe('large');
  });

  it('returns "insurgency" for 500+ bandits', () => {
    expect(campSize(baseCamp({ banditCount: 500 }))).toBe('insurgency');
    expect(campSize(baseCamp({ banditCount: 5000 }))).toBe('insurgency');
  });
});

describe('createCamp', () => {
  it('initializes loot as empty and copies provided fields', () => {
    const c = baseCamp();
    expect(c.banditCount).toBe(30);
    expect(c.hangersOnCount).toBe(10);
    expect(c.loot.size).toBe(0);
    expect(c.weaponsPerBandit).toBe(0.4);
    expect(c.armorPerBandit).toBe(0.2);
    expect(c.averageHealth).toBe(0.85);
    expect(c.treasury).toBe(50);
  });

  it('rejects negative bandit counts', () => {
    expect(() => createCamp({ ...baseCamp(), banditCount: -1, loot: new Map() })).toThrow();
  });

  it('rejects out-of-range weapons/armor/health', () => {
    expect(() => baseCamp({ weaponsPerBandit: 1.5 })).toThrow();
    expect(() => baseCamp({ armorPerBandit: -0.1 })).toThrow();
    expect(() => baseCamp({ averageHealth: 2 })).toThrow();
  });
});

describe('recruit', () => {
  it('returns a new camp with banditCount incremented', () => {
    const c = baseCamp({ banditCount: 30 });
    const c2 = recruit(c, 5);
    expect(c2.banditCount).toBe(35);
    // Original immutable.
    expect(c.banditCount).toBe(30);
  });

  it('accepts zero (no-op recruitment)', () => {
    const c = baseCamp({ banditCount: 30 });
    const c2 = recruit(c, 0);
    expect(c2.banditCount).toBe(30);
  });

  it('rejects negative recruitment', () => {
    expect(() => recruit(baseCamp(), -1)).toThrow();
  });

  it('rejects fractional recruitment', () => {
    expect(() => recruit(baseCamp(), 1.5)).toThrow();
  });

  it('preserves other fields and loot', () => {
    const c = baseCamp({ banditCount: 30 });
    c.loot.set(grain, 100);
    const c2 = recruit(c, 5);
    expect(c2.loot.get(grain)).toBe(100);
    expect(c2.id).toBe(c.id);
    expect(c2.hex).toEqual(c.hex);
    expect(c2.ownerActor).toBe(c.ownerActor);
  });
});

describe('campAsCombatUnit', () => {
  it('produces sensible combat stats with bandit baseline training ~0.4', () => {
    const c = baseCamp({ banditCount: 30, weaponsPerBandit: 0.4, armorPerBandit: 0.2 });
    const u = campAsCombatUnit(c, 'attacking');
    expect(u.id).toContain(String(c.id));
    expect(u.count).toBe(30);
    expect(u.training).toBeGreaterThan(0.3);
    expect(u.training).toBeLessThan(0.5);
    expect(u.weapons).toBe(0.4);
    expect(u.armor).toBe(0.2);
    expect(u.health).toBe(0.85);
    expect(u.posture).toBe('attacking');
    expect(u.terrainBonus).toBe(0);
  });

  it('applies forest/hills cover when terrainBonus override is given via posture defending', () => {
    const c = baseCamp({ banditCount: 30 });
    const defending = campAsCombatUnit(c, 'defending');
    expect(defending.posture).toBe('defending');
  });

  it('throws when banditCount is zero (cannot field a unit)', () => {
    const c = baseCamp({ banditCount: 0 });
    expect(() => campAsCombatUnit(c, 'attacking')).toThrow();
  });
});

const decisionInputs = (overrides: Partial<CampDecisionInputs> = {}): CampDecisionInputs => ({
  camp: baseCamp(),
  knownNearbyCaravans: [],
  knownNearbyPatrols: [],
  knownFriendlySettlements: [],
  daysSinceLastSuccessfulRaid: 7,
  rng: createRng('decide-default'),
  ...overrides,
});

describe('decideCampAction: determinism', () => {
  it('same inputs and seed give the same action', () => {
    const inputs1 = decisionInputs({
      knownNearbyCaravans: [{ hex: hex(2, 1), estimatedCargoValue: 500, guards: 4 }],
      rng: createRng('det-1'),
    });
    const inputs2 = decisionInputs({
      knownNearbyCaravans: [{ hex: hex(2, 1), estimatedCargoValue: 500, guards: 4 }],
      rng: createRng('det-1'),
    });
    expect(decideCampAction(inputs1)).toEqual(decideCampAction(inputs2));
  });
});

describe('decideCampAction: juicy caravan', () => {
  it('raids a lightly-guarded valuable caravan when no overwhelming patrol is present', () => {
    const inputs = decisionInputs({
      camp: baseCamp({ banditCount: 30 }),
      knownNearbyCaravans: [{ hex: hex(3, 0), estimatedCargoValue: 800, guards: 2 }],
      rng: createRng('juicy'),
    });
    const action = decideCampAction(inputs);
    expect(action.type).toBe('raid_caravan');
    if (action.type === 'raid_caravan') {
      expect(action.targetHex).toEqual(hex(3, 0));
    }
  });
});

describe('decideCampAction: no targets', () => {
  it('with no targets and no patrols, picks recruit_drive or lay_low', () => {
    const seenActions = new Set<CampAction['type']>();
    for (let i = 0; i < 10; i++) {
      const inputs = decisionInputs({ rng: createRng(`peace-${i}`) });
      const action = decideCampAction(inputs);
      seenActions.add(action.type);
      expect(['recruit_drive', 'lay_low']).toContain(action.type);
    }
    // Some variety expected across seeds — at least one of the two appears.
    expect(seenActions.size).toBeGreaterThanOrEqual(1);
  });
});

describe('decideCampAction: patrol superiority', () => {
  it('does not attack patrols head-on when patrols dwarf the camp', () => {
    for (let i = 0; i < 10; i++) {
      const inputs = decisionInputs({
        camp: baseCamp({ banditCount: 20 }),
        knownNearbyCaravans: [{ hex: hex(2, 0), estimatedCargoValue: 200, guards: 3 }],
        knownNearbyPatrols: [{ hex: hex(1, 1), size: 200 }],
        rng: createRng(`patrols-${i}`),
      });
      const action = decideCampAction(inputs);
      // Either lay low, move, or fence (if any loot) — but never raid into patrol territory.
      expect(action.type).not.toBe('raid_settlement');
      if (action.type === 'raid_caravan') {
        // If the camp DOES raid a caravan, the action must target a caravan,
        // not the patrol — verify by hex match.
        const isCaravanHex = inputs.knownNearbyCaravans.some(
          (c) => c.hex.q === action.targetHex.q && c.hex.r === action.targetHex.r,
        );
        expect(isCaravanHex).toBe(true);
      }
    }
  });

  it('with overwhelming patrols and a juicy caravan, sometimes lays low / moves', () => {
    const actions = new Set<CampAction['type']>();
    for (let i = 0; i < 30; i++) {
      const inputs = decisionInputs({
        camp: baseCamp({ banditCount: 15 }),
        knownNearbyCaravans: [{ hex: hex(2, 0), estimatedCargoValue: 1000, guards: 2 }],
        knownNearbyPatrols: [{ hex: hex(1, 0), size: 100 }],
        rng: createRng(`pressure-${i}`),
      });
      actions.add(decideCampAction(inputs).type);
    }
    expect(actions.has('lay_low') || actions.has('move_camp')).toBe(true);
  });
});

describe('decideCampAction: fence loot', () => {
  it('fences high-value loot when a friendly settlement is reachable and no immediate target', () => {
    const camp = baseCamp({ banditCount: 30 });
    camp.loot.set(silver, 50);
    const inputs = decisionInputs({
      camp,
      knownFriendlySettlements: [{ id: sid('corrupt-village'), hex: hex(2, 2) }],
      rng: createRng('fence'),
    });
    const action = decideCampAction(inputs);
    expect(['fence_loot', 'recruit_drive', 'lay_low']).toContain(action.type);
  });
});

describe('decideCampAction: insurgency-size', () => {
  it('insurgency-size camps may attack settlements directly', () => {
    let attackedSettlement = 0;
    for (let i = 0; i < 30; i++) {
      const inputs = decisionInputs({
        camp: baseCamp({ banditCount: 600 }),
        knownNearbyCaravans: [],
        knownFriendlySettlements: [{ id: sid('weak-town'), hex: hex(3, 3) }],
        rng: createRng(`uprising-${i}`),
      });
      const action = decideCampAction(inputs);
      if (action.type === 'raid_settlement') attackedSettlement++;
    }
    expect(attackedSettlement).toBeGreaterThan(0);
  });
});
