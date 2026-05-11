import { describe, expect, it } from 'vitest';
import { jobId, settlementId } from '../types.js';
import { hex } from '../world/hex.js';
import { createSettlement } from '../world/settlement.js';
import {
  allocatedWorkersForJob,
  allocatedWorkersForJobForOwner,
  buildLaborClassContext,
  wageEarningShareForJob,
  wageEarningShareForJobForOwner,
  wageEarningWorkerDaysForLabor,
  wageEarningWorkerDaysForLaborForOwner,
} from './laborEconomics.js';

const makeSettlement = (): ReturnType<typeof createSettlement> =>
  createSettlement({
    id: settlementId('labor-econ'),
    tier: 'village',
    name: 'Labor Econ',
    anchor: hex(0, 0),
    urbanHexes: [hex(0, 0)],
    catchmentHexes: [],
  });

describe('labor class economics', () => {
  it('derives paid and enslaved shares from per-job allocations', () => {
    const settlement = makeSettlement();
    settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 5);
    settlement.population.set({ age: '20-24', sex: 'male', class: 'slave' }, 5);
    settlement.jobAllocations.set(jobId('farmer'), 10);

    const context = buildLaborClassContext(settlement);

    expect(allocatedWorkersForJob(context, jobId('farmer'))).toBeCloseTo(10);
    expect(wageEarningShareForJob(context, jobId('farmer'))).toBeCloseTo(0.5);
    expect(wageEarningWorkerDaysForLabor(context, new Map([[jobId('farmer'), 4]]))).toBeCloseTo(2);
  });

  it('makes slave labor owner-sensitive instead of settlement-wide', () => {
    const settlement = makeSettlement();
    settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 5);
    settlement.population.set({ age: '20-24', sex: 'male', class: 'slave' }, 5);
    settlement.jobAllocations.set(jobId('farmer'), 10);

    const context = buildLaborClassContext(settlement);

    expect(allocatedWorkersForJobForOwner(context, jobId('farmer'), 'patrician_family')).toBeCloseTo(
      10,
    );
    expect(wageEarningShareForJobForOwner(context, jobId('farmer'), 'patrician_family')).toBeCloseTo(
      0.5,
    );
    expect(allocatedWorkersForJobForOwner(context, jobId('farmer'), 'common_household')).toBeCloseTo(
      5,
    );
    expect(wageEarningShareForJobForOwner(context, jobId('farmer'), 'common_household')).toBeCloseTo(
      1,
    );
    expect(
      wageEarningWorkerDaysForLaborForOwner(
        context,
        new Map([[jobId('farmer'), 4]]),
        'common_household',
      ),
    ).toBeCloseTo(4);
  });

  it('assigns no workers to jobs excluded by class restrictions', () => {
    const settlement = makeSettlement();
    settlement.population.set({ age: '20-24', sex: 'male', class: 'slave' }, 10);
    settlement.jobAllocations.set(jobId('priest'), 10);

    const context = buildLaborClassContext(settlement);

    expect(allocatedWorkersForJob(context, jobId('priest'))).toBe(0);
    expect(wageEarningShareForJob(context, jobId('priest'))).toBe(0);
  });

  it('keeps legacy wage behavior for allocation-only test fixtures', () => {
    const settlement = makeSettlement();
    settlement.jobAllocations.set(jobId('mason'), 1);

    const context = buildLaborClassContext(settlement);

    expect(wageEarningWorkerDaysForLabor(context, new Map([[jobId('mason'), 1]]))).toBe(1);
  });
});
