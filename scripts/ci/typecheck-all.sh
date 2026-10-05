#!/usr/bin/env bash
# SMI-6975 — the root typecheck orchestrator.
#
# WHY THIS EXISTS, AND WHY IT IS NOT `a && b`
#
# Before SMI-6975, `npm run typecheck` was exactly `tsc --build`, which walks
# root tsconfig.json's four project references and nothing else. All 677 .ts
# files under scripts/ were outside the graph, so a type error there exited 0.
#
# Worse than missing them, the gate ANSWERED about them: .husky/pre-commit
# detects non-package changes, escalates, and prints "TypeScript check passed
# (full)" — a success claim over files tsc --build structurally cannot read.
# A wrong instrument does not fail; it answers.
#
# The first draft of the plan wired this as:
#     tsc --build && bash scripts/ci/typecheck-scripts.sh
# Cross-family review rejected it (finding 8) and was right: `&&` short-circuits,
# so a package failure means the scripts gate never runs AND its absence is
# invisible in the output. "full" would have become conditional on the first
# check passing — the same misleading green, one layer along.
#
# So: run BOTH, always. Keep both statuses. Print both. Fail if either failed.
#
# POSIX note: a pipeline's exit status is its LAST command's, so every status
# here is captured immediately from the producer and never read through a pipe.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

printf '\n[typecheck] SMI-6975 — two checks, both always run\n\n'

# ---- 1. the four referenced packages -------------------------------------
printf '  [1/2] packages (tsc --build, root tsconfig.json references)\n'
npx tsc --build
PKG_STATUS=$?

# ---- 2. non-test scripts/ ------------------------------------------------
printf '\n  [2/2] scripts (tsconfig.scripts.json, non-test)\n'
bash scripts/ci/typecheck-scripts.sh
SCRIPTS_STATUS=$?

# ---- summary -------------------------------------------------------------
# Two rows, never one number. A single combined verdict would hide which half
# ran, which is the thing this whole issue is about.
pkg_word()     { [ "$1" -eq 0 ] && printf 'PASS' || printf 'FAIL'; }

printf '\n[typecheck] summary\n'
printf '  packages  %s (exit %d)\n' "$(pkg_word "$PKG_STATUS")"     "$PKG_STATUS"
printf '  scripts   %s (exit %d)\n' "$(pkg_word "$SCRIPTS_STATUS")" "$SCRIPTS_STATUS"

if [ "$PKG_STATUS" -ne 0 ] || [ "$SCRIPTS_STATUS" -ne 0 ]; then
  printf '\n[typecheck] FAILED — see the failing half above.\n'
  printf '            Both halves ran; neither result is inferred from the other.\n\n'
  exit 1
fi

printf '\n[typecheck] PASS — packages and non-test scripts both checked.\n'
printf '            NOT covered: scripts/tests/** (SMI-7006), .mjs/.cjs (SMI-6922),\n'
printf '            computed dynamic import() targets. See scripts/ci/typecheck-scripts.sh.\n\n'
exit 0
