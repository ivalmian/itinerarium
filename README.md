# Itinerarium

A Roman-era trading & caravan game with a fully simulated economy.
Browser-first TypeScript, hexagonal grid (1 km hexes), turn-based with
daily ticks and a Vagrus-style player turn UX.

**Live deployment:** <https://d2ylg6blq1xcs7.cloudfront.net/> — auto-deploys
on every push to `main` via the GitHub Actions workflow at
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). AWS
infrastructure (S3 + CloudFront + GitHub-OIDC deploy role) lives in
[`infra/aws/`](infra/aws/README.md).

**Design docs are the source of truth.** Start at
[`docs/README.md`](docs/README.md). Project guidance for AI sessions
is in [`CLAUDE.md`](CLAUDE.md).

## Status

Phase 1: headless world simulation, TDD. Player layer comes later.

## Development

```bash
npm install
npm test                # vitest run
npm run test:watch      # vitest in watch mode
npm run typecheck       # tsc --noEmit
npm run lint            # eslint
npm run burnin -- ...   # headless burn-in CLI (when built)
```

## Layout

```
src/
  sim/         # core simulation (no DOM, no React)
    world/     # hex grid, terrain
    population/
    production/
    market/
    caravan/
    politics/
    bandit/
    reputation/
  procgen/     # world generation
  burnin/      # stabilization sim runner
  cli/         # headless runners
  ui/          # React (later)
docs/          # design plan
```

Tests are co-located: `foo.ts` next to `foo.test.ts`.
