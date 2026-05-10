#!/usr/bin/env bash
#
# Burn-in watchdog (Claude Code Stop hook).
#
# Five gates that BLOCK Claude from stopping:
#   1. `npm run typecheck` — strict TypeScript must compile clean.
#   2. `npm run lint` — ESLint must pass with no errors or warnings.
#   3. `npm run test:coverage` — every test must pass (no skips).
#   4. Aggregate test coverage (lines + statements + functions +
#      branches, average) must be > 80%.
#   5. A 10-year burn-in on a realistic procgen world (80x80, 3 cities)
#      must stay self-sustainable: end pop ≥ 50% of start, no fatal
#      invariant violations, exit code 0.
#
# When all five pass, exits 0 with no output (Claude proceeds to stop
# normally). When any gate fails, prints a single JSON line
# {"decision":"block","reason":...} and exits 0 (Claude continues
# working with the reason in context).
#
# Project-scoped: wired in .claude/settings.json.
#
# Note: typecheck ~5s, lint ~5s, test+coverage ~20s, 10-year burn-in
# ~20–60s on a recent laptop. The hook timeout in settings.json is
# 900s for headroom.

set -u
cd "$(dirname "$0")/.."

block() {
  local msg="$1"
  printf '{"decision":"block","reason":%s}\n' "$(printf '%s' "$msg" | jq -Rs .)"
  exit 0
}

# Gate 1: typecheck.
TC_OUTPUT=$(npm run typecheck --silent 2>&1)
TC_EXIT=$?
if [ "$TC_EXIT" -ne 0 ]; then
  TAIL=$(printf '%s' "$TC_OUTPUT" | tail -40)
  block "npm run typecheck failed (exit $TC_EXIT). Last 40 lines: $TAIL"
fi

# Gate 2: lint.
LINT_OUTPUT=$(npm run lint --silent 2>&1)
LINT_EXIT=$?
if [ "$LINT_EXIT" -ne 0 ]; then
  TAIL=$(printf '%s' "$LINT_OUTPUT" | tail -40)
  block "npm run lint failed (exit $LINT_EXIT). Last 40 lines: $TAIL"
fi

# Gate 3+4: tests must pass AND coverage must be > 80%.
COVERAGE_OUTPUT=$(npm run test:coverage --silent 2>&1)
COVERAGE_EXIT=$?
if [ "$COVERAGE_EXIT" -ne 0 ]; then
  TAIL=$(printf '%s' "$COVERAGE_OUTPUT" | tail -40)
  block "npm run test:coverage failed (exit $COVERAGE_EXIT). Last 40 lines: $TAIL"
fi

# Parse coverage/coverage-summary.json (vitest `json-summary` reporter).
SUMMARY_JSON="coverage/coverage-summary.json"
if [ ! -f "$SUMMARY_JSON" ]; then
  block "tests passed but coverage summary missing at $SUMMARY_JSON. Check vitest.config.ts has 'json-summary' reporter."
fi

# Average lines + statements + functions + branches percentages.
COVERAGE_AVG=$(jq -r '
  (.total.lines.pct + .total.statements.pct + .total.functions.pct + .total.branches.pct) / 4
' "$SUMMARY_JSON" 2>/dev/null)
if [ -z "$COVERAGE_AVG" ] || [ "$COVERAGE_AVG" = "null" ]; then
  block "could not parse coverage from $SUMMARY_JSON"
fi

# Compare with bash arithmetic (multiply by 100 to integer-compare 80.5 → 8050).
COVERAGE_INT=$(printf '%.0f' "$(echo "$COVERAGE_AVG * 100" | bc -l)")
THRESHOLD_INT=8000  # 80.00 * 100
if [ "$COVERAGE_INT" -lt "$THRESHOLD_INT" ]; then
  PER_METRIC=$(jq -r '
    "lines=\(.total.lines.pct)% statements=\(.total.statements.pct)% functions=\(.total.functions.pct)% branches=\(.total.branches.pct)%"
  ' "$SUMMARY_JSON")
  block "coverage average $(printf '%.2f' "$COVERAGE_AVG")% is below 80% threshold. Per-metric: $PER_METRIC"
fi

# Gate 2: 10-year burn-in.
OUTPUT=$(npm run burnin -- \
  --seed=watchdog \
  --width=80 --height=80 \
  --cities=3 --towns=8 --villages=60 --hamlets=30 \
  --days=3650 --silent 2>&1)
EXIT_CODE=$?

if [ "$EXIT_CODE" -ne 0 ]; then
  block "burnin exited code $EXIT_CODE; output: $OUTPUT"
fi

# The CLI's silent mode emits a single one-line summary as the last line:
#   burnin done: day=3650 settlements=N→M pop=A→B caravans@end=X ... viol(fatal/error/warn)=F/E/W elapsedMs=T
LAST_LINE=$(printf '%s' "$OUTPUT" | tail -1)

POP_START=$(printf '%s' "$LAST_LINE" | grep -oE 'pop=[0-9]+→' | head -1 | sed -E 's/pop=([0-9]+)→/\1/')
POP_END=$(printf '%s' "$LAST_LINE" | grep -oE 'pop=[0-9]+→[0-9]+' | head -1 | sed -E 's/pop=[0-9]+→([0-9]+)/\1/')
FATAL=$(printf '%s' "$LAST_LINE" | grep -oE 'viol\([^)]*\)=[0-9]+' | head -1 | sed -E 's|viol\([^)]*\)=([0-9]+)|\1|')

if [ -z "$POP_START" ] || [ -z "$POP_END" ]; then
  block "could not parse burnin summary line: $LAST_LINE"
fi

if [ -n "$FATAL" ] && [ "$FATAL" -gt 0 ]; then
  block "burnin had $FATAL fatal invariant violation(s) over 10y on a 3-city world: $LAST_LINE"
fi

HALF_START=$(( POP_START / 2 ))
if [ "$POP_END" -lt "$HALF_START" ]; then
  block "burnin pop collapsed: end=$POP_END < 50% of start=$POP_START (threshold $HALF_START). full line: $LAST_LINE"
fi

# Stable enough — let Claude stop.
exit 0
