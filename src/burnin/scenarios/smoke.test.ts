/**
 * Integration smoke test (T42).
 *
 * Builds a tiny world (1 capital + 3 villages + 1 patrician family +
 * 1 governor + 1 bandit camp + 2 NPC caravans) and runs 30 days
 * through the tick loop. Asserts that the world doesn't blow up and
 * that basic activity (recipes, caravan movement, market clearing)
 * happens.
 */

import { describe, expect, it } from 'vitest';
import { runSmokeScenario } from './smoke.js';

describe('runSmokeScenario', () => {
  it('completes 30 days without crashing', async () => {
    const result = await runSmokeScenario();
    expect(result.daysRun).toBe(30);
  }, 15000);

  it('reports no fatal invariant violations', async () => {
    const result = await runSmokeScenario();
    const fatal = result.invariantViolations.filter((v) => v.severity === 'fatal');
    expect(fatal).toEqual([]);
  }, 15000);

  it('preserves total population within 5%', async () => {
    const result = await runSmokeScenario();
    expect(result.startTotalPopulation).toBeGreaterThan(0);
    const ratio = result.summary.totalPop / result.startTotalPopulation;
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  }, 15000);

  it('runs at least one recipe (production happens)', async () => {
    const result = await runSmokeScenario();
    const recipeRuns = result.events.filter((e) => e.type === 'recipe_ran');
    expect(recipeRuns.length).toBeGreaterThan(0);
  }, 15000);

  it('moves at least one caravan', async () => {
    const result = await runSmokeScenario();
    const moves = result.events.filter((e) => e.type === 'caravan_moved');
    expect(moves.length).toBeGreaterThan(0);
  }, 15000);

  it('clears at least one market', async () => {
    const result = await runSmokeScenario();
    const clears = result.events.filter((e) => e.type === 'market_cleared');
    expect(clears.length).toBeGreaterThan(0);
  }, 15000);

  it('builds the documented faction structure (1 capital + 3 villages + governor + 1 family + 1 bandit camp + 2 caravans)', async () => {
    const result = await runSmokeScenario();
    // 1 capital + 3 villages × 3 disagg factor (per docs/15 §C9 v1.5
    // disaggregation; smoke scenario asks for 3 villages, procgen produces
    // up to 9 entities). Hamlets are 0 in this scenario.
    const settlements = result.world.settlements.size;
    const capitals = [...result.world.settlements.values()].filter((s) => s.tier === 'large_city');
    const villages = [...result.world.settlements.values()].filter((s) => s.tier === 'village');
    expect(capitals.length).toBe(1);
    // The 3x disagg factor may produce fewer if the tiny smoke grid can't
    // accommodate; allow the historical 3-villages floor up to the new ceiling.
    expect(villages.length).toBeGreaterThanOrEqual(3);
    expect(villages.length).toBeLessThanOrEqual(9);
    expect(settlements).toBe(capitals.length + villages.length);
    // Governor + family + 1 city corp + 3 village/hamlet leaders + bandit_camp actor
    // We just assert the named-actor counts are in the expected band,
    // and that each documented role exists at least once.
    const kinds = [...result.world.actors.values()].map((a) => a.kind);
    expect(kinds).toContain('governor_office');
    expect(kinds).toContain('patrician_family');
    expect(kinds).toContain('bandit_camp');
    // Caravan count grew with the codex-review wirings: tax shipments
    // (per docs/11 §"Taxes") and edge-hub off-map trade (per docs/06 +
    // docs/08) both spawn caravans during the smoke scenario's days.
    // Floor: the 2 procgen-seeded caravans must still be present.
    expect(result.world.caravans.size).toBeGreaterThanOrEqual(2);
    expect(result.banditCamps.length).toBe(1);
    // The patriarch + governor + headmen + bandit leader are all named.
    const roles = [...result.world.characters.values()].map((c) => c.role);
    expect(roles).toContain('patriarch');
    expect(roles).toContain('governor');
    expect(roles).toContain('bandit_leader');
  }, 15000);

  it('completes in under 10 seconds', async () => {
    const start = Date.now();
    await runSmokeScenario();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10000);
  }, 15000);

  it('determinism: same seed → identical event sequence', async () => {
    const a = await runSmokeScenario({ seed: 'smoke-det' });
    const b = await runSmokeScenario({ seed: 'smoke-det' });
    expect(a.events.length).toBe(b.events.length);
    // Compare event type sequences and key payload fields.
    const fa = a.events.map((e) => JSON.stringify({ type: e.type, ...keyPayload(e) }));
    const fb = b.events.map((e) => JSON.stringify({ type: e.type, ...keyPayload(e) }));
    expect(fa).toEqual(fb);
  }, 15000);

  it('different seeds produce different event sequences (sanity)', async () => {
    const a = await runSmokeScenario({ seed: 'smoke-A' });
    const b = await runSmokeScenario({ seed: 'smoke-B' });
    // Almost surely the sequences differ; this is a sanity check on RNG plumbing.
    expect(a.events.length).not.toBe(b.events.length);
  }, 15000);
});

const keyPayload = (e: { type: string } & Record<string, unknown>): Record<string, unknown> => {
  // Keep only stable, comparable fields to make event-equality robust to
  // representation changes in tick events.
  const out: Record<string, unknown> = {};
  for (const k of ['settlement', 'recipe', 'caravan', 'resource'] as const) {
    if (k in e) out[k] = String(e[k]);
  }
  return out;
};
