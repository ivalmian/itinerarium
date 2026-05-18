import { describe, expect, it } from 'vitest';
import { actorId, resourceId, settlementId, type Day } from '../types.js';
import { createActor } from './actor.js';
import {
  KNOWN_PRICE_MAX_AGE_DAYS,
  getMarketObservation,
  getResourceQuote,
  isMarketObservationStale,
  iterFreshKnownPrices,
  mergeKnownPrices,
  pruneStaleObservations,
  recordMarketObservation,
  type MarketObservation,
} from './knownPrices.js';

const A = actorId('a');
const B = actorId('b');
const cityX = settlementId('city-x');
const cityY = settlementId('city-y');
const grain = resourceId('grain');
const wine = resourceId('wine');

const obs = (
  observedDay: Day,
  quotes: ReadonlyArray<readonly [string, { bestAsk: number; bestBid: number }]> = [],
): MarketObservation => ({
  observedDay,
  quotes: new Map(quotes.map(([r, q]) => [resourceId(r), q])),
});

describe('knownPrices: data shape', () => {
  it('starts empty for a new actor', () => {
    const a = createActor({ id: A, kind: 'patrician_family', name: 'A' });
    expect(a.knownPrices.size).toBe(0);
  });

  it('records and reads back a settlement observation', () => {
    const a = createActor({ id: A, kind: 'patrician_family', name: 'A' });
    recordMarketObservation(a, cityX, obs(10, [['grain', { bestAsk: 7, bestBid: 5 }]]));
    const got = getMarketObservation(a, cityX, 10 as Day);
    expect(got?.observedDay).toBe(10);
    expect(got?.quotes.get(grain)).toEqual({ bestAsk: 7, bestBid: 5 });
  });

  it('getResourceQuote returns the quote for a known resource', () => {
    const a = createActor({ id: A, kind: 'patrician_family', name: 'A' });
    recordMarketObservation(
      a,
      cityX,
      obs(10, [
        ['grain', { bestAsk: 7, bestBid: 5 }],
        ['wine', { bestAsk: 90, bestBid: 80 }],
      ]),
    );
    expect(getResourceQuote(a, cityX, grain, 10 as Day)).toEqual({ bestAsk: 7, bestBid: 5 });
    expect(getResourceQuote(a, cityX, wine, 10 as Day)).toEqual({ bestAsk: 90, bestBid: 80 });
  });

  it('getResourceQuote returns undefined if the resource is not in the observation', () => {
    const a = createActor({ id: A, kind: 'patrician_family', name: 'A' });
    recordMarketObservation(a, cityX, obs(10, [['grain', { bestAsk: 7, bestBid: 5 }]]));
    expect(getResourceQuote(a, cityX, wine, 10 as Day)).toBeUndefined();
  });
});

describe('knownPrices: merge rule (newer day wins, atomically)', () => {
  it('newer observation entirely replaces older one for the same settlement', () => {
    const a = createActor({ id: A, kind: 'patrician_family', name: 'A' });
    recordMarketObservation(
      a,
      cityX,
      obs(10, [
        ['grain', { bestAsk: 7, bestBid: 5 }],
        ['wine', { bestAsk: 90, bestBid: 80 }],
      ]),
    );
    // newer observation lacks wine → wine quote is dropped
    recordMarketObservation(a, cityX, obs(20, [['grain', { bestAsk: 8, bestBid: 6 }]]));
    expect(getResourceQuote(a, cityX, grain, 20 as Day)).toEqual({ bestAsk: 8, bestBid: 6 });
    expect(getResourceQuote(a, cityX, wine, 20 as Day)).toBeUndefined();
  });

  it('strictly older observation is ignored', () => {
    const a = createActor({ id: A, kind: 'patrician_family', name: 'A' });
    recordMarketObservation(a, cityX, obs(20, [['grain', { bestAsk: 8, bestBid: 6 }]]));
    recordMarketObservation(a, cityX, obs(10, [['grain', { bestAsk: 7, bestBid: 5 }]]));
    expect(getResourceQuote(a, cityX, grain, 20 as Day)).toEqual({ bestAsk: 8, bestBid: 6 });
  });

  it('same-day observation overwrites the existing one (later sync wins within a tick)', () => {
    const a = createActor({ id: A, kind: 'patrician_family', name: 'A' });
    recordMarketObservation(a, cityX, obs(10, [['grain', { bestAsk: 7, bestBid: 5 }]]));
    recordMarketObservation(a, cityX, obs(10, [['grain', { bestAsk: 8, bestBid: 6 }]]));
    expect(getResourceQuote(a, cityX, grain, 10 as Day)).toEqual({ bestAsk: 8, bestBid: 6 });
  });

  it('mergeKnownPrices: per-settlement newer wins, others untouched', () => {
    const a = createActor({ id: A, kind: 'patrician_family', name: 'A' });
    const b = createActor({ id: B, kind: 'patrician_family', name: 'B' });
    recordMarketObservation(a, cityX, obs(10, [['grain', { bestAsk: 7, bestBid: 5 }]]));
    recordMarketObservation(a, cityY, obs(15, [['wine', { bestAsk: 90, bestBid: 80 }]]));
    recordMarketObservation(b, cityX, obs(20, [['grain', { bestAsk: 8, bestBid: 6 }]]));
    // cityY: only A has data; B should receive it via merge
    mergeKnownPrices(b, a);
    expect(getResourceQuote(b, cityX, grain, 20 as Day)).toEqual({ bestAsk: 8, bestBid: 6 });
    expect(getResourceQuote(b, cityY, wine, 20 as Day)).toEqual({ bestAsk: 90, bestBid: 80 });
    // a is untouched by merge (it's the source, not the target)
    expect(getResourceQuote(a, cityX, grain, 20 as Day)).toEqual({ bestAsk: 7, bestBid: 5 });
  });
});

describe('knownPrices: staleness', () => {
  it('observation exactly KNOWN_PRICE_MAX_AGE_DAYS old is still fresh', () => {
    const a = createActor({ id: A, kind: 'patrician_family', name: 'A' });
    recordMarketObservation(a, cityX, obs(0, [['grain', { bestAsk: 7, bestBid: 5 }]]));
    const today = KNOWN_PRICE_MAX_AGE_DAYS as Day;
    const got = getMarketObservation(a, cityX, today);
    expect(got).toBeDefined();
    expect(isMarketObservationStale({ observedDay: 0 as Day, quotes: new Map() }, today)).toBe(
      false,
    );
  });

  it('observation older than KNOWN_PRICE_MAX_AGE_DAYS is treated as missing on read', () => {
    const a = createActor({ id: A, kind: 'patrician_family', name: 'A' });
    recordMarketObservation(a, cityX, obs(0, [['grain', { bestAsk: 7, bestBid: 5 }]]));
    const today = (KNOWN_PRICE_MAX_AGE_DAYS + 1) as Day;
    expect(getMarketObservation(a, cityX, today)).toBeUndefined();
    expect(getResourceQuote(a, cityX, grain, today)).toBeUndefined();
  });

  it('pruneStaleObservations physically drops old entries', () => {
    const a = createActor({ id: A, kind: 'patrician_family', name: 'A' });
    recordMarketObservation(a, cityX, obs(0, [['grain', { bestAsk: 7, bestBid: 5 }]]));
    recordMarketObservation(a, cityY, obs(100, [['wine', { bestAsk: 90, bestBid: 80 }]]));
    pruneStaleObservations(a, (KNOWN_PRICE_MAX_AGE_DAYS + 50) as Day);
    // cityX's day-0 obs is now (max_age + 50) days old → dropped.
    expect(a.knownPrices.has(cityX)).toBe(false);
    // cityY's day-100 obs is only (max_age - 50) days old → kept.
    expect(a.knownPrices.has(cityY)).toBe(true);
  });

  it('iterFreshKnownPrices yields only fresh entries', () => {
    const a = createActor({ id: A, kind: 'patrician_family', name: 'A' });
    recordMarketObservation(a, cityX, obs(0));
    recordMarketObservation(a, cityY, obs(100));
    const today = (KNOWN_PRICE_MAX_AGE_DAYS + 50) as Day;
    const seen = [...iterFreshKnownPrices(a, today)].map(([s]) => s);
    expect(seen).toEqual([cityY]);
  });
});
