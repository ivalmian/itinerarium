/**
 * Branded `JobId` constants for the two labor pools that drain
 * worker-days into building construction + demolition: stone-and-
 * brick masonry, and lumber carpentry. Per docs/15 §C14 every
 * pendingBuilding tracks `masonDaysRemaining` and
 * `carpenterDaysRemaining` separately so a quarry-rich, lumber-
 * poor city can keep building stone walls even when forester
 * camps are short of workers, and vice versa.
 *
 * Lifted out of tick.ts so both the demolition phase (now in
 * src/sim/phases/demolition.ts) and the construction phase (still
 * inline, until its own extraction) can share the same branded
 * job ids without re-declaring them.
 */

import { jobId } from '../types.js';

export const MASON_JOB = jobId('mason');
export const CARPENTER_JOB = jobId('carpenter');
