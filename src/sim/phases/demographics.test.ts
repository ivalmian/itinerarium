/** Tests for the demographics phase (src/sim/phases/demographics.ts). */

import { describe, expect, it } from 'vitest';
import {
  settlementId,
} from '../types.js';
import { createRng } from '../rng.js';
import { tick, } from '../tick.js';
import {
  buildOneSettlementWorld,
} from '../testing/tickFixtures.js';

  describe('demographics phase', () => {
    it('runs population dynamics each day (births / deaths drift over many ticks)', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 5000 },
        grainModii: 1_000_000, // ample food so famine isn't a confound
      });
      const settlementId1 = settlementId('settle-1');
      const startTotal = w.settlements.get(settlementId1)?.population.total() ?? 0;
      let world = w;
      // 120 days at 5000 people: at ~1.2% adult mortality / year that's
      // 5000 * 0.012 * 120/365 ≈ 20 deaths plus births. Reliably non-zero
      // drift even with zero RNG variance.
      for (let d = 0; d < 120; d++) {
        const r = tick({ world, rng: createRng(`demo-${d}`) });
        world = r.world;
      }
      const endTotal = world.settlements.get(settlementId1)?.population.total() ?? 0;
      expect(endTotal).not.toBe(startTotal);
    });
  });
