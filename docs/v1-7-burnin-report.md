# v1.6 burn-in analysis — 10-year final

Generated from `burnin-final-10y/` after pass 23 (recipe-yield calibration).

## 1. Run overview

- **Seed**: realism-compare
- **Years**: 10 (3650 days)
- **Population**: 261,522 → 242,811 (Δ -7.2 %)
- **Settlements**: 614 → 563
- **Total famine deaths**: 21,653
- **Total epidemics**: 31
- **Baseline + disease deaths**: 21,988 + 33
- **Recipe runs (total)**: 3,554,514
- **Market clearings (total)**: 8,509,019
- **Invariant violations**: fatal 0 / error 0 / warning 0

## 2. Population dynamics by tier (cyclicality)

All numbers are total population in that tier across all settlements of that tier.

| Year | hamlet | village | town | small_city | large_city | total |
|-----:|-------:|--------:|-----:|-----------:|-----------:|------:|
| Y1 | 26,759 | 144,433 | 33,567 | 20,923 | 34,932 | 260,614 |
| Y2 | 26,753 | 143,428 | 33,523 | 20,955 | 34,991 | 259,650 |
| Y3 | 26,686 | 142,732 | 33,489 | 20,911 | 34,987 | 258,805 |
| Y4 | 26,324 | 142,011 | 33,532 | 20,955 | 35,070 | 257,892 |
| Y5 | 26,240 | 141,100 | 33,605 | 20,955 | 35,053 | 256,953 |
| Y6 | 25,999 | 139,597 | 33,752 | 20,980 | 35,105 | 255,433 |
| Y7 | 25,317 | 137,901 | 33,808 | 20,990 | 35,105 | 253,121 |
| Y8 | 24,543 | 135,338 | 33,884 | 21,033 | 35,153 | 249,951 |
| Y9 | 23,750 | 132,801 | 33,118 | 20,991 | 35,117 | 245,777 |

## 3. Stockpile days-of-supply by tier × year

Median days-of-supply per settlement in each tier. 
Days = stockpile / (population × per-capita daily consumption rate).

### hamlet

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 0.00 | 0.00 | 5 | 3 | 0.00 | 0.00 | 108 | 0.00 | 0.00 | 0.00 |
| Y2 | 0.00 | 0.00 | 5 | 1 | 0.00 | 0.00 | 92 | 0.00 | 0.00 | 0.00 |
| Y3 | 0.00 | 0.00 | 5 | 0.00 | 0.00 | 0.00 | 79 | 0.00 | 0.00 | 0.00 |
| Y4 | 0.00 | 0.00 | 5 | 0.00 | 0.00 | 0.00 | 61 | 0.00 | 0.00 | 0.00 |
| Y5 | 0.00 | 0.00 | 5 | 0.00 | 0.00 | 0.00 | 49 | 0.00 | 0.00 | 0.00 |
| Y6 | 0.00 | 0.00 | 5 | 0.00 | 0.00 | 0.00 | 46 | 0.00 | 0.00 | 0.00 |
| Y7 | 0.00 | 0.00 | 5 | 0.00 | 0.00 | 0.00 | 37 | 0.00 | 0.00 | 0.00 |
| Y8 | 0.00 | 0.00 | 5 | 0.00 | 0.00 | 0.00 | 29 | 0.00 | 0.00 | 0.00 |
| Y9 | 0.00 | 0.00 | 4 | 0.00 | 0.00 | 0.00 | 17 | 0.00 | 0.00 | 0.00 |

### village

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 671 | 0.00 | 0.09 | 7 | 0.00 | 0.00 | 0.00 | 0.00 | 10 | 0.00 |
| Y2 | 980 | 0.00 | 0.00 | 1 | 0.00 | 0.00 | 0.00 | 0.00 | 10 | 0.00 |
| Y3 | 2177 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 11 | 0.00 |
| Y4 | 2276 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 11 | 0.00 |
| Y5 | 2130 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 10 | 0.00 |
| Y6 | 1971 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 11 | 0.00 |
| Y7 | 1953 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 11 | 0.00 |
| Y8 | 1737 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 11 | 0.00 |
| Y9 | 1573 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 11 | 0.00 |

### town

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 2051 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.29 | 138 | 945 | 0.00 |
| Y2 | 4023 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 2 | 75 | 1052 | 0.00 |
| Y3 | 5808 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 12 | 52 | 1141 | 0.00 |
| Y4 | 5883 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 1 | 52 | 1136 | 0.00 |
| Y5 | 5742 | 0.00 | 0.00 | 0.54 | 0.05 | 0.00 | 2 | 50 | 1135 | 0.00 |
| Y6 | 5748 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 2 | 53 | 1126 | 0.00 |
| Y7 | 5521 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.68 | 0.18 | 1127 | 0.00 |
| Y8 | 5581 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 47 | 43 | 1124 | 0.14 |
| Y9 | 8521 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 13 | 55 | 1124 | 0.51 |

### small_city

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 1736 | 0.00 | 15 | 74 | 13 | 25 | 0.00 | 164 | 503 | 23 |
| Y2 | 5098 | 0.00 | 0.00 | 160 | 20 | 171 | 0.82 | 234 | 542 | 57 |
| Y3 | 8170 | 0.00 | 0.00 | 128 | 38 | 58 | 207 | 461 | 587 | 5 |
| Y4 | 13853 | 0.00 | 0.00 | 108 | 22 | 74 | 358 | 410 | 662 | 2 |
| Y5 | 19756 | 0.00 | 0.00 | 131 | 7 | 31 | 362 | 479 | 691 | 0.02 |
| Y6 | 26160 | 0.00 | 0.03 | 254 | 18 | 688 | 362 | 480 | 732 | 33 |
| Y7 | 32559 | 0.00 | 0.17 | 177 | 18 | 962 | 359 | 480 | 743 | 0.49 |
| Y8 | 40066 | 0.01 | 0.00 | 143 | 0.73 | 558 | 358 | 481 | 752 | 6 |
| Y9 | 43630 | 0.00 | 0.00 | 73 | 4 | 383 | 359 | 483 | 789 | 0.03 |

### large_city

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 1578 | 0.28 | 33 | 95 | 7 | 307 | 30 | 172 | 455 | 57 |
| Y2 | 1494 | 0.83 | 3 | 109 | 2 | 256 | 118 | 171 | 486 | 58 |
| Y3 | 2216 | 0.31 | 0.00 | 63 | 1.00 | 219 | 137 | 175 | 584 | 58 |
| Y4 | 2106 | 0.26 | 0.00 | 104 | 2 | 168 | 138 | 175 | 582 | 58 |
| Y5 | 2108 | 0.47 | 19 | 106 | 31 | 272 | 137 | 174 | 582 | 57 |
| Y6 | 2161 | 0.20 | 0.00 | 144 | 1.00 | 199 | 128 | 176 | 579 | 58 |
| Y7 | 2133 | 0.00 | 0.18 | 117 | 19 | 186 | 126 | 173 | 577 | 55 |
| Y8 | 2257 | 0.00 | 0.00 | 109 | 7 | 156 | 123 | 169 | 575 | 54 |
| Y9 | 2854 | 0.18 | 2 | 74 | 3 | 164 | 109 | 169 | 570 | 47 |

## 4. Price level by resource × year

Median across all settlements that recorded a clearing price that year. Coin-per-unit.

| Year | grain | bread | wine | olive_oil | cheese | salted_me | salted_fi | cloth | clothing | furniture | pottery | iron | tools | gladius | silver |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 2 | 144 | 119 | 129 | 300 | 109 | 98 | 13 | 60 | 301 | 240 | 2400 | 5000 | 160 | 4309 |
| Y2 | 90 | 144 | 97 | 129 | 300 | 109 | 98 | 13 | 60 | 301 | 240 | 2400 | 5000 | 231 | 5584 |
| Y3 | 23 | 144 | 142 | 129 | 300 | 109 | 47 | 13 | 60 | 301 | 240 | 2400 | 5000 | 113 | 9025 |
| Y4 | 90 | 144 | 118.5 | 129 | 300 | 45 | 21 | 13 | 61 | 301 | 240 | 2400 | 5000 | 50 | 4408 |
| Y5 | 90 | 144 | 233 | 129 | 300 | 20 | 13 | 13 | 60 | 301 | 240 | 2400 | 5000 | 37 | 834 |
| Y6 | 23 | 144 | 98 | 129 | 300 | 20 | 27 | 13 | 75 | 301 | 240 | 2400 | 5000 | 55 | 578 |
| Y7 | 23 | 144 | 95 | 129 | 300 | 6 | 49 | 13 | 75 | 301 | 240 | 2400 | 5000 | 51 | 971.5 |
| Y8 | 2 | 144 | 348 | 129 | 300 | 21 | 99 | 13 | 60 | 301 | 240 | 2400 | 5000 | 45.5 | 1538 |
| Y9 | 2 | 144 | 176 | 129 | 300 | 11 | 29.5 | 13 | 66 | 301 | 240 | 2400 | 5000 | 37 | 4346.5 |

## 5. Caravan fleet composition by year

Active caravans on the map at end-of-year by ID-prefix type.

| Year | villager | merchant | export | import | tax | other | TOTAL |
|-----:|---------:|---------:|-------:|-------:|----:|------:|------:|
| Y1 | 61 | 18 | 2 | 1 | 3 | 11 | 96 |
| Y2 | 62 | 18 | 1 | 1 | 4 | 5 | 91 |
| Y3 | 57 | 26 | 2 | 5 | 2 | 3 | 95 |
| Y4 | 60 | 25 | 2 | 3 | 4 | 1 | 95 |
| Y5 | 57 | 19 | 4 | 7 | 5 | 1 | 93 |
| Y6 | 65 | 20 | 4 | 3 | 3 | 1 | 96 |
| Y7 | 68 | 20 | 4 | 0 | 3 | 1 | 96 |
| Y8 | 69 | 19 | 3 | 1 | 2 | 1 | 95 |
| Y9 | 66 | 18 | 2 | 4 | 4 | 1 | 95 |

## 6. Treasury (wealth) by actor kind

Aggregate coin holdings at year-end, by actor kind. Shows where money concentrates over 10 years.

| Year | governor | city_corp | patrician (sum) | guild (sum) | freedman (sum) | plebeian (sum) | hamlet (sum) | free_village (sum) | off_map_house |
|-----:|---------:|----------:|----------------:|------------:|---------------:|---------------:|-------------:|-------------------:|--------------:|
| Y1 | 171.1k | 2.7M | 1.8M | 35.0k | 1.0M | 10.7M | 2.1M | 777.2k | 2.6M |
| Y2 | 28.4k | 2.5M | 294.0k | 35.0k | 967.4k | 7.6M | 2.2M | 1.3M | 4.5M |
| Y3 | 26.2k | 2.4M | 1.5M | 35.0k | 576.1k | 5.8M | 2.2M | 949.9k | 5.8M |
| Y4 | 3.6k | 2.4M | 812.2k | 35.0k | 530.2k | 4.7M | 1.9M | 1.2M | 7.5M |
| Y5 | 0 | 2.1M | 460.6k | 35.0k | 414.9k | 4.3M | 1.7M | 1.1M | 8.6M |
| Y6 | 3.6k | 2.7M | 47.9k | 35.0k | 269.1k | 3.5M | 1.6M | 1.1M | 9.3M |
| Y7 | 0 | 2.1M | 71.8k | 35.0k | 308.7k | 3.0M | 1.7M | 790.4k | 9.4M |
| Y8 | 2.6k | 1.7M | 331.4k | 35.0k | 124.7k | 2.4M | 1.5M | 1.2M | 10.2M |
| Y9 | 286.5k | 1.2M | 200.8k | 35.0k | 154.7k | 2.4M | 1.7M | 742.9k | 10.6M |

## 7. Wage payments by class × year

Total coin + in-kind wages paid to workers, aggregated by hiring-owner kind. Shows labor income flows.

| Year | city_corporation | patrician_family | free_village | hamlet_household | plebeian_household | freedman_household | governor_office | total |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 201.5M | 34.6k | 27.2M | 0 | 0 | 0 | 4.7k | 228.7M |
| Y2 | 119.4M | 89.6k | 23.0M | 0 | 0 | 0 | 0 | 142.6M |
| Y3 | 88.0M | 13.6k | 27.4M | 0 | 0 | 0 | 0 | 115.4M |
| Y4 | 80.0M | 39.2k | 39.6M | 0 | 0 | 0 | 0 | 119.6M |
| Y5 | 76.1M | 25.1k | 19.8M | 0 | 0 | 0 | 0 | 95.8M |
| Y6 | 89.2M | 50.2k | 18.7M | 0 | 0 | 0 | 0 | 107.9M |
| Y7 | 80.3M | 50.9k | 18.1M | 0 | 0 | 0 | 0 | 98.4M |
| Y8 | 75.3M | 22.0k | 17.3M | 0 | 0 | 0 | 267.4k | 92.9M |
| Y9 | 84.3M | 152.6k | 14.0M | 0 | 0 | 0 | 674.7k | 99.1M |
| Y10 | 76.4M | 155.0k | 14.3M | 0 | 0 | 0 | 636.4k | 91.5M |

## 8. Owner take (recipe profit) by class × year

Net coin to owners after wages + inputs. Negative means owners ran the recipe at a subsidy.

| Year | city_corporation | patrician_family | free_village | hamlet_household | plebeian_household | freedman_household | governor_office | total |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 924.7M | 102.7k | 344.8M | 21.9M | 0 | 0 | 758.1k | 1.29B |
| Y2 | 773.7M | 1.4M | 271.9M | 138.3k | 0 | 0 | 5.1k | 1.05B |
| Y3 | 476.3M | 3.5M | 290.6M | 116.0k | 0 | 0 | 0 | 770.5M |
| Y4 | 593.7M | 4.9M | 206.4M | -294.0k | 0 | 0 | 0 | 804.8M |
| Y5 | 670.0M | 9.5M | 190.3M | 95.3k | 0 | 0 | 3.3k | 870.0M |
| Y6 | 633.7M | 2.4M | 151.1M | 114.5k | 0 | 0 | 0 | 787.3M |
| Y7 | 416.1M | 407.8k | 135.5M | 170.1k | 0 | 0 | 393.6k | 552.6M |
| Y8 | 404.9M | 6.1M | 113.0M | 197.4k | 0 | 0 | 690.7k | 524.9M |
| Y9 | 386.6M | 11.0M | 171.8M | 171.8k | 0 | 0 | 7.6M | 577.2M |
| Y10 | 343.7M | 9.8M | 126.7M | 186.1k | 0 | 0 | 7.1M | 487.5M |

## 9. Top 15 recipes by 10-year output value

Sum of `runs × output_value` across the full burn-in. Indicates which recipes drove the most coin-denominated output.

| Recipe | total runs | total output value | total owner take |
|--------|-----------:|-------------------:|-----------------:|
| `milk_dairy` | 313,517 | 2.37B | 2.22B |
| `bake_bread` | 35,696 | 1.17B | 354.9M |
| `harvest_grain` | 337,234 | 803.8M | 592.3M |
| `burn_charcoal` | 116,214 | 712.8M | 578.3M |
| `mill_grain` | 24,726 | 562.5M | 362.7M |
| `make_wine` | 19,560 | 530.4M | 384.7M |
| `fell_timber` | 158,057 | 423.3M | 322.8M |
| `hunt_game` | 139,336 | 402.6M | 307.6M |
| `forge_tools` | 12,816 | 394.8M | 154.5M |
| `tend_vineyard` | 31,570 | 390.9M | 333.6M |
| `tend_olive_grove` | 27,909 | 360.3M | 296.7M |
| `fish_lake` | 115,083 | 343.8M | 285.8M |
| `smelt_iron` | 26,621 | 314.7M | 198.7M |
| `salt_meat` | 20,376 | 277.0M | 237.4M |
| `press_olives` | 9,971 | 241.3M | 118.0M |

## 10. Worst 15 recipes by owner take (loss-makers)

Recipes whose owners paid more in wages + inputs than they recouped from outputs. Subsidies / loss-leaders.

| Recipe | total runs | total output value | total owner take |
|--------|-----------:|-------------------:|-----------------:|
| `sow_grain` | 39,646 | 0 | -6.0M |
| `raise_pigs` | 47,700 | 2.9M | -5.3M |
| `forge_helmet` | 796 | 1.5M | -2.8M |
| `forge_body_armor` | 629 | 856.0k | -2.3M |
| `forge_pilum` | 598 | 733.8k | -2.0M |
| `forge_gladius` | 688 | 802.8k | -2.0M |
| `refine_gold` | 1,413 | 449.5k | -1.5M |
| `forge_hasta` | 712 | 545.1k | -1.3M |
| `raise_equines` | 42,862 | 2.1M | -613.7k |
| `forge_dagger` | 757 | 375.5k | -607.8k |
| `make_bow` | 1,781 | 146.5k | -50.6k |
| `make_shield` | 219 | 160.3k | -26.4k |
| `build_cart` | 366 | 33.5k | -2.5k |
| `mint_coin` | 128 | 0 | -457 |

---

_Generated by `scripts/analyze_10y.py` from `burnin-final-10y-pass27/`._
