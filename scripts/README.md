# scripts/

Developer tooling for the ecogame project. Two broad categories:

1. **Active tooling** wired into `npm run <name>`, the Claude Code
   stop hook, the docs, or the build pipeline. These are
   load-bearing — touching them affects the dev / CI loop.
2. **Investigative one-shots** written during specific debugging
   sessions. Useful as templates for future investigations but not
   referenced from anywhere; safe to delete when stale.

The directory has no internal dependencies — every script is a
standalone entry point that imports from `../src/` (or `../viewer/`)
and is invoked via `npm run …`, `npx tsx …`, or `python3 …`.

## Active tooling

| Script | Invocation | Purpose |
|---|---|---|
| `analyze-burnin.py` | `python3 scripts/analyze-burnin.py --dir burnin/<name> --out docs/<name>-report.md` | Generates the multi-section markdown report from a burn-in output directory (pop / stockpile / price / caravan / treasury / recipe-economics tables). Referenced from CLAUDE.md + docs/14 §"Burn-in analysis report". |
| `analyze-steady-state.ts` | `npx tsx scripts/analyze-steady-state.ts [population]` | Leontief input-output analyzer on the recipe catalog. Computes steady-state per-day instance counts of every recipe needed to feed a population of N at the historical consumption rates. Referenced from docs/03 §"Steady-state analyzer". |
| `audit-resource-graph.ts` | `npm run audit` | Walks the resource catalog + recipe catalog + demand schedules and flags orphans (resources with no producer or no consumer). Per docs/02 §"Producer / consumer column" + the Phase-6 audit plan. |
| `bench-pathfinding.ts` | `npm run bench:pathfinding` | Micro-benchmark for the JS vs WASM pathfinder kernels. Drives `PATH_BENCH_SIDE` / `PATH_BENCH_ROUTES` / `PATH_BENCH_LOOPS` env knobs. |
| `build-generated-art-prompts.ts` | `npm run art:prompts` | Emits JSON prompts for the AI-art pipeline (resource icons, terrain tiles, unit sprites). Inputs the resource catalog so the prompt set stays in sync with what the game actually has. |
| `postprocess-generated-art.py` | `npm run art:postprocess` | Consumes the raw image-gen outputs and normalizes them into viewer-ready assets (transparent icons, hex-clipped tiles, sprite sheets). Requires the `.venv-imagegen` virtualenv. |
| `burnin-watchdog.sh` | Claude Code Stop hook (currently disabled in `.claude/settings.json` for AWS-deploy work; re-enable by moving the block back under `hooks.Stop[0]`) | 5-gate sanity check: typecheck, lint, tests, coverage, 3-year burn-in. Blocks Claude from stopping if anything regresses. |
| `embed-pathfinding-wasm.mjs` | `npm run wasm:build` (chained after `asc`) | Reads `src/wasm/pathfinding.kernel.wasm`, base64-encodes it, and writes `src/wasm/pathfinding.ts` so the wasm can ship as part of the JS bundle without a separate fetch. |
| `debug-activity.ts` | `npx tsx scripts/debug-activity.ts` | Per-year activity tally from a 10-year burn-in: trade volume, caravan trips, banditry, patrols. Age-band + class breakdowns of population. Referenced from docs/04 §"Verifying it's working". |

## Investigative one-shots

A small set of scripts kept around as templates for the next bug hunt.
They aren't referenced from anywhere — pure runtime utilities.

| Script | What it inspects |
|---|---|
| `debug-burnin.ts` | Short burn-in that dumps per-tier population + per-resource stockpile aggregates each year. Useful generic "where is the collapse" diagnostic — effectively a tiny in-terminal version of `analyze-burnin.py`. |
| `debug-activity.ts` | Per-year activity tally from a 10-year burn-in: trade volume, caravan trips, banditry, patrols. Age-band + class breakdowns of population. Referenced from docs/04 §"Verifying it's working". |

Older single-purpose debug scripts from the C29/C30/C32 cleanup work
(grain source, multi-settlement actors, patron grain, bandit engagement,
stockpile sources/accounting) were deleted once their target bugs were
fixed and the relevant invariants moved into vitest. The git log
preserves them if you ever need to resurrect a pattern.

The stockpile-accounting audit specifically lives at
`src/sim/world/stockpileAccounting.test.ts` — a per-tick reconciliation
that catches missing flow-column entries on every CI run.

## Conventions

- TypeScript scripts run via `tsx` (no compile step). Imports use
  the same `.ts`-suffix style as the rest of the repo.
- Python scripts require Python 3.10+. The image-pipeline scripts
  expect the `.venv-imagegen` virtualenv at the repo root.
- One-off output (intermediate JSON, dumped logs, scratch files)
  belongs under `./tmp/` per CLAUDE.md §"Scratch goes under
  `./tmp/`". Burn-in output belongs under `./burnin/<name>/` per
  CLAUDE.md §"Burn-in output goes under `./burnin/`".
- New investigative scripts should land here with a one-line `/**
  …  */` docstring explaining the bug being chased. When the bug
  is fixed, either promote the script to active tooling (with a
  doc cross-link and a `npm run` entry) or delete it — don't let
  it rot.
