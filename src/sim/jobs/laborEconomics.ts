/**
 * Labor class economics shared by production and market pricing.
 *
 * Job allocations are currently stored per role, not per class. This helper
 * derives a class mix for each job from the settlement's working-age
 * population and the job catalog's allowed classes, then exposes owner-aware
 * views over that labor. A settlement can contain enslaved workers without
 * every actor in that market being able to command them.
 */

import type { CharacterClass } from '../population/types.js';
import type { ActorKind } from '../politics/actor.js';
import type { JobId } from '../types.js';
import type { Settlement } from '../world/settlement.js';
import { getJob } from './catalog.js';

export interface LaborClassContext {
  readonly workingAdultsByClass: ReadonlyMap<CharacterClass, number>;
  readonly workersByJobAndClass: ReadonlyMap<JobId, ReadonlyMap<CharacterClass, number>>;
  readonly totalWorkingAdults: number;
  readonly hasJobAllocations: boolean;
}

const WORKING_AGE_BANDS: ReadonlySet<string> = new Set([
  '15-19',
  '20-24',
  '25-29',
  '30-34',
  '35-39',
  '40-44',
  '45-49',
  '50-54',
  '55-59',
]);

const WAGE_EARNING_CLASSES: ReadonlySet<CharacterClass> = new Set([
  'patrician',
  'plebeian',
  'freedman',
  'foreigner',
]);

export const isWageEarningLaborClass = (klass: CharacterClass): boolean =>
  WAGE_EARNING_CLASSES.has(klass);

/**
 * Owner kinds that can directly command enslaved labor for production.
 *
 * This is deliberately owner-sensitive instead of settlement-sensitive:
 * a town can contain slaves without every actor in that market getting
 * access to unpaid slave labor. Patrician estates, civic corporations,
 * temples, governor offices, villages/hamlets, and the player may own or
 * command enslaved workers; common household aggregates, caravan firms,
 * merchant guilds, and off-map houses pay for local labor in this model.
 */
const UNPAID_SLAVE_LABOR_OWNER_KINDS: ReadonlySet<ActorKind> = new Set([
  'patrician_family',
  'free_village',
  'hamlet_household',
  'governor_office',
  'temple',
  'bandit_camp',
  'player',
  'city_corporation',
]);

const ownerCanUseUnpaidSlaveLabor = (ownerKind: ActorKind | undefined): boolean =>
  ownerKind === undefined || UNPAID_SLAVE_LABOR_OWNER_KINDS.has(ownerKind);

export const ownerCanUseLaborClass = (
  klass: CharacterClass,
  ownerKind: ActorKind | undefined,
): boolean => {
  if (klass !== 'slave') return true;
  return ownerCanUseUnpaidSlaveLabor(ownerKind);
};

export const buildLaborClassContext = (settlement: Settlement): LaborClassContext => {
  const workingAdultsByClass = new Map<CharacterClass, number>();
  let totalWorkingAdults = 0;
  settlement.population.forEachCohort((key, count) => {
    if (count <= 0 || !WORKING_AGE_BANDS.has(key.age)) return;
    workingAdultsByClass.set(key.class, (workingAdultsByClass.get(key.class) ?? 0) + count);
    totalWorkingAdults += count;
  });
  return {
    workingAdultsByClass,
    workersByJobAndClass: buildWorkersByJobAndClass(settlement, workingAdultsByClass),
    totalWorkingAdults,
    hasJobAllocations: settlement.jobAllocations.size > 0,
  };
};

const buildWorkersByJobAndClass = (
  settlement: Settlement,
  workingAdultsByClass: ReadonlyMap<CharacterClass, number>,
): ReadonlyMap<JobId, ReadonlyMap<CharacterClass, number>> => {
  if (settlement.jobAllocations.size === 0) return new Map();

  const remainingByClass = new Map<CharacterClass, number>(workingAdultsByClass);
  let remainingTotal = 0;
  for (const [, count] of remainingByClass) remainingTotal += count;
  if (remainingTotal <= 0) return new Map();

  const out = new Map<JobId, Map<CharacterClass, number>>();
  const allocations = [...settlement.jobAllocations.entries()]
    .filter(([, count]) => count > 0)
    .map(([job, count]) => ({ job, count, allowedClasses: getJob(job).allowedClasses }))
    .sort((a, b) => {
      const aJob = String(a.job);
      const bJob = String(b.job);
      if (aJob === 'idle' && bJob !== 'idle') return 1;
      if (bJob === 'idle' && aJob !== 'idle') return -1;
      const aAllowed = a.allowedClasses.length;
      const bAllowed = b.allowedClasses.length;
      if (aAllowed !== bAllowed) return aAllowed - bAllowed;
      return aJob < bJob ? -1 : aJob > bJob ? 1 : 0;
    });

  for (const { job, count: requested, allowedClasses } of allocations) {
    let eligibleRemaining = 0;
    for (const klass of allowedClasses) {
      eligibleRemaining += remainingByClass.get(klass) ?? 0;
    }
    if (eligibleRemaining <= 0) continue;

    const assigned = Math.min(requested, eligibleRemaining);
    if (assigned <= 0) continue;
    const byClass = new Map<CharacterClass, number>();
    for (const klass of allowedClasses) {
      const remaining = remainingByClass.get(klass) ?? 0;
      if (remaining <= 0) continue;
      const count = (assigned * remaining) / eligibleRemaining;
      if (count <= 0) continue;
      byClass.set(klass, count);
      remainingByClass.set(klass, remaining - count);
    }
    out.set(job, byClass);
  }

  return out;
};

export const eligibleWorkingAdultsForJob = (
  context: LaborClassContext,
  job: JobId,
  ownerKind?: ActorKind,
): number => {
  const def = getJob(job);
  let eligible = 0;
  for (const klass of def.allowedClasses) {
    if (!ownerCanUseLaborClass(klass, ownerKind)) continue;
    eligible += context.workingAdultsByClass.get(klass) ?? 0;
  }
  return eligible;
};

export const allocatedWorkersForJobForOwner = (
  context: LaborClassContext,
  job: JobId,
  ownerKind?: ActorKind,
): number => {
  const byClass = context.workersByJobAndClass.get(job);
  if (byClass === undefined) {
    if (!context.hasJobAllocations && context.totalWorkingAdults <= 0) return Infinity;
    return context.hasJobAllocations && context.totalWorkingAdults > 0
      ? 0
      : eligibleWorkingAdultsForJob(context, job, ownerKind);
  }
  let total = 0;
  for (const [klass, count] of byClass) {
    if (!ownerCanUseLaborClass(klass, ownerKind)) continue;
    total += count;
  }
  return total;
};

export const allocatedWorkersForJob = (context: LaborClassContext, job: JobId): number =>
  allocatedWorkersForJobForOwner(context, job);

export const wageEarningShareForJobForOwner = (
  context: LaborClassContext,
  job: JobId,
  ownerKind?: ActorKind,
): number => {
  const byClass = context.workersByJobAndClass.get(job);
  if (byClass !== undefined) {
    let total = 0;
    let wageEarning = 0;
    for (const [klass, count] of byClass) {
      if (!ownerCanUseLaborClass(klass, ownerKind)) continue;
      total += count;
      if (WAGE_EARNING_CLASSES.has(klass)) wageEarning += count;
    }
    if (total > 0) return Math.max(0, Math.min(1, wageEarning / total));
  }
  if (context.hasJobAllocations && context.totalWorkingAdults > 0) return 0;

  const def = getJob(job);
  let eligible = 0;
  let wageEarning = 0;
  for (const klass of def.allowedClasses) {
    if (!ownerCanUseLaborClass(klass, ownerKind)) continue;
    const count = context.workingAdultsByClass.get(klass) ?? 0;
    eligible += count;
    if (WAGE_EARNING_CLASSES.has(klass)) wageEarning += count;
  }

  if (eligible <= 0) {
    // Legacy/unit-test fixtures sometimes provide job allocations without a
    // population pyramid. Preserve old behavior there. If there is a real
    // population but no eligible class for the role, the role has no paid
    // labor share.
    return context.totalWorkingAdults <= 0 ? 1 : 0;
  }
  return Math.max(0, Math.min(1, wageEarning / eligible));
};

export const wageEarningShareForJob = (context: LaborClassContext, job: JobId): number =>
  wageEarningShareForJobForOwner(context, job);

export const wageEarningWorkerDaysForLaborForOwner = (
  context: LaborClassContext,
  labor: ReadonlyMap<JobId, number>,
  ownerKind?: ActorKind,
): number => {
  let workerDays = 0;
  for (const [job, days] of labor) {
    if (days <= 0) continue;
    workerDays += days * wageEarningShareForJobForOwner(context, job, ownerKind);
  }
  return workerDays;
};

export const wageEarningWorkerDaysForLabor = (
  context: LaborClassContext,
  labor: ReadonlyMap<JobId, number>,
): number => wageEarningWorkerDaysForLaborForOwner(context, labor);
