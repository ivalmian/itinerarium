/**
 * Tests for the shared stockpile mutation wrappers, especially the
 * coin → treasury routing required by docs/08 §"Mint output flows to
 * treasury": a minted coin must never sit inert in the producer's
 * stockpile; it credits the owner's spendable treasury directly. The
 * same wrapper is also called by the caravan tax-arrival path, so the
 * coverage here is the load-bearing contract that both phases rely on.
 */

import { describe, expect, it } from 'vitest';

import { createActor, getStockAt } from '../politics/actor.js';
import { actorId, resourceId, settlementId } from '../types.js';

import {
  COIN_RESOURCE,
  decreaseStockpile,
  increaseStockpile,
  receiveResourceOrCoin,
} from './stockpileMutation.js';

const ACTOR = actorId('actor:treasury-test');
const SETTLEMENT = settlementId('settlement:test-1');
const GRAIN = resourceId('food.grain');

describe('receiveResourceOrCoin', () => {
  it('credits goods.coin to the actor treasury, not the stockpile', () => {
    const actor = createActor({
      id: ACTOR,
      kind: 'city_corporation',
      name: 'Test City',
      treasury: 100,
    });
    receiveResourceOrCoin(actor, SETTLEMENT, COIN_RESOURCE, 250);
    expect(actor.treasury).toBe(350);
    // No coin should appear in the stockpile — mint output is a
    // treasury credit per docs/08, never a stockpile good.
    expect(getStockAt(actor, SETTLEMENT, COIN_RESOURCE)).toBe(0);
  });

  it('credits a tangible good to the per-settlement stockpile, not the treasury', () => {
    const actor = createActor({
      id: ACTOR,
      kind: 'city_corporation',
      name: 'Test City',
      treasury: 50,
    });
    receiveResourceOrCoin(actor, SETTLEMENT, GRAIN, 30);
    expect(actor.treasury).toBe(50);
    expect(getStockAt(actor, SETTLEMENT, GRAIN)).toBe(30);
  });

  it('ignores non-positive quantities (no debit, no credit)', () => {
    const actor = createActor({
      id: ACTOR,
      kind: 'city_corporation',
      name: 'Test City',
      treasury: 10,
    });
    receiveResourceOrCoin(actor, SETTLEMENT, COIN_RESOURCE, 0);
    receiveResourceOrCoin(actor, SETTLEMENT, COIN_RESOURCE, -5);
    receiveResourceOrCoin(actor, SETTLEMENT, GRAIN, -2);
    expect(actor.treasury).toBe(10);
    expect(getStockAt(actor, SETTLEMENT, GRAIN)).toBe(0);
  });
});

describe('increaseStockpile / decreaseStockpile', () => {
  it('mutate the per-settlement slice without touching treasury', () => {
    const actor = createActor({
      id: ACTOR,
      kind: 'patrician_family',
      name: 'Test Family',
      treasury: 0,
    });
    increaseStockpile(actor, SETTLEMENT, GRAIN, 100);
    expect(getStockAt(actor, SETTLEMENT, GRAIN)).toBe(100);
    decreaseStockpile(actor, SETTLEMENT, GRAIN, 40);
    expect(getStockAt(actor, SETTLEMENT, GRAIN)).toBe(60);
    expect(actor.treasury).toBe(0);
  });
});
