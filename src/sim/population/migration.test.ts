import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.js';
import { settlementId, type Day, type SettlementId } from '../types.js';
import { hex, hexDistance, type Hex } from '../world/hex.js';
import { createSettlement, type Settlement } from '../world/settlement.js';
import { AGE_BANDS, agedKey, poolFromMap, type CohortKey, type PopulationPool } from './cohort.js';
import { CHARACTER_CLASSES, SEXES, type CharacterClass, type Sex } from './types.js';
import {
  ARRIVAL_RATIONS_REMAINDER_KG_PER_PERSON,
  createCohortCounts,
  createMigrationColumn,
  decideEmigration,
  tickMigration,
  type KnownDestination,
  type MigrationDecision,
} from './migration.js';

const k = (age: (typeof AGE_BANDS)[number], sex: Sex, cls: CharacterClass): CohortKey => ({
  age,
  sex,
  class: cls,
});

const id = (s: string): SettlementId => settlementId(s);

const evenlyDistributedPool = (perBucket: number): PopulationPool => {
  const m = new Map<string, number>();
  for (const a of AGE_BANDS) {
    for (const s of SEXES) {
      for (const c of CHARACTER_CLASSES) {
        m.set(agedKey({ age: a, sex: s, class: c }), perBucket);
      }
    }
  }
  return poolFromMap(m);
};

const buildSettlement = (sid: SettlementId, anchor: Hex, pool: PopulationPool): Settlement => {
  const s = createSettlement({
    id: sid,
    tier: 'town',
    name: String(sid),
    anchor,
    urbanHexes: [anchor],
    catchmentHexes: [],
  });
  // Copy population in.
  for (const [key, n] of pool.cohorts()) s.population.set(key, n);
  return s;
};

const knownDest = (sid: SettlementId, pos: Hex, score: number): KnownDestination => ({
  id: sid,
  positionHex: pos,
  estimatedConditionsScore: score,
});

describe('decideEmigration — knowledge gate', () => {
  it('no known destinations → no migration even with extreme severity', () => {
    const pool = evenlyDistributedPool(100);
    const s = buildSettlement(id('starvington'), hex(0, 0), pool);
    const rng = createRng('no-known');
    const decision = decideEmigration({
      settlement: s,
      unmetWantSeverity: 1,
      reason: 'famine',
      knownBetterDestinations: [],
      rng,
    });
    expect(decision).toBeNull();
  });

  it('single known destination is sufficient if severity is high enough', () => {
    const pool = evenlyDistributedPool(100);
    const s = buildSettlement(id('starvington'), hex(0, 0), pool);
    const rng = createRng('one-known');
    const decision = decideEmigration({
      settlement: s,
      unmetWantSeverity: 0.9,
      reason: 'famine',
      knownBetterDestinations: [knownDest(id('haven'), hex(20, 0), 0.7)],
      rng,
    });
    expect(decision).not.toBeNull();
    expect(decision?.toSettlement).toBe(id('haven'));
  });

  it('picks the highest-scored destination when multiple are known', () => {
    const pool = evenlyDistributedPool(100);
    const s = buildSettlement(id('starvington'), hex(0, 0), pool);
    const rng = createRng('multi-known');
    const decision = decideEmigration({
      settlement: s,
      unmetWantSeverity: 0.9,
      reason: 'famine',
      knownBetterDestinations: [
        knownDest(id('mid'), hex(10, 0), 0.4),
        knownDest(id('best'), hex(30, 0), 0.9),
        knownDest(id('low'), hex(5, 0), 0.2),
      ],
      rng,
    });
    expect(decision?.toSettlement).toBe(id('best'));
  });
});

describe('decideEmigration — severity threshold', () => {
  it('severity below threshold → no migration', () => {
    const pool = evenlyDistributedPool(100);
    const s = buildSettlement(id('cozy'), hex(0, 0), pool);
    const rng = createRng('low-severity');
    const decision = decideEmigration({
      settlement: s,
      unmetWantSeverity: 0.05,
      reason: 'opportunity',
      knownBetterDestinations: [knownDest(id('haven'), hex(10, 0), 0.5)],
      rng,
    });
    expect(decision).toBeNull();
  });

  it('mid severity → some young adults leave; not many old', () => {
    const pool = evenlyDistributedPool(100);
    const s = buildSettlement(id('strained'), hex(0, 0), pool);
    const rng = createRng('mid-severity');
    const decision = decideEmigration({
      settlement: s,
      unmetWantSeverity: 0.4,
      reason: 'famine',
      knownBetterDestinations: [knownDest(id('haven'), hex(10, 0), 0.6)],
      rng,
    });
    expect(decision).not.toBeNull();
    if (!decision) return;
    let youngAdult = 0;
    let elder = 0;
    for (const [key, n] of decision.cohorts) {
      if (key.age === '20-24' || key.age === '25-29') youngAdult += n;
      if (key.age === '70-74' || key.age === '75-79' || key.age === '80+') elder += n;
    }
    expect(youngAdult).toBeGreaterThan(elder);
  });

  it('severe famine → larger total fraction leaves than mid severity', () => {
    const make = (): Settlement =>
      buildSettlement(id('farm'), hex(0, 0), evenlyDistributedPool(200));
    const dest = [knownDest(id('haven'), hex(30, 0), 0.8)];
    const sumLeavers = (d: MigrationDecision | null): number => {
      if (!d) return 0;
      let n = 0;
      for (const v of d.cohorts.values()) n += v;
      return n;
    };
    const mid = decideEmigration({
      settlement: make(),
      unmetWantSeverity: 0.4,
      reason: 'famine',
      knownBetterDestinations: dest,
      rng: createRng('mid-vs-severe-1'),
    });
    const severe = decideEmigration({
      settlement: make(),
      unmetWantSeverity: 0.95,
      reason: 'famine',
      knownBetterDestinations: dest,
      rng: createRng('mid-vs-severe-2'),
    });
    expect(sumLeavers(severe)).toBeGreaterThan(sumLeavers(mid));
  });

  it('plague reason draws even old/young; famine skews young-adult', () => {
    const make = (): Settlement => buildSettlement(id('p'), hex(0, 0), evenlyDistributedPool(500));
    const dest = [knownDest(id('haven'), hex(20, 0), 0.7)];

    const sumByAge = (d: MigrationDecision | null): { young: number; old: number; mid: number } => {
      const r = { young: 0, old: 0, mid: 0 };
      if (!d) return r;
      for (const [key, n] of d.cohorts) {
        if (key.age === '0-4' || key.age === '5-9') r.young += n;
        else if (key.age === '70-74' || key.age === '75-79' || key.age === '80+') r.old += n;
        else r.mid += n;
      }
      return r;
    };

    const famine = decideEmigration({
      settlement: make(),
      unmetWantSeverity: 0.8,
      reason: 'famine',
      knownBetterDestinations: dest,
      rng: createRng('famine-skew'),
    });
    const plague = decideEmigration({
      settlement: make(),
      unmetWantSeverity: 0.8,
      reason: 'plague',
      knownBetterDestinations: dest,
      rng: createRng('plague-flat'),
    });
    const fa = sumByAge(famine);
    const pl = sumByAge(plague);
    // Plague has more old + young as a fraction of total than famine does.
    const famineEdgeShare = (fa.young + fa.old) / Math.max(1, fa.young + fa.old + fa.mid);
    const plagueEdgeShare = (pl.young + pl.old) / Math.max(1, pl.young + pl.old + pl.mid);
    expect(plagueEdgeShare).toBeGreaterThan(famineEdgeShare);
  });

  it('decision draws from the pool and never asks for more people than exist in any cohort', () => {
    // Tiny pool: 2 people per cohort. Severe famine. Selection must clamp.
    const pool = evenlyDistributedPool(2);
    const s = buildSettlement(id('tiny'), hex(0, 0), pool);
    const rng = createRng('tiny-pool');
    const decision = decideEmigration({
      settlement: s,
      unmetWantSeverity: 1,
      reason: 'famine',
      knownBetterDestinations: [knownDest(id('haven'), hex(5, 0), 0.7)],
      rng,
    });
    if (!decision) return;
    for (const [key, n] of decision.cohorts) {
      expect(n).toBeLessThanOrEqual(s.population.count(key));
    }
  });

  it('does not include slaves in emigration (slaves cannot leave)', () => {
    const pool = evenlyDistributedPool(100);
    const s = buildSettlement(id('slavetown'), hex(0, 0), pool);
    const decision = decideEmigration({
      settlement: s,
      unmetWantSeverity: 0.95,
      reason: 'famine',
      knownBetterDestinations: [knownDest(id('haven'), hex(10, 0), 0.7)],
      rng: createRng('no-slaves'),
    });
    if (!decision) return;
    for (const [key] of decision.cohorts) {
      expect(key.class).not.toBe('slave');
    }
  });

  it('is deterministic given the same RNG', () => {
    const make = (): Settlement => buildSettlement(id('det'), hex(0, 0), evenlyDistributedPool(50));
    const a = decideEmigration({
      settlement: make(),
      unmetWantSeverity: 0.7,
      reason: 'famine',
      knownBetterDestinations: [knownDest(id('haven'), hex(20, 0), 0.6)],
      rng: createRng('det-same'),
    });
    const b = decideEmigration({
      settlement: make(),
      unmetWantSeverity: 0.7,
      reason: 'famine',
      knownBetterDestinations: [knownDest(id('haven'), hex(20, 0), 0.6)],
      rng: createRng('det-same'),
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (!a || !b) return;
    let aTotal = 0;
    let bTotal = 0;
    for (const v of a.cohorts.values()) aTotal += v;
    for (const v of b.cohorts.values()) bTotal += v;
    expect(aTotal).toBe(bTotal);
  });
});

describe('createMigrationColumn', () => {
  it('starts at the origin hex with zero days on road and the given rations', () => {
    const decision: MigrationDecision = {
      fromSettlement: id('a'),
      toSettlement: id('b'),
      cohorts: createCohortCounts([[k('20-24', 'female', 'plebeian'), 30]]),
      reason: 'famine',
    };
    const c = createMigrationColumn({
      id: 'col-1',
      decision,
      originHex: hex(0, 0),
      destinationHex: hex(15, 0),
      initialRationsKg: 100,
    });
    expect(c.id).toBe('col-1');
    expect(c.position.q).toBe(0);
    expect(c.daysOnRoad).toBe(0);
    expect(c.rationsKg).toBe(100);
    expect(c.cohorts.get(k('20-24', 'female', 'plebeian'))).toBe(30);
    expect(c.reason).toBe('famine');
  });

  it('rejects empty id', () => {
    const decision: MigrationDecision = {
      fromSettlement: id('a'),
      toSettlement: id('b'),
      cohorts: createCohortCounts([[k('20-24', 'female', 'plebeian'), 30]]),
      reason: 'famine',
    };
    expect(() =>
      createMigrationColumn({
        id: '',
        decision,
        originHex: hex(0, 0),
        destinationHex: hex(5, 0),
        initialRationsKg: 100,
      }),
    ).toThrow();
  });

  it('rejects negative rations', () => {
    const decision: MigrationDecision = {
      fromSettlement: id('a'),
      toSettlement: id('b'),
      cohorts: createCohortCounts([[k('20-24', 'female', 'plebeian'), 30]]),
      reason: 'famine',
    };
    expect(() =>
      createMigrationColumn({
        id: 'x',
        decision,
        originHex: hex(0, 0),
        destinationHex: hex(5, 0),
        initialRationsKg: -1,
      }),
    ).toThrow();
  });
});

describe('tickMigration — movement', () => {
  it('column moves toward destination at ~15 hex/day baseline', () => {
    const decision: MigrationDecision = {
      fromSettlement: id('a'),
      toSettlement: id('b'),
      cohorts: createCohortCounts([[k('20-24', 'female', 'plebeian'), 50]]),
      reason: 'famine',
    };
    const column = createMigrationColumn({
      id: 'mv',
      decision,
      originHex: hex(0, 0),
      destinationHex: hex(60, 0),
      initialRationsKg: 10000,
    });
    const r = tickMigration({
      column,
      season: 'summer',
      today: 1 as Day,
      rng: createRng('move-1'),
    });
    expect(hexDistance(r.column.position, hex(0, 0))).toBeGreaterThan(10);
    expect(hexDistance(r.column.position, hex(0, 0))).toBeLessThanOrEqual(15);
    expect(r.arrived).toBe(false);
    expect(r.column.daysOnRoad).toBe(1);
  });

  it('arrives after distance / speed days', () => {
    const decision: MigrationDecision = {
      fromSettlement: id('a'),
      toSettlement: id('b'),
      cohorts: createCohortCounts([[k('25-29', 'male', 'plebeian'), 20]]),
      reason: 'opportunity',
    };
    let column = createMigrationColumn({
      id: 'arrive',
      decision,
      originHex: hex(0, 0),
      destinationHex: hex(30, 0),
      initialRationsKg: 10000,
    });
    // 30 hex / 15 per day = 2 days.
    let arrived = false;
    for (let day = 1; day <= 5 && !arrived; day++) {
      const r = tickMigration({
        column,
        season: 'summer',
        today: day as Day,
        rng: createRng(`arrive-${day}`),
      });
      column = r.column;
      arrived = r.arrived;
    }
    expect(arrived).toBe(true);
    expect(column.position.q).toBe(30);
    expect(column.position.r).toBe(0);
  });

  it('a column already at destination arrives without moving', () => {
    const decision: MigrationDecision = {
      fromSettlement: id('a'),
      toSettlement: id('b'),
      cohorts: createCohortCounts([[k('20-24', 'female', 'plebeian'), 5]]),
      reason: 'opportunity',
    };
    const column = createMigrationColumn({
      id: 'here',
      decision,
      originHex: hex(5, 5),
      destinationHex: hex(5, 5),
      initialRationsKg: 50,
    });
    const r = tickMigration({
      column,
      season: 'summer',
      today: 1 as Day,
      rng: createRng('here'),
    });
    expect(r.arrived).toBe(true);
    expect(r.column.position.q).toBe(5);
    expect(r.column.position.r).toBe(5);
    expect(r.deathsEnRoute.size).toBe(0);
    expect(r.rationsConsumed).toBe(0);
  });
});

describe('tickMigration — rations', () => {
  it('consumes rations at ~0.4 kg per adult-equivalent per day', () => {
    const decision: MigrationDecision = {
      fromSettlement: id('a'),
      toSettlement: id('b'),
      cohorts: createCohortCounts([[k('25-29', 'male', 'plebeian'), 100]]),
      reason: 'famine',
    };
    const column = createMigrationColumn({
      id: 'rations',
      decision,
      originHex: hex(0, 0),
      destinationHex: hex(60, 0),
      initialRationsKg: 1000,
    });
    const r = tickMigration({
      column,
      season: 'summer',
      today: 1 as Day,
      rng: createRng('rations'),
    });
    // 100 adults × 0.4 kg ≈ 40 kg/day.
    expect(r.rationsConsumed).toBeCloseTo(40, 0);
    expect(r.column.rationsKg).toBeCloseTo(960, 0);
  });

  it('children consume less than adults; elders intermediate', () => {
    const adults: MigrationDecision = {
      fromSettlement: id('a'),
      toSettlement: id('b'),
      cohorts: createCohortCounts([[k('25-29', 'male', 'plebeian'), 100]]),
      reason: 'famine',
    };
    const children: MigrationDecision = {
      fromSettlement: id('a'),
      toSettlement: id('b'),
      cohorts: createCohortCounts([[k('5-9', 'male', 'plebeian'), 100]]),
      reason: 'famine',
    };
    const elders: MigrationDecision = {
      fromSettlement: id('a'),
      toSettlement: id('b'),
      cohorts: createCohortCounts([[k('70-74', 'male', 'plebeian'), 100]]),
      reason: 'famine',
    };
    const colA = createMigrationColumn({
      id: 'a',
      decision: adults,
      originHex: hex(0, 0),
      destinationHex: hex(60, 0),
      initialRationsKg: 1000,
    });
    const colC = createMigrationColumn({
      id: 'c',
      decision: children,
      originHex: hex(0, 0),
      destinationHex: hex(60, 0),
      initialRationsKg: 1000,
    });
    const colE = createMigrationColumn({
      id: 'e',
      decision: elders,
      originHex: hex(0, 0),
      destinationHex: hex(60, 0),
      initialRationsKg: 1000,
    });
    const rA = tickMigration({
      column: colA,
      season: 'summer',
      today: 1 as Day,
      rng: createRng('aa'),
    });
    const rC = tickMigration({
      column: colC,
      season: 'summer',
      today: 1 as Day,
      rng: createRng('cc'),
    });
    const rE = tickMigration({
      column: colE,
      season: 'summer',
      today: 1 as Day,
      rng: createRng('ee'),
    });
    expect(rC.rationsConsumed).toBeLessThan(rA.rationsConsumed);
    expect(rE.rationsConsumed).toBeLessThan(rA.rationsConsumed);
    expect(rE.rationsConsumed).toBeGreaterThan(rC.rationsConsumed);
  });

  it('deaths accrue when out of rations', () => {
    const decision: MigrationDecision = {
      fromSettlement: id('a'),
      toSettlement: id('b'),
      cohorts: createCohortCounts([[k('25-29', 'male', 'plebeian'), 200]]),
      reason: 'famine',
    };
    let column = createMigrationColumn({
      id: 'starve',
      decision,
      originHex: hex(0, 0),
      destinationHex: hex(200, 0),
      initialRationsKg: 0, // nothing to eat
    });
    let totalDeaths = 0;
    let initialPop = 0;
    for (const v of column.cohorts.values()) initialPop += v;
    for (let day = 1; day <= 10; day++) {
      const r = tickMigration({
        column,
        season: 'summer',
        today: day as Day,
        rng: createRng(`starve-${day}`),
      });
      column = r.column;
      for (const v of r.deathsEnRoute.values()) totalDeaths += v;
    }
    expect(totalDeaths).toBeGreaterThan(0);
    let remaining = 0;
    for (const v of column.cohorts.values()) remaining += v;
    expect(remaining).toBe(initialPop - totalDeaths);
  });

  it('a column with rations to spare has no starvation deaths', () => {
    const decision: MigrationDecision = {
      fromSettlement: id('a'),
      toSettlement: id('b'),
      cohorts: createCohortCounts([[k('25-29', 'male', 'plebeian'), 50]]),
      reason: 'opportunity',
    };
    let column = createMigrationColumn({
      id: 'fed',
      decision,
      originHex: hex(0, 0),
      destinationHex: hex(150, 0),
      initialRationsKg: 100000, // way more than needed
    });
    let totalDeaths = 0;
    for (let day = 1; day <= 10; day++) {
      const r = tickMigration({
        column,
        season: 'summer',
        today: day as Day,
        rng: createRng(`fed-${day}`),
      });
      column = r.column;
      for (const v of r.deathsEnRoute.values()) totalDeaths += v;
    }
    expect(totalDeaths).toBe(0);
  });
});

describe('tickMigration — determinism', () => {
  it('same inputs and seed produce identical results', () => {
    const decision: MigrationDecision = {
      fromSettlement: id('a'),
      toSettlement: id('b'),
      cohorts: createCohortCounts([[k('25-29', 'male', 'plebeian'), 60]]),
      reason: 'famine',
    };
    const make = (): ReturnType<typeof createMigrationColumn> =>
      createMigrationColumn({
        id: 'det',
        decision,
        originHex: hex(0, 0),
        destinationHex: hex(40, 0),
        initialRationsKg: 0,
      });
    let colA = make();
    let colB = make();
    for (let day = 1; day <= 5; day++) {
      const ra = tickMigration({
        column: colA,
        season: 'summer',
        today: day as Day,
        rng: createRng(`det-${day}`),
      });
      const rb = tickMigration({
        column: colB,
        season: 'summer',
        today: day as Day,
        rng: createRng(`det-${day}`),
      });
      colA = ra.column;
      colB = rb.column;
      expect(ra.rationsConsumed).toBe(rb.rationsConsumed);
      let aDeaths = 0;
      let bDeaths = 0;
      for (const v of ra.deathsEnRoute.values()) aDeaths += v;
      for (const v of rb.deathsEnRoute.values()) bDeaths += v;
      expect(aDeaths).toBe(bDeaths);
    }
    expect(colA.position.q).toBe(colB.position.q);
    expect(colA.position.r).toBe(colB.position.r);
  });
});

describe('exported constants', () => {
  it('arrival rations remainder is a positive number (callers can check budget)', () => {
    expect(ARRIVAL_RATIONS_REMAINDER_KG_PER_PERSON).toBeGreaterThan(0);
  });
});
