/**
 * Patrol phase (docs/15 §C32 + docs/06).
 *
 * Each tick every alive patrol:
 *
 *  1. **Pursuit pre-pass.** If a likely-to-win quarry (camp or party)
 *     is inside the 2-hex sight radius, the patrol sets a pursuit
 *     target and walks straight toward it at the slightly faster
 *     pursuit speed for up to `PATROL_PURSUIT_MAX_DAYS`. While
 *     pursuing it bypasses the cyclic-route stepper entirely.
 *
 *  2. **Cyclic-route stepper.** Otherwise the patrol walks along its
 *     route via `tickPatrol`, up to `PATROL_MOVEMENT_HEXES_PER_DAY`
 *     hexes a day. Detection is wider than the strict same-hex
 *     contract of `tickPatrol` — a 15-hex `PATROL_DETECTION_HEXES`
 *     buffer either at current or next-route hex counts, modeling
 *     local informants tipping the patrol off. Each detected camp's
 *     hex is shimmed onto the route's next hex so engagement
 *     resolves there.
 *
 *  3. **Battle resolution.** Any `pendingBattles` from `tickPatrol`
 *     resolve via `resolveBattle`. Casualties update both the patrol
 *     unit (in-place mutation of `result.patrol.unit`) and the camp
 *     entry. Wiped units are removed from the world.
 *
 *  4. **News carriers.** After a battle, surviving witnesses spawn
 *     news carriers via `spawnNewsFromPatrolBattle` so reputation
 *     can propagate per docs/13.
 *
 * Trail wear accumulates at the patrol's end-of-day hex (coarse
 * single-hex approximation — granular per-hex wear isn't load-bearing
 * for the road model).
 */

import { resolveBattle } from '../conflict/battle.js';
import { tickPatrol } from '../conflict/patrol.js';
import { drainDemographics } from '../population/demographics.js';
import { markPersonsDeadByDemographics, personIdsInUnit } from '../people/registry.js';
import { averageCombatScoresForUnit } from '../people/equipment.js';
import type { CombatUnit } from '../conflict/battle.js';
import { applyBanditCasualties, type BanditCamp } from '../bandit/camp.js';

const applyRegistryScoresToCombatUnit = (
  world: WorldState,
  unitId: string,
  unit: CombatUnit,
): CombatUnit => {
  if (world.persons === undefined) return unit;
  const scores = averageCombatScoresForUnit(
    personIdsInUnit(world.persons, unitId),
    world.personEquipment,
  );
  if (scores === null) return unit;
  return { ...unit, weapons: scores.weapons, armor: scores.armor };
};
import {
  advanceTowardHex,
  PATROL_DETECTION_HEXES,
  PATROL_MOVEMENT_HEXES_PER_DAY,
  PATROL_PURSUIT_HEXES_PER_DAY,
  PATROL_PURSUIT_MAX_DAYS,
  visibleQuarryForPatrol,
} from '../conflict/unitMovement.js';
import { createNewsCarrier, createNewsItem, NEWS_CARRIER_SPEED } from '../reputation/news.js';
import type { ReputationKey, ReputationMagnitude } from '../reputation/table.js';
import type { Rng } from '../rng.js';
import type { ActorId, CaravanId, Day } from '../types.js';
import { addRoadWear, WEAR_PER_PATROL_SOLDIER } from '../world/roadWear.js';
import { hexDistance, hexEquals, type Hex } from '../world/hex.js';
import type { Settlement } from '../world/settlement.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

const spawnNewsFromPatrolBattle = (
  world: WorldState,
  today: Day,
  patrolId: string,
  camp: BanditCamp,
  survivors: ReturnType<typeof resolveBattle>['survivors'],
  patrolHome: Settlement,
  outcome: 'patrol_won' | 'bandits_won' | 'mutual_rout',
  events: TickEvent[],
): void => {
  if (world.newsCarriers === undefined) return;

  // Patrol-side fled_escaped → news of the engagement reaches patrolHome.
  let patrolFled = 0;
  for (const s of survivors) {
    if (s.unitId.startsWith('patrol:') && s.fate === 'fled_escaped') patrolFled += s.count;
  }
  // If patrol won and is alive, count is implicitly > 0; we still want news
  // home. So spawn one carrier from the patrol position to home if outcome
  // is patrol_won OR there are explicit fled_escaped.
  const wantPatrolNews = outcome === 'patrol_won' || patrolFled > 0;
  if (wantPatrolNews) {
    const id = `news-${today}-patrol-${patrolId}-${String(camp.id)}`;
    if (!world.newsCarriers.has(id)) {
      const magnitude: ReputationMagnitude = outcome === 'patrol_won' ? 'severe' : 'moderate';
      const news = createNewsItem({
        id,
        perpetrator: camp.ownerActor as ReputationKey,
        victim: null,
        magnitude,
        isCriminalAct: true,
        occurredAtHex: camp.hex,
        occurredOnDay: today,
      });
      const carrier = createNewsCarrier({
        id,
        news,
        spawnHex: camp.hex,
        destination: patrolHome.anchor,
        spawnDay: today,
        speed: NEWS_CARRIER_SPEED,
      });
      world.newsCarriers.set(id, carrier);
      events.push({
        type: 'news_carrier_spawned',
        id,
        perpetrator: news.perpetrator,
        victim: null,
        destination: patrolHome.anchor,
        magnitude,
      });
    }
  }
};

export const patrolPhase = (
  world: WorldState,
  rng: Rng,
  today: Day,
  events: TickEvent[],
): void => {
  if (world.patrols === undefined || world.patrols.size === 0) return;
  // Patrols still walk their routes even if camps are momentarily zero —
  // they're salaried; not exiting here also avoids missing newly-founded
  // camps that emerged within this tick.
  if (world.banditCamps === undefined) return;

  // Build a quick hex → camps index for proximity lookup.
  const campsByHex = new Map<string, BanditCamp[]>();
  for (const camp of world.banditCamps.values()) {
    const k = `${camp.hex.q},${camp.hex.r}`;
    const list = campsByHex.get(k);
    if (list === undefined) campsByHex.set(k, [camp]);
    else list.push(camp);
  }

  for (const [patrolId, patrol] of [...world.patrols]) {
    if (patrol.unit.count <= 0) {
      world.patrols.delete(patrolId);
      continue;
    }
    const subRng = rng.derive(`patrol-${patrolId}`);

    // Per docs/15 §C32: pursuit pre-pass. If a likely-to-win quarry
    // (camp or bandit party) is within the 2-hex sight radius, set the
    // pursuit target — patrol deviates from its cyclic route to chase
    // for up to PATROL_PURSUIT_MAX_DAYS. While pursuing we bypass
    // `tickPatrol` and walk straight toward the target at the slightly
    // faster pursuit speed.
    const quarry = visibleQuarryForPatrol(world, patrol);
    if (quarry !== undefined) {
      patrol.pursuit = { targetHex: { q: quarry.hex.q, r: quarry.hex.r }, daysActive: 0 };
    }
    if (patrol.pursuit !== undefined) {
      patrol.pursuit.daysActive += 1;
      // If we've burned the budget, give up. (Setting `pursuit` to
      // undefined via delete keeps the TickEvent[] free of churn.)
      if (patrol.pursuit.daysActive > PATROL_PURSUIT_MAX_DAYS) {
        delete patrol.pursuit;
      }
    }
    if (patrol.pursuit !== undefined) {
      // Direct pursuit movement (bypasses tickPatrol's cyclic route).
      const before = patrol.position;
      patrol.position = advanceTowardHex(
        patrol.position,
        patrol.pursuit.targetHex,
        PATROL_PURSUIT_HEXES_PER_DAY,
        world,
      );
      // Combat triggers on hex-overlap with the quarry. Handled below
      // by the post-phase scan; here we just walk + persist.
      world.patrols.set(patrolId, patrol);
      void before;
      // Trail wear: count the distance walked.
      const walked = hexDistance(before, patrol.position);
      if (walked > 0) {
        addRoadWear(world, patrol.position, patrol.unit.count * WEAR_PER_PATROL_SOLDIER * walked);
      }
      continue; // skip the cyclic route for this tick
    }

    // Detection: a patrol "knows" any camp within DETECTION hexes of EITHER
    // its current position OR the next hex on its route. Real Roman patrols
    // had local informants tipping them off, so the strict same-hex check
    // in tickPatrol's contract is too narrow. We shim each detected camp's
    // hex to the patrol's next route hex so the engagement resolves there
    // (representing the patrol diverting from its loop briefly).
    const nextIndex = (patrol.routeIndex + 1) % patrol.route.length;
    const nextHex = patrol.route[nextIndex];
    if (nextHex === undefined) continue;
    const known: { camp: BanditCamp; hex: Hex }[] = [];
    for (const camp of world.banditCamps.values()) {
      const dCurrent = hexDistance(camp.hex, patrol.position);
      const dNext = hexDistance(camp.hex, nextHex);
      if (Math.min(dCurrent, dNext) <= PATROL_DETECTION_HEXES) {
        known.push({ camp, hex: nextHex });
      }
    }
    // Caravan inspection list — patrol checks for suspicious caravans on hex.
    const knownCaravans: {
      caravanId: CaravanId;
      ownerActor: ActorId;
      hex: Hex;
      suspicious: boolean;
    }[] = [];
    for (const c of world.caravans.values()) {
      if (hexDistance(c.position, nextHex) <= 1) {
        knownCaravans.push({
          caravanId: c.id,
          ownerActor: c.ownerActor,
          hex: c.position,
          suspicious: false, // v1: no caravan-suspicion signal yet
        });
      }
    }

    // Per docs/15 §C32 + docs/06 movement: patrols cover ~25 hex/day on
    // foot. We advance through `tickPatrol` up to N times per day,
    // stopping early on the first iteration that produces a pending
    // battle (combat takes the rest of the day). The result is the
    // patrol's position+state at the END of the day.
    const STEPS_PER_DAY = PATROL_MOVEMENT_HEXES_PER_DAY;
    let result = tickPatrol({
      patrol,
      rng: subRng.derive('tick-0'),
      knownBanditCampsOnRoute: known,
      knownCaravansOnRoute: knownCaravans,
      reputation: world.reputation,
      today,
    });
    let trailDistance = hexEquals(patrol.position, result.patrol.position) ? 0 : 1;
    for (let step = 1; step < STEPS_PER_DAY && result.pendingBattles.length === 0; step++) {
      // Refresh the "known camps" + "known caravans" lists from the new
      // route hex. The patrol may have walked into a different
      // detection neighborhood.
      const nextIdx = (result.patrol.routeIndex + 1) % result.patrol.route.length;
      const nextRouteHex = result.patrol.route[nextIdx];
      if (nextRouteHex === undefined) break;
      const stepKnown: { camp: BanditCamp; hex: Hex }[] = [];
      for (const c of world.banditCamps.values()) {
        const d = Math.min(
          hexDistance(c.hex, result.patrol.position),
          hexDistance(c.hex, nextRouteHex),
        );
        if (d <= PATROL_DETECTION_HEXES) stepKnown.push({ camp: c, hex: nextRouteHex });
      }
      const stepKnownCaravans: typeof knownCaravans = [];
      for (const c of world.caravans.values()) {
        if (hexDistance(c.position, nextRouteHex) <= 1) {
          stepKnownCaravans.push({
            caravanId: c.id,
            ownerActor: c.ownerActor,
            hex: c.position,
            suspicious: false,
          });
        }
      }
      const prevPos = result.patrol.position;
      const stepResult = tickPatrol({
        patrol: result.patrol,
        rng: subRng.derive(`tick-${step}`),
        knownBanditCampsOnRoute: stepKnown,
        knownCaravansOnRoute: stepKnownCaravans,
        reputation: world.reputation,
        today,
      });
      if (!hexEquals(prevPos, stepResult.patrol.position)) trailDistance += 1;
      // Merge events + pendingBattles into the top-level result.
      result = {
        ...stepResult,
        events: [...result.events, ...stepResult.events],
        pendingBattles: [...result.pendingBattles, ...stepResult.pendingBattles],
      };
      // Stop early if the patrol's been wiped or stopped advancing.
      if (result.patrol.unit.count <= 0) break;
    }

    // Persist patrol mutations.
    world.patrols.set(patrolId, result.patrol);

    // Trail wear from the patrol's daily movement. We approximate by
    // landing the total day's wear at the END-of-day hex; granular
    // per-hex wear isn't load-bearing for the road model.
    if (trailDistance > 0) {
      addRoadWear(
        world,
        result.patrol.position,
        result.patrol.unit.count * WEAR_PER_PATROL_SOLDIER * trailDistance,
      );
    }

    // Emit dispatch event when the patrol steps into a hex containing a
    // known camp — proxy for "patrol detected & moved on it". Helps the
    // burn-in observability layer.
    for (const e of result.events) {
      if (e.type === 'tactical_retreat' || e.type === 'turned_blind_eye') {
        events.push({
          type: 'patrol_dispatched',
          patrolId,
          from: result.patrol.basedAt,
          target: e.detail.hex,
        });
      }
    }

    // Resolve any pending battles.
    for (const pb of result.pendingBattles) {
      if (pb.with.kind !== 'bandit_camp') continue;
      const camp = world.banditCamps.get(pb.with.campId);
      if (camp === undefined) continue; // already destroyed earlier this tick

      // Per docs/12: override patrol + camp weapons/armor from the
      // Person registry when populated, so combat reflects each
      // soldier's / bandit's actual kit rather than the unit scalar.
      const patrolUnit = applyRegistryScoresToCombatUnit(world, patrolId, result.patrol.unit);
      const campUnit = applyRegistryScoresToCombatUnit(
        world,
        String(pb.with.campId),
        pb.defenderUnit,
      );
      const battle = resolveBattle(patrolUnit, campUnit, {
        ambush: false,
        rng: subRng.derive(`battle-${pb.with.campId}`),
      });

      // Determine outcome category.
      let outcome: 'patrol_won' | 'bandits_won' | 'mutual_rout';
      if (battle.winnerId === result.patrol.unit.id) outcome = 'patrol_won';
      else if (battle.winnerId === pb.defenderUnit.id) outcome = 'bandits_won';
      else outcome = 'mutual_rout';

      events.push({
        type: 'patrol_engaged',
        patrolId,
        camp: pb.with.campId,
        outcome,
      });
      events.push({
        type: 'patrol_dispatched',
        patrolId,
        from: result.patrol.basedAt,
        target: camp.hex,
      });

      // Apply casualties. Patrol unit count is mutated inside Patrol.
      const patrolCas = battle.casualties.find((c) => c.unitId === result.patrol.unit.id);
      const campCas = battle.casualties.find((c) => c.unitId === pb.defenderUnit.id);
      const patrolDeaths = patrolCas?.deaths ?? 0;
      const campDeaths = campCas?.deaths ?? 0;

      // Drain patrol demographics + Person registry in step with count.
      const survivingPatrol = Math.max(0, result.patrol.unit.count - patrolDeaths);
      result.patrol.unit = { ...result.patrol.unit, count: survivingPatrol };
      if (patrolDeaths > 0 && result.patrol.demographics !== undefined) {
        const patrolDemo = new Map(result.patrol.demographics);
        const drained = drainDemographics(
          patrolDemo,
          patrolDeaths,
          rng.derive(`patrol-cas-${patrolId}`),
        );
        result.patrol.demographics = patrolDemo;
        if (world.persons !== undefined && drained.size > 0) {
          markPersonsDeadByDemographics(
            world.persons,
            world.personEquipment,
            patrolId,
            drained,
            rng.derive(`patrol-pers-${patrolId}`),
            today,
          );
        }
      }
      if (survivingPatrol <= 0) {
        world.patrols.delete(patrolId);
      } else {
        world.patrols.set(patrolId, result.patrol);
      }

      // Update camp: drain banditDemographics + Person registry too.
      if (campDeaths > 0) {
        const drainedCamp = applyBanditCasualties(
          camp,
          Math.min(campDeaths, camp.banditCount),
          rng.derive(`camp-cas-${String(pb.with.campId)}`),
        );
        if (world.persons !== undefined && drainedCamp.removed.size > 0) {
          markPersonsDeadByDemographics(
            world.persons,
            world.personEquipment,
            String(pb.with.campId),
            drainedCamp.removed,
            rng.derive(`camp-pers-${String(pb.with.campId)}`),
            today,
          );
        }
        if (drainedCamp.camp.banditCount <= 0) {
          world.banditCamps.delete(pb.with.campId);
        } else {
          world.banditCamps.set(pb.with.campId, drainedCamp.camp);
        }
      }

      // Emit news carriers — for patrol vs camp, the WITNESSES who carry
      // news are the survivors who flee back to civilization.
      // - patrol-side fled_escaped → tell the patrol's settlement
      // - camp-side fled_escaped → tell other bandits / sympathetic
      //   villages (we approximate by routing to nearest settlement)
      const patrolSettlement = world.settlements.get(result.patrol.basedAt);
      if (patrolSettlement !== undefined) {
        spawnNewsFromPatrolBattle(
          world,
          today,
          patrolId,
          camp,
          battle.survivors,
          patrolSettlement,
          outcome,
          events,
        );
      }
    }
  }
};

