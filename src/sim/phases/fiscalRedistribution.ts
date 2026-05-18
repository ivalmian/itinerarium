/**
 * Quarterly fiscal-redistribution phase (docs/15 §C20 + §C22).
 *
 * Keeps cash circulating across owner kinds. Without it, a single
 * watchdog burn-in drains patrician treasuries to ~0 within months
 * while city corporations accumulate the cash — every comfort /
 * status / capital market freezes even though physical stockpiles
 * are huge. See docs/08 §"Cash circulation discipline" for the
 * full mechanism.
 *
 * Two flows fire on the same quarterly cadence as investmentPhase:
 *
 *   1. **civic_dividend** — every city_corporation pays a fixed
 *      fraction (`CITY_CORP_DIVIDEND_FRACTION = 0.08`) of its
 *      treasury, split evenly, to patrician families whose
 *      `homeSettlement` matches the city. Models cura annonae /
 *      magistrate stipends / civic contract pay. ≈32% APR.
 *
 *   2. **tenant_rent** — each `free_village` / `hamlet_household`
 *      pays rent to the patrician families of its nearest patron
 *      city (within `TENANT_RENT_MAX_HEX_DISTANCE`), split evenly
 *      across all families there. `TENANT_RENT_FRACTION_PER_QUARTER
 *      = 0.05` (≈22% APR), capped at `TENANT_RENT_TREASURY_CAP_FRACTION
 *      = 0.15` of tenant treasury so a single collection never
 *      overdrafts.
 *
 * The legacy `merchant_residual` channel was REMOVED in §C22
 * because it was a synthetic transfer with no real economic story.
 * The proper inbound coin flow from off-map is the export-caravan
 * path: cities ship surplus → cargo crosses the map edge →
 * global-market coin credits the source actor's treasury via
 * `completeOffMapExportIfArrived`. Off-map houses still accumulate
 * treasury from import sales, but they don't bid on-map for
 * anything, so that growth is a benign sink.
 *
 * Each transfer emits a `fiscal_redistribution` event so the viewer
 * and burn-in instrumentation can audit the flows.
 */

import { addCoin, subtractCoin, type Actor } from '../politics/actor.js';
import type { Day, SettlementId } from '../types.js';
import { hexDistance, type Hex } from '../world/hex.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

const CITY_CORP_DIVIDEND_FRACTION = 0.08;
const TENANT_RENT_FRACTION_PER_QUARTER = 0.05;
const TENANT_RENT_TREASURY_CAP_FRACTION = 0.15;
const TENANT_RENT_MAX_HEX_DISTANCE = 30;
const FISCAL_TRANSFER_MIN_COIN = 0.5;

const nearestPatricianWithin = (
  anchors: readonly { actor: Actor; anchor: Hex }[],
  target: Hex,
  maxDistance: number,
): Actor | null => {
  let best: Actor | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  let bestId: string | undefined;
  for (const entry of anchors) {
    const d = hexDistance(target, entry.anchor);
    if (d > maxDistance) continue;
    if (d < bestDist || (d === bestDist && (bestId === undefined || entry.actor.id < bestId))) {
      best = entry.actor;
      bestDist = d;
      bestId = String(entry.actor.id);
    }
  }
  return best;
};

export const fiscalRedistributionPhase = (
  world: WorldState,
  _today: Day,
  events: TickEvent[],
): void => {
  void _today;
  // Index patrician families by homeSettlement for civic-dividend split.
  const patriciansBySettlement = new Map<SettlementId, Actor[]>();
  // Also keep a flat list for tenant-rent proximity lookups, paired
  // with the family's home anchor hex.
  const patricianAnchors: { actor: Actor; anchor: Hex }[] = [];
  for (const a of world.actors.values()) {
    if (a.kind !== 'patrician_family') continue;
    if (a.homeSettlement === undefined) continue;
    const home = world.settlements.get(a.homeSettlement);
    if (home === undefined) continue;
    let bucket = patriciansBySettlement.get(a.homeSettlement);
    if (bucket === undefined) {
      bucket = [];
      patriciansBySettlement.set(a.homeSettlement, bucket);
    }
    bucket.push(a);
    patricianAnchors.push({ actor: a, anchor: home.anchor });
  }

  // Channel 1: civic_dividend.
  for (const corp of world.actors.values()) {
    if (corp.kind !== 'city_corporation') continue;
    if (corp.homeSettlement === undefined) continue;
    const families = patriciansBySettlement.get(corp.homeSettlement);
    if (families === undefined || families.length === 0) continue;
    const pool = corp.treasury * CITY_CORP_DIVIDEND_FRACTION;
    if (pool < FISCAL_TRANSFER_MIN_COIN) continue;
    const perFamily = pool / families.length;
    for (const family of families) {
      const transfer = Math.min(perFamily, corp.treasury);
      if (transfer < FISCAL_TRANSFER_MIN_COIN) continue;
      subtractCoin(corp, transfer);
      addCoin(family, transfer);
      events.push({
        type: 'fiscal_redistribution',
        channel: 'civic_dividend',
        payer: corp.id,
        recipient: family.id,
        coinPaid: transfer,
      });
    }
  }

  // Channel 2: tenant_rent.
  if (patricianAnchors.length > 0) {
    // Group patricians by home settlement for the per-city split.
    const familiesByHome = new Map<SettlementId, Actor[]>();
    for (const entry of patricianAnchors) {
      const home = entry.actor.homeSettlement;
      if (home === undefined) continue;
      let bucket = familiesByHome.get(home);
      if (bucket === undefined) {
        bucket = [];
        familiesByHome.set(home, bucket);
      }
      bucket.push(entry.actor);
    }
    for (const tenant of world.actors.values()) {
      if (tenant.kind !== 'free_village' && tenant.kind !== 'hamlet_household') continue;
      if (tenant.homeSettlement === undefined) continue;
      const tenantHome = world.settlements.get(tenant.homeSettlement);
      if (tenantHome === undefined) continue;
      const patron = nearestPatricianWithin(
        patricianAnchors,
        tenantHome.anchor,
        TENANT_RENT_MAX_HEX_DISTANCE,
      );
      if (patron === null) continue;
      const patronHome = patron.homeSettlement;
      if (patronHome === undefined) continue;
      const families = familiesByHome.get(patronHome);
      if (families === undefined || families.length === 0) continue;
      const wanted = tenant.treasury * TENANT_RENT_FRACTION_PER_QUARTER;
      const cap = tenant.treasury * TENANT_RENT_TREASURY_CAP_FRACTION;
      const totalTransfer = Math.min(wanted, cap, tenant.treasury);
      if (totalTransfer < FISCAL_TRANSFER_MIN_COIN) continue;
      const perFamily = totalTransfer / families.length;
      for (const family of families) {
        if (perFamily < FISCAL_TRANSFER_MIN_COIN) continue;
        const actual = Math.min(perFamily, tenant.treasury);
        if (actual < FISCAL_TRANSFER_MIN_COIN) continue;
        subtractCoin(tenant, actual);
        addCoin(family, actual);
        events.push({
          type: 'fiscal_redistribution',
          channel: 'tenant_rent',
          payer: tenant.id,
          recipient: family.id,
          coinPaid: actual,
        });
      }
    }
  }
};
