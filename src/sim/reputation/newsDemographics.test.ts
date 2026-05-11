import { describe, expect, it } from 'vitest';
import { hex } from '../world/hex.js';
import { actorId } from '../types.js';
import { createNewsCarrier, createNewsItem, tickCarrier } from './news.js';
import type { ReputationKey } from './table.js';
import { demoKey, totalDemographics } from '../population/demographics.js';

const carrierWith = (
  demo?: Map<string, number>,
): ReturnType<typeof createNewsCarrier> => {
  const news = createNewsItem({
    id: 'news-1',
    perpetrator: actorId('a:perp') as ReputationKey,
    victim: null,
    magnitude: 'moderate',
    isCriminalAct: false,
    occurredAtHex: hex(0, 0),
    occurredOnDay: 1,
  });
  return createNewsCarrier({
    id: 'carrier-1',
    news,
    spawnHex: hex(0, 0),
    destination: hex(10, 0),
    spawnDay: 1,
    ...(demo !== undefined ? { demographics: demo } : {}),
  });
};

describe('NewsCarrier demographics', () => {
  it('persists demographics when present', () => {
    const demo = new Map([[demoKey('male', '20-24'), 1]]);
    const c = carrierWith(demo);
    expect(totalDemographics(c.demographics)).toBe(1);
  });

  it('is undefined for backward-compatible carriers', () => {
    const c = carrierWith();
    expect(c.demographics).toBeUndefined();
  });

  it('is defensively copied (mutating the original does not affect the carrier)', () => {
    const original = new Map([[demoKey('female', '30-34'), 1]]);
    const c = carrierWith(original);
    original.set(demoKey('male', '25-29'), 99);
    expect(c.demographics?.size).toBe(1);
  });

  it('demographics survives tickCarrier movement', () => {
    const demo = new Map([[demoKey('male', '30-34'), 1]]);
    const c = carrierWith(demo);
    const moved = tickCarrier(c, 2);
    expect(totalDemographics(moved.demographics)).toBe(1);
    // And it should be a different position (no longer at spawn).
    expect(moved.position).not.toEqual(c.position);
  });
});
