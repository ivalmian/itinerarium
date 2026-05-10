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

export type {
  CharacterRole,
  CharacterStatus,
  CreateCharacterInput,
  NamedCharacter,
} from './character.js';
export {
  ageOneYear,
  createCharacter,
  generateFullName,
  generateLatinNomen,
  generateLatinPraenomen,
  isAlive,
  LATIN_NOMEN_CHOICES,
  LATIN_PRAENOMEN_FEMALE,
  LATIN_PRAENOMEN_MALE,
  moveTo,
} from './character.js';
