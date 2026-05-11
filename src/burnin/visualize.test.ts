import { describe, expect, it } from 'vitest';
import { hex } from '../sim/world/hex.js';
import { createGrid } from '../sim/world/grid.js';
import type { HexTile } from '../sim/world/terrain.js';
import { createSettlement } from '../sim/world/settlement.js';
import { createActor } from '../sim/politics/actor.js';
import { createFaction } from '../sim/politics/faction.js';
import { createCharacter } from '../sim/politics/character.js';
import { createCaravan } from '../sim/caravan/caravan.js';
import { createCamp } from '../sim/bandit/camp.js';
import { createReputationTable } from '../sim/reputation/table.js';
import { createNewsCarrier, createNewsItem } from '../sim/reputation/news.js';
import {
  actorId,
  banditCampId,
  caravanId,
  characterId,
  factionId,
  resourceId,
  settlementId,
} from '../sim/types.js';
import type { WorldState } from '../procgen/seed.js';
import { renderAsciiMap, renderSettlementSummary, renderWorldSnapshot } from './visualize.js';

const tile = (overrides: Partial<HexTile> = {}): HexTile => ({
  terrain: 'plains',
  climate: 'temperate',
  elevation: 0,
  hasRiver: false,
  road: 'none',
  ownerActor: null,
  ...overrides,
});

const emptyWorld = (): WorldState => ({
  day: 0,
  grid: createGrid(),
  settlements: new Map(),
  actors: new Map(),
  factions: new Map(),
  characters: new Map(),
  caravans: new Map(),
  reputation: createReputationTable(),
  bySite: [],
});

describe('renderAsciiMap — terrain glyphs', () => {
  it('renders a single plains hex as "."', () => {
    const w = emptyWorld();
    w.grid.set(hex(0, 0), tile({ terrain: 'plains' }));
    const out = renderAsciiMap(w, { bounds: { qMin: 0, qMax: 0, rMin: 0, rMax: 0 } });
    expect(out).toContain('.');
  });

  it('uses distinct glyphs for each terrain in a multi-cell row', () => {
    const w = emptyWorld();
    w.grid.set(hex(0, 0), tile({ terrain: 'plains' }));
    w.grid.set(hex(1, 0), tile({ terrain: 'mountains' }));
    w.grid.set(hex(2, 0), tile({ terrain: 'forest' }));
    w.grid.set(hex(3, 0), tile({ terrain: 'lake' }));
    const out = renderAsciiMap(w, { bounds: { qMin: 0, qMax: 3, rMin: 0, rMax: 0 } });
    // Each glyph should appear at least once.
    expect(out).toContain('.');
    expect(out).toContain('M');
    expect(out).toContain('f');
    expect(out).toContain('≈');
  });

  it('renders missing hexes as space (not a crash)', () => {
    const w = emptyWorld();
    w.grid.set(hex(0, 0), tile({ terrain: 'plains' }));
    // Hex (1,0) NOT set.
    const out = renderAsciiMap(w, { bounds: { qMin: 0, qMax: 1, rMin: 0, rMax: 0 } });
    expect(out).toContain('.');
    // Should not crash; output is non-empty.
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('renderAsciiMap — settlement overlay', () => {
  it('places the first letter of the settlement name on its anchor', () => {
    const w = emptyWorld();
    for (let q = 0; q <= 2; q++) w.grid.set(hex(q, 0), tile({ terrain: 'plains' }));
    const s = createSettlement({
      id: settlementId('s.aq'),
      tier: 'small_city',
      name: 'Aquileia',
      anchor: hex(1, 0),
      urbanHexes: [hex(1, 0)],
      catchmentHexes: [hex(0, 0), hex(2, 0)],
    });
    w.settlements.set(s.id, s);
    const out = renderAsciiMap(w, {
      bounds: { qMin: 0, qMax: 2, rMin: 0, rMax: 0 },
      showSettlements: true,
    });
    expect(out).toContain('A');
  });

  it('multi-hex city: anchor uppercase, additional urban hexes lowercase first letter', () => {
    const w = emptyWorld();
    for (let q = 0; q <= 3; q++) w.grid.set(hex(q, 0), tile({ terrain: 'plains' }));
    const s = createSettlement({
      id: settlementId('s.big'),
      tier: 'large_city',
      name: 'Roma',
      anchor: hex(1, 0),
      urbanHexes: [hex(1, 0), hex(2, 0), hex(3, 0)],
      catchmentHexes: [hex(0, 0)],
    });
    w.settlements.set(s.id, s);
    const out = renderAsciiMap(w, {
      bounds: { qMin: 0, qMax: 3, rMin: 0, rMax: 0 },
      showSettlements: true,
    });
    expect(out).toContain('R');
    // The lowercase 'r' for suburbs.
    expect(out).toContain('r');
  });

  it('does not render settlement overlay when showSettlements is false', () => {
    const w = emptyWorld();
    w.grid.set(hex(0, 0), tile({ terrain: 'plains' }));
    const s = createSettlement({
      id: settlementId('s.aq'),
      tier: 'town',
      name: 'Verona',
      anchor: hex(0, 0),
      urbanHexes: [hex(0, 0)],
      catchmentHexes: [],
    });
    w.settlements.set(s.id, s);
    const out = renderAsciiMap(w, {
      bounds: { qMin: 0, qMax: 0, rMin: 0, rMax: 0 },
      showSettlements: false,
    });
    expect(out).not.toContain('V');
  });
});

describe('renderAsciiMap — road overlay', () => {
  it('marks roman-road plains hexes with uppercase variant when showRoads', () => {
    const w = emptyWorld();
    w.grid.set(hex(0, 0), tile({ terrain: 'plains', road: 'none' }));
    w.grid.set(hex(1, 0), tile({ terrain: 'plains', road: 'roman' }));
    w.grid.set(hex(2, 0), tile({ terrain: 'plains', road: 'dirt' }));
    const out = renderAsciiMap(w, {
      bounds: { qMin: 0, qMax: 2, rMin: 0, rMax: 0 },
      showRoads: true,
    });
    // Roman road → uppercase variant ('=' for plains+roman, by spec choice).
    // We only assert that something different from the baseline glyph appears.
    const noRoads = renderAsciiMap(w, {
      bounds: { qMin: 0, qMax: 2, rMin: 0, rMax: 0 },
      showRoads: false,
    });
    expect(out).not.toBe(noRoads);
  });
});

describe('renderAsciiMap — caravan overlay', () => {
  it('places a caravan glyph on its position when showCaravans', () => {
    const w = emptyWorld();
    w.grid.set(hex(0, 0), tile({ terrain: 'plains' }));
    w.grid.set(hex(1, 0), tile({ terrain: 'plains' }));
    const owner = createActor({
      id: actorId('a.merchant'),
      kind: 'caravan_owner',
      name: 'Merchant',
    });
    w.actors.set(owner.id, owner);
    const c = createCaravan({
      id: caravanId('cv.east'),
      ownerActor: owner.id,
      position: hex(1, 0),
      destination: hex(5, 0),
      crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
      animals: { mule: 1 },
      vehicles: {},
    });
    w.caravans.set(c.id, c);
    const out = renderAsciiMap(w, {
      bounds: { qMin: 0, qMax: 5, rMin: 0, rMax: 0 },
      showCaravans: true,
    });
    // Eastbound → '>'.
    expect(out).toContain('>');
  });

  it('renders directional indicators for each cardinal direction', () => {
    const w = emptyWorld();
    for (let q = 0; q <= 5; q++) {
      for (let r = 0; r <= 5; r++) {
        w.grid.set(hex(q, r), tile({ terrain: 'plains' }));
      }
    }
    const owner = createActor({
      id: actorId('a.m'),
      kind: 'caravan_owner',
      name: 'M',
    });
    w.actors.set(owner.id, owner);
    const cN = createCaravan({
      id: caravanId('cv.n'),
      ownerActor: owner.id,
      position: hex(1, 3),
      destination: hex(1, 0), // r decreases → north
      crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
      animals: { mule: 1 },
      vehicles: {},
    });
    const cS = createCaravan({
      id: caravanId('cv.s'),
      ownerActor: owner.id,
      position: hex(2, 1),
      destination: hex(2, 5),
      crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
      animals: { mule: 1 },
      vehicles: {},
    });
    const cW = createCaravan({
      id: caravanId('cv.w'),
      ownerActor: owner.id,
      position: hex(4, 2),
      destination: hex(0, 2),
      crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
      animals: { mule: 1 },
      vehicles: {},
    });
    w.caravans.set(cN.id, cN);
    w.caravans.set(cS.id, cS);
    w.caravans.set(cW.id, cW);
    const out = renderAsciiMap(w, {
      bounds: { qMin: 0, qMax: 5, rMin: 0, rMax: 5 },
      showCaravans: true,
    });
    expect(out).toContain('^');
    expect(out).toContain('v');
    expect(out).toContain('<');
  });

  it('caravan with null destination renders as a stationary glyph', () => {
    const w = emptyWorld();
    w.grid.set(hex(0, 0), tile({ terrain: 'plains' }));
    const owner = createActor({
      id: actorId('a.m'),
      kind: 'caravan_owner',
      name: 'M',
    });
    w.actors.set(owner.id, owner);
    const c = createCaravan({
      id: caravanId('cv.idle'),
      ownerActor: owner.id,
      position: hex(0, 0),
      destination: null,
      crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
      animals: { mule: 1 },
      vehicles: {},
    });
    w.caravans.set(c.id, c);
    const out = renderAsciiMap(w, {
      bounds: { qMin: 0, qMax: 0, rMin: 0, rMax: 0 },
      showCaravans: true,
    });
    // 'o' (or any non-arrow) for stationary; we accept any non-baseline glyph.
    const baseline = renderAsciiMap(w, {
      bounds: { qMin: 0, qMax: 0, rMin: 0, rMax: 0 },
      showCaravans: false,
    });
    expect(out).not.toBe(baseline);
  });
});

describe('renderAsciiMap — bandit + news overlays', () => {
  it('renders a bandit camp as "b"', () => {
    const w = emptyWorld();
    w.grid.set(hex(0, 0), tile({ terrain: 'forest' }));
    const owner = createActor({
      id: actorId('a.bandit'),
      kind: 'bandit_camp',
      name: 'Bandits',
    });
    void owner;
    const camp = createCamp({
      id: banditCampId('bc.1'),
      name: 'Wolf Den',
      hex: hex(0, 0),
      ownerActor: actorId('a.bandit'),
      banditCount: 8,
      hangersOnCount: 3,
      weaponsPerBandit: 0.4,
      armorPerBandit: 0.1,
      averageHealth: 0.7,
    });
    const out = renderAsciiMap(
      w,
      {
        bounds: { qMin: 0, qMax: 0, rMin: 0, rMax: 0 },
        showBandits: true,
      },
      { banditCamps: [camp], newsCarriers: [] },
    );
    expect(out).toContain('b');
  });

  it('renders a news carrier as "i"', () => {
    const w = emptyWorld();
    w.grid.set(hex(0, 0), tile({ terrain: 'plains' }));
    const news = createNewsItem({
      id: 'news.1',
      perpetrator: actorId('a.x'),
      victim: actorId('a.y'),
      magnitude: 'severe',
      isCriminalAct: true,
      occurredAtHex: hex(0, 0),
      occurredOnDay: 1,
    });
    const carrier = createNewsCarrier({
      id: 'nc.1',
      news,
      spawnHex: hex(0, 0),
      destination: hex(5, 0),
      spawnDay: 1,
    });
    const out = renderAsciiMap(
      w,
      { bounds: { qMin: 0, qMax: 0, rMin: 0, rMax: 0 } },
      { banditCamps: [], newsCarriers: [carrier] },
    );
    expect(out).toContain('i');
  });
});

describe('renderSettlementSummary', () => {
  const setupWorld = (): { world: WorldState; sId: ReturnType<typeof settlementId> } => {
    const w = emptyWorld();
    w.grid.set(hex(0, 0), tile({ terrain: 'plains' }));
    const s = createSettlement({
      id: settlementId('s.aq'),
      tier: 'small_city',
      name: 'Aquileia',
      anchor: hex(0, 0),
      urbanHexes: [hex(0, 0)],
      catchmentHexes: [],
    });
    s.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 4000);
    s.population.set({ age: '20-24', sex: 'female', class: 'plebeian' }, 4234);

    const corp = createActor({
      id: actorId('a.corp'),
      kind: 'city_corporation',
      name: 'Corp of Aquileia',
      homeSettlement: s.id,
    });
    corp.stockpile.set(resourceId('food.grain'), 4000);
    s.stockpileOwners.push(corp.id);

    const fA = createFaction({
      id: factionId('f.vibian'),
      actor: corp.id,
      name: 'Vibian',
      members: [characterId('c.v1')],
    });
    const fM = createFaction({
      id: factionId('f.metilian'),
      actor: corp.id,
      name: 'Metilian',
      members: [characterId('c.m1')],
    });
    s.factions.push(fA.id, fM.id);

    w.settlements.set(s.id, s);
    w.actors.set(corp.id, corp);
    w.factions.set(fA.id, fA);
    w.factions.set(fM.id, fM);
    w.characters.set(
      characterId('c.v1'),
      createCharacter({
        id: characterId('c.v1'),
        name: 'V One',
        age: 30,
        sex: 'male',
        class: 'patrician',
        faction: fA.id,
        location: hex(0, 0),
      }),
    );
    w.characters.set(
      characterId('c.m1'),
      createCharacter({
        id: characterId('c.m1'),
        name: 'M One',
        age: 30,
        sex: 'male',
        class: 'patrician',
        faction: fM.id,
        location: hex(0, 0),
      }),
    );
    return { world: w, sId: s.id };
  };

  it('one-line summary contains name and population', () => {
    const { world, sId } = setupWorld();
    const line = renderSettlementSummary(world, sId);
    expect(line).toContain('Aquileia');
    expect(line).toContain('8234');
    expect(line.includes('\n')).toBe(false);
  });

  it('summary shows granary days bracket', () => {
    const { world, sId } = setupWorld();
    const line = renderSettlementSummary(world, sId);
    expect(line).toMatch(/g:\d+d/);
  });

  it('summary shows caravan count bracket', () => {
    const { world, sId } = setupWorld();
    const line = renderSettlementSummary(world, sId);
    expect(line).toMatch(/c:\d+/);
  });

  it('summary shows faction abbreviations', () => {
    const { world, sId } = setupWorld();
    const line = renderSettlementSummary(world, sId);
    // Expect uppercase first-letter abbreviations of faction names.
    expect(line).toMatch(/\{V,M\}|\{M,V\}/);
  });

  it('throws on unknown settlement id', () => {
    const { world } = setupWorld();
    expect(() => renderSettlementSummary(world, settlementId('nope'))).toThrow();
  });
});

describe('renderWorldSnapshot', () => {
  it('returns a multi-line snapshot with the day header', () => {
    const w = emptyWorld();
    w.day = 42;
    w.grid.set(hex(0, 0), tile({ terrain: 'plains' }));
    const out = renderWorldSnapshot(w);
    expect(out).toContain('Day 42');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('includes one summary line per settlement after the map', () => {
    const w = emptyWorld();
    w.grid.set(hex(0, 0), tile({ terrain: 'plains' }));
    w.grid.set(hex(2, 0), tile({ terrain: 'plains' }));
    const a = createSettlement({
      id: settlementId('s.a'),
      tier: 'town',
      name: 'Apulum',
      anchor: hex(0, 0),
      urbanHexes: [hex(0, 0)],
      catchmentHexes: [],
    });
    a.population.set({ age: '25-29', sex: 'male', class: 'plebeian' }, 1000);
    const b = createSettlement({
      id: settlementId('s.b'),
      tier: 'village',
      name: 'Bovillae',
      anchor: hex(2, 0),
      urbanHexes: [hex(2, 0)],
      catchmentHexes: [],
    });
    b.population.set({ age: '25-29', sex: 'male', class: 'plebeian' }, 300);
    w.settlements.set(a.id, a);
    w.settlements.set(b.id, b);
    const out = renderWorldSnapshot(w);
    expect(out).toContain('Apulum');
    expect(out).toContain('Bovillae');
  });
});

describe('renderAsciiMap — determinism', () => {
  it('same world → same output', () => {
    const w = emptyWorld();
    for (let q = 0; q < 5; q++) w.grid.set(hex(q, 0), tile({ terrain: 'plains' }));
    const a = renderAsciiMap(w, { bounds: { qMin: 0, qMax: 4, rMin: 0, rMax: 0 } });
    const b = renderAsciiMap(w, { bounds: { qMin: 0, qMax: 4, rMin: 0, rMax: 0 } });
    expect(a).toBe(b);
  });
});

describe('renderAsciiMap — width budget', () => {
  it('respects maxWidthChars by downsampling wider maps', () => {
    const w = emptyWorld();
    for (let q = 0; q < 200; q++) w.grid.set(hex(q, 0), tile({ terrain: 'plains' }));
    const out = renderAsciiMap(w, {
      bounds: { qMin: 0, qMax: 199, rMin: 0, rMax: 0 },
      maxWidthChars: 40,
    });
    // Widest line should be at most ~maxWidthChars (allow for offset row indent).
    const widest = Math.max(...out.split('\n').map((l) => l.length));
    expect(widest).toBeLessThanOrEqual(45);
  });
});
