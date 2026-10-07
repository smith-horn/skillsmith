#!/bin/sh
# git-crypt-lock.sh -- SMI-5983's git-crypt filter lock, extracted from
# .husky/pre-commit by SMI-6973.
#
# POSIX sh, not bash: the only consumer is `.husky/pre-commit`, which husky
# invokes as `sh -e` (.husky/_/h:17), so no `local`, no `[[ ]]`, no
# BASH_SOURCE. Uses the SAME lock directory path that scripts/_lib.sh's bash
# `acquire_git_crypt_filter_lock()` computes, so both sides genuinely contend
# on one lock -- and because that path comes from `git rev-parse
# --git-common-dir`, the lock is shared across the main checkout AND every
# worktree. A leak wedges all of them.
#
# No automatic reclaim: an ABA race in an `mv`-to-tombstone reclaim was found
# and rejected during SMI-5983's design review. It fails closed with a manual
# unstick message instead.
#
# WHY THIS IS A SOURCED FILE AND NOT PURE FUNCTION DEFINITIONS. Unlike
# scripts/lib/preserve-gitlinks.sh, this file has two top-level assignments and
# its functions MUTATE globals the caller reads afterwards -- every
# `_release_git_crypt_lock` call site in the hook depends on
# GIT_CRYPT_LOCK_HELD surviving the function's return in the caller's own
# shell. Therefore:
#
#   - SOURCE it (`. "$LIB"`), never execute it;
#   - never wrap the source or an acquisition in a subshell;
#   - GIT_CRYPT_LOCK_DIR and GIT_CRYPT_LOCK_HELD must stay GLOBAL;
#   - source it only AFTER RED/NC are defined -- the busy message uses them.
#
# ONE DELIBERATE DEVIATION from the inline original, and the reason matters.
# Inline, this code could only ever run once per hook invocation, so
# `GIT_CRYPT_LOCK_HELD=""` was unconditionally safe. As a sourced file it CAN
# be sourced twice (a caller added later, a test harness sourcing it per
# case), and an unconditional reset would then erase live ownership: the flag
# would say "no lock held" while the directory was still on disk and owned by
# this pid, so `_release_git_crypt_lock` would short-circuit and leak it. The
# initialisation below preserves an existing value instead. That hazard is
# CREATED by the extraction, so handling it is part of extracting correctly
# rather than a separate improvement.
#
# shellcheck shell=sh

GIT_CRYPT_LOCK_DIR="$(git rev-parse --git-common-dir 2>/dev/null)/skillsmith-git-crypt-filter.lock"
# See the "ONE DELIBERATE DEVIATION" note above: preserve, do not reset.
GIT_CRYPT_LOCK_HELD="${GIT_CRYPT_LOCK_HELD-}"
_acquire_git_crypt_lock() {
  _wait_i=0
  while [ "$_wait_i" -lt 50 ]; do
    if mkdir "$GIT_CRYPT_LOCK_DIR" 2>/dev/null; then
      echo "$$" > "$GIT_CRYPT_LOCK_DIR/pid" 2>/dev/null
      GIT_CRYPT_LOCK_HELD=1
      # SMI-5983 (governance retro): self-release on a signal landing
      # between acquire and the caller's own explicit release below --
      # without this, unlike the bash-side
      # acquire_git_crypt_filter_lock() (scripts/_lib.sh), which arms an
      # equivalent trap at acquire time, an ordinary SIGINT/SIGTERM
      # during the disabled-precheck/restore-definition spans left this
      # repo-shared lock dangling forever (no auto-reclaim by design),
      # hard-failing every OTHER worktree's git-crypt filter operation
      # with the "never auto-reclaims" message below until a human ran
      # the printed `rmdir` -- confirmed via direct reproduction
      # (`kill -TERM` mid-lock-hold leaves the lock dir on disk).
      # INT/TERM only, deliberately NOT EXIT: every code path between
      # this acquire and the caller's own explicit release is
      # deterministic, signal-free control flow (the disabled-precheck
      # span always either hard-fails via an explicit release+exit, or
      # falls straight through into the restore-definition span, which
      # always releases explicitly on both its branches) -- there is no
      # plain/error exit in that window for an EXIT trap to guard
      # against, and arming one anyway would release the lock on ANY
      # process exit reachable from inside this function, including a
      # test harness or a future caller that intentionally checks
      # intermediate lock state before the real hook continues past this
      # point (confirmed by exactly this regression when EXIT was
      # included in an earlier draft of this fix -- see
      # scripts/tests/git-crypt-pre-commit-disable.test.ts's "proceeds
      # past the precheck" test). Plain (non-composing) registration is
      # correct here: this is the first `trap` call anywhere in this
      # hook, so there is no prior handler to preserve.
      # `_release_git_crypt_lock` is idempotent (a no-op once
      # GIT_CRYPT_LOCK_HELD is cleared), so this trap firing again later
      # -- after the caller's own explicit release (the hard-fail
      # branch, or the disable sequence's release-before-bigger-trap-
      # arm), after the bigger
      # `trap '_restore_smudge_filter' EXIT INT TERM` below overwrites
      # it outright, or from the re-acquire inside
      # _restore_smudge_filter() itself -- is always harmless; it only
      # ever protects the lock's own cleanup, never the filter VALUES
      # (which the marker + two-signal heal mechanism protects
      # regardless).
      trap '_release_git_crypt_lock' INT TERM
      return 0
    fi
    _wait_i=$((_wait_i + 1))
    sleep 0.2
  done
  _holder_pid=$(cat "$GIT_CRYPT_LOCK_DIR/pid" 2>/dev/null)
  echo "${RED}git-crypt filter lock busy after 10s (holder PID: ${_holder_pid:-unknown}).${NC}" >&2
  echo "  This lock never auto-reclaims. Confirm via 'ps' that the holder is gone, then:" >&2
  echo "    rmdir \"$GIT_CRYPT_LOCK_DIR\"" >&2
  echo "  and retry the commit." >&2
  exit 1
}
_release_git_crypt_lock() {
  [ -n "$GIT_CRYPT_LOCK_HELD" ] || return 0
  _owner=$(cat "$GIT_CRYPT_LOCK_DIR/pid" 2>/dev/null)
  [ "$_owner" = "$$" ] && rm -rf "$GIT_CRYPT_LOCK_DIR" 2>/dev/null
  GIT_CRYPT_LOCK_HELD=""
}
