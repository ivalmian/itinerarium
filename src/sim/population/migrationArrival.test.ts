import { describe, expect, it } from 'vitest';
import { hex } from '../world/hex.js';
import { createSettlement } from '../world/settlement.js';
import { settlementId } from '../types.js';
import type { CohortKey } from './cohort.js';
import { createCohortCounts, createMigrationColumn } from './migration.js';
import type { MigrationDecision } from './migration.js';
import { absorbArrival } from './migrationArrival.js';

const cohort = (
  age: CohortKey['age'],
  sex: CohortKey['sex'],
  klass: CohortKey['class'],
): CohortKey => ({ age, sex, class: klass });

const buildColumn = (
  origin: ReturnType<typeof settlementId>,
  destination: ReturnType<typeof settlementId>,
  cohorts: ReadonlyArray<readonly [CohortKey, number]>,
): ReturnType<typeof createMigrationColumn> => {
  const decision: MigrationDecision = {
    fromSettlement: origin,
    toSettlement: destination,
    cohorts: createCohortCounts(cohorts),
    reason: 'famine',
  };
  return createMigrationColumn({
    id: 'col.test',
    decision,
    originHex: hex(0, 0),
    destinationHex: hex(5, 0),
    initialRationsKg: 100,
  });
};

const buildSettlement = (id: ReturnType<typeof settlementId>): ReturnType<typeof createSettlement> =>
  createSettlement({
    id,
    tier: 'town',
    name: 'Destination',
    anchor: hex(5, 0),
    urbanHexes: [hex(5, 0)],
    catchmentHexes: [],
  });

describe('absorbArrival — basics', () => {
  it('adds every cohort in the column to the destination pool', () => {
    const dest = buildSettlement(settlementId('s.dest'));
    dest.population.set(cohort('20-24', 'male', 'plebeian'), 100);
    const column = buildColumn(settlementId('s.orig'), settlementId('s.dest'), [
      [cohort('20-24', 'male', 'plebeian'), 30],
      [cohort('5-9', 'female', 'plebeian'), 12],
    ]);
    const result = absorbArrival({ column, destinationSettlement: dest, today: 10 });
    expect(dest.population.count(cohort('20-24', 'male', 'plebeian'))).toBe(130);
    expect(dest.population.count(cohort('5-9', 'female', 'plebeian'))).toBe(12);
    expect(result.arrivalsByCohort.get(cohort('20-24', 'male', 'plebeian'))).toBe(30);
    expect(result.arrivalsByCohort.get(cohort('5-9', 'female', 'plebeian'))).toBe(12);
  });

  it("destination's total population grows by the column's total", () => {
    const dest = buildSettlement(settlementId('s.dest'));
    dest.population.set(cohort('30-34', 'female', 'plebeian'), 50);
    const before = dest.population.total();
    const column = buildColumn(settlementId('s.orig'), settlementId('s.dest'), [
      [cohort('15-19', 'male', 'plebeian'), 8],
      [cohort('20-24', 'female', 'plebeian'), 11],
      [cohort('40-44', 'male', 'plebeian'), 6],
    ]);
    absorbArrival({ column, destinationSettlement: dest, today: 1 });
    expect(dest.population.total()).toBe(before + 8 + 11 + 6);
  });

  it('preserves cohort identity (age/sex/class)', () => {
    const dest = buildSettlement(settlementId('s.dest'));
    const column = buildColumn(settlementId('s.orig'), settlementId('s.dest'), [
      [cohort('25-29', 'female', 'freedman'), 4],
    ]);
    absorbArrival({ column, destinationSettlement: dest, today: 1 });
    expect(dest.population.count(cohort('25-29', 'female', 'freedman'))).toBe(4);
    // Should not have leaked into a different class slot.
    expect(dest.population.count(cohort('25-29', 'female', 'plebeian'))).toBe(0);
    expect(dest.population.count(cohort('25-29', 'male', 'freedman'))).toBe(0);
  });
});

describe('absorbArrival — edge cases', () => {
  it('empty column produces no change and no arrivals map entries', () => {
    const dest = buildSettlement(settlementId('s.dest'));
    dest.population.set(cohort('30-34', 'male', 'plebeian'), 25);
    const before = dest.population.total();
    const column = buildColumn(settlementId('s.orig'), settlementId('s.dest'), []);
    const result = absorbArrival({ column, destinationSettlement: dest, today: 1 });
    expect(dest.population.total()).toBe(before);
    expect(result.arrivalsByCohort.size).toBe(0);
  });

  it('skips cohort entries with zero count (does not write 0 into pool)', () => {
    const dest = buildSettlement(settlementId('s.dest'));
    const column = buildColumn(settlementId('s.orig'), settlementId('s.dest'), [
      [cohort('20-24', 'male', 'plebeian'), 5],
    ]);
    // Manually inject a zero entry to simulate a degenerate column.
    column.cohorts.set(cohort('60-64', 'female', 'plebeian'), 0);
    const result = absorbArrival({ column, destinationSettlement: dest, today: 1 });
    expect(dest.population.count(cohort('60-64', 'female', 'plebeian'))).toBe(0);
    expect(result.arrivalsByCohort.has(cohort('60-64', 'female', 'plebeian'))).toBe(false);
    expect(result.arrivalsByCohort.get(cohort('20-24', 'male', 'plebeian'))).toBe(5);
  });

  it('non-integer or negative cohort counts in the column throw (defensive)', () => {
    const dest = buildSettlement(settlementId('s.dest'));
    const column = buildColumn(settlementId('s.orig'), settlementId('s.dest'), []);
    column.cohorts.set(cohort('20-24', 'male', 'plebeian'), 3.5);
    expect(() => absorbArrival({ column, destinationSettlement: dest, today: 1 })).toThrow();
  });

  it('merging into an empty destination pool yields exactly the column counts', () => {
    const dest = buildSettlement(settlementId('s.dest'));
    expect(dest.population.total()).toBe(0);
    const column = buildColumn(settlementId('s.orig'), settlementId('s.dest'), [
      [cohort('20-24', 'male', 'plebeian'), 40],
      [cohort('20-24', 'female', 'plebeian'), 35],
    ]);
    const result = absorbArrival({ column, destinationSettlement: dest, today: 1 });
    expect(dest.population.total()).toBe(75);
    expect(result.arrivalsByCohort.size).toBe(2);
  });
});

describe('absorbArrival — determinism', () => {
  it('called twice on equivalent inputs produces identical results', () => {
    const make = (): { col: ReturnType<typeof buildColumn>; dest: ReturnType<typeof buildSettlement> } => {
      const dest = buildSettlement(settlementId('s.dest'));
      dest.population.set(cohort('30-34', 'male', 'plebeian'), 10);
      const col = buildColumn(settlementId('s.orig'), settlementId('s.dest'), [
        [cohort('20-24', 'male', 'plebeian'), 7],
        [cohort('20-24', 'female', 'plebeian'), 8],
      ]);
      return { col, dest };
    };
    const a = make();
    const b = make();
    const ra = absorbArrival({ column: a.col, destinationSettlement: a.dest, today: 5 });
    const rb = absorbArrival({ column: b.col, destinationSettlement: b.dest, today: 5 });
    expect(ra.arrivalsByCohort.size).toBe(rb.arrivalsByCohort.size);
    for (const [k, v] of ra.arrivalsByCohort) {
      expect(rb.arrivalsByCohort.get(k)).toBe(v);
    }
    expect(a.dest.population.total()).toBe(b.dest.population.total());
  });
});
