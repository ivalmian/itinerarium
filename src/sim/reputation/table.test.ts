import { describe, expect, it } from 'vitest';
import { actorId, characterId, type ActorId, type CharacterId } from '../types.js';
import {
  applyReputationEvent,
  createReputationTable,
  type ReputationEvent,
  type ReputationKey,
} from './table.js';

const player: ActorId = actorId('player');
const vibian: CharacterId = characterId('vibian-patriarch');
const aurelian: CharacterId = characterId('aurelian-patriarch');
const governor: CharacterId = characterId('governor-quintus');
const merchantA: CharacterId = characterId('merchant-a');
const banditCaptain: CharacterId = characterId('captain-caelius');

describe('createReputationTable', () => {
  it('returns 0 for any unset pair', () => {
    const t = createReputationTable();
    expect(t.get(vibian, player)).toBe(0);
    expect(t.size()).toBe(0);
  });

  it('set then get round-trips the value', () => {
    const t = createReputationTable();
    t.set(vibian, player, -0.5);
    expect(t.get(vibian, player)).toBe(-0.5);
    expect(t.size()).toBe(1);
  });

  it('set is per-pair (directional, not symmetric)', () => {
    const t = createReputationTable();
    t.set(vibian, player, -0.5);
    expect(t.get(player, vibian)).toBe(0);
  });

  it('set throws when value is out of [-1, 1]', () => {
    const t = createReputationTable();
    expect(() => t.set(vibian, player, -1.5)).toThrow();
    expect(() => t.set(vibian, player, 1.01)).toThrow();
  });

  it('set throws when value is NaN or non-finite', () => {
    const t = createReputationTable();
    expect(() => t.set(vibian, player, NaN)).toThrow();
    expect(() => t.set(vibian, player, Infinity)).toThrow();
  });

  it('setting a holder = subject pair throws (a character has no reputation of itself)', () => {
    const t = createReputationTable();
    expect(() => t.set(vibian, vibian, 0.5)).toThrow();
  });

  it('setting to 0 prunes the entry (sparse storage)', () => {
    const t = createReputationTable();
    t.set(vibian, player, -0.5);
    expect(t.size()).toBe(1);
    t.set(vibian, player, 0);
    expect(t.size()).toBe(0);
    expect(t.get(vibian, player)).toBe(0);
  });
});

describe('apply', () => {
  it('applies a delta and returns the new clamped value', () => {
    const t = createReputationTable();
    expect(t.apply(vibian, player, -0.3)).toBe(-0.3);
    expect(t.apply(vibian, player, -0.5)).toBeCloseTo(-0.8, 10);
  });

  it('clamps to [-1, 1]', () => {
    const t = createReputationTable();
    t.apply(vibian, player, -0.7);
    const v = t.apply(vibian, player, -0.7);
    expect(v).toBe(-1);
    expect(t.get(vibian, player)).toBe(-1);

    const positive = t.apply(banditCaptain, player, 0.6);
    expect(positive).toBe(0.6);
    const positive2 = t.apply(banditCaptain, player, 0.9);
    expect(positive2).toBe(1);
  });

  it('apply with delta 0 is a no-op (no entry created)', () => {
    const t = createReputationTable();
    t.apply(vibian, player, 0);
    expect(t.size()).toBe(0);
  });

  it('apply throws on non-finite delta', () => {
    const t = createReputationTable();
    expect(() => t.apply(vibian, player, NaN)).toThrow();
    expect(() => t.apply(vibian, player, Infinity)).toThrow();
  });

  it('apply on holder = subject throws', () => {
    const t = createReputationTable();
    expect(() => t.apply(vibian, vibian, -0.1)).toThrow();
  });
});

describe('entries', () => {
  it('iterates only non-zero entries', () => {
    const t = createReputationTable();
    t.set(vibian, player, -0.5);
    t.set(banditCaptain, player, 0.4);
    const seen = Array.from(t.entries());
    expect(seen).toHaveLength(2);
    const players = seen.map((e) => ({
      h: String(e.holder),
      s: String(e.subject),
      v: e.value,
    }));
    expect(players).toContainEqual({ h: 'vibian-patriarch', s: 'player', v: -0.5 });
    expect(players).toContainEqual({ h: 'captain-caelius', s: 'player', v: 0.4 });
  });

  it('returns an empty iterator for an empty table', () => {
    const t = createReputationTable();
    expect(Array.from(t.entries())).toHaveLength(0);
  });
});

describe('decayTick', () => {
  it('halves a non-zero entry after halfLifeDays of decay ticks (geometric per-day decay)', () => {
    const t = createReputationTable();
    t.set(vibian, player, -0.8);
    const halfLife = 365;
    for (let i = 0; i < halfLife; i++) t.decayTick(halfLife);
    // After exactly halfLife ticks of factor 2^(-1/halfLife), value should be -0.4.
    expect(t.get(vibian, player)).toBeCloseTo(-0.4, 6);
  });

  it('over many half-lives, value approaches 0', () => {
    const t = createReputationTable();
    t.set(vibian, player, -0.8);
    const halfLife = 10;
    for (let i = 0; i < halfLife * 20; i++) t.decayTick(halfLife);
    // After 20 half-lives, value should be |0.8| * 2^-20 ≈ 7.6e-7. Below epsilon → pruned.
    expect(Math.abs(t.get(vibian, player))).toBeLessThan(1e-5);
  });

  it('prunes entries that decay below epsilon', () => {
    const t = createReputationTable();
    t.set(vibian, player, 0.001);
    const halfLife = 1;
    for (let i = 0; i < 50; i++) t.decayTick(halfLife);
    expect(t.size()).toBe(0);
  });

  it('empty table is a no-op', () => {
    const t = createReputationTable();
    t.decayTick(365);
    expect(t.size()).toBe(0);
  });

  it('throws on non-positive halfLifeDays', () => {
    const t = createReputationTable();
    expect(() => t.decayTick(0)).toThrow();
    expect(() => t.decayTick(-5)).toThrow();
  });

  it('positive and negative entries decay symmetrically', () => {
    const t = createReputationTable();
    t.set(vibian, player, -0.8);
    t.set(banditCaptain, player, 0.8);
    const halfLife = 10;
    for (let i = 0; i < halfLife; i++) t.decayTick(halfLife);
    expect(t.get(vibian, player)).toBeCloseTo(-0.4, 6);
    expect(t.get(banditCaptain, player)).toBeCloseTo(0.4, 6);
  });
});

describe('applyReputationEvent — worked example from docs/13', () => {
  const buildVibianRobbery = (): ReputationEvent => ({
    perpetrator: player,
    victim: vibian,
    victimAlliedActors: [characterId('vibian-ally-1')] as readonly ReputationKey[],
    victimRivalActors: [aurelian] as readonly ReputationKey[],
    authority: governor,
    banditAligned: [banditCaptain] as readonly ReputationKey[],
    honestThirdParties: [merchantA] as readonly ReputationKey[],
    magnitude: 'severe',
    isCriminalAct: true,
  });

  it('victim takes -0.5 from a severe criminal act', () => {
    const t = createReputationTable();
    const event = buildVibianRobbery();
    applyReputationEvent(t, event);
    expect(t.get(vibian, player)).toBeCloseTo(-0.5, 10);
  });

  it('victim-allied takes -0.3', () => {
    const t = createReputationTable();
    applyReputationEvent(t, buildVibianRobbery());
    expect(t.get(characterId('vibian-ally-1'), player)).toBeCloseTo(-0.3, 10);
  });

  it('victim-rival takes -0.1 (mild displeasure with a sliver of schadenfreude)', () => {
    const t = createReputationTable();
    applyReputationEvent(t, buildVibianRobbery());
    expect(t.get(aurelian, player)).toBeCloseTo(-0.1, 10);
  });

  it('authority takes -0.3', () => {
    const t = createReputationTable();
    applyReputationEvent(t, buildVibianRobbery());
    expect(t.get(governor, player)).toBeCloseTo(-0.3, 10);
  });

  it('honest third party takes -0.15', () => {
    const t = createReputationTable();
    applyReputationEvent(t, buildVibianRobbery());
    expect(t.get(merchantA, player)).toBeCloseTo(-0.15, 10);
  });

  it('bandit-aligned takes +0.2 ("a fellow operator!")', () => {
    const t = createReputationTable();
    applyReputationEvent(t, buildVibianRobbery());
    expect(t.get(banditCaptain, player)).toBeCloseTo(0.2, 10);
  });

  it('returns the list of (holder, subject, delta) triples actually applied', () => {
    const t = createReputationTable();
    const applied = applyReputationEvent(t, buildVibianRobbery());
    expect(applied.length).toBe(6);
    const triples = applied.map((a) => ({ h: String(a.holder), s: String(a.subject), d: a.delta }));
    expect(triples).toContainEqual({ h: 'vibian-patriarch', s: 'player', d: -0.5 });
    expect(triples).toContainEqual({ h: 'vibian-ally-1', s: 'player', d: -0.3 });
    expect(triples).toContainEqual({ h: 'aurelian-patriarch', s: 'player', d: -0.1 });
    expect(triples).toContainEqual({ h: 'governor-quintus', s: 'player', d: -0.3 });
    expect(triples).toContainEqual({ h: 'merchant-a', s: 'player', d: -0.15 });
    expect(triples).toContainEqual({ h: 'captain-caelius', s: 'player', d: 0.2 });
  });

  it('event with no victim still propagates to authority and bandit-aligned (e.g. a public assault on no one specific)', () => {
    const t = createReputationTable();
    applyReputationEvent(t, {
      perpetrator: player,
      victim: null,
      victimAlliedActors: [],
      victimRivalActors: [],
      authority: governor,
      banditAligned: [banditCaptain],
      honestThirdParties: [merchantA],
      magnitude: 'severe',
      isCriminalAct: true,
    });
    expect(t.get(governor, player)).toBeCloseTo(-0.3, 10);
    expect(t.get(merchantA, player)).toBeCloseTo(-0.15, 10);
    expect(t.get(banditCaptain, player)).toBeCloseTo(0.2, 10);
    expect(t.get(vibian, player)).toBe(0);
  });

  it('petty magnitude is much smaller than severe', () => {
    const t = createReputationTable();
    applyReputationEvent(t, {
      perpetrator: player,
      victim: vibian,
      victimAlliedActors: [],
      victimRivalActors: [],
      authority: null,
      banditAligned: [],
      honestThirdParties: [],
      magnitude: 'petty',
      isCriminalAct: true,
    });
    const v = t.get(vibian, player);
    expect(v).toBeLessThan(0);
    expect(Math.abs(v)).toBeLessThan(0.5);
  });

  it('atrocious magnitude is more severe than severe', () => {
    const t = createReputationTable();
    applyReputationEvent(t, {
      perpetrator: player,
      victim: vibian,
      victimAlliedActors: [],
      victimRivalActors: [],
      authority: null,
      banditAligned: [],
      honestThirdParties: [],
      magnitude: 'atrocious',
      isCriminalAct: true,
    });
    expect(Math.abs(t.get(vibian, player))).toBeGreaterThan(0.5);
  });

  it('non-criminal acts (e.g. lawful tax collection) do not push bandit-aligned positive', () => {
    const t = createReputationTable();
    applyReputationEvent(t, {
      perpetrator: player,
      victim: vibian,
      victimAlliedActors: [],
      victimRivalActors: [],
      authority: governor,
      banditAligned: [banditCaptain],
      honestThirdParties: [merchantA],
      magnitude: 'severe',
      isCriminalAct: false,
    });
    // Bandits are not cheering on a lawful actor.
    expect(t.get(banditCaptain, player)).toBeLessThanOrEqual(0);
  });

  it('a holder appearing in multiple roles only takes one delta (deduped)', () => {
    const t = createReputationTable();
    // Same character in honestThirdParties twice should not stack.
    applyReputationEvent(t, {
      perpetrator: player,
      victim: vibian,
      victimAlliedActors: [],
      victimRivalActors: [],
      authority: null,
      banditAligned: [],
      honestThirdParties: [merchantA, merchantA] as readonly ReputationKey[],
      magnitude: 'severe',
      isCriminalAct: true,
    });
    expect(t.get(merchantA, player)).toBeCloseTo(-0.15, 10);
  });

  it('victim role wins when same character is also listed elsewhere (priority order)', () => {
    // If aurelian is somehow listed both as rival and as honest third party, victim-related role wins.
    const t = createReputationTable();
    applyReputationEvent(t, {
      perpetrator: player,
      victim: vibian,
      victimAlliedActors: [],
      victimRivalActors: [aurelian],
      authority: null,
      banditAligned: [],
      honestThirdParties: [aurelian] as readonly ReputationKey[],
      magnitude: 'severe',
      isCriminalAct: true,
    });
    // Victim-rival (-0.1) wins over honest third party (-0.15) since it's a more specific relationship.
    expect(t.get(aurelian, player)).toBeCloseTo(-0.1, 10);
  });
});
