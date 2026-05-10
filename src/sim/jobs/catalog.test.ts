import { describe, expect, it } from 'vitest';
import { CHARACTER_CLASSES, type CharacterClass } from '../population/types.js';
import { jobId } from '../types.js';
import { JOBS, allJobs, getJob, type JobDef, type JobSector } from './catalog.js';

const PRIMARY = [
  'farmer',
  'shepherd',
  'cattle_herder',
  'swineherd',
  'fisher',
  'hunter',
  'forester',
  'miner',
  'quarryman',
  'salt_worker',
] as const;

const SECONDARY = [
  'miller',
  'baker',
  'presser',
  'vintner',
  'dairy_worker',
  'tanner',
  'collier',
  'sawyer',
  'mason',
  'brickmaker',
  'potter',
  'smelter',
  'smith',
  'weaver',
  'tailor',
  'wright',
  'carpenter',
  'minter',
] as const;

const TERTIARY = [
  'merchant',
  'drover',
  'caravan_guard',
  'soldier',
  'officer',
  'scribe',
  'official',
  'priest',
  'physician',
  'entertainer',
  'servant',
] as const;

const UNPRODUCTIVE = ['child', 'elder', 'idle'] as const;

describe('job catalog', () => {
  describe('coverage', () => {
    it('includes every job from docs/04', () => {
      const expected = [...PRIMARY, ...SECONDARY, ...TERTIARY, ...UNPRODUCTIVE];
      for (const id of expected) {
        expect(JOBS.has(jobId(id))).toBe(true);
      }
    });

    it('does not include sailor or shipwright (sea trade deferred)', () => {
      expect(JOBS.has(jobId('sailor'))).toBe(false);
      expect(JOBS.has(jobId('shipwright'))).toBe(false);
    });

    it('exposes the same set via allJobs()', () => {
      const all = allJobs();
      expect(all.length).toBe(JOBS.size);
    });
  });

  describe('uniqueness', () => {
    it('every job id is unique', () => {
      const ids = allJobs().map((j) => j.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('getJob', () => {
    it('returns the matching definition', () => {
      const j = getJob(jobId('farmer'));
      expect(j.id).toBe(jobId('farmer'));
      expect(j.name).toMatch(/farmer/i);
    });

    it('throws on unknown id', () => {
      expect(() => getJob(jobId('astronaut'))).toThrow();
    });
  });

  describe('sectors', () => {
    it('classifies primary sector correctly', () => {
      for (const id of PRIMARY) {
        expect(getJob(jobId(id)).sector).toBe('primary');
      }
    });
    it('classifies secondary sector correctly', () => {
      for (const id of SECONDARY) {
        expect(getJob(jobId(id)).sector).toBe('secondary');
      }
    });
    it('classifies tertiary sector correctly', () => {
      for (const id of TERTIARY) {
        expect(getJob(jobId(id)).sector).toBe('tertiary');
      }
    });
    it('classifies unproductive correctly', () => {
      for (const id of UNPRODUCTIVE) {
        expect(getJob(jobId(id)).sector).toBe('unproductive');
      }
    });

    it('every sector is one of the declared union members', () => {
      const allowed = new Set<JobSector>(['primary', 'secondary', 'tertiary', 'unproductive']);
      for (const j of allJobs()) {
        expect(allowed.has(j.sector)).toBe(true);
      }
    });
  });

  describe('class restrictions (docs/04)', () => {
    it('slaves are never officials, merchants, scribes, priests, officers', () => {
      const slaveForbidden: readonly string[] = [
        'official',
        'merchant',
        'scribe',
        'priest',
        'officer',
      ];
      for (const id of slaveForbidden) {
        const allowed = getJob(jobId(id)).allowedClasses;
        expect(allowed.includes('slave')).toBe(false);
      }
    });

    it('patricians are never miners, quarrymen, salt workers, or other heavy primary labor', () => {
      const patricianForbidden: readonly string[] = ['miner', 'quarryman', 'salt_worker'];
      for (const id of patricianForbidden) {
        const allowed = getJob(jobId(id)).allowedClasses;
        expect(allowed.includes('patrician')).toBe(false);
      }
    });

    it('plebeians have access to mainstream jobs', () => {
      const plebMainstream: readonly string[] = ['farmer', 'baker', 'soldier', 'merchant'];
      for (const id of plebMainstream) {
        expect(getJob(jobId(id)).allowedClasses.includes('plebeian')).toBe(true);
      }
    });

    it('every allowedClasses entry is a real CharacterClass', () => {
      const allowed = new Set<CharacterClass>(CHARACTER_CLASSES);
      for (const j of allJobs()) {
        for (const c of j.allowedClasses) {
          expect(allowed.has(c)).toBe(true);
        }
      }
    });

    it('every job has at least one allowed class', () => {
      for (const j of allJobs()) {
        expect(j.allowedClasses.length).toBeGreaterThan(0);
      }
    });

    it('child / elder / idle are open to everyone (passive cohorts)', () => {
      for (const id of ['child', 'elder', 'idle']) {
        const allowed = getJob(jobId(id)).allowedClasses;
        for (const c of CHARACTER_CLASSES) {
          expect(allowed.includes(c)).toBe(true);
        }
      }
    });
  });

  describe('training days', () => {
    it('every job has a non-negative training time', () => {
      for (const j of allJobs()) {
        expect(j.trainingDays).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(j.trainingDays)).toBe(true);
      }
    });

    it('passive cohorts (child/elder/idle) require zero training', () => {
      for (const id of UNPRODUCTIVE) {
        expect(getJob(jobId(id)).trainingDays).toBe(0);
      }
    });

    it('skilled crafts take longer than primary unskilled labor', () => {
      const farmer = getJob(jobId('farmer'));
      const smith = getJob(jobId('smith'));
      expect(smith.trainingDays).toBeGreaterThan(farmer.trainingDays);
    });
  });

  describe('immutability', () => {
    it('catalog entries cannot be mutated through the public API', () => {
      const def: JobDef = getJob(jobId('farmer'));
      expect(() => {
        (def as { name: string }).name = 'mutated';
      }).toThrow();
    });

    it('allowedClasses array is frozen', () => {
      const def = getJob(jobId('farmer'));
      expect(() => {
        (def.allowedClasses as CharacterClass[]).push('foreigner');
      }).toThrow();
    });
  });
});
