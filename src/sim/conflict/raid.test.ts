import { describe, expect, it } from 'vitest';
import { createCamp, type BanditCamp } from '../bandit/camp.js';
import { createRng } from '../rng.js';
import {
  actorId,
  banditCampId,
  resourceId,
  settlementId,
  type ActorId,
  type Quantity,
  type ResourceId,
  type SettlementId,
} from '../types.js';
import { hex } from '../world/hex.js';
import { createSettlement, type Settlement } from '../world/settlement.js';
import { campaignerUnit, type CombatUnit } from './battle.js';
import { createPatrol, type Patrol } from './patrol.js';
import { resolveRaid, type RaidInputs } from './raid.js';

const aid = (s: string): ActorId => actorId(s);
const sid = (s: string): SettlementId => settlementId(s);
const rid = (s: string): ResourceId => resourceId(s);

const town = (overrides: { id?: SettlementId; tier?: Settlement['tier'] } = {}): Settlement =>
  createSettlement({
    id: overrides.id ?? sid('aquileia'),
    tier: overrides.tier ?? 'town',
    name: 'Aquileia',
    anchor: hex(0, 0),
    urbanHexes: [hex(0, 0), hex(1, 0)],
    catchmentHexes: [hex(2, 0), hex(0, 1), hex(1, 1)],
  });

const baseCamp = (overrides: Partial<Parameters<typeof createCamp>[0]> = {}): BanditCamp =>
  createCamp({
    id: banditCampId('camp-A'),
    name: 'Wolfshead',
    hex: hex(5, 5),
    ownerActor: aid('bandits-A'),
    banditCount: 80,
    hangersOnCount: 25,
    weaponsPerBandit: 0.5,
    armorPerBandit: 0.3,
    averageHealth: 0.85,
    ...overrides,
  });

const baseUnit = (overrides: Partial<Parameters<typeof campaignerUnit>[0]> = {}): CombatUnit =>
  campaignerUnit({
    id: 'garrison',
    posture: 'defending',
    count: 50,
    training: 0.85,
    weapons: 0.85,
    armor: 0.7,
    health: 0.95,
    terrainBonus: 0,
    ...overrides,
  });

const baseGarrison = (overrides: Partial<Parameters<typeof createPatrol>[0]> = {}): Patrol =>
  createPatrol({
    id: 'cohors-1',
    kind: 'provincial_garrison',
    ownerActor: aid('governor'),
    basedAt: sid('aquileia'),
    route: [hex(0, 0)],
    unit: baseUnit(),
    ...overrides,
  });

const baseRaid = (overrides: Partial<RaidInputs> = {}): RaidInputs => ({
  attacker: baseCamp(),
  target: town(),
  defendingPatrols: [],
  militiaCount: 0,
  wallLevel: 0,
  settlementStockpile: new Map<ResourceId, Quantity>(),
  rng: createRng('raid-default'),
  ...overrides,
});

// --- Defender construction --------------------------------------------------

describe('resolveRaid: defender unit construction', () => {
  it('a small bandit raid against a well-garrisoned walled town fails', () => {
    const r = resolveRaid(
      baseRaid({
        attacker: baseCamp({ banditCount: 20, weaponsPerBandit: 0.2, armorPerBandit: 0.1 }),
        defendingPatrols: [
          baseGarrison({ unit: baseUnit({ id: 'g', count: 50, posture: 'defending' }) }),
        ],
        wallLevel: 2,
        rng: createRng('walled-town'),
      }),
    );
    expect(r.outcome).toBe('defender_won');
    // Bandits suffer high casualties — most are dead/captured/routed.
    expect(r.banditCasualties.deaths).toBeGreaterThan(5);
  });

  it('a large bandit raid against an unwalled hamlet with weak militia succeeds', () => {
    const stockpile = new Map<ResourceId, Quantity>([
      [rid('food.grain'), 200],
      [rid('goods.gladius'), 5],
    ]);
    const r = resolveRaid(
      baseRaid({
        attacker: baseCamp({
          banditCount: 150,
          weaponsPerBandit: 0.6,
          armorPerBandit: 0.4,
          averageHealth: 0.95,
        }),
        target: town({ id: sid('hamlet-X'), tier: 'hamlet' }),
        defendingPatrols: [],
        militiaCount: 10,
        wallLevel: 0,
        settlementStockpile: stockpile,
        rng: createRng('hamlet-overrun'),
      }),
    );
    expect(r.outcome).toBe('attacker_won');
    // Loot was taken (some grain at minimum).
    const totalLoot = Array.from(r.lootTaken.values()).reduce((a, b) => a + b, 0);
    expect(totalLoot).toBeGreaterThan(0);
  });
});

// --- Loot priority ----------------------------------------------------------

describe('resolveRaid: loot prioritization', () => {
  it('high-value items are taken before low-value ones when carry capacity is the bottleneck', () => {
    // Carry cap: 150 bandits × 30 kg = 4500 kg of loot.
    // Stockpile: 1000 grain (6.7 kg/u → 6700 kg), 50 weapons (10 kg → 500 kg).
    // valueOf weapons >> grain, so bandits should empty weapons before touching much grain.
    const stockpile = new Map<ResourceId, Quantity>([
      [rid('food.grain'), 1000],
      [rid('goods.gladius'), 50],
    ]);
    const r = resolveRaid(
      baseRaid({
        attacker: baseCamp({
          banditCount: 150,
          weaponsPerBandit: 0.7,
          armorPerBandit: 0.4,
          averageHealth: 0.95,
        }),
        target: town({ id: sid('soft-target'), tier: 'hamlet' }),
        defendingPatrols: [],
        militiaCount: 5,
        wallLevel: 0,
        settlementStockpile: stockpile,
        valueOfResource: (id: ResourceId) => (id === rid('goods.gladius') ? 100 : 1),
        rng: createRng('loot-pick'),
      }),
    );
    expect(r.outcome).toBe('attacker_won');
    expect(r.lootTaken.get(rid('goods.gladius'))).toBe(50);
  });

  it('cargo capacity caps total loot weight', () => {
    const stockpile = new Map<ResourceId, Quantity>([
      // 10000 grain ~ 67000 kg — way more than a bandit raid can carry.
      [rid('food.grain'), 10000],
    ]);
    const r = resolveRaid(
      baseRaid({
        attacker: baseCamp({ banditCount: 100 }),
        target: town({ id: sid('big-target'), tier: 'hamlet' }),
        defendingPatrols: [],
        militiaCount: 0,
        wallLevel: 0,
        settlementStockpile: stockpile,
        rng: createRng('cap-test'),
      }),
    );
    expect(r.outcome).toBe('attacker_won');
    const grain = r.lootTaken.get(rid('food.grain')) ?? 0;
    // 100 bandits × ~30 kg / (6.7 kg/grain) ≈ 447 grain. Exact cap is implementation
    // detail but cannot exceed the stockpile and must respect carry capacity.
    expect(grain).toBeLessThanOrEqual(10000);
    expect(grain).toBeLessThan(10000); // strict — capacity binds
  });
});

// --- Captives ---------------------------------------------------------------

describe('resolveRaid: captives', () => {
  it('attacker takes some captives when they overrun the settlement', () => {
    const r = resolveRaid(
      baseRaid({
        attacker: baseCamp({ banditCount: 200, weaponsPerBandit: 0.6, armorPerBandit: 0.4 }),
        defendingPatrols: [],
        militiaCount: 5,
        wallLevel: 0,
        rng: createRng('captives'),
      }),
    );
    expect(r.outcome).toBe('attacker_won');
    expect(r.captivesTaken).toBeGreaterThan(0);
  });

  it('no captives when defender wins', () => {
    const r = resolveRaid(
      baseRaid({
        attacker: baseCamp({ banditCount: 15, weaponsPerBandit: 0.2, armorPerBandit: 0 }),
        defendingPatrols: [
          baseGarrison({ unit: baseUnit({ id: 'g', count: 80, posture: 'defending' }) }),
        ],
        wallLevel: 3,
        rng: createRng('no-captives'),
      }),
    );
    expect(r.outcome).toBe('defender_won');
    expect(r.captivesTaken).toBe(0);
  });
});

// --- Determinism ------------------------------------------------------------

describe('resolveRaid: determinism', () => {
  it('same seed produces identical outcome and loot', () => {
    const stockpile = new Map<ResourceId, Quantity>([
      [rid('food.grain'), 500],
      [rid('goods.gladius'), 10],
    ]);
    const inputs1 = baseRaid({
      attacker: baseCamp({ banditCount: 100 }),
      militiaCount: 5,
      wallLevel: 0,
      settlementStockpile: new Map(stockpile),
      rng: createRng('det-raid'),
    });
    const inputs2 = baseRaid({
      attacker: baseCamp({ banditCount: 100 }),
      militiaCount: 5,
      wallLevel: 0,
      settlementStockpile: new Map(stockpile),
      rng: createRng('det-raid'),
    });
    const r1 = resolveRaid(inputs1);
    const r2 = resolveRaid(inputs2);
    expect(r1.outcome).toBe(r2.outcome);
    expect(r1.captivesTaken).toBe(r2.captivesTaken);
    expect(r1.banditCasualties).toEqual(r2.banditCasualties);
    expect(r1.settlementCasualties).toEqual(r2.settlementCasualties);
    expect(Array.from(r1.lootTaken.entries()).sort()).toEqual(
      Array.from(r2.lootTaken.entries()).sort(),
    );
  });
});

// --- Edge cases -------------------------------------------------------------

describe('resolveRaid: edge cases', () => {
  it('raids against a settlement with no defenders fight only against zero', () => {
    const r = resolveRaid(
      baseRaid({
        attacker: baseCamp({ banditCount: 100 }),
        defendingPatrols: [],
        militiaCount: 0,
        wallLevel: 0,
        settlementStockpile: new Map([[rid('food.grain'), 50]]),
        rng: createRng('undefended'),
      }),
    );
    expect(r.outcome).toBe('attacker_won');
  });

  it('rejects a wallLevel out of range', () => {
    expect(() =>
      resolveRaid(baseRaid({ wallLevel: 5 as unknown as RaidInputs['wallLevel'] })),
    ).toThrow();
  });

  it('survivors output is the same as the underlying battle survivors', () => {
    const r = resolveRaid(baseRaid({ militiaCount: 30, wallLevel: 1 }));
    expect(r.survivors).toBe(r.battle.survivors);
  });

  it('mutual rout possible with similarly-matched forces (returns either valid outcome)', () => {
    const r = resolveRaid(
      baseRaid({
        attacker: baseCamp({ banditCount: 80, weaponsPerBandit: 0.5, armorPerBandit: 0.3 }),
        defendingPatrols: [
          baseGarrison({
            unit: baseUnit({
              id: 'g',
              count: 70,
              training: 0.6,
              weapons: 0.5,
              armor: 0.4,
              posture: 'defending',
            }),
          }),
        ],
        wallLevel: 1,
        rng: createRng('coin-flip'),
      }),
    );
    expect(['attacker_won', 'defender_won', 'mutual_rout']).toContain(r.outcome);
  });
});
