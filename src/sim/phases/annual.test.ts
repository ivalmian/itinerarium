/** Tests for the annual hook (src/sim/phases/annual.ts). */

import { describe, expect, it } from 'vitest';
import {
  settlementId,
} from '../types.js';
import { createRng } from '../rng.js';
import { tick, } from '../tick.js';
import {
  buildOneSettlementWorld,
} from '../testing/tickFixtures.js';

  describe('annual tick', () => {
    it('does not age the pyramid on off-cycle days', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 100 },
        grainModii: 100000,
      });
      const sid = settlementId('settle-1');
      const startBand = w.settlements.get(sid)?.population.totalByAgeBand('20-24') ?? 0;
      // Tick a single day (day 0 → 1). No yearly tick should fire.
      tick({ world: w, rng: createRng('ann-off') });
      const after = w.settlements.get(sid)?.population.totalByAgeBand('20-24') ?? 0;
      // The 20-24 band should still hold ~100 (deaths are rare on a single day).
      // Tolerance: at most a couple of statistical deaths.
      expect(Math.abs(after - startBand)).toBeLessThan(5);
    });

    it('shifts cohorts into the next age band on a year boundary', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 1000 },
        grainModii: 1_000_000,
      });
      const sid = settlementId('settle-1');
      // Start the world at day 364 so the next tick crosses into day 365 and
      // triggers the yearly aging.
      w.day = 364;
      const before20 = w.settlements.get(sid)?.population.totalByAgeBand('20-24') ?? 0;
      const before25 = w.settlements.get(sid)?.population.totalByAgeBand('25-29') ?? 0;
      tick({ world: w, rng: createRng('ann-cross') });
      const after20 = w.settlements.get(sid)?.population.totalByAgeBand('20-24') ?? 0;
      const after25 = w.settlements.get(sid)?.population.totalByAgeBand('25-29') ?? 0;
      // The 20-24 band should have drained (people moved to 25-29) and the
      // 25-29 band should have grown.
      expect(after20).toBeLessThan(before20);
      expect(after25).toBeGreaterThan(before25);
    });
  });
