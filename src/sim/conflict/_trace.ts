import { createCamp } from '../bandit/camp.js';
import { createCaravan } from '../caravan/caravan.js';
import { createRng } from '../rng.js';
import { actorId, banditCampId, caravanId } from '../types.js';
import { hex } from '../world/hex.js';
import { resolveAmbush } from './ambush.js';

const outcomes: Record<string, number> = {};
for (let i = 0; i < 100; i++) {
  const camp = createCamp({
    id: banditCampId('camp-A'),
    name: 'Wolfshead',
    hex: hex(5, 5),
    ownerActor: actorId('bandits-A'),
    banditCount: 60,
    hangersOnCount: 5,
    weaponsPerBandit: 0.7,
    armorPerBandit: 0.4,
    averageHealth: 0.85,
  });
  const caravan = createCaravan({
    id: caravanId('lone-cart'),
    ownerActor: actorId('merchant-X'),
    position: hex(2, 0),
    crew: [
      { kind: 'merchant', count: 2, weapons: 0.1, armor: 0.05 },
      { kind: 'drover', count: 18, weapons: 0.1, armor: 0.05 },
      { kind: 'caravan_guard', count: 10, weapons: 0.6, armor: 0.4 },
    ],
    animals: { mule: 6 },
    vehicles: { pack_saddle: 6 },
    treasury: 200,
  });
  const r = resolveAmbush({
    attacker: camp,
    target: caravan,
    ambushHexTerrain: 'plains',
    rng: createRng(`flee-${i}`),
  });
  outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
}
console.log(JSON.stringify(outcomes, null, 2));
