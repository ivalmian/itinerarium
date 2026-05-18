# 00 — Design Pillars

The things that must stay true. Every other design decision answers to
these.

1. **No hidden hands.** Every transaction has a real counterparty. Every
   good was produced by named labor in a specific place from specific
   inputs. If a city has bread, you can trace each loaf back to a farmer's
   field.

2. **Population is the universal bottleneck.** Nothing happens without
   people. No people → no farming → no food → fewer people. Military,
   government, crafts, transport — all draw from the same labor pool.

3. **Consumption is mandatory, not flavor.** People must eat. They wear out
   clothing. They burn fuel. Unmet subsistence demand kills or scatters
   population over real timescales.

4. **Realism is the default; abstraction must justify itself.** Where we
   abstract (e.g. "grain" instead of wheat/barley/spelt/millet), we do so
   because the gameplay difference is too small to model — not because it's
   easier.

5. **Consequences are emergent, not scripted.** A blockade doesn't trigger
   a "city dying" event. The city dies because no caravans arrived, so the
   granaries emptied, so people starved or fled, so the garrison deserted,
   so bandits took the walls.

6. **The player is inside the simulation.** They get the same information
   channels as any other merchant: their own eyes, news from other
   travellers, letters that take time to arrive. No omniscient market
   screen.

7. **Information spreads with units, never with action at a distance —
   not even delayed action at a distance.** If A learns something B
   knows, it's because a specific unit (caravan, news carrier, refugee,
   patrol, migrant) physically traveled between them. There is no
   "guild ledger sync at 20 hex/day" pretending to be physical;
   the ledger is a memo-pad two members write to and read from when
   they happen to be present at the guild hall, and those members had
   to walk there with their own observations. Same for reputation
   propagation, news of battles, and price discovery.

8. **Every good is tradeable; every transaction goes through the
   market.** No resource lives outside the price ladder. If a pasture
   produces equines, those equines have a bid and an ask. If a caravan
   owner needs them, that need is a real demand source the CDA can
   match. The same uniformity holds for same-hex local trade,
   villager carts, synthetic off-map edge visitors, bandit fences, and
   every other transaction site: they all emit asks or bids that flow
   through the per-settlement continuous
   double auction, and every executed trade writes the price into the
   settlement's ladder. There are no "owner-internal" workarounds, no
   stockpile-fetch bypasses, no direct transfers at synthesized
   prices. If you need to move a good, you submit a bid and clear at
   the going price.

These pillars are also the test for new feature ideas: if a proposed
feature requires breaking one (e.g. a global price ticker that everyone
sees instantly, or a guild ledger that magically syncs across cities
even when no caravan made the trip, or a caravan-assembly stockpile
fetch that bypasses the equine market), the answer is no, find another
way.
