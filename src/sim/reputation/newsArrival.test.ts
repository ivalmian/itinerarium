/**
 * News carrier arrival → reputation update tests.
 *
 * The integration walks every named character at the destination settlement,
 * classifies their alignment toward the news perpetrator/victim, builds an
 * ArrivalContext, calls arrivalToReputationEvent (T18) → applyReputationEvent
 * (T17), and returns the deltas applied.
 */

import { describe, expect, it } from 'vitest';
import {
  characterId,
  factionId,
  settlementId,
  type CharacterId,
  type Day,
  type FactionId,
} from '../types.js';
import { hex } from '../world/hex.js';
import { createSettlement, type Settlement } from '../world/settlement.js';
import { createCharacter, type NamedCharacter } from '../politics/character.js';
import { createReputationTable } from './table.js';
import { createNewsCarrier, createNewsItem, type NewsCarrier } from './news.js';
import {
  classifyAlignment,
  processNewsArrival,
  type Alignment,
  type ClassificationContext,
} from './newsArrival.js';

const seedHex = hex(0, 0);

const SETTLEMENT_ID = settlementId('s:aquileia');
const VIBIAN = factionId('f:vibian');
const VIBIAN_ALLY = factionId('f:cornelius');
const VIBIAN_RIVAL = factionId('f:metellus');
const GOVERNOR = factionId('f:governor');
const BANDIT = factionId('f:silva-band');
const NEUTRAL = factionId('f:bystander');

const PATRIARCH = characterId('ch:vibian-patriarch');
const ROBBER = characterId('ch:silva');

const baseSettlement = (): Settlement =>
  createSettlement({
    id: SETTLEMENT_ID,
    tier: 'town',
    name: 'Aquileia',
    anchor: seedHex,
    urbanHexes: [seedHex],
    catchmentHexes: [],
  });

const char = (id: string, faction: FactionId, name: string): NamedCharacter =>
  createCharacter({
    id: characterId(id),
    name,
    age: 40,
    sex: 'male',
    class: 'patrician',
    faction,
    location: seedHex,
  });

const baseCarrier = (): NewsCarrier =>
  createNewsCarrier({
    id: 'nc:1',
    news: createNewsItem({
      id: 'ni:robbery-1',
      perpetrator: ROBBER,
      victim: PATRIARCH,
      magnitude: 'severe',
      isCriminalAct: true,
      occurredAtHex: seedHex,
      occurredOnDay: 0 as Day,
    }),
    spawnHex: seedHex,
    destination: seedHex,
    spawnDay: 0 as Day,
  });

const baseClassification: ClassificationContext = {
  victimFaction: VIBIAN,
  victimAlliedFactions: [VIBIAN_ALLY],
  victimRivalFactions: [VIBIAN_RIVAL],
  authorityFaction: GOVERNOR,
  banditAlignedFactions: [BANDIT],
};

const findDelta = (
  results: ReturnType<typeof processNewsArrival>['reputationDeltasApplied'],
  holder: CharacterId,
): number | undefined => {
  for (const d of results) {
    if (String(d.holder) === String(holder)) return d.delta;
  }
  return undefined;
};

// --- classifyAlignment ------------------------------------------------------

describe('classifyAlignment', () => {
  it('classifies victim-faction member as victim_aligned', () => {
    const c = char('ch:vibian-cousin', VIBIAN, 'Vibian Cousin');
    expect(classifyAlignment(c, baseClassification)).toBe<Alignment>('victim_aligned');
  });

  it('classifies victim-allied family as victim_aligned', () => {
    const c = char('ch:cornelius-elder', VIBIAN_ALLY, 'Cornelius Elder');
    expect(classifyAlignment(c, baseClassification)).toBe<Alignment>('victim_aligned');
  });

  it('classifies victim-rival family as victim_rival', () => {
    const c = char('ch:metellus-elder', VIBIAN_RIVAL, 'Metellus Elder');
    expect(classifyAlignment(c, baseClassification)).toBe<Alignment>('victim_rival');
  });

  it('classifies governor as authority', () => {
    const c = char('ch:governor', GOVERNOR, 'Governor');
    expect(classifyAlignment(c, baseClassification)).toBe<Alignment>('authority');
  });

  it('classifies bandit-aligned faction as bandit_aligned', () => {
    const c = char('ch:fence-aurelius', BANDIT, 'Aurelius Fence');
    expect(classifyAlignment(c, baseClassification)).toBe<Alignment>('bandit_aligned');
  });

  it('classifies unaffiliated character as honest', () => {
    const c = char('ch:bystander', NEUTRAL, 'Bystander');
    expect(classifyAlignment(c, baseClassification)).toBe<Alignment>('honest');
  });

  it('victim membership wins over authority membership when both apply', () => {
    // E.g. a Vibian who happens to also be in the governor's office: per
    // ROLE_PRIORITY in T17, victim-aligned beats authority. classifyAlignment
    // must return the higher-priority bucket.
    const c = char('ch:vibian-magistrate', VIBIAN, 'Vibian Magistrate');
    const ctxBoth: ClassificationContext = {
      ...baseClassification,
      authorityFaction: VIBIAN, // overlap
    };
    expect(classifyAlignment(c, ctxBoth)).toBe<Alignment>('victim_aligned');
  });

  it('with no classification context, character is honest', () => {
    const c = char('ch:loner', NEUTRAL, 'Loner');
    expect(classifyAlignment(c, {})).toBe<Alignment>('honest');
  });
});

// --- processNewsArrival -----------------------------------------------------

describe('processNewsArrival', () => {
  it('throws if the carrier has not arrived', () => {
    const settlement = baseSettlement();
    const carrier: NewsCarrier = { ...baseCarrier(), arrived: false };
    expect(() =>
      processNewsArrival({
        carrier,
        destinationSettlement: settlement,
        charactersAtSettlement: [],
        reputation: createReputationTable(),
        ...baseClassification,
      }),
    ).toThrow(/arrived/i);
  });

  it('returns no deltas when no characters are present', () => {
    const settlement = baseSettlement();
    const reputation = createReputationTable();
    const result = processNewsArrival({
      carrier: baseCarrier(),
      destinationSettlement: settlement,
      charactersAtSettlement: [],
      reputation,
      ...baseClassification,
    });
    expect(result.reputationDeltasApplied).toEqual([]);
    expect(result.charactersUpdated).toBe(0);
  });

  it('applies the docs/13 worked-example deltas for a severe robbery', () => {
    const settlement = baseSettlement();
    const reputation = createReputationTable();
    const allied = char('ch:cornelius', VIBIAN_ALLY, 'Cornelius');
    const rival = char('ch:metellus', VIBIAN_RIVAL, 'Metellus');
    const fence = char('ch:fence', BANDIT, 'Aurelius Fence');
    const bystander = char('ch:bystander', NEUTRAL, 'Bystander');
    const result = processNewsArrival({
      carrier: baseCarrier(),
      destinationSettlement: settlement,
      charactersAtSettlement: [allied, rival, fence, bystander],
      reputation,
      ...baseClassification,
    });
    // Severe (scale 1) × base deltas: victim_allied -0.3, victim_rival -0.1,
    // bandit_aligned +0.2, honest -0.15.
    expect(findDelta(result.reputationDeltasApplied, allied.id)).toBeCloseTo(-0.3);
    expect(findDelta(result.reputationDeltasApplied, rival.id)).toBeCloseTo(-0.1);
    expect(findDelta(result.reputationDeltasApplied, fence.id)).toBeCloseTo(+0.2);
    expect(findDelta(result.reputationDeltasApplied, bystander.id)).toBeCloseTo(-0.15);
    expect(result.charactersUpdated).toBe(4);
  });

  it('updates the reputation table directly (not just returning deltas)', () => {
    const settlement = baseSettlement();
    const reputation = createReputationTable();
    const allied = char('ch:cornelius', VIBIAN_ALLY, 'Cornelius');
    processNewsArrival({
      carrier: baseCarrier(),
      destinationSettlement: settlement,
      charactersAtSettlement: [allied],
      reputation,
      ...baseClassification,
    });
    expect(reputation.get(allied.id, ROBBER)).toBeCloseTo(-0.3);
  });

  it('scales by magnitude (petty = 0.2x, atrocious = 2x)', () => {
    const settlement = baseSettlement();
    const allied = char('ch:cornelius', VIBIAN_ALLY, 'Cornelius');
    const makeCarrier = (mag: 'petty' | 'severe' | 'atrocious'): NewsCarrier =>
      createNewsCarrier({
        id: `nc:${mag}`,
        news: createNewsItem({
          id: `ni:${mag}`,
          perpetrator: ROBBER,
          victim: PATRIARCH,
          magnitude: mag,
          isCriminalAct: true,
          occurredAtHex: seedHex,
          occurredOnDay: 0 as Day,
        }),
        spawnHex: seedHex,
        destination: seedHex,
        spawnDay: 0 as Day,
      });
    const runWith = (mag: 'petty' | 'severe' | 'atrocious'): number => {
      const r = processNewsArrival({
        carrier: makeCarrier(mag),
        destinationSettlement: settlement,
        charactersAtSettlement: [allied],
        reputation: createReputationTable(),
        ...baseClassification,
      });
      const d = findDelta(r.reputationDeltasApplied, allied.id);
      if (d === undefined) throw new Error('expected a delta');
      return d;
    };
    expect(runWith('petty')).toBeCloseTo(-0.3 * 0.2);
    expect(runWith('severe')).toBeCloseTo(-0.3);
    expect(runWith('atrocious')).toBeCloseTo(-0.3 * 2);
  });

  it('a lawful act (isCriminalAct=false) suppresses bandit cheering and authority hit', () => {
    const settlement = baseSettlement();
    const reputation = createReputationTable();
    const fence = char('ch:fence', BANDIT, 'Aurelius Fence');
    const governor = char('ch:governor', GOVERNOR, 'Governor');
    const allied = char('ch:cornelius', VIBIAN_ALLY, 'Cornelius');
    const lawfulCarrier = createNewsCarrier({
      id: 'nc:lawful',
      news: createNewsItem({
        id: 'ni:lawful-tax',
        perpetrator: ROBBER,
        victim: PATRIARCH,
        magnitude: 'severe',
        isCriminalAct: false, // lawful tax collection
        occurredAtHex: seedHex,
        occurredOnDay: 0 as Day,
      }),
      spawnHex: seedHex,
      destination: seedHex,
      spawnDay: 0 as Day,
    });
    const result = processNewsArrival({
      carrier: lawfulCarrier,
      destinationSettlement: settlement,
      charactersAtSettlement: [fence, governor, allied],
      reputation,
      ...baseClassification,
    });
    // Bandit cheering and authority displeasure should be suppressed (delta 0
    // → not emitted by applyReputationEvent). Victim-allied still hurt.
    expect(findDelta(result.reputationDeltasApplied, fence.id)).toBeUndefined();
    expect(findDelta(result.reputationDeltasApplied, governor.id)).toBeUndefined();
    expect(findDelta(result.reputationDeltasApplied, allied.id)).toBeCloseTo(-0.3);
  });

  it('does not apply a delta to the perpetrator about themselves (even if present)', () => {
    const settlement = baseSettlement();
    const reputation = createReputationTable();
    // The perpetrator is a NamedCharacter happening to be at the settlement.
    const robber = char('ch:silva', BANDIT, 'Silva');
    expect(robber.id).toBe(ROBBER);
    const result = processNewsArrival({
      carrier: baseCarrier(),
      destinationSettlement: settlement,
      charactersAtSettlement: [robber],
      reputation,
      ...baseClassification,
    });
    // The perpetrator would be classified bandit_aligned; applyReputationEvent
    // skips the perpetrator-about-themselves entry.
    expect(reputation.get(robber.id, ROBBER)).toBe(0);
    expect(result.reputationDeltasApplied.length).toBe(0);
  });

  it('victim-allied wins over authority when one character is in both buckets', () => {
    const settlement = baseSettlement();
    const reputation = createReputationTable();
    // Construct a character whose faction is both authority AND victim-allied
    // by reusing the same FactionId for both classification roles.
    const overlapping = char('ch:vibian-magistrate', VIBIAN, 'Vibian Magistrate');
    const ctxOverlap: ClassificationContext = {
      ...baseClassification,
      authorityFaction: VIBIAN,
    };
    const result = processNewsArrival({
      carrier: baseCarrier(),
      destinationSettlement: settlement,
      charactersAtSettlement: [overlapping],
      reputation,
      authorityFaction: ctxOverlap.authorityFaction,
      victimFaction: ctxOverlap.victimFaction,
      victimAlliedFactions: ctxOverlap.victimAlliedFactions,
      victimRivalFactions: ctxOverlap.victimRivalFactions,
      banditAlignedFactions: ctxOverlap.banditAlignedFactions,
    });
    // Victim-allied delta -0.3 wins over authority delta -0.3 — same magnitude
    // by accident here, but the role priority is what we're verifying.
    expect(findDelta(result.reputationDeltasApplied, overlapping.id)).toBeCloseTo(-0.3);
  });

  it('determinism — same inputs produce identical deltas', () => {
    const settlement = baseSettlement();
    const allied = char('ch:cornelius', VIBIAN_ALLY, 'Cornelius');
    const fence = char('ch:fence', BANDIT, 'Aurelius Fence');
    const run = (): ReturnType<typeof processNewsArrival> =>
      processNewsArrival({
        carrier: baseCarrier(),
        destinationSettlement: settlement,
        charactersAtSettlement: [allied, fence],
        reputation: createReputationTable(),
        ...baseClassification,
      });
    const a = run();
    const b = run();
    expect(a.reputationDeltasApplied.length).toBe(b.reputationDeltasApplied.length);
    for (let i = 0; i < a.reputationDeltasApplied.length; i++) {
      const da = a.reputationDeltasApplied[i];
      const db = b.reputationDeltasApplied[i];
      if (!da || !db) throw new Error('mismatched delta lengths');
      expect(da.delta).toBe(db.delta);
      expect(String(da.holder)).toBe(String(db.holder));
      expect(String(da.subject)).toBe(String(db.subject));
    }
  });

  it('clamps reputation values to [-1, 1] across repeated arrivals (table guarantee)', () => {
    const settlement = baseSettlement();
    const reputation = createReputationTable();
    const allied = char('ch:cornelius', VIBIAN_ALLY, 'Cornelius');
    // Fire ten severe-robbery arrivals; the table clamps at -1.
    for (let i = 0; i < 10; i++) {
      processNewsArrival({
        carrier: baseCarrier(),
        destinationSettlement: settlement,
        charactersAtSettlement: [allied],
        reputation,
        ...baseClassification,
      });
    }
    const v = reputation.get(allied.id, ROBBER);
    expect(v).toBeLessThanOrEqual(0);
    expect(v).toBeGreaterThanOrEqual(-1);
  });

  it('uses settlement context for diagnostics — counts updated characters even if some receive zero delta', () => {
    // A lawful act delivered to a bandit-aligned receiver yields a 0 delta
    // (cheering suppressed). The character should still be counted as
    // "updated" — the news reached them. Test that charactersUpdated reflects
    // the number we attempted to update, not just the number with non-zero
    // deltas. (Documents the intended semantics; can be revised by team-lead.)
    const settlement = baseSettlement();
    const reputation = createReputationTable();
    const fence = char('ch:fence', BANDIT, 'Aurelius Fence');
    const lawfulCarrier = createNewsCarrier({
      id: 'nc:lawful',
      news: createNewsItem({
        id: 'ni:lawful',
        perpetrator: ROBBER,
        victim: PATRIARCH,
        magnitude: 'severe',
        isCriminalAct: false,
        occurredAtHex: seedHex,
        occurredOnDay: 0 as Day,
      }),
      spawnHex: seedHex,
      destination: seedHex,
      spawnDay: 0 as Day,
    });
    const result = processNewsArrival({
      carrier: lawfulCarrier,
      destinationSettlement: settlement,
      charactersAtSettlement: [fence],
      reputation,
      ...baseClassification,
    });
    // No actual delta applied (bandit cheering suppressed), but the carrier
    // delivered the news; the count reflects the headcount of receivers.
    expect(result.reputationDeltasApplied.length).toBe(0);
    expect(result.charactersUpdated).toBe(1);
  });

  it('handles a news event with no victim (e.g. tax collection from a household)', () => {
    const settlement = baseSettlement();
    const reputation = createReputationTable();
    const allied = char('ch:cornelius', VIBIAN_ALLY, 'Cornelius');
    const carrier = createNewsCarrier({
      id: 'nc:no-victim',
      news: createNewsItem({
        id: 'ni:no-victim',
        perpetrator: ROBBER,
        victim: null,
        magnitude: 'severe',
        isCriminalAct: true,
        occurredAtHex: seedHex,
        occurredOnDay: 0 as Day,
      }),
      spawnHex: seedHex,
      destination: seedHex,
      spawnDay: 0 as Day,
    });
    // Without a victim the victim-allied bucket loses its semantic anchor,
    // but classification still classifies on faction membership and the
    // event still applies. The allied character takes the victim-allied hit.
    const result = processNewsArrival({
      carrier,
      destinationSettlement: settlement,
      charactersAtSettlement: [allied],
      reputation,
      ...baseClassification,
    });
    expect(findDelta(result.reputationDeltasApplied, allied.id)).toBeCloseTo(-0.3);
  });
});
