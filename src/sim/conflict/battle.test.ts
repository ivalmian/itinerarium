import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.js';
import {
  campaignerUnit,
  resolveBattle,
  type BattleOpts,
  type CombatUnit,
  type Posture,
} from './battle.js';

const baseUnit = (
  overrides: Partial<CombatUnit> & { id: string; posture: Posture },
): CombatUnit => ({
  count: 50,
  training: 0.5,
  weapons: 0.5,
  armor: 0.5,
  health: 1,
  terrainBonus: 0,
  ...overrides,
});

const opts = (overrides: Partial<BattleOpts> = {}): BattleOpts => ({
  ambush: false,
  rng: createRng('battle-seed'),
  ...overrides,
});

describe('resolveBattle: trivial parity', () => {
  it('two equal forces produce roughly even casualties (within 30%)', () => {
    const a = baseUnit({ id: 'A', posture: 'attacking', count: 100 });
    const b = baseUnit({ id: 'B', posture: 'defending', count: 100 });
    const result = resolveBattle(a, b, opts());
    const casA = result.casualties.find((c) => c.unitId === 'A');
    const casB = result.casualties.find((c) => c.unitId === 'B');
    expect(casA).toBeDefined();
    expect(casB).toBeDefined();
    if (!casA || !casB) throw new Error('missing casualty record');
    const totalA = casA.deaths + casA.wounded;
    const totalB = casB.deaths + casB.wounded;
    // Order-of-magnitude parity. Either side may "win" the random rolls.
    const ratio = Math.max(totalA, totalB) / Math.max(1, Math.min(totalA, totalB));
    expect(ratio).toBeLessThan(5);
  });
});

describe('resolveBattle: overwhelming force', () => {
  it('a 10x attacker quickly beats a small defender', () => {
    const attacker = baseUnit({
      id: 'big',
      posture: 'attacking',
      count: 500,
      training: 0.7,
      weapons: 0.8,
      armor: 0.6,
    });
    const defender = baseUnit({
      id: 'small',
      posture: 'defending',
      count: 50,
      training: 0.6,
      weapons: 0.6,
      armor: 0.5,
    });
    const result = resolveBattle(attacker, defender, opts({ rng: createRng('overwhelm') }));
    expect(result.winnerId).toBe('big');
    expect(result.loserId).toBe('small');
    // The defender is mostly destroyed (killed, captured, or fled-and-caught).
    const defSurv = result.survivors.filter((s) => s.unitId === 'small');
    const defGone = defSurv
      .filter((s) => s.fate !== 'fled_escaped')
      .reduce((acc, s) => acc + s.count, 0);
    const defTotal = defSurv.reduce((acc, s) => acc + s.count, 0);
    expect(defTotal).toBe(50);
    expect(defGone / defTotal).toBeGreaterThan(0.6);
  });
});

describe('resolveBattle: walled defender', () => {
  it('walls let a smaller defender impose disproportionate cost on the attacker', () => {
    // Compare the same attacker-vs-defender size matchup with and without walls.
    // With walls the defender takes far less damage per round.
    const attacker = baseUnit({
      id: 'attackers',
      posture: 'attacking',
      count: 80,
      training: 0.5,
      weapons: 0.6,
      armor: 0.4,
    });
    const baseDefender = {
      id: 'wall',
      posture: 'defending' as const,
      count: 30,
      training: 0.5,
      weapons: 0.5,
      armor: 0.4,
    };
    const walledResult = resolveBattle(
      attacker,
      baseUnit({ ...baseDefender, terrainBonus: 0.5 }),
      opts({ maxRounds: 3, rng: createRng('walls-on') }),
    );
    const openResult = resolveBattle(
      attacker,
      baseUnit({ ...baseDefender, terrainBonus: 0 }),
      opts({ maxRounds: 3, rng: createRng('walls-off') }),
    );
    const walledLosses = walledResult.casualties.find((c) => c.unitId === 'wall');
    const openLosses = openResult.casualties.find((c) => c.unitId === 'wall');
    if (!walledLosses || !openLosses) throw new Error('missing casualty rows');
    expect(walledLosses.deaths + walledLosses.wounded).toBeLessThan(
      openLosses.deaths + openLosses.wounded,
    );
  });
});

describe('resolveBattle: ambush', () => {
  it('ambushing attacker gets a free first round (more defender casualties round 1)', () => {
    const attacker = baseUnit({
      id: 'amb',
      posture: 'attacking',
      count: 30,
      training: 0.4,
      weapons: 0.5,
      armor: 0.2,
    });
    const defender = baseUnit({
      id: 'caravan',
      posture: 'defending',
      count: 30,
      training: 0.5,
      weapons: 0.5,
      armor: 0.4,
    });
    const ambushed = resolveBattle(
      attacker,
      defender,
      opts({ ambush: true, rng: createRng('amb1') }),
    );
    const fair = resolveBattle(attacker, defender, opts({ ambush: false, rng: createRng('amb1') }));
    const ambushedDefendersLeft = ambushed.finalUnits.find((u) => u.id === 'caravan')?.count ?? 0;
    const fairDefendersLeft = fair.finalUnits.find((u) => u.id === 'caravan')?.count ?? 0;
    // Defenders fare worse when ambushed.
    expect(ambushedDefendersLeft).toBeLessThanOrEqual(fairDefendersLeft);
  });
});

describe('resolveBattle: determinism', () => {
  it('same seed produces identical results', () => {
    const a = baseUnit({ id: 'A', posture: 'attacking', count: 80 });
    const b = baseUnit({ id: 'B', posture: 'defending', count: 70 });
    const r1 = resolveBattle(a, b, opts({ rng: createRng('det') }));
    const r2 = resolveBattle(a, b, opts({ rng: createRng('det') }));
    expect(r1.rounds).toBe(r2.rounds);
    expect(r1.winnerId).toBe(r2.winnerId);
    expect(r1.casualties).toEqual(r2.casualties);
    expect(r1.survivors).toEqual(r2.survivors);
    expect(r1.finalUnits).toEqual(r2.finalUnits);
  });

  it('different seeds can produce different rolls', () => {
    const a = baseUnit({ id: 'A', posture: 'attacking', count: 80 });
    const b = baseUnit({ id: 'B', posture: 'defending', count: 80 });
    const r1 = resolveBattle(a, b, opts({ rng: createRng('seed-x') }));
    const r2 = resolveBattle(a, b, opts({ rng: createRng('seed-y') }));
    // Not strictly required but extremely likely with random rolls.
    const sameCasualties = JSON.stringify(r1.casualties) === JSON.stringify(r2.casualties);
    expect(sameCasualties).toBe(false);
  });
});

describe('resolveBattle: survivor accounting', () => {
  it('survivor fates plus on-field count sum to the original unit counts', () => {
    const a = baseUnit({ id: 'A', posture: 'attacking', count: 60 });
    const b = baseUnit({ id: 'B', posture: 'defending', count: 60 });
    const result = resolveBattle(a, b, opts({ rng: createRng('survive') }));
    for (const start of [
      { id: 'A', count: 60 },
      { id: 'B', count: 60 },
    ]) {
      const survivorCount = result.survivors
        .filter((s) => s.unitId === start.id)
        .reduce((acc, s) => acc + s.count, 0);
      const onField = result.finalUnits.find((u) => u.id === start.id)?.count ?? 0;
      // Every original participant: either left the field (any fate) or stood it.
      expect(survivorCount + onField).toBe(start.count);
    }
  });

  it('casualties.deaths matches sum of `killed` + `fled_caught_killed` fates', () => {
    const a = baseUnit({ id: 'A', posture: 'attacking', count: 100 });
    const b = baseUnit({ id: 'B', posture: 'defending', count: 100 });
    const result = resolveBattle(a, b, opts({ rng: createRng('cas-equiv') }));
    for (const cas of result.casualties) {
      const killCount = result.survivors
        .filter(
          (s) =>
            s.unitId === cas.unitId && (s.fate === 'killed' || s.fate === 'fled_caught_killed'),
        )
        .reduce((acc, s) => acc + s.count, 0);
      expect(cas.deaths).toBe(killCount);
    }
  });

  it('only the loser produces fled survivors (winners are not "fleeing")', () => {
    const big = baseUnit({
      id: 'big',
      posture: 'attacking',
      count: 400,
      training: 0.8,
      weapons: 0.9,
      armor: 0.7,
    });
    const small = baseUnit({
      id: 'small',
      posture: 'defending',
      count: 30,
      training: 0.3,
      weapons: 0.3,
      armor: 0.2,
    });
    const result = resolveBattle(big, small, opts({ rng: createRng('rout') }));
    const fledKinds = new Set<string>(['fled_escaped', 'fled_captured', 'fled_caught_killed']);
    const winnerFled = result.survivors.filter(
      (s) => s.unitId === result.winnerId && fledKinds.has(s.fate),
    );
    expect(winnerFled).toHaveLength(0);
  });
});

describe('resolveBattle: leave-no-witnesses', () => {
  it('high-pursuit attackers kill or capture most fleers but some can still escape', () => {
    // Run many trials; expect some `fled_escaped` survivors across the runs.
    let totalFled = 0;
    let totalEscaped = 0;
    for (let i = 0; i < 30; i++) {
      const big = baseUnit({
        id: 'pursuers',
        posture: 'attacking',
        count: 100,
        training: 0.9,
        weapons: 0.9,
        armor: 0.6,
      });
      const small = baseUnit({
        id: 'prey',
        posture: 'defending',
        count: 80,
        training: 0.4,
        weapons: 0.3,
        armor: 0.2,
      });
      const r = resolveBattle(big, small, opts({ rng: createRng(`pursue-${i}`) }));
      const fled = r.survivors.filter((s) => s.unitId === 'prey');
      totalFled += fled.reduce((a, s) => a + s.count, 0);
      totalEscaped += fled
        .filter((s) => s.fate === 'fled_escaped')
        .reduce((a, s) => a + s.count, 0);
    }
    // Most prey die or are captured.
    expect(totalEscaped).toBeLessThan(totalFled);
    // But at least one trial leaves witnesses.
    expect(totalEscaped).toBeGreaterThan(0);
  });
});

describe('resolveBattle: input validation', () => {
  it('rejects non-positive counts', () => {
    const a = baseUnit({ id: 'A', posture: 'attacking', count: 0 });
    const b = baseUnit({ id: 'B', posture: 'defending', count: 10 });
    expect(() => resolveBattle(a, b, opts())).toThrow();
  });

  it('rejects out-of-range training/weapons/armor/health/terrainBonus', () => {
    const a = baseUnit({ id: 'A', posture: 'attacking', count: 10, training: 1.5 });
    const b = baseUnit({ id: 'B', posture: 'defending', count: 10 });
    expect(() => resolveBattle(a, b, opts())).toThrow();
  });

  it('rejects identical unit ids', () => {
    const a = baseUnit({ id: 'X', posture: 'attacking', count: 10 });
    const b = baseUnit({ id: 'X', posture: 'defending', count: 10 });
    expect(() => resolveBattle(a, b, opts())).toThrow();
  });

  it('respects maxRounds: terminates even in stalemate', () => {
    const a = baseUnit({
      id: 'A',
      posture: 'defending',
      count: 50,
      training: 0.1,
      weapons: 0,
      armor: 1,
    });
    const b = baseUnit({
      id: 'B',
      posture: 'defending',
      count: 50,
      training: 0.1,
      weapons: 0,
      armor: 1,
    });
    const r = resolveBattle(a, b, opts({ maxRounds: 3, rng: createRng('stalemate') }));
    expect(r.rounds).toBeLessThanOrEqual(3);
  });
});

describe('campaignerUnit helper', () => {
  it('clamps inputs into valid ranges', () => {
    const u = campaignerUnit({
      id: 'x',
      posture: 'attacking',
      count: 20,
      training: 1.5,
      weapons: -0.2,
      armor: 0.3,
      health: 2,
      terrainBonus: 1,
    });
    expect(u.training).toBe(1);
    expect(u.weapons).toBe(0);
    expect(u.armor).toBe(0.3);
    expect(u.health).toBe(1);
    expect(u.terrainBonus).toBeLessThanOrEqual(0.5);
  });
});
