#!/usr/bin/env bash
# SMI-5419 W0.1 — shell mirror of the canonical encoded-project-dir resolver
# (packages/doc-retrieval-mcp/src/retrieval-log/project-dir.ts).
#
# Why a third mirror: the diagnostic + hook shell paths must keep working in the
# exact dead-node / dead-binding state that hid the original 6-week telemetry
# outage, so they cannot shell out to the TS/mjs resolver. This file MUST stay
# behaviour-equivalent to project-dir.ts and project-dir.mjs; the cross-runtime
# parity test (scripts/tests/project-dir-parity.test.ts) feeds all three the same
# inputs and asserts identical (state, encoded) output.
#
# Invariants (see project-dir.ts for the full rationale):
#   - The bug is the INPUT path's casing, never the encoding; we never DECODE an
#     on-disk name (dash->slash is ambiguous), only match on the encoded form.
#   - The SHARED dir keys on the MAIN repo root so all worktrees of one project
#     resolve to one dir (NOT CLAUDE_PROJECT_DIR, which shards it per worktree).
#
# Portability: bash 3.2 (stock macOS) — no associative arrays, no `mapfile`.
#
# Source it and call the functions, or run as a CLI (used by the parity test):
#   bash project-dir.sh reconcile <computed-encoded-name>   -> "<state>\t<encoded>"
#   bash project-dir.sh resolve-shared <cwd>                -> "<state>\t<encoded>"

claude_projects_root() { printf '%s' "${HOME}/.claude/projects"; }

# Replace every '/' with '-' (matches encodeProjectSegment in project-dir.ts).
encode_project_segment() { printf '%s' "${1//\//-}"; }

# ASCII-only lowercase fold (A-Z only), matching asciiFold(). LC_ALL=C makes tr
# map bytes A-Z->a-z without locale rules, and no UTF-8 multibyte byte ever falls
# in 0x41-0x5A, so non-ASCII (e.g. Turkish dotless-i, Æ) passes through unchanged
# — exactly like the JS /[A-Z]/ replacement.
ascii_fold() { printf '%s' "$1" | LC_ALL=C tr 'A-Z' 'a-z'; }

# Walk up for the first ancestor whose .git is a DIRECTORY (worktrees have .git
# as a file). Echoes the path and returns 0, or returns 1 before filesystem root.
#
# Unlike project-dir.ts (which calls path.resolve first), this assumes an already
# absolute, lexically-normalized input — every caller derives it via `cd && pwd`
# or `git rev-parse --show-toplevel`, so there is no relative/`..` form to resolve.
# We deliberately do NOT use realpath here (it resolves symlinks; see project-dir.ts).
find_main_repo_root() {
  local current parent depth
  current="$1"
  depth=0
  while [ "$depth" -lt 64 ]; do
    if [ -d "$current/.git" ]; then
      printf '%s' "$current"
      return 0
    fi
    parent="$(dirname "$current")"
    if [ "$parent" = "$current" ]; then
      return 1
    fi
    current="$parent"
    depth=$((depth + 1))
  done
  return 1
}

# Reconcile a computed encoded name against the filesystem WITHOUT decoding.
# Echoes "<state>\t<encoded>" (no trailing newline). State order mirrors
# reconcileEncodedDir: exact -> reconciled -> anchored -> ambiguous -> miss.
reconcile_encoded_dir() {
  local computed root entry name folded_computed folded_name clen prefix
  computed="$1"
  root="$(claude_projects_root)"

  # 1. exact — the computed name exists verbatim (file or dir, matches existsSync).
  if [ -e "$root/$computed" ]; then
    printf '%s\t%s' "exact" "$computed"
    return 0
  fi
  if [ ! -d "$root" ]; then
    printf '%s\t%s' "miss" "$computed"
    return 0
  fi

  folded_computed="$(ascii_fold "$computed")"
  clen=${#computed}

  # 2. reconciled — exactly one entry equals computed under ASCII fold.
  local full=()
  for entry in "$root"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue # incl. broken symlinks (readdirSync parity)
    name="${entry##*/}"
    if [ "$(ascii_fold "$name")" = "$folded_computed" ]; then
      full+=("$name")
    fi
  done
  if [ "${#full[@]}" -eq 1 ]; then
    printf '%s\t%s' "reconciled" "${full[0]}"
    return 0
  fi
  if [ "${#full[@]}" -gt 1 ]; then
    printf '%s\t%s' "ambiguous" "$computed"
    return 0
  fi

  # 3. anchored — a descendant entry's length-bounded prefix supplies the casing.
  prefix="${folded_computed}-"
  local anchors=()
  for entry in "$root"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue # incl. broken symlinks (readdirSync parity)
    name="${entry##*/}"
    folded_name="$(ascii_fold "$name")"
    case "$folded_name" in
      "$prefix"*) anchors+=("${name:0:clen}") ;;
    esac
  done
  if [ "${#anchors[@]}" -gt 0 ]; then
    # Dedupe without associative arrays (bash 3.2): sort -u into an indexed array.
    local uniq=() line
    while IFS= read -r line; do
      [ -n "$line" ] && uniq+=("$line")
    done < <(printf '%s\n' "${anchors[@]}" | sort -u)
    if [ "${#uniq[@]}" -eq 1 ]; then
      printf '%s\t%s' "anchored" "${uniq[0]}"
      return 0
    fi
    if [ "${#uniq[@]}" -gt 1 ]; then
      printf '%s\t%s' "ambiguous" "$computed"
      return 0
    fi
  fi

  printf '%s\t%s' "miss" "$computed"
}

# SHARED dir keyed on the main repo root (telemetry DB + /memory corpus).
# Echoes "<state>\t<encoded>".
resolve_shared_project_dir() {
  local cwd root
  cwd="${1:-$PWD}"
  root="$(find_main_repo_root "$cwd" 2>/dev/null || printf '%s' "$cwd")"
  reconcile_encoded_dir "$(encode_project_segment "$root")"
}

# CLI dispatch only when executed directly (not when sourced).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-}" in
    reconcile) reconcile_encoded_dir "${2:-}" ;;
    resolve-shared) resolve_shared_project_dir "${2:-$PWD}" ;;
    *)
      echo "usage: project-dir.sh {reconcile <computed>|resolve-shared <cwd>}" >&2
      exit 2
      ;;
  esac
fi
