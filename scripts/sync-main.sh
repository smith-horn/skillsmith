#!/usr/bin/env bash
# scripts/sync-main.sh — Quiet main-branch sync for Claude Code sessions
# Suppresses git-crypt warnings and smudge filter noise (~5,000 → ~75 tokens)
#
# Usage: ./scripts/sync-main.sh [--discard-local-commits] [-h|--help]
#
# SMI-6465 / ADR-184: the main checkout is shared by every session, so this
# script only ever fast-forwards it. It never changes which branch HEAD names,
# never discards staged, unstaged, untracked or ignored files, and never drops
# local commits unless --discard-local-commits is passed. When it cannot sync
# safely it refuses with three lines on stderr:
#   sync-main: REFUSED [<token>]: <cause>
#   <whether anything was changed>
#   next: <one action>
#
# Exit codes: 0 synced; 1 refused (nothing local was changed); 2 usage;
#             3 stopped partway, or HEAD moved during the sync (read the message).

set -Eeuo pipefail
# An unexpected failure must not look like a refusal (exit 1) or a sync (exit 0).
trap 'printf "sync-main: ERROR: unexpected failure at line %s; inspect git status before rerunning\n" "$LINENO" >&2; exit 3' ERR

usage() {
  cat <<'EOF'
Usage: ./scripts/sync-main.sh [--discard-local-commits] [-h|--help]

Fast-forwards local main to origin/main in this checkout, keeping every
uncommitted change. Refuses (exit 1, nothing local changed) when:
  not-on-main / detached-head   HEAD is not main; it is never switched
  in-progress-op                a merge, rebase, am, cherry-pick, revert or bisect is in progress
  unsupported-state             sparse checkout
  overlap                       an uncommitted change touches a path origin/main changes
  untracked-collision           an untracked or ignored file sits at a path origin/main adds
  local-ahead / local-diverged  local main has commits not on origin/main
  staged-under-discard          --discard-local-commits with something staged
  keep-refused / ff-refused     git refused the move for another reason
  branch-changed-during-fetch   another session switched or moved main during the fetch
  fetch-failed                  git fetch origin main failed

--discard-local-commits  drop local main's own commits (reset --keep). This flag
                         does not save them; first run:
                         git branch save/main-<short> HEAD

Exit codes: 0 synced, 1 refused, 2 usage, 3 stopped partway or HEAD moved.
EOF
}

# State lines: whether anything local changed before the refusal.
STATE_PRE='Nothing was changed.'
STATE_POST='Nothing local was changed (origin/main was fetched).'

# refuse <token> <cause> <state> <next> [exit-code]
refuse() {
  printf 'sync-main: REFUSED [%s]: %s\n%s\nnext: %s\n' "$1" "$2" "$3" "$4" >&2
  exit "${5:-1}"
}

# Render up to 5 NUL-separated paths from a file as one line, each once.
# Newlines and tabs in a path are shown as \n and \t so it stays on one line.
render_paths() {
  local file=$1 out='' n=0 p s dup
  local seen=()
  while IFS= read -r -d '' p; do
    dup=0
    for s in ${seen[@]+"${seen[@]}"}; do [ "$s" != "$p" ] || dup=1; done
    [ "$dup" -eq 0 ] || continue
    seen+=("$p")
    n=$((n + 1))
    [ "$n" -le 5 ] || continue
    p=${p//$'\n'/\\n}
    p=${p//$'\t'/\\t}
    out="${out:+$out, }$p"
  done <"$file"
  [ "$n" -le 5 ] || out="$out (and $((n - 5)) more)"
  printf '%s' "$out"
}

# Count NUL-separated records in a file.
count_paths() {
  local n=0 p
  while IFS= read -r -d '' p; do n=$((n + 1)); done <"$1"
  printf '%s' "$n"
}

discard=0
for arg in "$@"; do
  case "$arg" in
    -h | --help)
      usage
      exit 0
      ;;
    --discard-local-commits) discard=1 ;;
    *) refuse usage "unknown argument '$arg'" "$STATE_PRE" './scripts/sync-main.sh --help' 2 ;;
  esac
done

tmp=$(mktemp -d "${TMPDIR:-/tmp}/sync-main.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# --- Change 1: never move HEAD off the branch it found --------------------
leave_it='work in a worktree (./scripts/create-worktree.sh)'
head_ref=$(git symbolic-ref -q HEAD 2>/dev/null) || head_ref=''
if [ -z "$head_ref" ]; then
  refuse detached-head "HEAD is detached at $(git rev-parse --short HEAD 2>/dev/null || echo unknown)" "$STATE_PRE" \
    "this checkout is detached, possibly by another session. Leave it as it is; $leave_it or ask the session that detached it"
fi
if [ "$head_ref" != refs/heads/main ]; then
  b=${head_ref#refs/heads/}
  refuse not-on-main "this checkout is on '$b', not main" "$STATE_PRE" \
    "this checkout is on '$b', which another session may be using. Leave it as it is; $leave_it or ask the session that owns '$b'"
fi

# Every path set below is repo-root-relative, so run from the top level.
cd "$(git rev-parse --show-toplevel)"

# --- Change 2: preconditions before the fetch -----------------------------
for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-apply rebase-merge sequencer BISECT_LOG; do
  if [ -e "$(git rev-parse --git-path "$marker")" ]; then
    case "$marker" in
      MERGE_HEAD) op=merge ;;
      CHERRY_PICK_HEAD) op=cherry-pick ;;
      REVERT_HEAD) op=revert ;;
      rebase-apply) op='rebase or am' ;;
      rebase-merge) op=rebase ;;
      sequencer) op='cherry-pick or revert sequence' ;;
      BISECT_LOG) op=bisect ;;
    esac
    refuse in-progress-op "a $op is in progress ($marker exists)" "$STATE_PRE" \
      "a $op is in progress here, possibly another session's; leave it and $leave_it"
  fi
done
if [ "$(git config --bool core.sparseCheckout 2>/dev/null || true)" = true ]; then
  refuse unsupported-state "core.sparseCheckout is true" "$STATE_PRE" \
    'sync-main does not support sparse checkouts; run git merge --ff-only origin/main yourself'
fi

# Submodules are synchronized independently below. Disable recursive fetching
# here so one inaccessible submodule cannot abort the parent fetch before the
# per-path fail-soft reporting has a chance to run.
if ! git fetch --no-recurse-submodules origin main >"$tmp/fetch.out" 2>&1; then
  reason=$(tr '\r' '\n' <"$tmp/fetch.out" | sed '/^[[:space:]]*$/d' | tail -n 1)
  refuse fetch-failed "git fetch origin main failed: ${reason:-no output}" "$STATE_PRE" \
    'check network and auth, then rerun'
fi
REMOTE=$(git rev-parse -q --verify 'refs/remotes/origin/main^{commit}' 2>/dev/null) ||
  refuse fetch-failed 'origin/main does not resolve after the fetch' "$STATE_PRE" 'check network and auth, then rerun'
LOCAL=$(git rev-parse HEAD)

# SMI-4212: Divergence summary — tell the user why local differs from
# origin/main, so they know whether local commits hold real work.
if [ "$LOCAL" != "$REMOTE" ]; then
  AHEAD=$(git rev-list --count "$REMOTE..$LOCAL" 2>/dev/null || echo 0)
  BEHIND=$(git rev-list --count "$LOCAL..$REMOTE" 2>/dev/null || echo 0)
  if [ "$AHEAD" -gt 0 ]; then
    echo "Local ahead by $AHEAD commit(s):"
    git log --oneline "$REMOTE..$LOCAL" 2>/dev/null | sed 's/^/  /' || true
    # Squash-merge heuristic: if a local commit's tree matches any of the last 50
    # origin commits, the content is already on main under a different SHA.
    RECENT_TREES=$(git log "$REMOTE" -n 50 --format='%T' 2>/dev/null || true)
    for sha in $(git rev-list "$REMOTE..$LOCAL" 2>/dev/null || true); do
      TREE=$(git rev-parse "$sha^{tree}" 2>/dev/null || true)
      if [ -n "$TREE" ] && echo "$RECENT_TREES" | grep -q "$TREE" 2>/dev/null; then
        echo "  └─ $sha matches a recent squash-merge on origin (content already on origin/main)"
      fi
    done || true
  fi
  if [ "$BEHIND" -gt 0 ]; then
    echo "Remote ahead by $BEHIND commit(s)"
  fi
fi

# --- Change 3: classify, then fast-forward or (opt-in) reset --keep -------
# is_ancestor <a> <b>: 0 yes, 1 no; any other git status is a failure, not "no".
is_ancestor() {
  local st=0
  git merge-base --is-ancestor "$1" "$2" || st=$?
  case "$st" in
    0 | 1) return "$st" ;;
    *)
      printf 'sync-main: ERROR: git merge-base --is-ancestor failed (exit %s); inspect git status before rerunning\n' "$st" >&2
      exit 3
      ;;
  esac
}

mode=none
if [ "$LOCAL" != "$REMOTE" ]; then
  if is_ancestor "$LOCAL" "$REMOTE"; then
    mode=ff
  else
    short=$(git rev-parse --short "$LOCAL")
    if is_ancestor "$REMOTE" "$LOCAL"; then
      token=local-ahead cause="local main has $AHEAD commit(s) not on origin/main"
    else
      token=local-diverged cause="local main and origin/main have diverged ($AHEAD local, $BEHIND upstream)"
    fi
    if [ "$discard" -ne 1 ]; then
      refuse "$token" "$cause" "$STATE_POST" \
        "save them: git branch save/main-$short HEAD; then, if they are not needed on main: ./scripts/sync-main.sh --discard-local-commits"
    fi
    mode=keep
  fi
fi

if [ "$mode" != none ]; then
  # Path sets, all NUL-separated in files (a shell variable cannot hold NUL).
  # Tokens come from these sets and git's exit status, never from git's prose.
  git diff -z --name-only --no-renames "$LOCAL" "$REMOTE" >"$tmp/incoming"
  git diff -z --name-only --no-renames --diff-filter=A "$LOCAL" "$REMOTE" >"$tmp/added"
  : >"$tmp/overlap"
  : >"$tmp/collide"
  : >"$tmp/fp-index.before"
  : >"$tmp/fp-wt.before"
  if [ -s "$tmp/incoming" ]; then
    # Tracked paths with a staged or unstaged change that origin/main also changes.
    xargs -0 git --literal-pathspecs diff -z --name-only --no-renames --cached -- <"$tmp/incoming" >>"$tmp/overlap"
    xargs -0 git --literal-pathspecs diff -z --name-only --no-renames --ignore-submodules=all -- <"$tmp/incoming" >>"$tmp/overlap"
    # Change 6 fingerprint: index entries and unstaged changes for incoming paths only.
    xargs -0 git --literal-pathspecs ls-files -z -s -- <"$tmp/incoming" >"$tmp/fp-index.before"
    xargs -0 git --literal-pathspecs diff -z --name-only --no-renames -- <"$tmp/incoming" >"$tmp/fp-wt.before"
  fi
  # Paths origin/main adds that already exist locally as untracked or ignored files.
  while IFS= read -r -d '' p; do
    if { [ -e "$p" ] || [ -L "$p" ]; } && [ -z "$(git --literal-pathspecs ls-files -- "$p")" ]; then
      printf '%s\0' "$p" >>"$tmp/collide"
    fi
  done <"$tmp/added"

  if [ "$mode" = keep ]; then
    # reset --keep drops staging and overwrites ignored files, so refuse both first.
    git diff -z --name-only --cached HEAD >"$tmp/staged"
    git diff -z --name-only --diff-filter=A >>"$tmp/staged" # intent-to-add
    if [ -s "$tmp/staged" ]; then
      refuse staged-under-discard "staged or intent-to-add: $(render_paths "$tmp/staged")" "$STATE_POST" \
        'commit or unstage first; --keep would drop the staging'
    fi
    if [ -s "$tmp/collide" ]; then
      refuse untracked-collision "origin/main adds $(render_paths "$tmp/collide"), which exist locally" "$STATE_POST" \
        'move the named path(s) aside, then rerun'
    fi
  fi

  # --- Change 4: re-check the branch immediately before moving ------------
  now_ref=$(git symbolic-ref -q HEAD 2>/dev/null) || now_ref=''
  if [ "$now_ref" != refs/heads/main ]; then
    refuse branch-changed-during-fetch "this checkout switched to '${now_ref:-detached HEAD}' during the fetch" "$STATE_POST" \
      'another session switched this checkout; rerun once it is back on main'
  fi
  if [ "$(git rev-parse HEAD)" != "$LOCAL" ]; then
    refuse branch-changed-during-fetch "main moved from ${LOCAL:0:12} to $(git rev-parse --short HEAD) during the fetch" "$STATE_POST" \
      'another session committed or moved main; rerun'
  fi

  # --- Change 5: no hook fires; neither move touches submodule checkouts ---
  move_status=0
  if [ "$mode" = ff ]; then
    git -c core.hooksPath=/dev/null merge --ff-only --no-autostash --no-overwrite-ignore -q "$REMOTE" \
      >"$tmp/move.out" 2>&1 || move_status=$?
  else
    git -c core.hooksPath=/dev/null reset --keep --no-recurse-submodules -q "$REMOTE" \
      >"$tmp/move.out" 2>&1 || move_status=$?
  fi
else
  move_status=0
fi

# --- Change 4 (after): did HEAD still name main when git moved it? --------
after_ref=$(git symbolic-ref -q HEAD 2>/dev/null) || after_ref=''
if [ "$after_ref" != refs/heads/main ]; then
  shown=${after_ref:-detached HEAD}
  if [ "$mode" = none ] || [ "$move_status" -ne 0 ]; then
    printf 'ERROR [branch-changed-after-sync]: this checkout switched to %s during the sync; this sync moved no ref.\n' "$shown" >&2
  elif [ "$(git rev-parse refs/heads/main)" = "$REMOTE" ]; then
    printf 'ERROR [branch-changed-after-sync]: main was synced to %s, then this checkout switched to %s.\n' "${REMOTE:0:12}" "$shown" >&2
  else
    # The displaced value comes from the moved ref's own reflog entry for this
    # move, never from ORIG_HEAD (any session can rewrite it) or LOCAL (the
    # switched-to ref need not have started at main's commit).
    if [ "$mode" = ff ]; then want="merge $REMOTE: Fast-forward"; else want="reset: moving to $REMOTE"; fi
    old='' i=0
    if [ -n "$after_ref" ]; then
      while IFS=' ' read -r sha subject; do
        if [ "$sha" = "$REMOTE" ] && [ "$subject" = "$want" ]; then
          old=$(git rev-parse -q --verify "$after_ref@{$((i + 1))}" 2>/dev/null) || old=''
          break
        fi
        i=$((i + 1))
      done < <(git log -g --format='%H %gs' "$after_ref" -- 2>/dev/null || true)
    fi
    printf 'ERROR [branch-changed-after-sync]: %s was moved %s→%s by this sync (HEAD switched before the move).\n' \
      "$shown" "${old:-<unknown: no reflog entry>}" "$REMOTE" >&2
    if [ -n "$old" ] && [ "$(git rev-parse -q --verify "$after_ref" 2>/dev/null)" = "$REMOTE" ]; then
      printf 'restore the ref (not the index or working tree): git update-ref %s %s %s\n' "$after_ref" "$old" "$REMOTE" >&2
    else
      printf '%s moved again; reconcile by hand (reflog: git reflog %s)\n' "$shown" "${after_ref:-HEAD}" >&2
    fi
  fi
  exit 3
fi

if [ "$move_status" -ne 0 ]; then
  # --- Change 6: did the failed move leave incoming paths half-written? ---
  : >"$tmp/fp-index.after"
  : >"$tmp/fp-wt.after"
  : >"$tmp/fp-named"
  if [ -s "$tmp/incoming" ]; then
    xargs -0 git --literal-pathspecs ls-files -z -s -- <"$tmp/incoming" >"$tmp/fp-index.after"
    xargs -0 git --literal-pathspecs diff -z --name-only --no-renames -- <"$tmp/incoming" >"$tmp/fp-wt.after"
    # Name index-only changes too: incoming paths now staged against HEAD.
    cat "$tmp/fp-wt.after" >"$tmp/fp-named"
    xargs -0 git --literal-pathspecs diff -z --name-only --no-renames --cached -- <"$tmp/incoming" >>"$tmp/fp-named"
  fi
  if ! cmp -s "$tmp/fp-index.before" "$tmp/fp-index.after" || ! cmp -s "$tmp/fp-wt.before" "$tmp/fp-wt.after"; then
    printf 'ERROR [partial-move]: these incoming paths changed during the attempted move (source unknown; a failing checkout filter such as git-crypt is one cause, another session'"'"'s edit is another): %s\n' \
      "$(render_paths "$tmp/fp-named")" >&2
    printf 'HEAD and main still point at %s; the working tree needs attention.\n' "${LOCAL:0:12}" >&2
    printf 'next: inspect git status before changing anything; if every path above is unedited by any session, git restore --worktree -- <path> undoes this sync'"'"'s writes\n' >&2
    exit 3
  fi
  if [ -s "$tmp/overlap" ]; then
    refuse overlap "uncommitted change(s) on path(s) origin/main changes: $(render_paths "$tmp/overlap")" "$STATE_POST" \
      'keep the edit: copy it out (git diff HEAD -- <path> > a file outside the repo) or redo it in a worktree. Discard it only if it is yours: git restore --worktree --staged -- <path>'
  fi
  if [ -s "$tmp/collide" ]; then
    refuse untracked-collision "origin/main adds $(render_paths "$tmp/collide"), which exist locally" "$STATE_POST" \
      'move the named path(s) aside, then rerun'
  fi
  if [ "$mode" = keep ]; then
    refuse keep-refused 'git reset --keep refused the move' "$STATE_POST" \
      'the paths above changed locally and upstream; resolve them, then rerun'
  fi
  refuse ff-refused 'git refused the fast-forward for a reason this script does not classify' "$STATE_POST" \
    'run git status and look for a change on a path origin/main touches, then rerun'
fi

# SMI-5823 Phase 2: keep every declared submodule checkout aligned with the
# gitlink recorded by the freshly-synced parent. Update paths independently so
# one inaccessible private remote does not hide successful updates elsewhere.
# Dirty initialized submodules are never passed to `submodule update`: even
# without --force, skipping explicitly makes the preservation contract clear.
submodule_mismatches=()
if [ -f .gitmodules ]; then
  repo_root=$(git rev-parse --show-toplevel)
  gitmodules="$repo_root/.gitmodules"
  while IFS= read -r submodule_path; do
    [ -n "$submodule_path" ] || continue

    expected_sha=$(git ls-tree HEAD -- "$submodule_path" 2>/dev/null | awk '{print $3}')
    [ -n "$expected_sha" ] || continue

    mismatch_reason=""
    if git -C "$submodule_path" rev-parse --is-inside-work-tree >/dev/null 2>&1 &&
      [ -n "$(git -C "$submodule_path" status --porcelain 2>/dev/null)" ]; then
      mismatch_reason="dirty worktree preserved"
    else
      git submodule update --init -- "$submodule_path" >/dev/null 2>&1 || {
        mismatch_reason="update failed"
      }
    fi

    actual_sha=$(git -C "$submodule_path" rev-parse HEAD 2>/dev/null || true)
    if [ "$actual_sha" != "$expected_sha" ]; then
      [ -n "$mismatch_reason" ] || mismatch_reason="checkout remains mismatched"
      submodule_mismatches+=(
        "$submodule_path|$mismatch_reason|${actual_sha:-unavailable}|$expected_sha"
      )
    fi
  done < <(
    (cd / && git config --file "$gitmodules" --get-regexp 'submodule\..*\.path' 2>/dev/null) |
      awk '{print $2}' || true
  )
fi

if [ "${#submodule_mismatches[@]}" -gt 0 ]; then
  echo "WARNING: Submodule sync incomplete:"
  for mismatch in "${submodule_mismatches[@]}"; do
    IFS='|' read -r path reason actual expected <<<"$mismatch"
    echo "  - $path: $reason (found ${actual:0:12}, expected ${expected:0:12})"
  done
  echo "Parent main is synced; resolve the named submodule path(s) and retry."
fi

# --- Change 7: report what was kept ---------------------------------------
# Tracked paths with staged or unstaged changes, once each; submodules are
# reported by the loop above, untracked files are not listed.
git --no-optional-locks status -z --porcelain=v1 --no-renames --untracked-files=no --ignore-submodules=all |
  while IFS= read -r -d '' rec; do printf '%s\0' "${rec:3}"; done >"$tmp/kept"
kept=$(count_paths "$tmp/kept")
if [ "$kept" -gt 0 ]; then
  echo "Kept $kept uncommitted change(s):"
  n=0
  while IFS= read -r -d '' p; do
    n=$((n + 1))
    [ "$n" -le 5 ] || break
    p=${p//$'\n'/\\n}
    p=${p//$'\t'/\\t}
    echo "  $p"
  done <"$tmp/kept"
  [ "$kept" -le 5 ] || echo "  ... and $((kept - 5)) more (git status --short)"
fi

# SMI-5548: cheap dist-staleness hint — NO build here, just a heads-up. If
# source moved while syncing, dist/ (built before the sync) likely no longer
# matches; the pre-commit/pre-push dist-freshness guards will catch it for
# real, but a hint right after sync saves the "why did the guard fire" step.
# Fail-soft: a git diff hiccup just skips the hint, never blocks the sync.
if [ "$LOCAL" != "$REMOTE" ]; then
  if git diff --name-only "$LOCAL..$REMOTE" 2>/dev/null | grep -q '^packages/[^/]*/src/'; then
    echo "ℹ️  Source changed on sync — dist may be stale; run: docker exec skillsmith-dev-1 npm run build"
  fi
fi

commit=$(git log --oneline -1)
echo "Synced to main: $commit"
