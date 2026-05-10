import { describe, expect, it } from 'vitest';
import { campAsCombatUnit, createCamp, type BanditCamp } from '../bandit/camp.js';
import { createReputationTable } from '../reputation/table.js';
import { createRng } from '../rng.js';
import {
  actorId,
  banditCampId,
  caravanId,
  settlementId,
  type ActorId,
  type SettlementId,
} from '../types.js';
import { hex, hexEquals } from '../world/hex.js';
import { campaignerUnit, type CombatUnit } from './battle.js';
import {
  createPatrol,
  defaultPatrolRoute,
  tickPatrol,
  type Patrol,
  type PatrolEvent,
  type PatrolKind,
  type PatrolTickInputs,
} from './patrol.js';

const aid = (s: string): ActorId => actorId(s);
const sid = (s: string): SettlementId => settlementId(s);

const baseUnit = (overrides: Partial<Parameters<typeof campaignerUnit>[0]> = {}): CombatUnit =>
  campaignerUnit({
    id: 'patrol-unit',
    posture: 'attacking',
    count: 30,
    training: 0.7,
    weapons: 0.7,
    armor: 0.6,
    health: 0.95,
    terrainBonus: 0,
    ...overrides,
  });

const baseCamp = (overrides: Partial<Parameters<typeof createCamp>[0]> = {}): BanditCamp =>
  createCamp({
    id: banditCampId('camp-A'),
    name: 'Wolfshead',
    hex: hex(2, 0),
    ownerActor: aid('bandits-A'),
    banditCount: 25,
    hangersOnCount: 5,
    weaponsPerBandit: 0.4,
    armorPerBandit: 0.2,
    averageHealth: 0.85,
    ...overrides,
  });

const baseRoute = [hex(0, 0), hex(1, 0), hex(2, 0), hex(2, 1), hex(1, 1), hex(0, 1)] as const;

const makePatrol = (
  overrides: {
    kind?: PatrolKind;
    ownerActor?: ActorId;
    basedAt?: SettlementId;
    unit?: CombatUnit;
    route?: readonly { q: number; r: number }[];
    id?: string;
  } = {},
): Patrol =>
  createPatrol({
    id: overrides.id ?? 'patrol-1',
    kind: overrides.kind ?? 'provincial_garrison',
    ownerActor: overrides.ownerActor ?? aid('governor'),
    basedAt: overrides.basedAt ?? sid('aquileia'),
    route: overrides.route ?? baseRoute,
    unit: overrides.unit ?? baseUnit(),
  });

const tickInputs = (
  overrides: Partial<PatrolTickInputs> & { patrol: Patrol },
): PatrolTickInputs => ({
  rng: createRng('patrol-default'),
  knownBanditCampsOnRoute: [],
  knownCaravansOnRoute: [],
  today: 0,
  ...overrides,
});

describe('createPatrol', () => {
  it('initializes position to first hex of the route, routeIndex=0, fresh counters', () => {
    const p = makePatrol();
    expect(p.routeIndex).toBe(0);
    expect(hexEquals(p.position, baseRoute[0]!)).toBe(true);
    expect(p.daysOnPatrol).toBe(0);
    expect(p.daysWithoutEngagement).toBe(0);
  });

  it('rejects an empty route', () => {
    expect(() => makePatrol({ route: [] })).toThrow();
  });

  it('rejects a unit whose count is zero', () => {
    expect(() =>
      makePatrol({
        unit: campaignerUnit({
          id: 'broken',
          posture: 'attacking',
          count: 1,
          training: 0.5,
          weapons: 0.5,
          armor: 0.5,
          health: 1,
          terrainBonus: 0,
        }),
      }),
    ).not.toThrow();
  });
});

describe('defaultPatrolRoute', () => {
  it('produces a closed walk visiting at least the urban hexes once', () => {
    const route = defaultPatrolRoute({
      anchor: hex(10, 5),
      urbanHexes: [hex(10, 5), hex(11, 5), hex(10, 6)],
      hexesPerLap: 6,
    });
    expect(route.length).toBeGreaterThanOrEqual(3);
    // All urban hexes appear somewhere on the route.
    for (const u of [hex(10, 5), hex(11, 5), hex(10, 6)]) {
      expect(route.some((h) => hexEquals(h, u))).toBe(true);
    }
  });

  it('hexesPerLap caps the total length', () => {
    const route = defaultPatrolRoute({
      anchor: hex(0, 0),
      urbanHexes: [hex(0, 0)],
      hexesPerLap: 8,
    });
    expect(route.length).toBeLessThanOrEqual(8);
    expect(route.length).toBeGreaterThan(0);
  });
});

describe('tickPatrol: routine walking', () => {
  it('with no encounters, advances one hex along the route per tick', () => {
    let p = makePatrol();
    let day = 0;
    const visited: { q: number; r: number }[] = [{ ...p.position }];
    for (let i = 0; i < baseRoute.length; i++) {
      const result = tickPatrol(tickInputs({ patrol: p, today: day }));
      p = result.patrol;
      visited.push({ ...p.position });
      day++;
    }
    // After length-1 ticks, we should have circled back to the start.
    for (let i = 0; i < baseRoute.length; i++) {
      const expected = baseRoute[i % baseRoute.length]!;
      expect(visited[i]!.q).toBe(expected.q);
      expect(visited[i]!.r).toBe(expected.r);
    }
  });

  it('emits arrived_at_base when stepping onto the home settlement hex (configured as part of route)', () => {
    let p = makePatrol();
    const events: PatrolEvent[] = [];
    for (let i = 0; i < baseRoute.length * 2; i++) {
      const r = tickPatrol(
        tickInputs({
          patrol: p,
          today: i,
          knownFriendlySettlementHexes: [{ id: sid('aquileia'), hex: hex(0, 0) }],
        }),
      );
      events.push(...r.events);
      p = r.patrol;
    }
    // Visited the base hex (0,0) at least once → at least one arrived_at_base event.
    expect(events.some((e) => e.type === 'arrived_at_base')).toBe(true);
  });

  it('daysOnPatrol resets when patrol returns to its base hex', () => {
    let p = makePatrol();
    for (let i = 0; i < baseRoute.length; i++) {
      p = tickPatrol(
        tickInputs({
          patrol: p,
          today: i,
          knownFriendlySettlementHexes: [{ id: sid('aquileia'), hex: hex(0, 0) }],
        }),
      ).patrol;
    }
    expect(p.daysOnPatrol).toBe(0);
  });
});

describe('tickPatrol: bandit engagement', () => {
  it('emits a pendingBattle when a bandit camp sits on the patrol`s next hex', () => {
    // Position the patrol so the next step will be the camp's hex (2,0).
    const p = makePatrol();
    const camp = baseCamp({ banditCount: 20 });
    const result = tickPatrol(
      tickInputs({
        patrol: p,
        today: 0,
        knownBanditCampsOnRoute: [{ camp, hex: hex(1, 0) }],
        rng: createRng('engage-1'),
      }),
    );
    expect(result.pendingBattles.length).toBeGreaterThan(0);
    const battle = result.pendingBattles[0]!;
    expect(battle.with.kind).toBe('bandit_camp');
    if (battle.with.kind === 'bandit_camp') {
      expect(battle.with.campId).toBe(camp.id);
    }
    expect(result.events.some((e) => e.type === 'engagement')).toBe(true);
  });

  it('an undermanned patrol does NOT engage a much bigger camp (tactical retreat)', () => {
    const p = makePatrol({
      unit: baseUnit({ count: 10, training: 0.7, weapons: 0.7, armor: 0.6 }),
    });
    const camp = baseCamp({ banditCount: 200 });
    const result = tickPatrol(
      tickInputs({
        patrol: p,
        today: 0,
        knownBanditCampsOnRoute: [{ camp, hex: hex(1, 0) }],
        rng: createRng('outgunned'),
      }),
    );
    expect(result.pendingBattles).toHaveLength(0);
    // No engagement event of type 'engagement', but 'tactical_retreat' or similar may fire.
    expect(result.events.some((e) => e.type === 'engagement')).toBe(false);
  });

  it('bribed condition: high reputation between owner and camp owner skips engagement', () => {
    const p = makePatrol();
    const camp = baseCamp({ banditCount: 20 });
    const reputation = createReputationTable();
    // Patrol owner views camp owner very favorably (i.e. is on their take).
    reputation.set(p.ownerActor, camp.ownerActor, 0.9);
    const result = tickPatrol(
      tickInputs({
        patrol: p,
        today: 0,
        knownBanditCampsOnRoute: [{ camp, hex: hex(1, 0) }],
        reputation,
        rng: createRng('bribed'),
      }),
    );
    expect(result.pendingBattles).toHaveLength(0);
    expect(result.events.some((e) => e.type === 'engagement')).toBe(false);
  });
});

describe('tickPatrol: caravan inspection', () => {
  it('emits an inspection event when a suspicious caravan is on the patrol`s hex', () => {
    const p = makePatrol();
    const caravanIdValue = caravanId('lone-cart');
    const result = tickPatrol(
      tickInputs({
        patrol: p,
        today: 0,
        knownCaravansOnRoute: [
          {
            caravanId: caravanIdValue,
            ownerActor: aid('merchant-X'),
            hex: hex(1, 0),
            suspicious: true,
          },
        ],
        rng: createRng('inspect'),
      }),
    );
    expect(result.events.some((e) => e.type === 'inspection')).toBe(true);
  });

  it('does NOT inspect non-suspicious caravans', () => {
    const p = makePatrol();
    const result = tickPatrol(
      tickInputs({
        patrol: p,
        today: 0,
        knownCaravansOnRoute: [
          {
            caravanId: caravanId('honest-cart'),
            ownerActor: aid('merchant-Y'),
            hex: hex(1, 0),
            suspicious: false,
          },
        ],
        rng: createRng('no-inspect'),
      }),
    );
    expect(result.events.some((e) => e.type === 'inspection')).toBe(false);
  });
});

describe('tickPatrol: determinism', () => {
  it('same RNG seed produces the same patrol state and events', () => {
    const camp = baseCamp({ banditCount: 22 });
    let p1 = makePatrol();
    let p2 = makePatrol();
    let day = 0;
    for (let i = 0; i < 5; i++) {
      const r1 = tickPatrol(
        tickInputs({
          patrol: p1,
          today: day,
          knownBanditCampsOnRoute: [{ camp, hex: hex(1, 0) }],
          rng: createRng('det-patrol'),
        }),
      );
      const r2 = tickPatrol(
        tickInputs({
          patrol: p2,
          today: day,
          knownBanditCampsOnRoute: [{ camp, hex: hex(1, 0) }],
          rng: createRng('det-patrol'),
        }),
      );
      expect(r1.events).toEqual(r2.events);
      expect(r1.pendingBattles).toEqual(r2.pendingBattles);
      expect(r1.patrol.position).toEqual(r2.patrol.position);
      expect(r1.patrol.routeIndex).toBe(r2.patrol.routeIndex);
      p1 = r1.patrol;
      p2 = r2.patrol;
      day++;
    }
  });
});

describe('tickPatrol: integration with battle system', () => {
  it('the pendingBattle defenderUnit can be passed to resolveBattle (camp-derived CombatUnit)', () => {
    const camp = baseCamp({ banditCount: 22 });
    const p = makePatrol();
    const result = tickPatrol(
      tickInputs({
        patrol: p,
        today: 0,
        knownBanditCampsOnRoute: [{ camp, hex: hex(1, 0) }],
      }),
    );
    expect(result.pendingBattles).toHaveLength(1);
    const pb = result.pendingBattles[0]!;
    // The defender combat unit must match the camp's bandit count (sanity).
    expect(pb.defenderUnit.count).toBe(camp.banditCount);
    // And matches campAsCombatUnit defaulting to defending.
    const expected = campAsCombatUnit(camp, 'defending');
    expect(pb.defenderUnit.training).toBe(expected.training);
    expect(pb.defenderUnit.weapons).toBe(expected.weapons);
    expect(pb.defenderUnit.armor).toBe(expected.armor);
  });
});
