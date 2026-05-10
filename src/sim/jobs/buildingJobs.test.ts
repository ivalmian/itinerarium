import { describe, expect, it } from 'vitest';
import { buildingId, jobId } from '../types.js';
import { jobsForBuilding, primaryJobForBuilding } from './buildingJobs.js';

describe('jobsForBuilding', () => {
  it('returns the labor jobs declared on every recipe at that building', () => {
    // farm hosts sow_grain + harvest_grain + grow_flax + grow_legumes — all
    // farmer-only.
    const farmJobs = jobsForBuilding(buildingId('farm'));
    expect(farmJobs.size).toBe(1);
    expect(farmJobs.get(jobId('farmer'))).toBeGreaterThan(0);
  });

  it('aggregates pasture across multiple jobs (shepherd/cattle/swineherd)', () => {
    const pastureJobs = jobsForBuilding(buildingId('pasture'));
    // Pasture hosts raise_sheep (shepherd), raise_cattle (cattle_herder),
    // raise_pigs (swineherd), shear_wool (shepherd), etc.
    expect(pastureJobs.has(jobId('shepherd'))).toBe(true);
    expect(pastureJobs.has(jobId('cattle_herder'))).toBe(true);
    expect(pastureJobs.has(jobId('swineherd'))).toBe(true);
  });

  it('returns empty map for storage/civic/military buildings', () => {
    expect(jobsForBuilding(buildingId('granary')).size).toBe(0);
    expect(jobsForBuilding(buildingId('warehouse')).size).toBe(0);
    expect(jobsForBuilding(buildingId('walls')).size).toBe(0);
  });
});

describe('primaryJobForBuilding', () => {
  it('returns the single job for single-job buildings', () => {
    expect(primaryJobForBuilding(buildingId('farm'))).toBe(jobId('farmer'));
    expect(primaryJobForBuilding(buildingId('mill'))).toBe(jobId('miller'));
    expect(primaryJobForBuilding(buildingId('bakery'))).toBe(jobId('baker'));
    expect(primaryJobForBuilding(buildingId('smithy'))).toBe(jobId('smith'));
  });

  it('returns null for buildings with no recipes', () => {
    expect(primaryJobForBuilding(buildingId('granary'))).toBeNull();
  });

  it('is deterministic for ties', () => {
    // Two calls return the same answer.
    const a = primaryJobForBuilding(buildingId('pasture'));
    const b = primaryJobForBuilding(buildingId('pasture'));
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });
});
