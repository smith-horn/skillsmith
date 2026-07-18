#!/bin/sh
# SMI-5713: Protect staged submodule gitlinks (mode 160000) from being
# silently clobbered by .husky/pre-commit's post-lint-staged blind re-add.
# `git add <submodule-path>` stages the working-tree checkout's commit, NOT
# the previously staged SHA — a pointer staged via `git update-index
# --cacheinfo` (e.g. a docs/internal bump to an upstream commit not checked
# out locally) would otherwise be silently overwritten.

# Prints "<new-sha> <path>" (one per line) for every staged mode-160000
# entry in the current diff-cached. Call BEFORE anything mutates the index
# (same snapshot point as pre-commit's own STAGED_FILES capture, line 197).
capture_staged_gitlinks() {
  git diff --cached --raw --no-abbrev --no-renames --diff-filter=d \
    | while read -r _old_mode new_mode _old_sha new_sha _status path; do
        if [ "$new_mode" = "160000" ]; then
          printf '%s %s\n' "$new_sha" "$path"
        fi
      done
}

# Re-applies a capture_staged_gitlinks snapshot (passed as $1) via
# `git update-index --cacheinfo`, overwriting whatever a blind `git add`
# staged for that path in the meantime. Idempotent — a no-op if the path
# was never actually clobbered. On a `git update-index` failure for a given
# path, prints a diagnostic to stderr so a rare soft-failure is diagnosable
# rather than silently wrong; does not abort the remaining entries (matches
# the hook's no-`set -e` philosophy).
restore_staged_gitlinks() {
  snapshot="$1"
  [ -n "$snapshot" ] || return 0
  printf '%s\n' "$snapshot" | while read -r sha path; do
    if ! git update-index --cacheinfo 160000 "$sha" "$path" 2>/dev/null; then
      echo "⚠️  SMI-5713: could not restore gitlink $path to $sha — check its staged state before pushing" >&2
    fi
  done
}
