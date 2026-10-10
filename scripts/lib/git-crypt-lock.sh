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
#   - GIT_CRYPT_LOCK_HELD is PRIVATE to this file: a caller must never assign,
#     export or pre-seed it. Its value means "this shell's own mkdir took the
#     lock" only because nothing else writes it -- a caller that sets it to $$
#     before sourcing looks exactly like a re-source and would be trusted;
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
# CALLER ORDERING (moved from .husky/pre-commit, SMI-5983 governance follow-up).
# The hook releases the disable sequence's lock BEFORE arming its own restore
# trap. The original SMI-2747 order was "arm trap, disable+write, release", but
# the restore function itself calls `_acquire_git_crypt_lock`, which is not
# reentrant: arming it while this instance still held the lock meant a signal
# landing during the two `git config` writes or the marker write made the trap
# spin against its OWN lock for the whole wait window and then hard-exit, with
# filters left disabled and the restore never run. The marker protects the
# write window (a dead-PID marker with no active rebase is what the auto-heal
# keys on); the lock protects the mutation.
#
# SMI-6973 F1 adds the missing half of that split: BEFORE the first disabling
# write the caller sets GIT_CRYPT_LOCK_OUTER_TRAP to its restore function, so an
# errexit abort or signal in the window before its own trap is armed still
# releases the lock AND restores the filters (otherwise the handler released
# the lock and left the filters disabled, with no marker for the auto-heal).
#
# TRAP OWNERSHIP. `_git_crypt_lock_arm` REPLACES any EXIT/INT/TERM trap the
# caller installed, on every acquire attempt. A caller with its own cleanup must
# therefore chain it through GIT_CRYPT_LOCK_OUTER_TRAP (a function name or shell
# text), which a handler runs once per invocation, after the first lock release,
# and clears before running so it cannot re-enter itself. The lock RELEASE is
# attempted again afterwards, and a cleanup that re-names itself in the variable
# (the hook's restore does) can run again from a later handler. Do not assume a
# trap set earlier survives an acquisition.
#
# shellcheck shell=sh

GIT_CRYPT_LOCK_DIR="$(git rev-parse --git-common-dir 2>/dev/null)/skillsmith-git-crypt-filter.lock"
# See the "ONE DELIBERATE DEVIATION" note above: preserve, do not reset --
# but only a shell-local value naming THIS shell. HELD holds the pid of the
# shell whose own mkdir took the lock (SMI-6973 round 4). A value naming any
# other process cannot be that, and trusting it let release delete, and
# acquire adopt, a foreign lock caught in its mkdir-to-pid-write window.
#
# Round 5: equality with $$ is not enough on its own. `exec` keeps the pid, so
# a parent can export HELD=<the pid the hook will run as> and hand over a value
# that equals $$ without this shell ever running mkdir. Only an EXPORTED value
# can cross an exec, and this file never exports HELD, so an exported HELD is
# discarded. `unset` (not `=""`) also drops the export attribute; otherwise our
# own later HELD=$$ would ride it into every child and a re-source would then
# discard live ownership. That holds while allexport is off: under `set -a`
# every assignment is exported again, so a re-source would discard live
# ownership and leak the lock (the hook never enables it). Re-sourcing in the
# same shell keeps a live, unexported value, which is what the deviation
# protects.
#
# This check establishes "shell-local and equal to $$", not "set by our own
# mkdir". Three cases pass it without that mkdir, all outside the contract
# (header): a caller that pre-seeds HELD=$$; a SUBSHELL of the holding shell,
# which shares its $$ and HELD; and an operator's manual rmdir followed by
# another holder's mkdir, which replaces the directory under us (the busy
# message gates rmdir on the holder being gone).
if [ "${GIT_CRYPT_LOCK_HELD-}" != "$$" ] ||
  export -p | grep -Eq '^(export|declare -x) GIT_CRYPT_LOCK_HELD(=|$)'; then
  unset GIT_CRYPT_LOCK_HELD
  GIT_CRYPT_LOCK_HELD=""
fi
# A caller that owns its own cleanup (the hook's _restore_smudge_filter) names
# it here, so the lock's traps CHAIN to it instead of replacing it. Cleared
# when run, so a handler can never re-enter itself.
GIT_CRYPT_LOCK_OUTER_TRAP="${GIT_CRYPT_LOCK_OUTER_TRAP-}"

# SMI-6973 (cross-family review, H1/H3). THE INVARIANT: from the instant
# `mkdir` succeeds until release, EVERY exit path -- plain exit, an errexit
# abort, INT, TERM -- releases a lock this process owns, and the caller's own
# cleanup (GIT_CRYPT_LOCK_OUTER_TRAP) still runs.
#
# Why EXIT is armed now: the earlier claim here that the held interval has "no
# plain/error exit" was false. Husky runs hooks as `sh -e`, and a failing
# command inside an `if` BODY (git config, a command substitution, the marker
# write) aborts the shell, which skipped the explicit release.
#
# Handlers do `set +e` first: they run while the shell is already dying, and
# one failing cleanup step must not skip the release that follows it.
_git_crypt_lock_run_outer() {
  _gcl_outer="$GIT_CRYPT_LOCK_OUTER_TRAP"
  GIT_CRYPT_LOCK_OUTER_TRAP=""
  if [ -n "$_gcl_outer" ]; then
    eval "$_gcl_outer"
  fi
}
_git_crypt_lock_on_exit() {
  _gcl_status=$?
  set +e
  _release_git_crypt_lock
  # R4: a failed cleanup step is never reported as success. A shell's exit
  # status survives an EXIT trap unless the trap calls `exit`, so say it so.
  _git_crypt_lock_run_outer || { [ "$_gcl_status" -ne 0 ] || _gcl_status=1; }
  # Restoration may itself have taken and released the lock; release again in
  # case it died holding it, or if the first removal failed. Idempotent. A
  # removal that STILL fails (it printed the manual rmdir) fails the exit.
  _release_git_crypt_lock || { [ "$_gcl_status" -ne 0 ] || _gcl_status=1; }
  exit "$_gcl_status"
}
_git_crypt_lock_on_signal() {
  set +e
  _release_git_crypt_lock
  _git_crypt_lock_run_outer
  _release_git_crypt_lock
  exit "$1"
}
_git_crypt_lock_arm() {
  trap '_git_crypt_lock_on_exit' EXIT
  trap '_git_crypt_lock_on_signal 130' INT
  trap '_git_crypt_lock_on_signal 143' TERM
}

_acquire_git_crypt_lock() {
  # R4 (M): a lock THIS process still holds (a release whose removal failed
  # leaves HELD set, and the signal handler's chained restore then acquires)
  # is reused, not re-contended: spinning on our own directory cost the whole
  # 10s window and exited 1 instead of 130/143. Within the contract (no
  # caller writes HELD, no subshells, no manual rmdir while held) HELD equals
  # $$ only after this shell's own successful mkdir -- an exported or foreign
  # value is discarded at source time -- so an empty pid file or one naming
  # us is ours.
  if [ "$GIT_CRYPT_LOCK_HELD" = "$$" ]; then
    _own=$(cat "$GIT_CRYPT_LOCK_DIR/pid" 2>/dev/null) || _own=""
    if [ "$_own" = "$$" ] || [ -z "$_own" ]; then
      return 0
    fi
  fi
  _wait_i=0
  while [ "$_wait_i" -lt 50 ]; do
    # H3: the gap between `mkdir` returning and GIT_CRYPT_LOCK_HELD=1 cannot be
    # closed with a handler -- the handler cannot tell "I just created it" from
    # "someone else holds it" without the flag. So the window is made
    # unreachable instead: INT/TERM are IGNORED across exactly the mkdir and
    # the flag assignment (a signal there is dropped, never leaked), and the
    # real handlers are armed on both outcomes immediately after.
    trap '' INT TERM
    if mkdir "$GIT_CRYPT_LOCK_DIR" 2>/dev/null; then
      # mkdir succeeding IS acquisition: nothing else can take the directory
      # (SMI-5983 deliberately has no auto-reclaim). Claim it FIRST, before
      # anything that can fail.
      GIT_CRYPT_LOCK_HELD=$$
      _git_crypt_lock_arm
      # Then record the owner. errexit is suppressed for an `if` CONDITION but
      # not an `if` BODY, so this stays a condition.
      if ! echo "$$" > "$GIT_CRYPT_LOCK_DIR/pid" 2>/dev/null; then
        echo "${RED}  acquired the git-crypt filter lock but could not record ownership${NC}" >&2
        echo "    $GIT_CRYPT_LOCK_DIR/pid" >&2
        if rm -rf "$GIT_CRYPT_LOCK_DIR" 2>/dev/null; then
          GIT_CRYPT_LOCK_HELD=""
          echo "  The lock has been released, so nothing is wedged. This usually means" >&2
          echo "  a full disk or a read-only .git. Fix that and retry the commit." >&2
        else
          # Honest: removal failed too. HELD stays set so the exit trap retries.
          echo "  The lock directory could NOT be removed either, so it may still be on" >&2
          echo "  disk and wedge every worktree. Once the disk/permission problem is" >&2
          echo "  fixed, run: rmdir \"$GIT_CRYPT_LOCK_DIR\" (rm -rf if it is not empty)." >&2
        fi
        exit 1
      fi
      return 0
    fi
    _git_crypt_lock_arm
    _wait_i=$((_wait_i + 1))
    sleep 0.2
  done
  # Nothing to release here, and re-running the caller's cleanup would only
  # wait out this same busy window a second time: drop the chain.
  GIT_CRYPT_LOCK_OUTER_TRAP=""
  # `|| var=` : a missing/unreadable pid file must not abort under `sh -e`.
  _holder_pid=$(cat "$GIT_CRYPT_LOCK_DIR/pid" 2>/dev/null) || _holder_pid=""
  echo "${RED}git-crypt filter lock busy after 10s (holder PID: ${_holder_pid:-unknown}).${NC}" >&2
  echo "  This lock never auto-reclaims. Confirm via 'ps' that the holder is gone, then:" >&2
  echo "    rmdir \"$GIT_CRYPT_LOCK_DIR\"" >&2
  echo "  and retry the commit." >&2
  exit 1
}
_release_git_crypt_lock() {
  [ "$GIT_CRYPT_LOCK_HELD" = "$$" ] || return 0
  # `|| _owner=` : under `sh -e` a bare substitution of a failing `cat` aborts
  # here, so the empty-owner handling below would never run.
  _owner=$(cat "$GIT_CRYPT_LOCK_DIR/pid" 2>/dev/null) || _owner=""
  # SMI-6973 step 5: release when the pid file names US, **or** when it is
  # absent or unreadable.
  #
  # The empty case is a state step 5 itself introduced, and leaving it out
  # would have been a second leak inside the fix for the first. Claiming
  # ownership before writing the pid file means there is now a real instant
  # where GIT_CRYPT_LOCK_HELD is set and no pid file exists yet. The old
  # `[ "$_owner" = "$$" ]` test is FALSE there, so the directory would survive
  # a release that believed it had done its job.
  #
  # Releasing on an empty read is safe here, and only here, because
  # within the contract GIT_CRYPT_LOCK_HELD equals $$ only after this shell's
  # own successful `mkdir`: an exported or foreign value is discarded when the
  # file is sourced, and nothing sets it speculatively (the cases outside
  # the contract are named where HELD is initialised). And
  # SMI-5983 deliberately implemented NO auto-reclaim -- an ABA race in an
  # `mv`-to-tombstone design was found and rejected -- so no other process can
  # take this directory from us while we hold it (short of an operator's manual
  # rmdir, which the busy message gates on confirming via ps that the holder is
  # gone), which is what would otherwise
  # make "pid unreadable" ambiguous between "mine, unrecorded" and "someone
  # else's now".
  #
  # A pid file naming a DIFFERENT process is still refused. That is the case
  # the original check exists for, and it stays.
  if [ "$_owner" = "$$" ] || [ -z "$_owner" ]; then
    # A failing rm must not abort under `sh -e`, nor fail silently: say so, with
    # the manual remedy. SMI-6973 F6: and it must NOT clear the flag -- the EXIT
    # trap re-enters this function and can only retry while HELD is still set.
    rm -rf "$GIT_CRYPT_LOCK_DIR" 2>/dev/null || {
      echo "${RED}  could not remove the git-crypt filter lock: rmdir \"$GIT_CRYPT_LOCK_DIR\"${NC}" >&2
      # R4 (H-b): NON-zero, so no caller can read this as released and then
      # drop the traps that are the only remaining retry.
      return 1
    }
  fi
  GIT_CRYPT_LOCK_HELD=""
}

# SMI-6973: read ONE git config key into the variable named by $1, with the
# exit status actually examined instead of discarded.
#
# This lives here, with the lock, because its failure path IS lock release --
# it is called from inside the held window and must not abort while holding.
#
# THE DEFECT IT REPLACES. The caller used to do a bare
# `SMUDGE_CMD=$(git config --local <key> 2>/dev/null)` one line after taking
# the lock. Under the `sh -e` husky invokes every hook with (.husky/_/h:17), a
# command substitution whose command fails aborts the shell -- and `git config`
# exits 1 for a key that is merely ABSENT, which is the normal case. So the
# hook died there, holding a lock whose only cleanup was trapped on INT/TERM,
# leaking a directory that never self-heals and is shared across the main
# checkout and every worktree via --git-common-dir.
#
# WHY NOT `|| VAR=""`. That is the obvious one-line fix and it is too blunt: it
# collapses every failure into "absent". Measured exit codes make the
# distinction available, so it is drawn rather than thrown away:
#
#   0    key is set
#   1    key absent            <- normal; yields empty, proceed
#   6    bad pattern/arguments <- genuine failure
#   128  not in a repository   <- genuine failure
#
# A genuine failure means this hook cannot classify the filter state it is
# about to mutate, so it releases the lock and refuses rather than guessing.
_read_git_crypt_cfg() {
  _rfc_name="$1"
  _rfc_key="$2"
  _rfc_rc=0
  _rfc_val=$(git config --local "$_rfc_key" 2>/dev/null) || _rfc_rc=$?
  if [ "$_rfc_rc" -gt 1 ]; then
    _release_git_crypt_lock || true # a failed removal must not skip the explanation below
    echo "${RED}  cannot read $_rfc_key (git config exit $_rfc_rc)${NC}" >&2
    echo "  Exit 1 would mean the key is simply unset, which is fine. This is not" >&2
    echo "  that: the read itself failed, so the filter state cannot be classified." >&2
    echo "  Refusing to disable git-crypt filters on an unknown pre-image." >&2
    echo "  The lock has been released; no cleanup is needed." >&2
    exit 1
  fi
  # Names are literals supplied by this file's own callers, never user input.
  eval "$_rfc_name=\$_rfc_val"
}
