import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.js';
import type { Day } from '../types.js';
import type { Climate, Terrain } from '../world/terrain.js';
import { AGE_BANDS, agedKey, emptyPool, poolFromMap, type CohortKey } from './cohort.js';
import { CHARACTER_CLASSES, SEXES, type CharacterClass, type Sex } from './types.js';
import {
  DISEASES,
  applyEndemicMortality,
  createSettlementHealth,
  declareQuarantine,
  isQuarantined,
  maybeTriggerEpidemic,
  tickInfection,
  transmitFromCaravan,
} from './disease.js';

const k = (age: (typeof AGE_BANDS)[number], sex: Sex, cls: CharacterClass): CohortKey => ({
  age,
  sex,
  class: cls,
});

const evenlyDistributedPool = (perBucket: number): ReturnType<typeof emptyPool> => {
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

describe('DISEASES catalog', () => {
  it('contains the three named v1 diseases from docs/04', () => {
    expect(DISEASES.has('smallpox-analog')).toBe(true);
    expect(DISEASES.has('typhus-analog')).toBe(true);
    expect(DISEASES.has('plague-analog')).toBe(true);
  });

  it('every disease has positive transmission, duration, and at least one mortality entry', () => {
    for (const d of DISEASES.values()) {
      expect(d.baseTransmissionPerDay).toBeGreaterThan(0);
      expect(d.durationDays).toBeGreaterThan(0);
      expect(Object.keys(d.mortalityByAge).length).toBeGreaterThan(0);
      for (const m of Object.values(d.mortalityByAge)) {
        expect(m).toBeGreaterThanOrEqual(0);
        expect(m).toBeLessThan(1);
      }
    }
  });

  it('plague-analog is the most lethal of the three (highest peak per-day mortality)', () => {
    const peakMortality = (id: string): number => {
      const d = DISEASES.get(id);
      if (!d) throw new Error(`missing disease ${id}`);
      let max = 0;
      for (const m of Object.values(d.mortalityByAge)) if (m !== undefined && m > max) max = m;
      return max;
    };
    expect(peakMortality('plague-analog')).toBeGreaterThan(peakMortality('typhus-analog'));
    expect(peakMortality('plague-analog')).toBeGreaterThan(peakMortality('smallpox-analog'));
  });

  it('smallpox-analog confers lifelong immunity in survivors; typhus-analog does not', () => {
    const smallpox = DISEASES.get('smallpox-analog');
    const typhus = DISEASES.get('typhus-analog');
    if (!smallpox || !typhus) throw new Error('missing disease');
    expect(smallpox.immunityInSurvivors).toBe(true);
    expect(typhus.immunityInSurvivors).toBe(false);
  });
});

describe('applyEndemicMortality', () => {
  it('produces deaths roughly in line with adult baseline mortality over a year', () => {
    // For comparison: docs/04 adult baseline ≈ 12/1000/year. Endemic background
    // mortality is the share of baseline attributable to endemic disease (a
    // fraction). We assert the endemic mortality alone is substantially less
    // than total baseline, and positive on a healthy temperate plain.
    const pool = emptyPool();
    pool.set(k('30-34', 'male', 'plebeian'), 10000);
    const rng = createRng('endemic-temperate');
    let deaths = 0;
    for (let day = 0; day < 365; day++) {
      const r = applyEndemicMortality(pool, 'temperate', 'plains', rng, day as Day);
      deaths += r.deaths;
    }
    // Roughly 1-20 per 1000 per year for adults from endemic causes alone.
    // Pool of 10000 → 5-200 deaths/year.
    expect(deaths).toBeGreaterThan(5);
    expect(deaths).toBeLessThan(200);
  });

  it('marsh + warm climate produces more endemic deaths than mountains + alpine', () => {
    const make = (): ReturnType<typeof emptyPool> => {
      const p = emptyPool();
      p.set(k('30-34', 'male', 'plebeian'), 50000);
      p.set(k('30-34', 'female', 'plebeian'), 50000);
      return p;
    };
    const marshPool = make();
    const alpinePool = make();
    let marshDeaths = 0;
    let alpineDeaths = 0;
    const rng = createRng('endemic-comparison');
    for (let day = 0; day < 365; day++) {
      marshDeaths += applyEndemicMortality(
        marshPool,
        'mediterranean',
        'marsh',
        rng.derive('marsh'),
        day as Day,
      ).deaths;
      alpineDeaths += applyEndemicMortality(
        alpinePool,
        'alpine',
        'mountains',
        rng.derive('alpine'),
        day as Day,
      ).deaths;
    }
    expect(marshDeaths).toBeGreaterThan(alpineDeaths);
  });

  it('an empty pool produces zero deaths', () => {
    const rng = createRng('empty-endemic');
    const result = applyEndemicMortality(emptyPool(), 'temperate', 'plains', rng, 0 as Day);
    expect(result.deaths).toBe(0);
  });

  it('infants die at higher rates than adults from endemic causes', () => {
    const adultPool = emptyPool();
    adultPool.set(k('30-34', 'male', 'plebeian'), 10000);
    const infantPool = emptyPool();
    infantPool.set(k('0-4', 'male', 'plebeian'), 10000);
    let adultDeaths = 0;
    let infantDeaths = 0;
    const rng = createRng('cohort-mortality');
    for (let day = 0; day < 365; day++) {
      adultDeaths += applyEndemicMortality(
        adultPool,
        'mediterranean',
        'plains',
        rng.derive('a'),
        day as Day,
      ).deaths;
      infantDeaths += applyEndemicMortality(
        infantPool,
        'mediterranean',
        'plains',
        rng.derive('i'),
        day as Day,
      ).deaths;
    }
    expect(infantDeaths).toBeGreaterThan(adultDeaths);
  });

  it('is deterministic given the same RNG sequence', () => {
    const make = (): ReturnType<typeof emptyPool> => {
      const p = emptyPool();
      p.set(k('30-34', 'male', 'plebeian'), 10000);
      return p;
    };
    const a = make();
    const b = make();
    const ra = createRng('det-endemic');
    const rb = createRng('det-endemic');
    for (let day = 0; day < 100; day++) {
      applyEndemicMortality(a, 'temperate', 'plains', ra, day as Day);
      applyEndemicMortality(b, 'temperate', 'plains', rb, day as Day);
    }
    expect(a.total()).toBe(b.total());
  });
});

describe('createSettlementHealth', () => {
  it('starts with no infections, no immunes, no quarantine', () => {
    const h = createSettlementHealth();
    expect(h.infections.size).toBe(0);
    expect(h.immune.size).toBe(0);
    expect(h.quarantineUntilDay).toBeUndefined();
  });
});

describe('maybeTriggerEpidemic', () => {
  it('low density rarely triggers an outbreak', () => {
    const pool = emptyPool();
    pool.set(k('30-34', 'male', 'plebeian'), 200);
    const health = createSettlementHealth();
    const rng = createRng('low-density');
    let triggered = 0;
    for (let day = 0; day < 365; day++) {
      const r = maybeTriggerEpidemic(health, pool, 5, 'temperate', rng, day as Day);
      if (r.triggered) {
        triggered++;
        // Reset infection state so we keep trying.
        health.infections.clear();
      }
    }
    expect(triggered).toBeLessThan(10);
  });

  it('high density occasionally triggers an outbreak (over a few years)', () => {
    const pool = emptyPool();
    pool.set(k('30-34', 'male', 'plebeian'), 30000);
    const health = createSettlementHealth();
    const rng = createRng('high-density');
    let triggered = 0;
    // Window: 5 years. At density 20k and the calibrated base rate this
    // should comfortably see at least one spawn but not many.
    for (let day = 0; day < 365 * 5; day++) {
      const r = maybeTriggerEpidemic(health, pool, 20000, 'temperate', rng, day as Day);
      if (r.triggered) {
        triggered++;
        health.infections.clear();
      }
    }
    expect(triggered).toBeGreaterThan(0);
    expect(triggered).toBeLessThan(50);
  });

  it('does not trigger if pool is empty', () => {
    const health = createSettlementHealth();
    const rng = createRng('empty-pool');
    for (let day = 0; day < 365; day++) {
      const r = maybeTriggerEpidemic(health, emptyPool(), 100, 'temperate', rng, day as Day);
      expect(r.triggered).toBeNull();
    }
  });

  it('does not trigger if all DISEASES are already active in the settlement', () => {
    const pool = emptyPool();
    pool.set(k('30-34', 'male', 'plebeian'), 30000);
    const health = createSettlementHealth();
    for (const d of DISEASES.values()) {
      health.infections.set(d.id, { startDay: 0 as Day, activeCases: 100 });
    }
    const rng = createRng('all-active');
    for (let day = 0; day < 365; day++) {
      const r = maybeTriggerEpidemic(health, pool, 20000, 'temperate', rng, day as Day);
      expect(r.triggered).toBeNull();
    }
  });

  it('is deterministic given the same RNG', () => {
    const pool = emptyPool();
    pool.set(k('30-34', 'male', 'plebeian'), 30000);
    const ha = createSettlementHealth();
    const hb = createSettlementHealth();
    const ra = createRng('det-trigger');
    const rb = createRng('det-trigger');
    let aTriggered = 0;
    let bTriggered = 0;
    for (let day = 0; day < 365; day++) {
      if (maybeTriggerEpidemic(ha, pool, 20000, 'temperate', ra, day as Day).triggered) {
        aTriggered++;
        ha.infections.clear();
      }
      if (maybeTriggerEpidemic(hb, pool, 20000, 'temperate', rb, day as Day).triggered) {
        bTriggered++;
        hb.infections.clear();
      }
    }
    expect(aTriggered).toBe(bTriggered);
  });
});

describe('tickInfection', () => {
  it('produces deaths in active cohorts and grows the cohort to which they belong', () => {
    const pool = evenlyDistributedPool(1000);
    const startTotal = pool.total();
    const health = createSettlementHealth();
    const plague = DISEASES.get('plague-analog');
    if (!plague) throw new Error('missing disease');
    health.infections.set(plague.id, { startDay: 0 as Day, activeCases: 5000 });
    const rng = createRng('plague-tick');
    let totalDeaths = 0;
    let totalRecovered = 0;
    // Tick for the duration of the disease; expect deaths and recoveries.
    for (let day = 1; day <= plague.durationDays; day++) {
      const r = tickInfection(health, pool, rng, day as Day);
      totalDeaths += r.deaths;
      totalRecovered += r.recovered;
    }
    expect(totalDeaths).toBeGreaterThan(0);
    expect(pool.total()).toBeLessThan(startTotal);
    expect(totalDeaths + totalRecovered).toBeGreaterThan(0);
  });

  it('after duration days, the infection is cleared', () => {
    const pool = evenlyDistributedPool(1000);
    const health = createSettlementHealth();
    const smallpox = DISEASES.get('smallpox-analog');
    if (!smallpox) throw new Error('missing disease');
    health.infections.set(smallpox.id, { startDay: 0 as Day, activeCases: 1000 });
    const rng = createRng('smallpox-clear');
    for (let day = 1; day <= smallpox.durationDays + 5; day++) {
      tickInfection(health, pool, rng, day as Day);
    }
    expect(health.infections.has(smallpox.id)).toBe(false);
  });

  it('survivors of an immunity-conferring disease are added to the immune count', () => {
    const pool = evenlyDistributedPool(1000);
    const health = createSettlementHealth();
    const smallpox = DISEASES.get('smallpox-analog');
    if (!smallpox) throw new Error('missing disease');
    health.infections.set(smallpox.id, { startDay: 0 as Day, activeCases: 5000 });
    const rng = createRng('smallpox-immune');
    for (let day = 1; day <= smallpox.durationDays + 1; day++) {
      tickInfection(health, pool, rng, day as Day);
    }
    expect(health.immune.get(smallpox.id) ?? 0).toBeGreaterThan(0);
  });

  it('survivors of a non-immunity-conferring disease are not added to the immune count', () => {
    const pool = evenlyDistributedPool(1000);
    const health = createSettlementHealth();
    const typhus = DISEASES.get('typhus-analog');
    if (!typhus) throw new Error('missing disease');
    health.infections.set(typhus.id, { startDay: 0 as Day, activeCases: 5000 });
    const rng = createRng('typhus-no-immune');
    for (let day = 1; day <= typhus.durationDays + 1; day++) {
      tickInfection(health, pool, rng, day as Day);
    }
    expect(health.immune.get(typhus.id) ?? 0).toBe(0);
  });

  it('does nothing if there are no infections', () => {
    const pool = evenlyDistributedPool(100);
    const startTotal = pool.total();
    const health = createSettlementHealth();
    const rng = createRng('no-infections');
    for (let day = 0; day < 30; day++) {
      const r = tickInfection(health, pool, rng, day as Day);
      expect(r.deaths).toBe(0);
      expect(r.recovered).toBe(0);
    }
    expect(pool.total()).toBe(startTotal);
  });

  it('is deterministic given the same RNG', () => {
    const a = evenlyDistributedPool(1000);
    const b = evenlyDistributedPool(1000);
    const ha = createSettlementHealth();
    const hb = createSettlementHealth();
    const plague = DISEASES.get('plague-analog');
    if (!plague) throw new Error('missing disease');
    ha.infections.set(plague.id, { startDay: 0 as Day, activeCases: 1000 });
    hb.infections.set(plague.id, { startDay: 0 as Day, activeCases: 1000 });
    const ra = createRng('det-tick');
    const rb = createRng('det-tick');
    for (let day = 1; day <= 10; day++) {
      tickInfection(ha, a, ra, day as Day);
      tickInfection(hb, b, rb, day as Day);
    }
    expect(a.total()).toBe(b.total());
  });
});

describe('transmitFromCaravan', () => {
  it('an uninfected caravan does nothing', () => {
    const health = createSettlementHealth();
    const rng = createRng('clean-caravan');
    const r = transmitFromCaravan(health, [], rng, 0 as Day);
    expect(r.newInfections).toHaveLength(0);
    expect(health.infections.size).toBe(0);
  });

  it('an infectious caravan can seed a new outbreak in a clean settlement', () => {
    let observed = 0;
    for (let trial = 0; trial < 200; trial++) {
      const health = createSettlementHealth();
      const rng = createRng(`seed-${trial}`);
      const r = transmitFromCaravan(health, ['plague-analog'], rng, 0 as Day);
      observed += r.newInfections.length;
    }
    expect(observed).toBeGreaterThan(0);
  });

  it('does not double-infect a settlement that already has the disease active', () => {
    const health = createSettlementHealth();
    health.infections.set('plague-analog', { startDay: 0 as Day, activeCases: 100 });
    let newCount = 0;
    for (let trial = 0; trial < 50; trial++) {
      const rng = createRng(`already-${trial}`);
      const r = transmitFromCaravan(health, ['plague-analog'], rng, 1 as Day);
      newCount += r.newInfections.length;
    }
    expect(newCount).toBe(0);
    expect(health.infections.get('plague-analog')?.activeCases).toBe(100);
  });

  it('ignores unknown disease ids', () => {
    const health = createSettlementHealth();
    const rng = createRng('unknown-disease');
    const r = transmitFromCaravan(health, ['common-cold'], rng, 0 as Day);
    expect(r.newInfections).toHaveLength(0);
    expect(health.infections.size).toBe(0);
  });

  it('is deterministic given the same RNG', () => {
    const ha = createSettlementHealth();
    const hb = createSettlementHealth();
    const ra = createRng('det-transmit');
    const rb = createRng('det-transmit');
    for (let day = 0; day < 50; day++) {
      transmitFromCaravan(ha, ['typhus-analog'], ra, day as Day);
      transmitFromCaravan(hb, ['typhus-analog'], rb, day as Day);
    }
    expect(Array.from(ha.infections.keys())).toEqual(Array.from(hb.infections.keys()));
  });
});

describe('quarantine', () => {
  it('declareQuarantine sets the cutoff day; isQuarantined respects the window', () => {
    const health = createSettlementHealth();
    expect(isQuarantined(health, 0 as Day)).toBe(false);
    declareQuarantine(health, 30 as Day);
    expect(isQuarantined(health, 0 as Day)).toBe(true);
    expect(isQuarantined(health, 29 as Day)).toBe(true);
    expect(isQuarantined(health, 30 as Day)).toBe(false);
    expect(isQuarantined(health, 100 as Day)).toBe(false);
  });

  it('declareQuarantine throws on a non-future day', () => {
    const health = createSettlementHealth();
    expect(() => declareQuarantine(health, -1 as Day)).toThrow();
  });

  it('declaring a longer quarantine extends the window; a shorter one is ignored', () => {
    const health = createSettlementHealth();
    declareQuarantine(health, 30 as Day);
    declareQuarantine(health, 60 as Day);
    expect(health.quarantineUntilDay).toBe(60);
    declareQuarantine(health, 10 as Day);
    expect(health.quarantineUntilDay).toBe(60);
  });
});

describe('terrain types are accepted', () => {
  it('accepts all terrain types without throwing', () => {
    const pool = emptyPool();
    pool.set(k('30-34', 'male', 'plebeian'), 1000);
    const rng = createRng('terrain-cover');
    const climates: readonly Climate[] = [
      'mediterranean',
      'temperate',
      'continental',
      'arid',
      'alpine',
    ];
    const terrains: readonly Terrain[] = [
      'plains',
      'fertile_valley',
      'hills',
      'mountains',
      'forest',
      'dense_forest',
      'marsh',
      'desert',
      'steppe',
      'river',
      'lake',
      'urban',
      'ruin',
    ];
    for (const c of climates) {
      for (const t of terrains) {
        const r = applyEndemicMortality(pool, c, t, rng, 0 as Day);
        expect(r.deaths).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
