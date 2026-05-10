/**
 * Politics module: actors (owners) and factions.
 *
 * See docs/11-politics-and-ownership.md.
 */

export type { Actor, ActorKind, CreateActorInput } from './actor.js';
export {
  ACTOR_KINDS,
  addToStockpile,
  createActor,
  getStockpile,
  removeFromStockpile,
} from './actor.js';

export type { CreateFactionInput, Faction } from './faction.js';
export { addMember, createFaction, hasMember, removeMember } from './faction.js';
