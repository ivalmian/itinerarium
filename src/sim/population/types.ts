/**
 * Shared population types: sex and character class.
 *
 * Owned by the demographic pyramid module (T5). Other modules
 * (jobs, named characters, ownership) import from here.
 *
 * Design references:
 *   docs/04-population.md  (class structure: patrician/plebeian
 *                          /freedman/slave/foreigner-resident)
 */

export type Sex = 'male' | 'female';

export const SEXES = ['male', 'female'] as const satisfies readonly Sex[];

/**
 * Character class.
 *
 * `patrician` and `plebeian` are sub-tiers of "free citizen"
 * (docs/04 § Class structure). They are tracked separately
 * because their consumption profiles and political weight differ.
 */
export type CharacterClass = 'patrician' | 'plebeian' | 'freedman' | 'slave' | 'foreigner';

export const CHARACTER_CLASSES = [
  'patrician',
  'plebeian',
  'freedman',
  'slave',
  'foreigner',
] as const satisfies readonly CharacterClass[];
