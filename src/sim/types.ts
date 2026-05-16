/**
 * Shared sim-wide types. Module-specific types live in their module.
 *
 * Design references:
 *   docs/01-simulation-frame.md  (turn structure, scale)
 *   docs/02-resources.md         (resource enumeration)
 *   docs/04-population.md        (cohort structure)
 *   docs/11-politics-and-ownership.md (actors and ownership)
 */

import type { Hex } from './world/hex.js';

/** Discrete day index. Day 0 is the start of the simulation; ticks advance by 1. */
export type Day = number;

/** Stable identifiers. Branded types prevent mixing them up. */
export type SettlementId = string & { readonly __brand: 'SettlementId' };
export type CaravanId = string & { readonly __brand: 'CaravanId' };
export type ActorId = string & { readonly __brand: 'ActorId' };
export type CharacterId = string & { readonly __brand: 'CharacterId' };
export type FactionId = string & { readonly __brand: 'FactionId' };
export type RecipeId = string & { readonly __brand: 'RecipeId' };
export type BuildingId = string & { readonly __brand: 'BuildingId' };
export type ResourceId = string & { readonly __brand: 'ResourceId' };
export type BanditCampId = string & { readonly __brand: 'BanditCampId' };
export type BanditPartyId = string & { readonly __brand: 'BanditPartyId' };
export type JobId = string & { readonly __brand: 'JobId' };
export type PersonId = string & { readonly __brand: 'PersonId' };

export const settlementId = (s: string): SettlementId => s as SettlementId;
export const caravanId = (s: string): CaravanId => s as CaravanId;
export const actorId = (s: string): ActorId => s as ActorId;
export const characterId = (s: string): CharacterId => s as CharacterId;
export const factionId = (s: string): FactionId => s as FactionId;
export const recipeId = (s: string): RecipeId => s as RecipeId;
export const buildingId = (s: string): BuildingId => s as BuildingId;
export const resourceId = (s: string): ResourceId => s as ResourceId;
export const banditCampId = (s: string): BanditCampId => s as BanditCampId;
export const banditPartyId = (s: string): BanditPartyId => s as BanditPartyId;
export const jobId = (s: string): JobId => s as JobId;
export const personId = (s: string): PersonId => s as PersonId;

/** Quantities are stored as plain numbers; units are documented per resource. */
export type Quantity = number;

/** Coin amounts (basically just a number, but explicit). */
export type Coin = number;

/** A position on the hex grid. */
export type Position = Hex;
