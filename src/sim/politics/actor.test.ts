import { describe, expect, it } from 'vitest';
import {
  actorId,
  resourceId,
  settlementId,
  type ActorId,
  type ResourceId,
  type SettlementId,
} from '../types.js';
import {
  ACTOR_KINDS,
  addToStockpile,
  createActor,
  getStockpile,
  removeFromStockpile,
  type Actor,
  type ActorKind,
} from './actor.js';

const id = (s: string): ActorId => actorId(s);
const grain = resourceId('grain');
const oil = resourceId('olive_oil');
const aquileia: SettlementId = settlementId('aquileia');

describe('ACTOR_KINDS', () => {
  it('enumerates the kinds from docs/11', () => {
    const expected: readonly ActorKind[] = [
      'patrician_family',
      'free_village',
      'hamlet_household',
      'governor_office',
      'temple',
      'bandit_camp',
      'caravan_owner',
      'player',
      'off_map_house',
      'city_corporation',
      // docs/15 §C17: merchant guilds for price discovery.
      'merchant_guild',
    ];
    for (const k of expected) expect(ACTOR_KINDS).toContain(k);
    expect(ACTOR_KINDS).toHaveLength(expected.length);
  });
});

describe('createActor', () => {
  it('creates an actor with the provided fields and zero treasury/stockpile', () => {
    const a = createActor({
      id: id('vibian'),
      kind: 'patrician_family',
      name: 'Family Vibian of Aquileia',
      homeSettlement: aquileia,
    });
    expect(a.id).toBe(id('vibian'));
    expect(a.kind).toBe('patrician_family');
    expect(a.name).toBe('Family Vibian of Aquileia');
    expect(a.homeSettlement).toBe(aquileia);
    expect(a.treasury).toBe(0);
    expect(a.stockpile.size).toBe(0);
  });

  it('homeSettlement is optional (e.g. the player has none)', () => {
    const a = createActor({
      id: id('player'),
      kind: 'player',
      name: 'You',
    });
    expect(a.homeSettlement).toBeUndefined();
  });

  it('initial treasury can be set', () => {
    const a = createActor({
      id: id('rich'),
      kind: 'patrician_family',
      name: 'Family Aurelian',
      homeSettlement: aquileia,
      treasury: 10000,
    });
    expect(a.treasury).toBe(10000);
  });

  it('rejects empty name', () => {
    expect(() => createActor({ id: id('x'), kind: 'player', name: '' })).toThrow();
  });
});

describe('stockpile accounting', () => {
  const fresh = (): Actor =>
    createActor({
      id: id('store'),
      kind: 'patrician_family',
      name: 'Storehouse',
      homeSettlement: aquileia,
    });

  it('getStockpile returns 0 for unknown resource', () => {
    const a = fresh();
    expect(getStockpile(a, grain)).toBe(0);
  });

  it('addToStockpile then getStockpile returns the added quantity', () => {
    const a = fresh();
    addToStockpile(a, grain, 50);
    expect(getStockpile(a, grain)).toBe(50);
  });

  it('addToStockpile is cumulative', () => {
    const a = fresh();
    addToStockpile(a, grain, 50);
    addToStockpile(a, grain, 30);
    expect(getStockpile(a, grain)).toBe(80);
  });

  it('removeFromStockpile subtracts and balances to 0', () => {
    const a = fresh();
    addToStockpile(a, grain, 50);
    removeFromStockpile(a, grain, 50);
    expect(getStockpile(a, grain)).toBe(0);
  });

  it('removeFromStockpile past zero throws', () => {
    const a = fresh();
    addToStockpile(a, grain, 5);
    expect(() => removeFromStockpile(a, grain, 6)).toThrow();
    // Failed remove must not have mutated state.
    expect(getStockpile(a, grain)).toBe(5);
  });

  it('removing exactly to zero leaves no entry behind', () => {
    const a = fresh();
    addToStockpile(a, grain, 7);
    removeFromStockpile(a, grain, 7);
    expect(a.stockpile.has(grain)).toBe(false);
  });

  it('rejects non-positive add quantity', () => {
    const a = fresh();
    expect(() => addToStockpile(a, grain, 0)).toThrow();
    expect(() => addToStockpile(a, grain, -1)).toThrow();
  });

  it('rejects non-positive remove quantity', () => {
    const a = fresh();
    addToStockpile(a, grain, 10);
    expect(() => removeFromStockpile(a, grain, 0)).toThrow();
    expect(() => removeFromStockpile(a, grain, -1)).toThrow();
  });

  it('handles multiple resource types independently', () => {
    const a = fresh();
    addToStockpile(a, grain, 100);
    addToStockpile(a, oil, 25);
    expect(getStockpile(a, grain)).toBe(100);
    expect(getStockpile(a, oil)).toBe(25);
    removeFromStockpile(a, grain, 40);
    expect(getStockpile(a, grain)).toBe(60);
    expect(getStockpile(a, oil)).toBe(25);
  });

  it('rejects fractional quantities', () => {
    const a = fresh();
    expect(() => addToStockpile(a, grain, 1.5)).toThrow();
  });
});

describe('actor identity uniqueness via ID branding', () => {
  it('IDs are stored exactly as supplied', () => {
    const a = createActor({ id: id('actor-1'), kind: 'temple', name: 'Temple of Mars' });
    const b = createActor({ id: id('actor-2'), kind: 'temple', name: 'Temple of Vesta' });
    expect(a.id).not.toBe(b.id);
  });
});

describe('ownership marker (hex / village owner-actor lookup)', () => {
  it('a patron family can be assigned as owner of a tenant village hex', () => {
    // The actor model stores its own data; ownership is a relation
    // tracked by the geography layer. Here we just confirm the Actor
    // can be referenced via its branded ID for that purpose.
    const family = createActor({
      id: id('vibian'),
      kind: 'patrician_family',
      name: 'Family Vibian',
      homeSettlement: aquileia,
    });
    const ownerOf = new Map<string, ActorId>();
    ownerOf.set('hex:12,7', family.id);
    expect(ownerOf.get('hex:12,7')).toBe(family.id);
  });
});

describe('treasury bookkeeping', () => {
  it('treasury can be mutated directly (it is a public field by design)', () => {
    const a = createActor({ id: id('a'), kind: 'player', name: 'You', treasury: 100 });
    a.treasury -= 30;
    expect(a.treasury).toBe(70);
  });
});

describe('resourceId/quantity types', () => {
  it('typed ResourceId/Quantity round-trip cleanly', () => {
    const a = createActor({ id: id('a'), kind: 'temple', name: 'T' });
    const r: ResourceId = grain;
    addToStockpile(a, r, 1);
    expect(getStockpile(a, r)).toBe(1);
  });
});
