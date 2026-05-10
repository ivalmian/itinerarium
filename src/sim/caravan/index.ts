/**
 * Caravan module: the unit of trade and travel.
 *
 * See docs/06-caravans.md.
 */

export type {
  AnimalKind,
  AnimalSpec,
  Caravan,
  CreateCaravanInput,
  CrewKind,
  CrewMember,
  PriceObservation,
  VehicleKind,
  VehicleSpec,
} from './caravan.js';

export {
  ANIMAL_KINDS,
  ANIMAL_SPECS,
  CREW_KINDS,
  VEHICLE_KINDS,
  VEHICLE_SPECS,
  createCaravan,
  dailyAnimalFodderKg,
  dailyCrewRationKg,
  dailyMpAllowance,
  loadFraction,
  totalCargoWeightKg,
  totalCarryKg,
  totalCrewCount,
} from './caravan.js';
