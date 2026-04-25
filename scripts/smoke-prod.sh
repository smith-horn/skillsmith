#!/usr/bin/env bash
# SMI-4459 — post-deploy smoke harness orchestrator.
#
# Usage:
#   scripts/smoke-prod.sh [--dry-run] [--surface=<id>] [--since=<git-ref>] [--report=<path>]
#
# --dry-run        Resolve surfaces from the changed-file set; print the plan;
#                  do NOT make network calls. Exit 0 on shape-valid plan.
# --surface=<id>   Run only the named surface (always-run canary still runs).
# --since=<ref>    Compute changed files via `git diff --name-only <ref> HEAD`.
#                  Defaults to HEAD~1 in CI; in dev, falls back to "all surfaces".
# --report=<path>  Write JSON report to this path. Defaults to /dev/null when
#                  not set; emit JSON to stdout if --json is passed.
# --json           Emit JSON report to stdout (suppresses table). Compatible
#                  with --report (writes both).
#
# Exit codes:
#   0 — all matched surfaces passed
#   1 — one or more failed
#   2 — opt-out via [skip-smoke] OR no surfaces matched
#
# Conventions: ASCII-only output, no `set -x`, 60s total budget enforced
# via foreground SECONDS check. Per-call HTTP timeouts in lib.sh.

set -euo pipefail

SMOKE_PROD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/smoke-prod"
# shellcheck disable=SC1091
. "$SMOKE_PROD_DIR/lib.sh"

DRY_RUN="${SMOKE_DRY_RUN:-0}"
SINGLE_SURFACE=""
SINCE_REF=""
REPORT_PATH=""
EMIT_JSON=0
SMOKE_BUDGET_SEC="${SMOKE_BUDGET_SEC:-60}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --surface=*) SINGLE_SURFACE="${1#*=}"; shift ;;
    --since=*) SINCE_REF="${1#*=}"; shift ;;
    --report=*) REPORT_PATH="${1#*=}"; shift ;;
    --json) EMIT_JSON=1; shift ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *)
      smoke_warn "unknown arg: $1"
      exit 2
      ;;
  esac
done

# ---- skip-smoke marker -------------------------------------------------
if [ -n "${SMOKE_PR_BODY:-}" ] && printf '%s' "$SMOKE_PR_BODY" | grep -q '\[skip-smoke\]'; then
  smoke_log "PR body contains [skip-smoke] — exit 2"
  exit 2
fi
if git log -1 --pretty=%B 2>/dev/null | grep -q '\[skip-smoke\]'; then
  smoke_log "merge commit contains [skip-smoke] — exit 2"
  exit 2
fi

# ---- load surfaces.json ------------------------------------------------
SURFACES_JSON="$SMOKE_PROD_DIR/surfaces.json"
if [ ! -f "$SURFACES_JSON" ]; then
  smoke_warn "surfaces.json missing at $SURFACES_JSON"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  smoke_warn "jq required but not installed"
  exit 1
fi

# ---- resolve changed-files set ----------------------------------------
CHANGED_FILES=""
if [ -n "${SMOKE_CHANGED_FILES:-}" ]; then
  CHANGED_FILES="$SMOKE_CHANGED_FILES"
elif [ -n "$SINCE_REF" ]; then
  if ! CHANGED_FILES=$(git diff --name-only "$SINCE_REF" HEAD 2>/dev/null); then
    smoke_warn "git diff $SINCE_REF..HEAD failed; defaulting to all surfaces"
    CHANGED_FILES=""
  fi
fi

# ---- match surfaces ----------------------------------------------------
# Bash glob matching against trigger_globs. `**` is treated as `*` here
# for simplicity — we expand each glob via shell extglob below. Surfaces
# with always_run=true match unconditionally.

# Bash 3.2 (macOS default) lacks globstar; we use case-pattern matching
# (see _glob_matches_any below) and convert `**` → `*` defensively. CI
# runners (ubuntu-latest) have bash 5.x but we keep the lowest-common-
# denominator surface so the harness is invokable from a dev box.
shopt -s extglob nullglob 2>/dev/null || true

_glob_matches_any() {
  # _glob_matches_any FILE GLOB1 [GLOB2 ...]
  # Returns 0 if FILE matches any GLOB; else 1.
  #
  # Glob semantics (lowest common denominator across bash 3.2 and 5.x):
  #   - `prefix/**` matches FILE iff FILE startswith `prefix/`
  #   - `prefix/*`  matches FILE iff FILE startswith `prefix/` AND has no further `/`
  #   - exact path matches iff FILE equals the glob
  # No support for inner `*` segments or `?` — surfaces.json sticks to
  # path-prefix patterns by convention. The R-4 audit-standards check
  # (Section 34) uses the same matcher to enforce coverage.
  local file="$1"; shift
  local g
  for g in "$@"; do
    case "$g" in
      *'/**')
        local prefix="${g%/**}"
        case "$file" in
          "$prefix"/*) return 0 ;;
          "$prefix") return 0 ;;
        esac
        ;;
      *'/*')
        local prefix="${g%/*}"
        # Match files directly under prefix/ (no deeper slashes).
        local rest="${file#"$prefix"/}"
        if [ "$rest" != "$file" ] && [ "${rest%%/*}" = "$rest" ]; then
          return 0
        fi
        ;;
      *)
        if [ "$file" = "$g" ]; then return 0; fi
        ;;
    esac
  done
  return 1
}

# Build the matched-surface set. Output: one surface ID per line.
_select_surfaces() {
  local n
  n=$(jq -r '.surfaces | length' "$SURFACES_JSON")
  local i=0
  while [ "$i" -lt "$n" ]; do
    local id always trigger_count
    id=$(jq -r ".surfaces[$i].id" "$SURFACES_JSON")
    always=$(jq -r ".surfaces[$i].always_run // false" "$SURFACES_JSON")
    if [ -n "$SINGLE_SURFACE" ]; then
      if [ "$id" = "$SINGLE_SURFACE" ] || [ "$always" = "true" ]; then
        printf '%s\n' "$id"
      fi
      i=$((i + 1))
      continue
    fi
    if [ "$always" = "true" ]; then
      printf '%s\n' "$id"
      i=$((i + 1))
      continue
    fi
    if [ -z "$CHANGED_FILES" ]; then
      # No `--since`/CHANGED_FILES — full-smoke mode (manual run).
      printf '%s\n' "$id"
      i=$((i + 1))
      continue
    fi
    trigger_count=$(jq -r ".surfaces[$i].trigger_globs | length" "$SURFACES_JSON")
    local globs=()
    local j=0
    while [ "$j" -lt "$trigger_count" ]; do
      globs+=("$(jq -r ".surfaces[$i].trigger_globs[$j]" "$SURFACES_JSON")")
      j=$((j + 1))
    done
    local matched=0
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      if _glob_matches_any "$f" "${globs[@]}"; then
        matched=1
        break
      fi
    done <<< "$CHANGED_FILES"
    if [ "$matched" = "1" ]; then
      printf '%s\n' "$id"
    fi
    i=$((i + 1))
  done
}

MATCHED=$(_select_surfaces | sort -u)

if [ -z "$MATCHED" ]; then
  smoke_log "no surfaces matched — exit 2"
  exit 2
fi

smoke_log "matched surfaces: $(printf '%s' "$MATCHED" | tr '\n' ' ')"

# ---- dry-run: print plan, validate JSON shape, exit ------------------
if [ "$DRY_RUN" = "1" ]; then
  smoke_log "DRY RUN — no network calls"
  PLAN=$(printf '%s\n' "$MATCHED" | jq -R . | jq -sc '{dry_run: true, matched_surfaces: .}')
  if [ "$EMIT_JSON" = "1" ]; then
    printf '%s\n' "$PLAN"
  fi
  if [ -n "$REPORT_PATH" ]; then
    printf '%s\n' "$PLAN" > "$REPORT_PATH"
  fi
  exit 0
fi

# ---- run checks -------------------------------------------------------
START_EPOCH=$(date +%s)
SECONDS=0

while IFS= read -r surface_id; do
  [ -z "$surface_id" ] && continue
  if [ "$SECONDS" -ge "$SMOKE_BUDGET_SEC" ]; then
    smoke_warn "60s budget exceeded — aborting remaining surfaces"
    SMOKE_FAIL_COUNT=$((SMOKE_FAIL_COUNT + 1))
    break
  fi
  script_rel=$(jq -r --arg id "$surface_id" '.surfaces[] | select(.id == $id) | .script' "$SURFACES_JSON")
  if [ -z "$script_rel" ] || [ "$script_rel" = "null" ]; then
    smoke_warn "surface $surface_id has no script"
    continue
  fi
  script_abs="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../$script_rel"
  # Resolve the path relative to repo root. ${BASH_SOURCE[0]} is .../scripts/smoke-prod.sh,
  # so its dirname is .../scripts, and ../scripts/smoke-prod/<file> normalizes correctly.
  script_abs=$(cd "$(dirname "$script_abs")" 2>/dev/null && pwd)/$(basename "$script_abs") || true
  if [ ! -f "$script_abs" ]; then
    smoke_warn "surface $surface_id script not found: $script_rel"
    continue
  fi
  # shellcheck disable=SC1090
  . "$script_abs"
  # Run each declared check function. We use process substitution + a
  # while-read in the parent shell so SMOKE_RESULTS_JSON / counters
  # accumulate (a `jq | while` pipeline forks the loop into a subshell
  # and loses state — the orchestrator's report aggregation depends on
  # parent-shell side effects in lib.sh).
  while IFS= read -r fn; do
    if [ -z "$fn" ]; then continue; fi
    if ! command -v "$fn" >/dev/null 2>&1 && ! declare -f "$fn" >/dev/null 2>&1; then
      smoke_warn "check function not defined: $fn (surface $surface_id)"
      continue
    fi
    "$fn" || true
  done < <(jq -r --arg id "$surface_id" '.surfaces[] | select(.id == $id) | .checks[]' "$SURFACES_JSON")
done <<< "$MATCHED"

# ---- emit report ------------------------------------------------------
DURATION_MS=$(( SECONDS * 1000 ))
SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
REPORT_JSON=$(jq -nc \
  --arg sha "$SHA" \
  --arg started "$(date -u -r "$START_EPOCH" +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --argjson duration "$DURATION_MS" \
  --argjson pass "$SMOKE_PASS_COUNT" \
  --argjson fail "$SMOKE_FAIL_COUNT" \
  --argjson results "[${SMOKE_RESULTS_JSON}]" \
  '{smoke_run_id: $sha, started_at: $started, duration_ms: $duration, pass: $pass, fail: $fail, results: $results}')

if [ "$EMIT_JSON" = "1" ]; then
  printf '%s\n' "$REPORT_JSON"
fi
if [ -n "$REPORT_PATH" ]; then
  printf '%s\n' "$REPORT_JSON" > "$REPORT_PATH"
fi

if [ "$SMOKE_FAIL_COUNT" -gt 0 ]; then
  smoke_log "smoke complete: pass=$SMOKE_PASS_COUNT fail=$SMOKE_FAIL_COUNT duration=${DURATION_MS}ms"
  exit 1
fi
smoke_log "smoke complete: pass=$SMOKE_PASS_COUNT fail=0 duration=${DURATION_MS}ms"
exit 0
