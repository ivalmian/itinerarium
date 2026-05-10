/**
 * Factions: groups of named characters acting under one Actor.
 *
 * docs/11 §"Every faction has named characters": every faction
 * (a patrician house, a free village council, a city watch, a
 * bandit camp, a temple, the governor's office, …) is owned by
 * exactly one Actor and has named individual members who decide,
 * remember, and act.
 *
 * This module is the membership skeleton only. Reputation between
 * factions and behavior policies live elsewhere.
 */

import type { ActorId, CharacterId, FactionId } from '../types.js';

export interface Faction {
  readonly id: FactionId;
  /** The Actor that owns this faction (treasury, stockpile, hex ownership). */
  readonly actor: ActorId;
  readonly name: string;
  /** Named character members, in insertion order. */
  readonly members: CharacterId[];
}

export interface CreateFactionInput {
  readonly id: FactionId;
  readonly actor: ActorId;
  readonly name: string;
  readonly members?: readonly CharacterId[];
}

export const createFaction = (input: CreateFactionInput): Faction => {
  if (input.name.length === 0) {
    throw new Error(`Faction ${input.id} must have a non-empty name`);
  }
  const seen = new Set<CharacterId>();
  const members: CharacterId[] = [];
  for (const m of input.members ?? []) {
    if (seen.has(m)) {
      throw new Error(`Duplicate member ${String(m)} in faction ${String(input.id)}`);
    }
    seen.add(m);
    members.push(m);
  }
  return {
    id: input.id,
    actor: input.actor,
    name: input.name,
    members,
  };
};

export const hasMember = (faction: Faction, character: CharacterId): boolean => {
  return faction.members.includes(character);
};

export const addMember = (faction: Faction, character: CharacterId): void => {
  if (hasMember(faction, character)) return;
  faction.members.push(character);
};

export const removeMember = (faction: Faction, character: CharacterId): void => {
  const i = faction.members.indexOf(character);
  if (i < 0) {
    throw new Error(
      `Cannot remove ${String(character)} from faction ${String(faction.id)}: not a member`,
    );
  }
  faction.members.splice(i, 1);
};
