# 02 — Resources

A bounded enumerated set. Goal: ~40–50 items — enough for rich
production chains, few enough that the player can hold them in their
head.

Naming convention: `category.name`. Categories are lowercase tags
only — they don't restrict gameplay.

## Tier 0 — Raw materials (extracted from terrain)

| Resource | Source hex | Notes |
|---|---|---|
| `food.grain` | Plains, fertile valleys | Wheat/barley/spelt aggregated. Subsistence backbone. Seasonal: planted spring, harvested late summer. |
| `food.olives` | Mediterranean climate, hills | Annual harvest in autumn. Trees take years to mature. |
| `food.grapes` | Mediterranean climate, hills | Annual autumn harvest. Vines take years. |
| `food.fish` | Coast, river, lake hexes | Continuous, depletable if over-fished. |
| `food.game` | Forest, hills | Limited supply per hex; mostly subsistence in marginal regions. |
| `food.legumes` | Plains | Fallback crop, rotation partner with grain. |
| `livestock.sheep` | Pasture, hills | Provides wool, milk, meat, hide. Herd unit, not individual animals. |
| `livestock.cattle` | Plains, pasture | Provides meat, milk, hide, draft labor. |
| `livestock.pigs` | Forests, settlements | Mostly meat; eat scraps & forage. |
| `livestock.equines` | Plains | Horses/mules/donkeys. Caravan & military input. |
| `material.wood` | Forest hexes | Renewable but depletable; over-harvest → erosion → reduced yield. |
| `material.stone` | Hills, mountains | Effectively infinite per deposit, slow to extract. |
| `material.clay` | River banks, lowlands | Effectively infinite. |
| `material.flax` | Plains (cooler) | Annual; produces fiber + linseed oil. |
| `material.hides` | Byproduct of livestock slaughter | Co-output, not extracted directly. |
| `mineral.iron_ore` | Specific mountain hexes | Finite deposit per hex. |
| `mineral.copper_ore` | Specific mountain hexes | Finite. |
| `mineral.tin_ore` | Rare mountain hexes | Strategic — needed for bronze. |
| `mineral.lead_ore` | Mountain hexes | Often co-located with silver. |
| `mineral.silver_ore` | Mountain hexes | Coinage + luxury. |
| `mineral.gold_ore` | Rare mountain/river hexes | Coinage + status. |
| `mineral.salt` | Coastal pans, salt mines | Essential for preservation; geographically bottlenecked. |

## Tier 1 — Refined / processed

| Resource | Inputs | Notes |
|---|---|---|
| `food.flour` | grain + mill labor | Stockpile shelf life: months. |
| `food.bread` | flour + fuel + baker | Spoils in days; mostly produced where consumed. |
| `food.olive_oil` | olives + press labor + amphora | Stores well; cooking + lighting + soap. |
| `food.wine` | grapes + vintner + amphora | Improves over years; major trade good. |
| `food.cheese` | milk + salt + dairy labor | Stores well. [TODO] Milk is currently implicit in dairy recipes; decide whether to promote raw milk to a tracked resource. |
| `food.salted_fish` | fish + salt + labor | Stores months; major Roman trade good. (Garum is a sub-variant — skip for current scope.) |
| `food.salted_meat` | livestock slaughter + salt | Stores months. |
| `material.wool` | sheep + shearer | Annual yield per herd unit. |
| `material.linen_fiber` | flax + retting labor | Linen textile input. |
| `material.leather` | hides + tanner + (oak bark / time) | Tanning takes turns to complete. |
| `material.charcoal` | wood + collier | Required for smelting; *a lot* of wood per unit. |
| `material.lumber` | wood + sawyer | Building material. |
| `material.cut_stone` | stone + mason labor | Construction. |
| `material.brick_tile` | clay + fuel + kiln labor | Construction. |
| `material.pottery` | clay + fuel + potter | Storage, daily use. |
| `material.amphora` | clay + fuel + potter | Specialized — required to ship liquids. |
| `metal.iron` | iron_ore + charcoal + smelter | Bar stock. |
| `metal.bronze` | copper/tin ore + charcoal + smelter | Bar stock; Roman-era still common for fittings. [TODO] Decide whether to add `metal.copper` / `metal.tin` intermediates or keep bronze as direct ore alloying. |
| `metal.lead` | lead_ore + charcoal | Plumbing, weights, sling bullets. |
| `metal.silver` | silver_ore + lead + cupellation labor | Coinage, plate. |
| `metal.gold` | gold_ore + labor | Coinage, status. |

## Tier 2 — Manufactured goods

| Resource | Inputs | Notes |
|---|---|---|
| `goods.cloth` | wool *or* linen_fiber + weaver | Bolts of fabric. |
| `goods.clothing` | cloth + tailor | Wears out at population's consumption rate. |
| `goods.tools` | iron + lumber + smith | Required for most production jobs. Wear out. |
| `goods.weapons` | iron + lumber + smith | Military equipment. |
| `goods.armor` | iron + leather + smith | Military equipment. |
| `goods.shields` | lumber + leather + bronze trim + carpenter | Military. |
| `goods.cart` | lumber + iron + leather + wright | Caravan capacity unit. Wears out. |
| `goods.furniture` | lumber + carpenter | Comfort/status good. |
| `goods.luxury_textiles` | cloth + dye + skilled weaver | Elite demand. |
| `goods.coin` | silver/gold + mint labor | Medium of exchange. |

(No `goods.ship` — sea trade deferred.)

## Tier 2b — Exotic imports (locked)

These goods don't exist locally. They arrive only via real off-map
caravans (see [06 — Caravans](06-caravans.md)) and command high
prices. They're high value per unit weight, which is why long-haul
trade brings them at all.

| Resource | Notes |
|---|---|
| `exotic.spices` | Pepper, cinnamon, etc. Status + comfort demand; some preservation use. |
| `exotic.silk` | Luxury textile input or finished cloth. Pure status good. |
| `exotic.incense` | Religious + status use; consumed in temples and patrician homes. |
| `exotic.dyes` | Murex purple, indigo, etc. Input for `goods.luxury_textiles`. |

Bulk staples (especially grain) **don't appear here** even though
the global market exists, because the math doesn't work: their value
per kg is too low to justify the long-haul transport cost. Amphora-
packed olive oil and wine can export when quality, scarcity, or
surplus makes them high-value enough; ordinary local staples do not.
Only goods whose value-to-weight ratio clears the caravan economics
naturally flow at this distance — emergent, not hard-coded. See
[08 — Money & Trade](08-money-and-trade.md).

## Tier 2c — People as cargo

People can be carried or led by a caravan. The two cases that
matter:

| Resource | Notes |
|---|---|
| `people.slave` | Owned humans being transported. Walks under guard rather than being carted. Consumes rations. Has weight (~70 kg) but doesn't take cargo space the way packed goods do. Detailed in [04 — Population](04-population.md) and [11 — Politics & Ownership](11-politics-and-ownership.md). |
| `people.migrants` | Free people relocating with their belongings. Walking caravan. Same physics. Detailed in [04 — Population](04-population.md). |

Both can be intercepted, ransomed, lost to disease en route. People
are not abstractions; they are real cargo that walks.

## Tier 3 — Abstract / institutional outputs

These aren't items in cargo holds; they're standing capacities tied
to a settlement.

| Capacity | Backed by | What it does |
|---|---|---|
| `service.garrison` | trained soldiers + weapons + armor + ration upkeep | Suppresses banditry in catchment, defends against raids. |
| `service.administration` | scribes/officials + parchment + grain stipend | Enables taxation, edicts, public works. |
| `service.priesthood` | priests + offerings (grain, wine, livestock) | Population happiness; festivals shift demand. |
| `service.public_works` | masons + lumber + cut_stone + iron, accumulated over turns | Roads (movement bonus), aqueducts (city size cap), walls (defense). |

## Locked decisions (formerly open questions)

- **Slavery**: included as a population class + transportable cargo
  (`people.slave`). Roman economics depended on it; we model it
  directly with the historical name. See
  [04 — Population](04-population.md) and
  [11 — Politics & Ownership](11-politics-and-ownership.md).
- **Exotic imports**: included as `exotic.*` resources, available
  only via real off-map caravans entering at edge hexes. No magic
  spawning. See [06 — Caravans](06-caravans.md).
- **Exports to off-map global market**: symmetric — high-value
  low-weight goods (silver, luxury cloth, slaves, fine pottery,
  amphora-packed olive oil and wine when the spread is high enough)
  are taken off-map by NPC long-haul caravans. The player cannot run
  these. Bulk staples, especially grain, do not export because the
  math doesn't justify the transport. See
  [08 — Money & Trade](08-money-and-trade.md).
