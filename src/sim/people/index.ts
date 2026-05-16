export {
  type Person,
  type PersonRole,
  type PersonStatus,
  type CreatePersonInput,
  createPerson,
  isAlive,
  markCaptured,
  markDead,
  markMissing,
  markWounded,
  ageOneYear,
} from './person.js';

export {
  type PersonRegistry,
  emptyPersonRegistry,
  registerPerson,
  getPerson,
  allAlive,
  ageToBand,
  markPersonsDeadByDemographics,
  personIdsInUnit,
  tickAnnualAging,
} from './registry.js';

export {
  type UnitInventory,
  type PersonEquip,
  ARMOR_CONTRIBUTION,
  DEFENSE_SLOTS,
  MELEE_PRIORITY,
  RANGED_PRIORITY,
  WEAPON_EFFECTIVE_STRENGTH,
  averageCombatScoresForUnit,
  combatScoresForPerson,
  emptyUnitInventory,
  emptyPersonEquip,
  issueOne,
  issueStandardKit,
  returnPersonEquipmentToUnit,
  totalEquippedForResource,
} from './equipment.js';
