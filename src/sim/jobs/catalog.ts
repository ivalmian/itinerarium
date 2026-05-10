/**
 * Typed registry of every job role in the game.
 *
 * Source: docs/04-population.md "Job roles" section. Sectors mirror
 * the doc's primary / secondary / tertiary / unproductive grouping.
 *
 * Class restrictions encode the hard-coded rules from docs/04:
 *   - Slaves are never officials, merchants, scribes, priests, or officers.
 *   - Patricians are never miners, quarrymen, or salt workers — and by
 *     extension never the other heavy primary-sector trades.
 * Other restrictions are softer (e.g., foreigners can serve as merchants
 * but rarely as officials); we model the hard rules and leave the rest
 * open so the population sim can express social mobility without the
 * catalog fighting it.
 *
 * Training days are placeholder: passive cohorts cost 0; primary unskilled
 * trades are short; skilled crafts and tertiary roles require more training.
 * Tuning lives in burn-in, not here.
 */

import { CHARACTER_CLASSES, type CharacterClass } from '../population/types.js';
import { jobId, type JobId } from '../types.js';

export type JobSector = 'primary' | 'secondary' | 'tertiary' | 'unproductive';

export interface JobDef {
  readonly id: JobId;
  readonly sector: JobSector;
  readonly name: string;
  readonly allowedClasses: readonly CharacterClass[];
  readonly trainingDays: number;
  readonly notes?: string;
}

interface JobInput {
  readonly id: string;
  readonly sector: JobSector;
  readonly name: string;
  readonly allowedClasses: readonly CharacterClass[];
  readonly trainingDays: number;
  readonly notes?: string;
}

// Allowed-class shortcuts used heavily below. Patricians are excluded
// from anything they would never personally do (heavy labor, manual
// crafts traditionally done by plebs/freedmen/slaves).
const FREE_AND_DEPENDENT: readonly CharacterClass[] = [
  'plebeian',
  'freedman',
  'slave',
  'foreigner',
];
const FREE_INCLUDING_PATRICIAN: readonly CharacterClass[] = [
  'patrician',
  'plebeian',
  'freedman',
  'foreigner',
];
const FREE_NO_SLAVE: readonly CharacterClass[] = ['patrician', 'plebeian', 'freedman', 'foreigner'];
const PATRICIAN_PLEBEIAN: readonly CharacterClass[] = ['patrician', 'plebeian'];
const ALL_CLASSES: readonly CharacterClass[] = CHARACTER_CLASSES;

const DEFS: readonly JobInput[] = [
  // --- Primary sector ---
  {
    id: 'farmer',
    sector: 'primary',
    name: 'Farmer',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 30,
  },
  {
    id: 'shepherd',
    sector: 'primary',
    name: 'Shepherd',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 60,
  },
  {
    id: 'cattle_herder',
    sector: 'primary',
    name: 'Cattle herder',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 60,
  },
  {
    id: 'swineherd',
    sector: 'primary',
    name: 'Swineherd',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 30,
  },
  {
    id: 'fisher',
    sector: 'primary',
    name: 'Fisher',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 60,
  },
  {
    id: 'hunter',
    sector: 'primary',
    name: 'Hunter',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 90,
  },
  {
    id: 'forester',
    sector: 'primary',
    name: 'Forester',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 60,
  },
  {
    id: 'miner',
    sector: 'primary',
    name: 'Miner',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 60,
    notes: 'Patricians never mine (docs/04).',
  },
  {
    id: 'quarryman',
    sector: 'primary',
    name: 'Quarryman',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 60,
  },
  {
    id: 'salt_worker',
    sector: 'primary',
    name: 'Salt worker',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 60,
  },

  // --- Secondary sector ---
  {
    id: 'miller',
    sector: 'secondary',
    name: 'Miller',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 90,
  },
  {
    id: 'baker',
    sector: 'secondary',
    name: 'Baker',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 120,
  },
  {
    id: 'presser',
    sector: 'secondary',
    name: 'Oil presser',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 60,
  },
  {
    id: 'vintner',
    sector: 'secondary',
    name: 'Vintner',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 180,
  },
  {
    id: 'dairy_worker',
    sector: 'secondary',
    name: 'Dairy worker',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 90,
  },
  {
    id: 'tanner',
    sector: 'secondary',
    name: 'Tanner',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 180,
  },
  {
    id: 'collier',
    sector: 'secondary',
    name: 'Collier',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 90,
  },
  {
    id: 'sawyer',
    sector: 'secondary',
    name: 'Sawyer',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 90,
  },
  {
    id: 'mason',
    sector: 'secondary',
    name: 'Mason',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 365,
  },
  {
    id: 'brickmaker',
    sector: 'secondary',
    name: 'Brickmaker',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 90,
  },
  {
    id: 'potter',
    sector: 'secondary',
    name: 'Potter',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 365,
  },
  {
    id: 'smelter',
    sector: 'secondary',
    name: 'Smelter',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 365,
  },
  {
    id: 'smith',
    sector: 'secondary',
    name: 'Smith',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 730,
  },
  {
    id: 'weaver',
    sector: 'secondary',
    name: 'Weaver',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 365,
  },
  {
    id: 'tailor',
    sector: 'secondary',
    name: 'Tailor',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 180,
  },
  {
    id: 'wright',
    sector: 'secondary',
    name: 'Cart wright',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 730,
  },
  {
    id: 'carpenter',
    sector: 'secondary',
    name: 'Carpenter',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 365,
  },
  {
    id: 'minter',
    sector: 'secondary',
    name: 'Minter',
    allowedClasses: FREE_NO_SLAVE,
    trainingDays: 365,
    notes: 'State-controlled; not staffed by slaves.',
  },

  // --- Tertiary sector ---
  {
    id: 'merchant',
    sector: 'tertiary',
    name: 'Merchant',
    allowedClasses: FREE_INCLUDING_PATRICIAN,
    trainingDays: 180,
    notes: 'Slaves never merchants (docs/04).',
  },
  {
    id: 'drover',
    sector: 'tertiary',
    name: 'Drover',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 60,
  },
  {
    id: 'caravan_guard',
    sector: 'tertiary',
    name: 'Caravan guard',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 90,
  },
  {
    id: 'soldier',
    sector: 'tertiary',
    name: 'Soldier',
    allowedClasses: FREE_NO_SLAVE,
    trainingDays: 180,
  },
  {
    id: 'officer',
    sector: 'tertiary',
    name: 'Officer',
    allowedClasses: PATRICIAN_PLEBEIAN,
    trainingDays: 365,
    notes: 'Patrician/plebeian only; state command authority.',
  },
  {
    id: 'scribe',
    sector: 'tertiary',
    name: 'Scribe',
    allowedClasses: FREE_INCLUDING_PATRICIAN,
    trainingDays: 730,
    notes:
      'Slaves never scribes in this catalog (docs/04: slaves not officials/merchants; scribes carry official authority).',
  },
  {
    id: 'official',
    sector: 'tertiary',
    name: 'Official',
    allowedClasses: PATRICIAN_PLEBEIAN,
    trainingDays: 730,
    notes: 'Slaves never officials (docs/04).',
  },
  {
    id: 'priest',
    sector: 'tertiary',
    name: 'Priest',
    allowedClasses: FREE_INCLUDING_PATRICIAN,
    trainingDays: 365,
  },
  {
    id: 'physician',
    sector: 'tertiary',
    name: 'Physician',
    allowedClasses: FREE_INCLUDING_PATRICIAN,
    trainingDays: 730,
  },
  {
    id: 'entertainer',
    sector: 'tertiary',
    name: 'Entertainer',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 180,
  },
  {
    id: 'servant',
    sector: 'tertiary',
    name: 'Servant',
    allowedClasses: FREE_AND_DEPENDENT,
    trainingDays: 30,
  },

  // --- Unproductive cohorts ---
  {
    id: 'child',
    sector: 'unproductive',
    name: 'Child',
    allowedClasses: ALL_CLASSES,
    trainingDays: 0,
    notes: 'Under working age; consumes but does not produce.',
  },
  {
    id: 'elder',
    sector: 'unproductive',
    name: 'Elder',
    allowedClasses: ALL_CLASSES,
    trainingDays: 0,
    notes: 'Past working age; consumes at ~0.8x adult.',
  },
  {
    id: 'idle',
    sector: 'unproductive',
    name: 'Idle',
    allowedClasses: ALL_CLASSES,
    trainingDays: 0,
    notes: 'Working-age but unemployed; banditry recruitment pool (docs/12).',
  },
];

const buildCatalog = (): ReadonlyMap<JobId, JobDef> => {
  const map = new Map<JobId, JobDef>();
  for (const input of DEFS) {
    const id = jobId(input.id);
    if (map.has(id)) {
      throw new Error(`Duplicate job id: ${input.id}`);
    }
    const def: JobDef = Object.freeze({
      id,
      sector: input.sector,
      name: input.name,
      allowedClasses: Object.freeze([...input.allowedClasses]),
      trainingDays: input.trainingDays,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    map.set(id, def);
  }
  return map;
};

export const JOBS: ReadonlyMap<JobId, JobDef> = buildCatalog();

const ALL_JOBS: readonly JobDef[] = Object.freeze(Array.from(JOBS.values()));

export const allJobs = (): readonly JobDef[] => ALL_JOBS;

export const getJob = (id: JobId): JobDef => {
  const def = JOBS.get(id);
  if (def === undefined) {
    throw new Error(`Unknown job id: ${String(id)}`);
  }
  return def;
};
