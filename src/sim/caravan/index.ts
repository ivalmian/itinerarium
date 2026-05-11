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
  applyCrewCasualties,
  createCaravan,
  dailyAnimalFodderKg,
  dailyCrewRationKg,
  dailyMpAllowance,
  loadFraction,
  totalCargoWeightKg,
  totalCarryKg,
  totalCrewCount,
} from './caravan.js';

export type { CaravanTickEvent, CaravanTickInputs, CaravanTickResult } from './movement.js';
export { tickCaravanMovement } from './movement.js';

export type {
  CityExportSource,
  CityImportTarget,
  EdgeHubConfig,
  EdgeHubResult,
  EdgeHubReturnEvent,
  EdgeHubTickInputs,
  ImportPaletteEntry,
} from './edgeHub.js';
export {
  DEFAULT_GLOBAL_PRICES,
  DEFAULT_IMPORT_PALETTE,
  estimateExportMargin,
  TRANSPORT_COST_COIN_PER_KG_PER_HEX,
  tickEdgeHubs,
} from './edgeHub.js';

export type {
  CandidateSettlement,
  ExpectedProfitResult,
  PlanCaravanRouteInputs,
  RoutePlan,
} from './ai.js';
export { expectedProfit, expectedRisk, planCaravanRoute, travelCost } from './ai.js';
