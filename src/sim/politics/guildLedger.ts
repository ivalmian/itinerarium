/**
 * Per-tick merchant-guild ledger maintenance.
 *
 * Per docs/15 §C17 merchant guilds share a collective price ledger
 * across their member caravans. Two things keep the ledger fresh:
 *
 *   1. `syncCaravanWithLocalGuild`: when a caravan arrives at a
 *      settlement, deposit its private observations into its guild's
 *      ledger AND pull the guild's collective fresher entries back
 *      into the caravan's priceBook. Called by the per-tick caravan
 *      replan path.
 *
 *   2. `crossGuildRumorPhase`: once per tick, find caravans of
 *      *different* guilds co-located on the same hex, and have them
 *      exchange a slice of their ledgers. This is how knowledge
 *      crosses guild boundaries (slowly).
 *
 * Both share a one-tick cache of `actorId → Guild` so the lookup is
 * cheap when called many times within the same tick. The cache is
 * keyed on (world, today) and invalidates automatically when either
 * changes.
 *
 * Originally lived inline in `src/sim/tick.ts`; moved here so the
 * tick orchestrator can stay slim.
 */

import type { Caravan } from '../caravan/caravan.js';
import type { ActorId, Day } from '../types.js';
import type { WorldState } from '../../procgen/seed.js';
import { buildGuildByMember, mergeLedgerInto, type Guild, type GuildPriceObs } from './guild.js';

export const GUILD_LEDGER_MAX_AGE_DAYS = 60;

// Cached per-tick: caravan-owner Actor → Guild.
let guildByMemberCache: ReadonlyMap<ActorId, Guild> | null = null;
let guildByMemberCacheDay: Day | null = null;
let guildByMemberCacheWorld: WorldState | null = null;

const getGuildByMember = (world: WorldState, today: Day): ReadonlyMap<ActorId, Guild> => {
  if (
    guildByMemberCache !== null &&
    guildByMemberCacheDay === today &&
    guildByMemberCacheWorld === world &&
    world.guilds !== undefined
  ) {
    return guildByMemberCache;
  }
  const guilds = world.guilds?.values() ?? [];
  guildByMemberCache = buildGuildByMember(guilds);
  guildByMemberCacheDay = today;
  guildByMemberCacheWorld = world;
  return guildByMemberCache;
};

/**
 * On caravan arrival at a settlement: deposit the caravan's recent
 * observations into the local guild's ledger (if the caravan's owner
 * is a member of any guild). Then read the guild's collective ledger
 * back into the caravan's priceBook so the next leg uses the freshest
 * collective intel.
 */
export const syncCaravanWithLocalGuild = (
  world: WorldState,
  c: Caravan,
  today: Day,
): void => {
  if (world.guilds === undefined || world.guilds.size === 0) return;
  const memberGuilds = getGuildByMember(world, today);
  const ownerGuild = memberGuilds.get(c.ownerActor);
  if (ownerGuild === undefined) return;

  // Deposit recent observations.
  for (const [resource, byHex] of c.priceBook) {
    let guildByHex = ownerGuild.priceLedger.get(resource);
    for (const [hexK, obs] of byHex) {
      if (guildByHex === undefined) {
        guildByHex = new Map<string, GuildPriceObs>();
        ownerGuild.priceLedger.set(resource, guildByHex);
      }
      const prev = guildByHex.get(hexK);
      if (prev === undefined || obs.observedOnDay > prev.observedOnDay) {
        guildByHex.set(hexK, obs);
      }
    }
  }

  // Pull the ledger back into the caravan's priceBook (only fresher entries).
  for (const [resource, byHex] of ownerGuild.priceLedger) {
    let book = c.priceBook.get(resource);
    if (book === undefined) {
      book = new Map();
      c.priceBook.set(resource, book);
    }
    for (const [hexK, obs] of byHex) {
      if (today - obs.observedOnDay > GUILD_LEDGER_MAX_AGE_DAYS) continue;
      const prev = book.get(hexK);
      if (prev === undefined || obs.observedOnDay > prev.observedOnDay) {
        book.set(hexK, obs);
      }
    }
  }
};

/**
 * Cross-guild rumor phase: caravans of different guilds co-located
 * on the same hex exchange a slice of their ledgers. Runs once per
 * tick.
 */
export const crossGuildRumorPhase = (world: WorldState, today: Day): void => {
  if (world.guilds === undefined || world.guilds.size < 2) return;
  const memberGuilds = getGuildByMember(world, today);
  if (memberGuilds.size === 0) return;

  // Group caravans by hex so we can find co-located members of distinct guilds.
  const byHex = new Map<string, Caravan[]>();
  for (const c of world.caravans.values()) {
    const k = `${c.position.q},${c.position.r}`;
    let arr = byHex.get(k);
    if (arr === undefined) {
      arr = [];
      byHex.set(k, arr);
    }
    arr.push(c);
  }
  for (const [, caravans] of byHex) {
    if (caravans.length < 2) continue;
    for (let i = 0; i < caravans.length; i++) {
      const cI = caravans[i] as Caravan;
      const gI = memberGuilds.get(cI.ownerActor);
      if (gI === undefined) continue;
      for (let j = i + 1; j < caravans.length; j++) {
        const cJ = caravans[j] as Caravan;
        const gJ = memberGuilds.get(cJ.ownerActor);
        if (gJ === undefined) continue;
        if (gI === gJ) continue;
        // Bidirectional exchange.
        mergeLedgerInto(gI, gJ.priceLedger, today, GUILD_LEDGER_MAX_AGE_DAYS);
        mergeLedgerInto(gJ, gI.priceLedger, today, GUILD_LEDGER_MAX_AGE_DAYS);
      }
    }
  }
};
