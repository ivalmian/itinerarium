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
  tickAnnualAging,
} from './registry.js';

export {
  type UnitInventory,
  type PersonEquip,
  DEFENSE_SLOTS,
  MELEE_PRIORITY,
  RANGED_PRIORITY,
  emptyUnitInventory,
  emptyPersonEquip,
  issueOne,
  issueStandardKit,
  returnPersonEquipmentToUnit,
  totalEquippedForResource,
} from './equipment.js';
