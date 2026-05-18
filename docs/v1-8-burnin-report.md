# v1.8 burn-in analysis — 10-year final

Generated from `burnin-final-10y-v18/`.

## 1. Run overview

- **Seed**: realism-compare
- **Years**: 10 (3650 days)
- **Population**: 261,522 → 253,295 (Δ -3.1 %)
- **Settlements**: 614 → 575
- **Total famine deaths**: 21,424
- **Total epidemics**: 33
- **Baseline + disease deaths**: 22,895 + 29
- **Recipe runs (total)**: 3,687,926
- **Market clearings (total)**: 8,558,382
- **Invariant violations**: fatal 0 / error 0 / warning 0

## 2. Population dynamics by tier (cyclicality)

All numbers are total population in that tier across all settlements of that tier.

| Year | hamlet | village | town | small_city | large_city | total |
|-----:|-------:|--------:|-----:|-----------:|-----------:|------:|
| Y1 | 26,864 | 145,233 | 33,740 | 21,011 | 35,088 | 261,936 |
| Y2 | 27,058 | 145,312 | 33,858 | 21,125 | 35,253 | 262,606 |
| Y3 | 27,025 | 145,131 | 33,949 | 21,195 | 35,383 | 262,683 |
| Y4 | 27,023 | 144,479 | 34,099 | 21,320 | 35,552 | 262,473 |
| Y5 | 26,991 | 143,750 | 34,324 | 21,411 | 35,646 | 262,122 |
| Y6 | 26,924 | 143,386 | 34,574 | 21,504 | 35,798 | 262,186 |
| Y7 | 26,253 | 142,643 | 34,746 | 21,579 | 35,940 | 261,161 |
| Y8 | 25,814 | 141,914 | 34,930 | 21,680 | 36,132 | 260,470 |
| Y9 | 25,210 | 140,115 | 34,231 | 21,732 | 36,234 | 257,522 |

## 3. Stockpile days-of-supply by tier × year

Median days-of-supply per settlement in each tier. 
Days = stockpile / (population × per-capita daily consumption rate).

### hamlet

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 0.00 | 0.00 | 5 | 3 | 0.00 | 0.00 | 102 | 0.00 | 0.00 | 0.00 |
| Y2 | 0.00 | 0.00 | 5 | 1 | 0.00 | 0.00 | 90 | 0.00 | 0.00 | 0.00 |
| Y3 | 0.00 | 0.00 | 5 | 0.00 | 0.00 | 0.00 | 73 | 0.00 | 0.00 | 0.00 |
| Y4 | 0.00 | 0.00 | 4 | 0.00 | 0.00 | 0.00 | 60 | 0.00 | 0.00 | 0.00 |
| Y5 | 0.00 | 0.00 | 4 | 0.00 | 0.00 | 0.00 | 47 | 0.00 | 0.00 | 0.00 |
| Y6 | 0.00 | 0.00 | 4 | 0.00 | 0.00 | 0.00 | 36 | 0.00 | 0.00 | 0.00 |
| Y7 | 0.00 | 0.00 | 4 | 0.00 | 0.00 | 0.00 | 29 | 0.00 | 0.00 | 0.00 |
| Y8 | 0.00 | 0.00 | 4 | 0.00 | 0.00 | 0.00 | 17 | 0.00 | 0.00 | 0.00 |
| Y9 | 0.00 | 0.00 | 4 | 0.00 | 0.00 | 0.00 | 5 | 0.00 | 0.00 | 0.00 |

### village

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 670 | 0.00 | 0.00 | 6 | 0.00 | 0.00 | 0.00 | 0.00 | 10 | 0.00 |
| Y2 | 994 | 0.00 | 0.00 | 0.66 | 0.00 | 0.00 | 0.00 | 0.00 | 10 | 0.00 |
| Y3 | 2060 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 10 | 0.00 |
| Y4 | 2194 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 10 | 0.00 |
| Y5 | 2162 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 10 | 0.00 |
| Y6 | 1999 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 10 | 0.00 |
| Y7 | 1810 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 10 | 0.00 |
| Y8 | 1771 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 10 | 0.00 |
| Y9 | 1641 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 10 | 0.00 |

### town

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 1454 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 192 | 890 | 0.00 |
| Y2 | 1852 | 0.00 | 0.07 | 0.00 | 0.00 | 0.00 | 0.00 | 149 | 1016 | 0.00 |
| Y3 | 4523 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 2 | 120 | 1025 | 0.77 |
| Y4 | 4927 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 53 | 81 | 1032 | 0.02 |
| Y5 | 4769 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 54 | 44 | 1046 | 1 |
| Y6 | 4630 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 58 | 6 | 1048 | 0.00 |
| Y7 | 4359 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 20 | 3 | 1062 | 0.00 |
| Y8 | 4136 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 41 | 0.56 | 1076 | 0.00 |
| Y9 | 4364 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.98 | 20 | 1085 | 0.33 |

### small_city

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 1988 | 0.00 | 0.00 | 16 | 13 | 71 | 0.00 | 112 | 151 | 10 |
| Y2 | 3250 | 0.04 | 0.00 | 119 | 10 | 380 | 4 | 231 | 258 | 46 |
| Y3 | 6336 | 0.01 | 0.00 | 103 | 31 | 167 | 74 | 444 | 530 | 14 |
| Y4 | 13151 | 0.39 | 0.18 | 136 | 5 | 98 | 334 | 453 | 575 | 33 |
| Y5 | 21318 | 0.00 | 0.00 | 202 | 14 | 424 | 343 | 456 | 598 | 17 |
| Y6 | 28135 | 0.21 | 0.00 | 203 | 18 | 240 | 343 | 458 | 670 | 58 |
| Y7 | 32319 | 0.00 | 8 | 231 | 0.00 | 456 | 342 | 460 | 689 | 33 |
| Y8 | 39060 | 0.14 | 0.00 | 177 | 1 | 361 | 241 | 457 | 704 | 34 |
| Y9 | 47328 | 0.00 | 0.00 | 182 | 1 | 242 | 310 | 456 | 719 | 10 |

### large_city

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 2657 | 0.43 | 46 | 115 | 14 | 330 | 26 | 174 | 578 | 57 |
| Y2 | 3802 | 11 | 2 | 96 | 5 | 323 | 136 | 175 | 575 | 58 |
| Y3 | 3633 | 9 | 0.50 | 87 | 0.21 | 192 | 136 | 174 | 572 | 58 |
| Y4 | 3254 | 8 | 0.37 | 85 | 0.93 | 93 | 135 | 174 | 569 | 57 |
| Y5 | 3077 | 8 | 0.79 | 76 | 22 | 144 | 136 | 173 | 567 | 57 |
| Y6 | 2881 | 7 | 9 | 79 | 12 | 111 | 135 | 173 | 565 | 56 |
| Y7 | 3715 | 5 | 4 | 159 | 0.09 | 173 | 134 | 173 | 562 | 56 |
| Y8 | 4055 | 0.39 | 0.00 | 119 | 28 | 227 | 128 | 174 | 558 | 55 |
| Y9 | 3146 | 0.29 | 0.00 | 89 | 0.23 | 249 | 115 | 171 | 553 | 47 |

## 4. Price level by resource × year

Median across all settlements that recorded a clearing price that year. Coin-per-unit.

| Year | grain | bread | wine | olive_oil | cheese | salted_me | salted_fi | cloth | clothing | furniture | pottery | iron | tools | gladius | silver |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 13 | 144 | 144 | 129 | 300 | 109 | 98 | 13 | 60 | 301 | 240 | 2400 | 5000 | 74.5 | 4177 |
| Y2 | 46 | 144 | 119 | 129 | 300 | 109 | 98 | 13 | 60 | 301 | 240 | 2400 | 5000 | 163 | 4940 |
| Y3 | 23 | 144 | 119 | 129 | 300 | 109 | 59 | 13 | 66 | 301 | 240 | 2400 | 5000 | 141 | 4826 |
| Y4 | 90 | 144 | 119 | 129 | 300 | 19 | 23 | 13 | 75 | 301 | 240 | 2400 | 5000 | 217 | 1550 |
| Y5 | 23 | 144 | 119 | 129 | 300 | 9 | 14 | 13 | 75 | 301 | 240 | 2400 | 5000 | 37.5 | 1760 |
| Y6 | 23 | 144 | 84 | 129 | 300 | 4 | 57.5 | 13 | 75 | 301 | 240 | 2400 | 5000 | 42 | 1122 |
| Y7 | 23 | 144 | 84 | 129 | 300 | 15 | 26 | 13 | 61 | 301 | 240 | 2400 | 5000 | 71 | 4505.5 |
| Y8 | 2 | 144 | 146 | 129 | 300 | 4 | 29 | 15 | 61 | 301 | 240 | 2400 | 5000 | 42 | 1584 |
| Y9 | 2 | 144 | 212 | 129 | 300 | 11 | 18 | 14 | 61 | 301 | 240 | 2400 | 5000 | 37 | 2442 |

## 5. Caravan fleet composition by year

Active caravans on the map at end-of-year by ID-prefix type.

| Year | villager | merchant | export | import | tax | other | TOTAL |
|-----:|---------:|---------:|-------:|-------:|----:|------:|------:|
| Y1 | 62 | 20 | 0 | 2 | 4 | 8 | 96 |
| Y2 | 63 | 23 | 2 | 1 | 1 | 6 | 96 |
| Y3 | 70 | 21 | 0 | 0 | 0 | 5 | 96 |
| Y4 | 68 | 19 | 0 | 0 | 4 | 5 | 96 |
| Y5 | 70 | 18 | 1 | 0 | 2 | 5 | 96 |
| Y6 | 70 | 15 | 1 | 1 | 4 | 5 | 96 |
| Y7 | 65 | 21 | 2 | 1 | 4 | 3 | 96 |
| Y8 | 63 | 21 | 1 | 4 | 3 | 1 | 93 |
| Y9 | 59 | 21 | 2 | 5 | 7 | 1 | 95 |

## 6. Treasury (wealth) by actor kind

Aggregate coin holdings at year-end, by actor kind. Shows where money concentrates over 10 years.

| Year | governor | city_corp | patrician (sum) | guild (sum) | freedman (sum) | plebeian (sum) | hamlet (sum) | free_village (sum) | off_map_house |
|-----:|---------:|----------:|----------------:|------------:|---------------:|---------------:|-------------:|-------------------:|--------------:|
| Y1 | 521.9k | 1.9M | 1.0M | 35.0k | 1.8M | 9.7M | 1.8M | 653.8k | 3.8M |
| Y2 | 272.2k | 2.7M | 249.4k | 35.0k | 1.8M | 6.7M | 2.6M | 1.2M | 5.9M |
| Y3 | 2.8k | 2.6M | 350.7k | 35.0k | 1.4M | 5.1M | 3.3M | 892.5k | 7.2M |
| Y4 | 3.8k | 3.2M | 420.6k | 35.0k | 1.2M | 4.1M | 3.6M | 665.4k | 8.0M |
| Y5 | 75.9k | 2.2M | 695.5k | 35.0k | 1.1M | 3.4M | 3.4M | 315.6k | 9.6M |
| Y6 | 52.9k | 3.4M | 322.7k | 35.0k | 1.0M | 2.9M | 3.0M | 324.9k | 9.8M |
| Y7 | 18.8k | 2.0M | 1.1M | 35.0k | 966.2k | 2.5M | 2.5M | 263.2k | 10.6M |
| Y8 | 175.6k | 2.0M | 956.9k | 35.0k | 427.0k | 2.3M | 2.1M | 215.5k | 11.8M |
| Y9 | 65.0k | 1.7M | 1.1M | 35.0k | 523.0k | 2.0M | 1.9M | 208.0k | 12.5M |

## 7. Wage payments by class × year

Total coin + in-kind wages paid to workers, aggregated by hiring-owner kind. Shows labor income flows.

| Year | city_corporation | patrician_family | free_village | hamlet_household | plebeian_household | freedman_household | governor_office | total |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 227.6M | 132.6k | 26.1M | 0 | 0 | 0 | 0 | 253.9M |
| Y2 | 105.0M | 32.5k | 20.2M | 0 | 0 | 0 | 371.3k | 125.6M |
| Y3 | 85.6M | 42.8k | 26.3M | 0 | 0 | 0 | 229.3k | 112.2M |
| Y4 | 70.0M | 4.1k | 32.3M | 0 | 0 | 0 | 4.4k | 102.2M |
| Y5 | 62.1M | 4.6k | 25.3M | 0 | 0 | 0 | 16.9k | 87.4M |
| Y6 | 66.8M | 13.6k | 24.8M | 0 | 0 | 0 | 47 | 91.6M |
| Y7 | 75.2M | 54.4k | 19.1M | 0 | 0 | 0 | 521.3k | 94.9M |
| Y8 | 71.6M | 84.3k | 18.4M | 0 | 0 | 0 | 59.2k | 90.2M |
| Y9 | 128.3M | 62.9k | 16.0M | 0 | 0 | 0 | 212.0k | 144.6M |
| Y10 | 156.8M | 158.7k | 14.4M | 0 | 0 | 0 | 81.4k | 171.5M |

## 8. Owner take (recipe profit) by class × year

Net coin to owners after wages + inputs. Negative means owners ran the recipe at a subsidy.

| Year | city_corporation | patrician_family | free_village | hamlet_household | plebeian_household | freedman_household | governor_office | total |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 1.09B | 293.5k | 322.3M | 21.6M | 0 | 0 | 0 | 1.44B |
| Y2 | 691.3M | 298.9k | 322.4M | 236.7k | 0 | 0 | 2.9M | 1.02B |
| Y3 | 455.7M | 131.0k | 291.6M | -192.0k | 0 | 0 | 448.6k | 747.7M |
| Y4 | 489.7M | 1.8M | 148.3M | -324.1k | 0 | 0 | 8.3k | 639.4M |
| Y5 | 358.2M | 9.1M | 117.2M | 224.3k | 0 | 0 | 107.0k | 484.8M |
| Y6 | 360.8M | 1.9M | 115.0M | 568.7k | 0 | 0 | 78 | 478.3M |
| Y7 | 651.9M | 10.2M | 93.9M | 300.4k | 0 | 0 | 2.8M | 759.2M |
| Y8 | 560.7M | 25.7M | 83.7M | 222.4k | 0 | 0 | 1.0M | 671.4M |
| Y9 | 627.2M | 12.7M | 88.0M | 184.2k | 0 | 0 | 1.6M | 729.7M |
| Y10 | 1.15B | 5.4M | 84.9M | 343.7k | 0 | 0 | 757.0k | 1.24B |

## 9. Top 15 recipes by 10-year output value

Sum of `runs × output_value` across the full burn-in. Indicates which recipes drove the most coin-denominated output.

| Recipe | total runs | total output value | total owner take |
|--------|-----------:|-------------------:|-----------------:|
| `milk_dairy` | 325,081 | 2.50B | 2.38B |
| `bake_bread` | 36,301 | 1.26B | 313.4M |
| `harvest_grain` | 374,807 | 792.4M | 586.8M |
| `make_wine` | 20,888 | 720.7M | 549.7M |
| `mill_grain` | 24,924 | 641.6M | 450.6M |
| `burn_charcoal` | 109,627 | 593.9M | 409.8M |
| `fell_timber` | 169,440 | 551.8M | 421.6M |
| `hunt_game` | 140,909 | 517.6M | 379.7M |
| `tend_vineyard` | 31,190 | 440.4M | 376.4M |
| `fish_lake` | 110,153 | 398.6M | 330.6M |
| `press_olives` | 10,561 | 351.1M | 241.0M |
| `tend_olive_grove` | 29,316 | 323.6M | 253.8M |
| `salt_meat` | 23,716 | 305.7M | 251.4M |
| `forge_tools` | 14,211 | 288.8M | 82.7M |
| `ret_flax` | 57,239 | 239.2M | 44.9M |

## 10. Worst 15 recipes by owner take (loss-makers)

Recipes whose owners paid more in wages + inputs than they recouped from outputs. Subsidies / loss-leaders.

| Recipe | total runs | total output value | total owner take |
|--------|-----------:|-------------------:|-----------------:|
| `raise_pigs` | 49,726 | 2.5M | -5.6M |
| `sow_grain` | 37,887 | 0 | -5.3M |
| `forge_helmet` | 965 | 764.9k | -3.2M |
| `forge_body_armor` | 678 | 635.9k | -2.5M |
| `forge_gladius` | 756 | 596.0k | -2.1M |
| `forge_pilum` | 545 | 635.4k | -2.1M |
| `refine_gold` | 1,326 | 533.2k | -1.4M |
| `forge_hasta` | 810 | 476.4k | -1.3M |
| `raise_equines` | 44,351 | 2.3M | -726.3k |
| `forge_dagger` | 577 | 311.9k | -585.0k |
| `make_bow` | 1,984 | 160.8k | -44.8k |
| `make_shield` | 195 | 190.1k | -22.4k |
| `build_cart` | 371 | 56.4k | -11.6k |

---

_Generated by `scripts/analyze_10y.py` from `burnin-final-10y-v18/`._
