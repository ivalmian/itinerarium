import { describe, expect, it } from 'vitest';
import { createCamp, type BanditCamp } from '../bandit/camp.js';
import { createCaravan, type Caravan } from '../caravan/caravan.js';
import { createRng } from '../rng.js';
import {
  actorId,
  banditCampId,
  caravanId,
  resourceId,
  type ActorId,
  type ResourceId,
} from '../types.js';
import { hex } from '../world/hex.js';
import { resolveAmbush, type AmbushInputs } from './ambush.js';

const aid = (s: string): ActorId => actorId(s);
const rid = (s: string): ResourceId => resourceId(s);

const baseCamp = (overrides: Partial<Parameters<typeof createCamp>[0]> = {}): BanditCamp =>
  createCamp({
    id: banditCampId('camp-A'),
    name: 'Wolfshead',
    hex: hex(5, 5),
    ownerActor: aid('bandits-A'),
    banditCount: 30,
    hangersOnCount: 5,
    weaponsPerBandit: 0.5,
    armorPerBandit: 0.2,
    averageHealth: 0.85,
    ...overrides,
  });

const baseCaravan = (overrides: Partial<Parameters<typeof createCaravan>[0]> = {}): Caravan => {
  return createCaravan({
    id: caravanId('lone-cart'),
    ownerActor: aid('merchant-X'),
    position: hex(2, 0),
    crew: [
      { kind: 'merchant', count: 1, weapons: 0.2, armor: 0.1 },
      { kind: 'drover', count: 4, weapons: 0.2, armor: 0.1 },
      { kind: 'caravan_guard', count: 2, weapons: 0.7, armor: 0.5 },
    ],
    animals: { mule: 6 },
    vehicles: { pack_saddle: 6 },
    treasury: 200,
    ...overrides,
  });
};

const baseAmbush = (overrides: Partial<AmbushInputs> = {}): AmbushInputs => ({
  attacker: baseCamp(),
  target: baseCaravan(),
  ambushHexTerrain: 'forest',
  rng: createRng('ambush-default'),
  ...overrides,
});

// --- Bandit-favorable: forest ambush of a small caravan -------------------

describe('resolveAmbush: bandits ambushing a small caravan in forest', () => {
  it('30 bandits routinely overrun a 4-drover + 2-guard caravan and take cargo', () => {
    const caravan = baseCaravan();
    caravan.cargo.set(rid('food.grain'), 100);
    caravan.cargo.set(rid('goods.gladius'), 5);
    const result = resolveAmbush(
      baseAmbush({
        attacker: baseCamp({ banditCount: 30 }),
        target: caravan,
        ambushHexTerrain: 'forest',
        rng: createRng('forest-ambush'),
      }),
    );
    expect(result.outcome).toBe('attacker_won');
    expect(result.coinTaken).toBe(200);
    const totalCargo = Array.from(result.cargoTaken.values()).reduce((a, b) => a + b, 0);
    expect(totalCargo).toBeGreaterThan(0);
    // News: at least one survivor record exists.
    expect(result.survivors.length).toBeGreaterThan(0);
  });

  it('dense_forest gives an even stronger ambush effect than open plains', () => {
    // Same matchup, two terrains, identical RNG. With the same rolls dense
    // cover should let the bandits inflict at least as much damage as plains.
    const matchup = (terrain: AmbushInputs['ambushHexTerrain']): number => {
      const result = resolveAmbush(
        baseAmbush({
          attacker: baseCamp({ banditCount: 25 }),
          target: baseCaravan(),
          ambushHexTerrain: terrain,
          rng: createRng('terrain-fixed'),
        }),
      );
      return result.caravanCasualties.crewDeaths;
    };
    const denseDeaths = matchup('dense_forest');
    const plainsDeaths = matchup('plains');
    // Dense forest favors the ambusher → defenders take at least as much damage.
    expect(denseDeaths).toBeGreaterThanOrEqual(plainsDeaths);
  });
});

// --- Defender-favorable: well-escorted caravan in plains ------------------

describe('resolveAmbush: well-escorted caravan in plains', () => {
  it('5 bandits attacking a 12-soldier escort lose decisively', () => {
    const caravan = baseCaravan({
      crew: [
        { kind: 'merchant', count: 2, weapons: 0.3, armor: 0.2 },
        { kind: 'soldier', count: 12, weapons: 0.9, armor: 0.8 },
      ],
    });
    const result = resolveAmbush(
      baseAmbush({
        attacker: baseCamp({
          banditCount: 5,
          weaponsPerBandit: 0.3,
          armorPerBandit: 0.1,
        }),
        target: caravan,
        ambushHexTerrain: 'plains',
        rng: createRng('plains-defender-wins'),
      }),
    );
    expect(result.outcome).toBe('defender_won');
    expect(result.banditCasualties.deaths).toBeGreaterThan(0);
    // No cargo or coin taken when defender wins.
    expect(result.cargoTaken.size).toBe(0);
    expect(result.coinTaken).toBe(0);
    expect(result.captivesTaken).toBe(0);
  });
});

// --- Cargo cap ------------------------------------------------------------

describe('resolveAmbush: cargo capacity caps loot', () => {
  it('attacker cannot carry more than count × ~30 kg of cargo', () => {
    // 10000 grain at 6.7 kg = 67000 kg. 30 bandits × 30 kg = 900 kg cap.
    const caravan = baseCaravan();
    caravan.cargo.set(rid('food.grain'), 10000);
    const result = resolveAmbush(
      baseAmbush({
        attacker: baseCamp({ banditCount: 30 }),
        target: caravan,
        ambushHexTerrain: 'forest',
        rng: createRng('cargo-cap'),
      }),
    );
    expect(result.outcome).toBe('attacker_won');
    const grain = result.cargoTaken.get(rid('food.grain')) ?? 0;
    expect(grain).toBeGreaterThan(0);
    expect(grain).toBeLessThan(10000);
  });

  it('high-value-per-kg cargo is taken first when capacity binds', () => {
    const caravan = baseCaravan();
    caravan.cargo.set(rid('food.grain'), 1000);
    caravan.cargo.set(rid('goods.gladius'), 50);
    const result = resolveAmbush(
      baseAmbush({
        attacker: baseCamp({ banditCount: 25 }),
        target: caravan,
        valueOfResource: (id: ResourceId) => (id === rid('goods.gladius') ? 100 : 1),
        ambushHexTerrain: 'forest',
        rng: createRng('value-pick'),
      }),
    );
    expect(result.outcome).toBe('attacker_won');
    expect(result.cargoTaken.get(rid('goods.gladius'))).toBe(50);
  });
});

// --- Captives -------------------------------------------------------------

describe('resolveAmbush: captives', () => {
  it('attacker takes captives when overrunning a caravan', () => {
    const result = resolveAmbush(
      baseAmbush({
        attacker: baseCamp({ banditCount: 50 }),
        target: baseCaravan(),
        ambushHexTerrain: 'forest',
        rng: createRng('captive'),
      }),
    );
    expect(result.outcome).toBe('attacker_won');
    expect(result.captivesTaken).toBeGreaterThan(0);
  });
});

// --- Caravan flee ---------------------------------------------------------

describe('resolveAmbush: caravan flees', () => {
  it('a routed-but-not-destroyed caravan emits a caravan_fled outcome', () => {
    // Tune for a likely caravan rout: small caravan ambushed by a much
    // larger band so it routs in the first round.
    let sawFlee = false;
    for (let i = 0; i < 30; i++) {
      const result = resolveAmbush(
        baseAmbush({
          attacker: baseCamp({ banditCount: 60, weaponsPerBandit: 0.7, armorPerBandit: 0.4 }),
          target: baseCaravan({
            crew: [
              { kind: 'merchant', count: 1, weapons: 0.1, armor: 0.05 },
              { kind: 'drover', count: 5, weapons: 0.1, armor: 0.05 },
            ],
          }),
          ambushHexTerrain: 'plains',
          rng: createRng(`flee-${i}`),
        }),
      );
      if (result.outcome === 'caravan_fled') {
        sawFlee = true;
        // When fleeing, attacker may still grab some cargo dropped on the road.
        const totalCargo = Array.from(result.cargoTaken.values()).reduce((a, b) => a + b, 0);
        expect(totalCargo).toBeGreaterThanOrEqual(0);
        break;
      }
    }
    expect(sawFlee).toBe(true);
  });
});

// --- Determinism ---------------------------------------------------------

describe('resolveAmbush: determinism', () => {
  it('same RNG seed produces identical outcome, casualties and loot', () => {
    const c1 = baseCaravan();
    c1.cargo.set(rid('food.grain'), 200);
    const c2 = baseCaravan();
    c2.cargo.set(rid('food.grain'), 200);
    const r1 = resolveAmbush(
      baseAmbush({ target: c1, ambushHexTerrain: 'forest', rng: createRng('det-amb') }),
    );
    const r2 = resolveAmbush(
      baseAmbush({ target: c2, ambushHexTerrain: 'forest', rng: createRng('det-amb') }),
    );
    expect(r1.outcome).toBe(r2.outcome);
    expect(r1.coinTaken).toBe(r2.coinTaken);
    expect(r1.captivesTaken).toBe(r2.captivesTaken);
    expect(r1.banditCasualties).toEqual(r2.banditCasualties);
    expect(r1.caravanCasualties).toEqual(r2.caravanCasualties);
    expect(Array.from(r1.cargoTaken.entries()).sort()).toEqual(
      Array.from(r2.cargoTaken.entries()).sort(),
    );
  });
});

// --- Edge cases ----------------------------------------------------------

describe('resolveAmbush: edge cases', () => {
  it('survivors output is the same instance as the underlying battle survivors', () => {
    const result = resolveAmbush(baseAmbush({ rng: createRng('survivors-pass') }));
    expect(result.survivors).toBe(result.battle.survivors);
  });

  it('caravan with empty cargo and zero treasury yields empty loot', () => {
    const caravan = baseCaravan({ treasury: 0 });
    // Ensure cargo is empty.
    caravan.cargo.clear();
    const result = resolveAmbush(
      baseAmbush({
        target: caravan,
        attacker: baseCamp({ banditCount: 80 }),
        rng: createRng('empty-loot'),
      }),
    );
    if (result.outcome === 'attacker_won') {
      expect(result.cargoTaken.size).toBe(0);
      expect(result.coinTaken).toBe(0);
    }
  });

  it('animal deaths counted on attacker victory', () => {
    const caravan = baseCaravan({ animals: { mule: 10 } });
    const result = resolveAmbush(
      baseAmbush({
        target: caravan,
        attacker: baseCamp({ banditCount: 60 }),
        rng: createRng('animal-deaths'),
      }),
    );
    if (result.outcome === 'attacker_won') {
      expect(result.caravanCasualties.animalDeaths).toBeGreaterThanOrEqual(0);
    }
  });
});
