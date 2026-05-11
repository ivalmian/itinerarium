/**
 * Merchant guilds — communicated price discovery (docs/15 §C17 +
 * docs/08 §"Communicated price discovery via guilds" + docs/10
 * Decision 27).
 *
 * Each city of size ≥ town hosts a merchant guild. Member NPC
 * caravans drop their recent price observations into the guild's
 * shared ledger when they arrive home, and read the latest
 * collective ledger when they depart. The result is a delayed
 * shared-information channel: the spread caravan A spotted in
 * City B is visible to caravan C at City A several days later
 * (the round trip of caravan A), but never instantaneously.
 *
 * Cross-guild rumor: when two members of different guilds happen
 * to be on the same hex (caravans pass each other on the road),
 * they exchange a slice of their ledgers. Long-haul rumor.
 */

import type { ActorId, CaravanId, Day, ResourceId, SettlementId } from '../types.js';

export interface GuildPriceObs {
  readonly price: number;
  readonly observedOnDay: Day;
}

export interface Guild {
  readonly id: ActorId;
  readonly name: string;
  /** Settlement this guild is anchored to. */
  readonly homeSettlement: SettlementId;
  /** Caravan owner ids who are members. */
  readonly members: Set<ActorId>;
  /** Shared ledger: resource → settlement-anchor-key → most recent observation. */
  readonly priceLedger: Map<ResourceId, Map<string, GuildPriceObs>>;
}

export interface CreateGuildInput {
  readonly id: ActorId;
  readonly name: string;
  readonly homeSettlement: SettlementId;
}

export const createGuild = (input: CreateGuildInput): Guild => {
  if (input.name.length === 0) {
    throw new Error(`Guild ${String(input.id)} must have a non-empty name`);
  }
  return {
    id: input.id,
    name: input.name,
    homeSettlement: input.homeSettlement,
    members: new Set<ActorId>(),
    priceLedger: new Map(),
  };
};

export const addGuildMember = (guild: Guild, actor: ActorId): void => {
  guild.members.add(actor);
};

/**
 * Deposit a single (resource, hex) observation into the ledger,
 * keeping the freshest one. `hexKey` should be the canonical
 * `${q},${r}` form so different observers' positions match.
 */
export const depositObservation = (
  guild: Guild,
  resource: ResourceId,
  hexKey: string,
  obs: GuildPriceObs,
): void => {
  let byHex = guild.priceLedger.get(resource);
  if (byHex === undefined) {
    byHex = new Map<string, GuildPriceObs>();
    guild.priceLedger.set(resource, byHex);
  }
  const prev = byHex.get(hexKey);
  if (prev === undefined || obs.observedOnDay > prev.observedOnDay) {
    byHex.set(hexKey, obs);
  }
};

/**
 * Merge a slice of source's ledger into target's ledger. Used by
 * (a) the per-arrival deposit and (b) the cross-guild rumor exchange.
 * `maxAgeDays` filters stale observations relative to `today`.
 */
export const mergeLedgerInto = (
  target: Guild,
  source: ReadonlyMap<ResourceId, ReadonlyMap<string, GuildPriceObs>>,
  today: Day,
  maxAgeDays: number,
): void => {
  for (const [resource, byHex] of source) {
    for (const [hexKey, obs] of byHex) {
      if (today - obs.observedOnDay > maxAgeDays) continue;
      depositObservation(target, resource, hexKey, obs);
    }
  }
};

/**
 * Return the freshest observation for a (resource, hex) — used by
 * the caravan AI when re-planning departure from the guild.
 */
export const lookupObservation = (
  guild: Guild,
  resource: ResourceId,
  hexKey: string,
): GuildPriceObs | undefined => {
  return guild.priceLedger.get(resource)?.get(hexKey);
};

/**
 * Tracking the per-caravan "what guild does this caravan owner
 * belong to". Built once at procgen + memoized for the tick loop.
 */
export type GuildByMember = ReadonlyMap<ActorId, Guild>;

export const buildGuildByMember = (guilds: Iterable<Guild>): GuildByMember => {
  const out = new Map<ActorId, Guild>();
  for (const g of guilds) {
    for (const m of g.members) out.set(m, g);
  }
  return out;
};

/** Used only as a re-export shim so callers don't need to import the
 *  ActorId/SettlementId/CaravanId tags individually for typing helpers
 *  in the guild module. */
export type { ActorId, CaravanId, SettlementId };
