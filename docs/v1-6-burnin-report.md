# v1.6 burn-in analysis — 10-year final

Generated from `burnin-final-10y/` after pass 23 (recipe-yield calibration).

## 1. Run overview

- **Seed**: realism-compare
- **Years**: 10 (3650 days)
- **Population**: 261,522 → 202,955 (Δ -22.4 %)
- **Settlements**: 614 → 546
- **Total famine deaths**: 60,259
- **Total epidemics**: 25
- **Baseline + disease deaths**: 19,438 + 26
- **Recipe runs (total)**: 5,910,320
- **Market clearings (total)**: 10,218,654
- **Invariant violations**: fatal 0 / error 0 / warning 0

## 2. Population dynamics by tier (cyclicality)

All numbers are total population in that tier across all settlements of that tier.

| Year | hamlet | village | town | small_city | large_city | total |
|-----:|-------:|--------:|-----:|-----------:|-----------:|------:|
| Y1 | 26,883 | 141,549 | 33,569 | 20,923 | 34,931 | 257,855 |
| Y2 | 26,970 | 130,308 | 30,613 | 20,955 | 34,984 | 243,830 |
| Y3 | 26,904 | 117,372 | 30,591 | 20,913 | 34,981 | 230,761 |
| Y4 | 26,753 | 110,663 | 30,619 | 20,957 | 35,063 | 224,055 |
| Y5 | 26,599 | 106,467 | 30,681 | 20,955 | 35,046 | 219,748 |
| Y6 | 26,359 | 105,143 | 29,828 | 20,982 | 35,101 | 217,413 |
| Y7 | 26,200 | 103,063 | 29,823 | 20,996 | 35,101 | 215,183 |
| Y8 | 25,963 | 99,226 | 28,650 | 21,053 | 35,151 | 210,043 |
| Y9 | 25,917 | 96,776 | 27,232 | 21,024 | 35,109 | 206,058 |

## 3. Stockpile days-of-supply by tier × year

Median days-of-supply per settlement in each tier. 
Days = stockpile / (population × per-capita daily consumption rate).

### hamlet

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 40 | 0.00 | 5 | 23 | 0.49 | 1 | 18 | 0.00 | 5 | 0.00 |
| Y2 | 39 | 0.00 | 5 | 9 | 0.21 | 0.52 | 9 | 0.00 | 5 | 0.00 |
| Y3 | 38 | 0.00 | 5 | 2 | 0.08 | 0.24 | 4 | 0.00 | 5 | 0.00 |
| Y4 | 37 | 0.00 | 5 | 0.46 | 0.03 | 0.10 | 3 | 0.00 | 5 | 0.00 |
| Y5 | 36 | 0.00 | 5 | 0.19 | 0.00 | 0.02 | 2 | 0.00 | 5 | 0.00 |
| Y6 | 34 | 0.00 | 5 | 0.09 | 0.00 | 0.01 | 0.84 | 0.00 | 5 | 0.00 |
| Y7 | 30 | 0.00 | 5 | 0.04 | 0.00 | 0.00 | 0.47 | 0.00 | 5 | 0.00 |
| Y8 | 26 | 0.00 | 5 | 0.02 | 0.00 | 0.00 | 0.21 | 0.00 | 5 | 0.00 |
| Y9 | 16 | 0.00 | 5 | 0.01 | 0.00 | 0.00 | 0.01 | 0.00 | 5 | 0.00 |

### village

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 123 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 14 | 0.00 |
| Y2 | 105 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 14 | 0.00 |
| Y3 | 631 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 14 | 0.00 |
| Y4 | 980 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 14 | 0.00 |
| Y5 | 1307 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 14 | 0.00 |
| Y6 | 1266 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 14 | 0.00 |
| Y7 | 1121 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 14 | 0.00 |
| Y8 | 968 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 14 | 0.00 |
| Y9 | 998 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 14 | 0.00 |

### town

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 1160 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 183 | 949 | 0.00 |
| Y2 | 1048 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 196 | 1142 | 0.00 |
| Y3 | 5032 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 45 | 132 | 1143 | 0.00 |
| Y4 | 5683 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.22 | 17 | 1141 | 0.00 |
| Y5 | 5582 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.50 | 0.35 | 1139 | 0.00 |
| Y6 | 5480 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 3 | 0.84 | 1156 | 0.00 |
| Y7 | 6115 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 4 | 76 | 1162 | 0.29 |
| Y8 | 13471 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 92 | 75 | 1161 | 0.25 |
| Y9 | 17759 | 0.21 | 0.00 | 0.00 | 0.00 | 0.00 | 122 | 154 | 1299 | 0.33 |

### small_city

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 885 | 0.00 | 0.00 | 8 | 27 | 92 | 0.00 | 165 | 776 | 0.01 |
| Y2 | 5751 | 0.00 | 0.00 | 7 | 22 | 534 | 56 | 289 | 1345 | 8 |
| Y3 | 8064 | 0.03 | 0.00 | 35 | 41 | 826 | 231 | 266 | 1352 | 3 |
| Y4 | 13746 | 0.03 | 0.00 | 26 | 0.01 | 1085 | 0.41 | 310 | 1346 | 0.62 |
| Y5 | 15555 | 0.00 | 0.00 | 18 | 0.06 | 1350 | 0.44 | 214 | 1346 | 0.00 |
| Y6 | 16464 | 0.00 | 4 | 17 | 3 | 612 | 147 | 168 | 1406 | 1 |
| Y7 | 17165 | 0.08 | 3 | 32 | 0.36 | 259 | 116 | 111 | 1446 | 0.53 |
| Y8 | 17082 | 0.52 | 0.23 | 41 | 0.96 | 68 | 113 | 97 | 1440 | 0.64 |
| Y9 | 17257 | 0.17 | 0.03 | 71 | 3 | 7 | 114 | 89 | 1444 | 0.64 |

### large_city

| Year | grain | wine | olive_oil | cheese | salted_mea | salted_fis | cloth | clothing | furniture | pottery |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 896 | 0.08 | 0.00 | 88 | 79 | 435 | 127 | 172 | 573 | 57 |
| Y2 | 3565 | 7 | 12 | 160 | 121 | 426 | 138 | 191 | 572 | 57 |
| Y3 | 6048 | 2 | 50 | 93 | 132 | 406 | 137 | 191 | 572 | 57 |
| Y4 | 9817 | 25 | 0.01 | 49 | 49 | 386 | 135 | 191 | 620 | 60 |
| Y5 | 15571 | 17 | 62 | 29 | 18 | 403 | 134 | 172 | 858 | 59 |
| Y6 | 18305 | 0.04 | 0.13 | 76 | 15 | 377 | 114 | 171 | 835 | 24 |
| Y7 | 19980 | 0.12 | 12 | 62 | 40 | 493 | 137 | 174 | 829 | 27 |
| Y8 | 22038 | 0.55 | 0.31 | 71 | 52 | 430 | 137 | 173 | 1021 | 31 |
| Y9 | 22330 | 1 | 0.02 | 36 | 15 | 327 | 137 | 189 | 1099 | 51 |

## 4. Price level by resource × year

Median across all settlements that recorded a clearing price that year. Coin-per-unit.

| Year | grain | bread | wine | olive_oil | cheese | salted_me | salted_fi | cloth | clothing | furniture | pottery | iron | tools | gladius | silver |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 2 | 144 | 95 | 129 | 300 | 109 | 98 | 13 | 61 | 301 | 240 | 2400 | 897 | 231 | 10000 |
| Y2 | 23 | 144 | 95 | 129 | 300 | 109 | 98 | 13 | 60 | 300 | 240 | 2400 | 5000 | 212 | 10000 |
| Y3 | 2 | 144 | 92.5 | 129 | 300 | 109 | 98 | 13 | 60 | 300 | 240 | 2400 | 5000 | 170 | 10000 |
| Y4 | 2 | 144 | 84 | 129 | 300 | 109 | 98 | 13 | 60 | 300 | 240 | 2400 | 5000 | 50 | 10000 |
| Y5 | 2 | 144 | 84 | 129 | 300 | 109 | 98 | 13 | 60 | 300 | 240 | 1693.5 | 5000 | 60 | 10000 |
| Y6 | 2 | 144 | 84 | 129 | 300 | 109 | 98 | 13 | 60 | 300 | 240 | 2400 | 5000 | 37 | 4876 |
| Y7 | 2 | 144 | 84 | 129 | 300 | 109 | 98 | 13 | 60 | 300 | 240 | 987 | 5000 | 39.5 | 10000 |
| Y8 | 2 | 144 | 84 | 129 | 300 | 109 | 98 | 13 | 44 | 300 | 240 | 2400 | 5000 | 37 | 4751 |
| Y9 | 12.5 | 144 | 84 | 129 | 300 | 109 | 98 | 13 | 60 | 300 | 240 | 2400 | 5000 | 37 | 10000 |

## 5. Caravan fleet composition by year

Active caravans on the map at end-of-year by ID-prefix type.

| Year | villager | merchant | export | import | tax | other | TOTAL |
|-----:|---------:|---------:|-------:|-------:|----:|------:|------:|
| Y1 | 2 | 22 | 3 | 6 | 5 | 8 | 46 |
| Y2 | 1 | 23 | 9 | 5 | 5 | 7 | 50 |
| Y3 | 2 | 25 | 21 | 6 | 5 | 7 | 66 |
| Y4 | 3 | 29 | 9 | 12 | 6 | 6 | 65 |
| Y5 | 3 | 20 | 10 | 12 | 6 | 6 | 57 |
| Y6 | 7 | 15 | 3 | 8 | 3 | 5 | 41 |
| Y7 | 7 | 14 | 9 | 10 | 5 | 5 | 50 |
| Y8 | 6 | 14 | 19 | 10 | 6 | 4 | 59 |
| Y9 | 7 | 5 | 3 | 12 | 6 | 3 | 36 |

## 6. Treasury (wealth) by actor kind

Aggregate coin holdings at year-end, by actor kind. Shows where money concentrates over 10 years.

| Year | governor | city_corp | patrician (sum) | guild (sum) | freedman (sum) | plebeian (sum) | hamlet (sum) | free_village (sum) | off_map_house |
|-----:|---------:|----------:|----------------:|------------:|---------------:|---------------:|-------------:|-------------------:|--------------:|
| Y1 | 3.2k | 2.3M | 567.5k | 35.0k | 707.2k | 6.1M | 5.9M | 51.9k | 3.4M |
| Y2 | 1.2M | 2.5M | 931.6k | 35.0k | 513.7k | 3.5M | 5.2M | 44.2k | 4.8M |
| Y3 | 1.4M | 1.7M | 162.4k | 35.0k | 487.0k | 3.6M | 3.8M | 425.3k | 5.3M |
| Y4 | 2.9M | 1.9M | 210.6k | 35.0k | 342.8k | 2.6M | 2.9M | 402.4k | 5.8M |
| Y5 | 4.0M | 2.3M | 63.0k | 35.0k | 244.2k | 2.1M | 1.8M | 181.4k | 6.0M |
| Y6 | 1.2M | 1.6M | 3.6M | 35.0k | 77.1k | 1.6M | 1.3M | 167.9k | 5.6M |
| Y7 | 2.8M | 989.7k | 153.3k | 35.0k | 97.5k | 1.5M | 924.4k | 210.1k | 7.5M |
| Y8 | 1.8M | 436.9k | 374.0k | 35.0k | 103.9k | 1.2M | 656.2k | 69.7k | 9.5M |
| Y9 | 2.1M | 1.4M | 119.2k | 35.0k | 48.7k | 837.9k | 541.5k | 32.1k | 9.1M |

## 7. Wage payments by class × year

Total coin + in-kind wages paid to workers, aggregated by hiring-owner kind. Shows labor income flows.

| Year | city_corporation | patrician_family | free_village | hamlet_household | plebeian_household | freedman_household | governor_office | total |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 251.2M | 441.4k | 18.6M | 0 | 0 | 0 | 11.5k | 270.3M |
| Y2 | 94.8M | 761.5k | 17.4M | 0 | 0 | 0 | 0 | 113.0M |
| Y3 | 98.4M | 811.2k | 17.0M | 0 | 0 | 0 | 297.3k | 116.6M |
| Y4 | 149.9M | 1.4M | 18.1M | 0 | 0 | 0 | 234.4k | 169.6M |
| Y5 | 141.6M | 1.3M | 12.3M | 0 | 0 | 0 | 1.5M | 156.7M |
| Y6 | 116.3M | 1.1M | 11.9M | 0 | 0 | 0 | 3.8M | 133.0M |
| Y7 | 88.8M | 2.5M | 11.9M | 0 | 0 | 0 | 4.6M | 107.8M |
| Y8 | 101.1M | 310.1k | 12.6M | 0 | 0 | 0 | 6.8M | 120.8M |
| Y9 | 74.2M | 288.2k | 10.1M | 0 | 0 | 0 | 6.2M | 90.8M |
| Y10 | 77.5M | 815.6k | 10.8M | 0 | 0 | 0 | 1.1M | 90.2M |

## 8. Owner take (recipe profit) by class × year

Net coin to owners after wages + inputs. Negative means owners ran the recipe at a subsidy.

| Year | city_corporation | patrician_family | free_village | hamlet_household | plebeian_household | freedman_household | governor_office | total |
|-----:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Y1 | 735.2M | 908.2k | 197.7M | 63.2M | 0 | 0 | 857.1k | 997.9M |
| Y2 | 450.3M | 1.8M | 153.6M | 5.4M | 0 | 0 | 781.8k | 611.9M |
| Y3 | 450.1M | 7.0M | 133.0M | 1.4M | 0 | 0 | 2.7M | 594.1M |
| Y4 | 782.8M | 3.6M | 128.9M | 573.1k | 0 | 0 | 16.1M | 932.0M |
| Y5 | 823.4M | 4.2M | 106.9M | 302.1k | 0 | 0 | 27.3M | 962.2M |
| Y6 | 411.9M | 5.5M | 97.0M | 178.6k | 0 | 0 | 21.8M | 536.4M |
| Y7 | 354.2M | 12.2M | 96.3M | 100.4k | 0 | 0 | 104.1M | 567.0M |
| Y8 | 380.7M | 10.9M | 94.1M | 104.8k | 0 | 0 | 43.2M | 529.0M |
| Y9 | 290.8M | 2.4M | 79.8M | 151.3k | 0 | 0 | 48.2M | 421.4M |
| Y10 | 353.8M | 4.5M | 57.4M | 88.5k | 0 | 0 | 12.5M | 428.2M |

## 9. Top 15 recipes by 10-year output value

Sum of `runs × output_value` across the full burn-in. Indicates which recipes drove the most coin-denominated output.

| Recipe | total runs | total output value | total owner take |
|--------|-----------:|-------------------:|-----------------:|
| `milk_dairy` | 681,881 | 1.77B | 1.72B |
| `make_wine` | 59,084 | 1.49B | 664.9M |
| `bake_bread` | 35,641 | 1.36B | 130.0M |
| `fell_timber` | 292,800 | 1.06B | 807.3M |
| `hunt_game` | 263,490 | 1.05B | 845.9M |
| `tend_vineyard` | 46,794 | 983.5M | 915.2M |
| `burn_charcoal` | 200,387 | 943.0M | 629.6M |
| `press_olives` | 26,844 | 879.6M | 262.5M |
| `fish_lake` | 203,056 | 789.0M | 701.6M |
| `harvest_grain` | 403,100 | 740.9M | 595.2M |
| `tend_olive_grove` | 47,895 | 717.7M | 651.3M |
| `salt_fish` | 26,289 | 520.5M | -236.1M |
| `mill_grain` | 29,166 | 471.9M | 234.7M |
| `forge_tools` | 28,379 | 462.4M | 1.7M |
| `ret_flax` | 111,994 | 403.3M | 65.0M |

## 10. Worst 15 recipes by owner take (loss-makers)

Recipes whose owners paid more in wages + inputs than they recouped from outputs. Subsidies / loss-leaders.

| Recipe | total runs | total output value | total owner take |
|--------|-----------:|-------------------:|-----------------:|
| `make_cheese` | 16,010 | 98.9M | -1.43B |
| `smelt_iron` | 30,294 | 355.5M | -290.0M |
| `salt_meat` | 30,725 | 84.6M | -288.7M |
| `weave_linen_cloth` | 125,851 | 58.4M | -270.3M |
| `salt_fish` | 26,289 | 520.5M | -236.1M |
| `smelt_copper` | 12,783 | 82.9M | -121.1M |
| `make_furniture` | 30,127 | 61.1M | -88.1M |
| `smelt_lead` | 6,347 | 13.0M | -87.2M |
| `smelt_tin` | 5,882 | 67.2M | -20.5M |
| `tailor_clothing` | 120,237 | 35.3M | -14.1M |
| `sow_grain` | 51,889 | 0 | -11.7M |
| `raise_pigs` | 70,862 | 3.7M | -11.5M |
| `cupel_silver` | 1,566 | 2.0M | -6.7M |
| `forge_helmet` | 3,147 | 1.9M | -4.9M |
| `refine_gold` | 3,920 | 631.8k | -4.7M |

---

_Generated by `scripts/analyze_10y.py` from `burnin-final-10y/`._
