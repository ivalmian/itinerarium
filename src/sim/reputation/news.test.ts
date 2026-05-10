import { describe, expect, it } from 'vitest';
import { actorId, characterId, type ActorId, type CharacterId, type Day } from '../types.js';
import { hex, hexDistance, type Hex } from '../world/hex.js';
import { createReputationTable, applyReputationEvent, type ReputationKey } from './table.js';
import {
  arrivalToReputationEvent,
  createNewsCarrier,
  createNewsItem,
  tickCarrier,
  type NewsCarrier,
  type NewsItem,
} from './news.js';

const player: ActorId = actorId('player');
const vibian: CharacterId = characterId('vibian-patriarch');
const governor: CharacterId = characterId('governor-quintus');
const merchantA: CharacterId = characterId('merchant-a');
const banditCaptain: CharacterId = characterId('captain-caelius');

const sampleNews = (overrides: Partial<NewsItem> = {}): NewsItem =>
  createNewsItem({
    id: 'news-1',
    perpetrator: player,
    victim: vibian,
    magnitude: 'severe',
    isCriminalAct: true,
    occurredAtHex: hex(0, 0),
    occurredOnDay: 10 as Day,
    ...overrides,
  });

describe('createNewsItem', () => {
  it('builds a NewsItem with the provided fields', () => {
    const n = sampleNews();
    expect(n.id).toBe('news-1');
    expect(n.perpetrator).toBe(player);
    expect(n.victim).toBe(vibian);
    expect(n.magnitude).toBe('severe');
    expect(n.isCriminalAct).toBe(true);
    expect(n.occurredAtHex.q).toBe(0);
    expect(n.occurredAtHex.r).toBe(0);
    expect(n.occurredOnDay).toBe(10);
  });

  it('victim is optional (e.g. a missing-caravan investigation has no specific named victim)', () => {
    const n = createNewsItem({
      id: 'news-2',
      perpetrator: player,
      victim: null,
      magnitude: 'moderate',
      isCriminalAct: false,
      occurredAtHex: hex(1, 1),
      occurredOnDay: 0 as Day,
    });
    expect(n.victim).toBeNull();
  });

  it('rejects empty id', () => {
    expect(() =>
      createNewsItem({
        id: '',
        perpetrator: player,
        victim: null,
        magnitude: 'petty',
        isCriminalAct: true,
        occurredAtHex: hex(0, 0),
        occurredOnDay: 0 as Day,
      }),
    ).toThrow();
  });
});

describe('createNewsCarrier', () => {
  it('starts at the spawn hex with arrived=false and a default refugee speed of 20 km/day', () => {
    const c = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: hex(0, 0),
      destination: hex(50, 0),
      spawnDay: 10 as Day,
    });
    expect(c.id).toBe('c1');
    expect(c.position.q).toBe(0);
    expect(c.position.r).toBe(0);
    expect(c.destination.q).toBe(50);
    expect(c.movementPointsPerDay).toBe(20);
    expect(c.arrived).toBe(false);
    expect(c.startedOnDay).toBe(10);
  });

  it('honors a custom speed', () => {
    const c = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: hex(0, 0),
      destination: hex(10, 0),
      spawnDay: 0 as Day,
      speed: 30,
    });
    expect(c.movementPointsPerDay).toBe(30);
  });

  it('a carrier spawned at the destination is immediately arrived', () => {
    const c = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: hex(5, 5),
      destination: hex(5, 5),
      spawnDay: 0 as Day,
    });
    expect(c.arrived).toBe(true);
    expect(c.position.q).toBe(5);
    expect(c.position.r).toBe(5);
  });

  it('throws on non-positive speed', () => {
    expect(() =>
      createNewsCarrier({
        id: 'c1',
        news: sampleNews(),
        spawnHex: hex(0, 0),
        destination: hex(10, 0),
        spawnDay: 0 as Day,
        speed: 0,
      }),
    ).toThrow();
    expect(() =>
      createNewsCarrier({
        id: 'c1',
        news: sampleNews(),
        spawnHex: hex(0, 0),
        destination: hex(10, 0),
        spawnDay: 0 as Day,
        speed: -1,
      }),
    ).toThrow();
  });

  it('throws on empty id', () => {
    expect(() =>
      createNewsCarrier({
        id: '',
        news: sampleNews(),
        spawnHex: hex(0, 0),
        destination: hex(10, 0),
        spawnDay: 0 as Day,
      }),
    ).toThrow();
  });
});

describe('tickCarrier', () => {
  it('moves the carrier toward the destination by speed hexes per day (straight line)', () => {
    const start = hex(0, 0);
    const dest = hex(50, 0);
    const c = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: start,
      destination: dest,
      spawnDay: 0 as Day,
      speed: 20,
    });
    const next = tickCarrier(c, 1 as Day);
    // Distance closed should equal speed (20 hexes) along a straight line.
    expect(hexDistance(c.position, next.position)).toBe(20);
    expect(hexDistance(next.position, dest)).toBe(30);
    expect(next.arrived).toBe(false);
  });

  it('a multi-day journey arrives after enough ticks', () => {
    const start = hex(0, 0);
    const dest = hex(50, 0);
    let c = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: start,
      destination: dest,
      spawnDay: 0 as Day,
      speed: 20,
    });
    // 50 hex / 20 per day = 3 ticks (third caps at destination).
    c = tickCarrier(c, 1 as Day);
    expect(c.arrived).toBe(false);
    c = tickCarrier(c, 2 as Day);
    expect(c.arrived).toBe(false);
    c = tickCarrier(c, 3 as Day);
    expect(c.arrived).toBe(true);
    expect(c.position.q).toBe(dest.q);
    expect(c.position.r).toBe(dest.r);
  });

  it('clamps to the destination on the final step (no overshoot)', () => {
    const start = hex(0, 0);
    const dest = hex(15, 0); // 15 < speed of 20
    let c = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: start,
      destination: dest,
      spawnDay: 0 as Day,
      speed: 20,
    });
    c = tickCarrier(c, 1 as Day);
    expect(c.arrived).toBe(true);
    expect(c.position.q).toBe(15);
    expect(c.position.r).toBe(0);
  });

  it('a carrier already arrived stays arrived and at the destination on subsequent ticks', () => {
    const dest = hex(5, 5);
    let c = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: dest,
      destination: dest,
      spawnDay: 0 as Day,
    });
    expect(c.arrived).toBe(true);
    c = tickCarrier(c, 1 as Day);
    expect(c.arrived).toBe(true);
    expect(c.position.q).toBe(5);
    expect(c.position.r).toBe(5);
  });

  it('is deterministic: ticking the same carrier from the same state yields the same result', () => {
    const c0 = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: hex(0, 0),
      destination: hex(40, -10),
      spawnDay: 0 as Day,
      speed: 20,
    });
    const a = tickCarrier(c0, 1 as Day);
    const b = tickCarrier(c0, 1 as Day);
    expect(a.position.q).toBe(b.position.q);
    expect(a.position.r).toBe(b.position.r);
    expect(a.arrived).toBe(b.arrived);
  });

  it('returns a new carrier object — does not mutate the input', () => {
    const c0 = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: hex(0, 0),
      destination: hex(40, 0),
      spawnDay: 0 as Day,
      speed: 20,
    });
    const c1 = tickCarrier(c0, 1 as Day);
    expect(c1).not.toBe(c0);
    expect(c0.position.q).toBe(0);
    expect(c0.position.r).toBe(0);
    expect(c0.arrived).toBe(false);
  });

  it('moves along an axis where r changes (not just along q axis)', () => {
    const start = hex(0, 0);
    const dest = hex(0, 30);
    let c = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: start,
      destination: dest,
      spawnDay: 0 as Day,
      speed: 10,
    });
    c = tickCarrier(c, 1 as Day);
    expect(hexDistance(c.position, start)).toBe(10);
    expect(hexDistance(c.position, dest)).toBe(20);
  });

  it('moves along a diagonal (q and r both change)', () => {
    const start = hex(0, 0);
    const dest = hex(20, -10); // distance = max(|20|,|-10|,|-10|) = 20 hexes
    let c = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: start,
      destination: dest,
      spawnDay: 0 as Day,
      speed: 10,
    });
    expect(hexDistance(start, dest)).toBe(20);
    c = tickCarrier(c, 1 as Day);
    // Should have closed half the distance (10 hexes).
    expect(hexDistance(c.position, dest)).toBe(10);
  });
});

describe('arrivalToReputationEvent', () => {
  it('builds a ReputationEvent from arrival context, partitioning receivers by alignment', () => {
    const carrier: NewsCarrier = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: hex(0, 0),
      destination: hex(10, 0),
      spawnDay: 0 as Day,
      speed: 5,
    });
    const event = arrivalToReputationEvent(carrier, {
      receivers: [
        { holder: vibian as ReputationKey, alignment: 'victim_aligned' },
        { holder: characterId('aurelian-patriarch') as ReputationKey, alignment: 'victim_rival' },
        { holder: governor as ReputationKey, alignment: 'authority' },
        { holder: merchantA as ReputationKey, alignment: 'honest' },
        { holder: banditCaptain as ReputationKey, alignment: 'bandit_aligned' },
      ],
    });
    expect(event.perpetrator).toBe(player);
    expect(event.victim).toBe(vibian);
    expect(event.magnitude).toBe('severe');
    expect(event.isCriminalAct).toBe(true);
    expect(event.victimAlliedActors).toContain(vibian);
    expect(event.victimRivalActors).toContain(characterId('aurelian-patriarch'));
    expect(event.authority).toBe(governor);
    expect(event.banditAligned).toContain(banditCaptain);
    expect(event.honestThirdParties).toContain(merchantA);
  });

  it('victim role is preserved on news.victim, even when not in the receivers list', () => {
    const carrier = createNewsCarrier({
      id: 'c1',
      news: sampleNews({ victim: vibian }),
      spawnHex: hex(0, 0),
      destination: hex(0, 0),
      spawnDay: 0 as Day,
    });
    const event = arrivalToReputationEvent(carrier, { receivers: [] });
    expect(event.victim).toBe(vibian);
    expect(event.victimAlliedActors).toHaveLength(0);
  });

  it('null victim in news produces null victim in event', () => {
    const carrier = createNewsCarrier({
      id: 'c1',
      news: sampleNews({ victim: null }),
      spawnHex: hex(0, 0),
      destination: hex(0, 0),
      spawnDay: 0 as Day,
    });
    const event = arrivalToReputationEvent(carrier, { receivers: [] });
    expect(event.victim).toBeNull();
  });

  it('chooses the first authority when receivers list multiple authorities', () => {
    const gov2 = characterId('governor-marcus') as ReputationKey;
    const carrier = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: hex(0, 0),
      destination: hex(0, 0),
      spawnDay: 0 as Day,
    });
    const event = arrivalToReputationEvent(carrier, {
      receivers: [
        { holder: governor as ReputationKey, alignment: 'authority' },
        { holder: gov2, alignment: 'authority' },
      ],
    });
    expect(event.authority).toBe(governor);
  });

  it('integrates end-to-end: carrier journey + arrival → ReputationTable updates per docs/13', () => {
    const start = hex(0, 0);
    const dest = hex(40, 0); // 40 hex / 20 per day = 2 days
    let carrier = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: start,
      destination: dest,
      spawnDay: 0 as Day,
      speed: 20,
    });
    carrier = tickCarrier(carrier, 1 as Day);
    expect(carrier.arrived).toBe(false);
    carrier = tickCarrier(carrier, 2 as Day);
    expect(carrier.arrived).toBe(true);

    const table = createReputationTable();
    const event = arrivalToReputationEvent(carrier, {
      receivers: [
        { holder: vibian as ReputationKey, alignment: 'victim_aligned' },
        { holder: governor as ReputationKey, alignment: 'authority' },
        { holder: banditCaptain as ReputationKey, alignment: 'bandit_aligned' },
      ],
    });
    applyReputationEvent(table, event);
    // Victim is named on the news directly (severe → -0.5).
    expect(table.get(vibian, player)).toBeCloseTo(-0.5, 10);
    expect(table.get(governor, player)).toBeCloseTo(-0.3, 10);
    expect(table.get(banditCaptain, player)).toBeCloseTo(0.2, 10);
  });

  it('victim listed as victim_aligned receiver still wins victim role (not double-counted)', () => {
    // Vibian is the victim AND lists themselves as victim_aligned. They should
    // still take only -0.5 (the victim hit), not victim+victimAllied stacked.
    const carrier = createNewsCarrier({
      id: 'c1',
      news: sampleNews({ victim: vibian }),
      spawnHex: hex(0, 0),
      destination: hex(0, 0),
      spawnDay: 0 as Day,
    });
    const table = createReputationTable();
    const event = arrivalToReputationEvent(carrier, {
      receivers: [{ holder: vibian as ReputationKey, alignment: 'victim_aligned' }],
    });
    applyReputationEvent(table, event);
    expect(table.get(vibian, player)).toBeCloseTo(-0.5, 10);
  });
});

describe('news/carrier exported types are stable across modules', () => {
  it('carrier position is a Hex value', () => {
    const c = createNewsCarrier({
      id: 'c1',
      news: sampleNews(),
      spawnHex: hex(2, 3),
      destination: hex(2, 3),
      spawnDay: 0 as Day,
    });
    const p: Hex = c.position;
    expect(p.q).toBe(2);
    expect(p.r).toBe(3);
  });
});
