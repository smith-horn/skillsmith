#!/usr/bin/env bash
# resolve-supabase-cli.sh -- pick the Supabase CLI that matches the package.json pin (SMI-7223).
#
# Source this file, then call:
#   resolve_supabase_cli <repo-root>
# On success it sets the array SUPABASE_CLI and returns 0. Run the CLI as
#   "${SUPABASE_CLI[@]}" functions deploy ...
# On failure it prints why to stderr, leaves SUPABASE_CLI empty, and returns 1.
#
# Why: `npx supabase` with no local package downloads registry-latest and
# ignores any pinned binary on PATH. On 2026-11-16 that pulled CLI 3.1.0 into
# the deploy job and every edge-function deploy failed. This helper never
# downloads anything.
#
# Candidates, first match wins:
#   1. <repo-root>/node_modules/.bin/supabase  (a host checkout, pinned by the lockfile)
#   2. `supabase` on PATH                       (CI, installed by supabase/setup-cli)
# A candidate matches only when `--version` exits 0 and its stdout is exactly
# the pin plus one newline. stderr (update notices) is ignored. This stops
# accidental version drift; it does not defend against a deliberately
# substituted binary, which anyone able to edit the runner's PATH could plant.
#
# No opt-out variable by design: the remedy for a mismatch is to change the
# pin or install the pinned CLI.

resolve_supabase_cli() {
  local repo_root="${1:?resolve_supabase_cli: repo root required}"
  # shellcheck disable=SC2034  # read by the script that sourced this file
  SUPABASE_CLI=()

  local pin
  if ! pin="$(node -p "require(process.argv[1]).devDependencies?.supabase ?? ''" "$repo_root/package.json" 2>/dev/null)"; then
    echo "ERROR: could not read devDependencies.supabase from $repo_root/package.json" >&2
    return 1
  fi
  if ! [[ "$pin" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: package.json devDependencies.supabase is '$pin', not an exact X.Y.Z pin" >&2
    return 1
  fi

  local candidates=()
  local local_bin="$repo_root/node_modules/.bin/supabase"
  if [[ -x "$local_bin" ]]; then
    candidates+=("$local_bin")
  fi
  local path_bin
  path_bin="$(command -v supabase 2>/dev/null || true)"
  if [[ -n "$path_bin" ]]; then
    if [[ ${#candidates[@]} -eq 0 ]] || [[ "$(_rsc_realpath "$path_bin")" != "$(_rsc_realpath "${candidates[0]}")" ]]; then
      candidates+=("$path_bin")
    fi
  fi
  if [[ ${#candidates[@]} -eq 0 ]]; then
    echo "ERROR: no Supabase CLI found (looked at $local_bin and PATH); expected version $pin" >&2
    return 1
  fi

  local notes=() c out rc
  for c in "${candidates[@]}"; do
    # $(...) strips trailing newlines, so compare a sentinel-terminated copy
    # to require exactly one trailing newline and nothing else.
    # `|| rc=$?` keeps a caller's `set -e` from aborting on a failing candidate.
    rc=0
    out="$("$c" --version 2>/dev/null; r=$?; printf 'x'; exit "$r")" || rc=$?
    if [[ $rc -eq 0 && "$out" == "$pin"$'\n'x ]]; then
      # shellcheck disable=SC2034  # read by the script that sourced this file
      SUPABASE_CLI=("$c")
      echo "Supabase CLI: $c -> $(_rsc_realpath "$c") ($pin)"
      return 0
    fi
    out="${out%x}"
    notes+=("$c: exit $rc, stdout '$(printf '%s' "${out:0:40}" | tr '\n' ' ')'")
  done

  echo "ERROR: no Supabase CLI matches the package.json pin $pin:" >&2
  local n
  for n in "${notes[@]}"; do
    echo "  - $n" >&2
  done
  echo "Install CLI $pin (npm ci on a host; supabase/setup-cli in CI), or change the pin." >&2
  return 1
}

# Portable realpath: macOS ships no GNU realpath by default, so use node.
_rsc_realpath() {
  node -e 'try{process.stdout.write(require("fs").realpathSync(process.argv[1]))}catch{process.stdout.write(process.argv[1])}' "$1"
}
