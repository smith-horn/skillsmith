#!/usr/bin/env bash
# audit:host-npm-required — see SMI-4814 (host-side native binding auto-heal per SMI-4549; cannot run in Docker)
#
# retrieval-autoheal.sh (SMI-5426) — out-of-band, autonomous host native-binding
# auto-heal. Wraps repair-host-native-deps.sh (SMI-4549) with the guardrails an
# UNATTENDED loop needs: a disable opt-out, a Docker no-op, a real-time
# concurrent-install detector, a macOS-safe NON-evicting lock, an atomic
# cooldown/attempt-cap state, and a banner that cannot go silent.
#
# Launched detached from .husky/post-merge AFTER that hook's own `npm install`:
#   nohup bash scripts/retrieval-autoheal.sh </dev/null >/dev/null 2>&1 &
# so the spawning install has already returned before this child starts.
#
# Modes:
#   (default)        run the guarded auto-heal (detached; exit code irrelevant).
#   --print-banner   fast + fail-soft: print one banner line for the post-merge
#                    hook, or NOTHING when the binding is healthy. Never mutates.
#
# Spec: docs/internal/implementation/smi-5426-w01-host-autoheal.md (D1–D6).
# NOTE: no `set -e` — a non-zero probe/detector is normal control flow and must
# not abort the heal mid-flight. `set -u`/pipefail stay on; all paths use ${x:-}.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Resolve the main repo (state key + probe cwd + repair target) -----------
# Identical derivation to autoheal-state.ts resolveMainRepoKey(): the first
# `worktree` entry of `git worktree list --porcelain` is always the main tree.
# Use sed (full line after the prefix), NOT `awk '{print $2}'` — awk would
# truncate a path containing a space, diverging from the TS full-path slice and
# silently breaking the heal + banner on such a path (round-2 retro Low-1).
MAIN_REPO="$(git -C "$SCRIPT_DIR" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -1)"
if [ -z "${MAIN_REPO:-}" ]; then
  MAIN_REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "")"
fi
[ -z "${MAIN_REPO:-}" ] && MAIN_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Paths / constants -------------------------------------------------------
# SKILLSMITH_AUTOHEAL_HOME isolates all state/lock/logs under a test temp dir;
# honored identically by autoheal-state.ts resolveAutohealStateDir(). Unset in
# production → the real $HOME.
STATE_DIR="${SKILLSMITH_AUTOHEAL_HOME:-$HOME}/.skillsmith"
STATE_FILE="$STATE_DIR/retrieval-autoheal.state"
LOCK_DIR="$STATE_DIR/retrieval-autoheal.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"
FLOCK_FILE="$STATE_DIR/retrieval-autoheal.flock"
LOG_DIR="$STATE_DIR/logs"
LOG_FILE="$LOG_DIR/retrieval-autoheal-$(date +%Y-%m-%d).log"
STATE_CLI="$SCRIPT_DIR/retrieval-autoheal-state.ts"
REPAIR_SCRIPT="$SCRIPT_DIR/repair-host-native-deps.sh"

T_MAX=1800         # lock-staleness backstop (s): hung-holder / PID-reuse ONLY (30min ≫ any real rebuild, so a holder past it is genuinely hung, not slow); release is ownership-checked so a T_MAX reclaim can't cascade
T_GRACE_MS=2000    # mkdir-then-write-PID TOCTOU grace before treating a pidless lock as crashed
LOCK_FLOCK_WAIT=5  # flock -w timeout (s) — defer (never evict) if a live heal holds it

LOCK_MODE=""

# --- Logging (fail-soft) -----------------------------------------------------
log() {
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$*" >> "$LOG_FILE" 2>/dev/null || true
}

# --- tsx runner (prefer the local bin; npx fallback matches session priming) -
run_state_cli() {
  # Pass the bash-resolved MAIN_REPO as the explicit state key so bash and the CLI
  # never disagree, and so keying survives a `git worktree list` failure (MAIN_REPO
  # has a worktree-list → rev-parse → parent-dir fallback chain; it is never empty).
  local tsx_bin="$MAIN_REPO/node_modules/.bin/tsx"
  if [ -x "$tsx_bin" ]; then
    "$tsx_bin" "$STATE_CLI" "$@" --key "$MAIN_REPO" 2>/dev/null
  else
    npx --no-install tsx "$STATE_CLI" "$@" --key "$MAIN_REPO" 2>/dev/null
  fi
}

# --- Test seams (inert unless SKILLSMITH_AUTOHEAL_TEST=1) ---------------------
# Let the scripts/tests suite drive the probe/repair/detector deterministically
# without a real broken binding or mutating real node_modules. Gated behind a
# single master switch so production behavior can never be hijacked by a stray
# env var; asserted test-gated by the static-source test.
AUTOHEAL_TEST="${SKILLSMITH_AUTOHEAL_TEST:-}"

# --- Cheap binding probe (ground truth; mirrors repair-host-native-deps.sh) ---
probe_binding() {
  if [ "$AUTOHEAL_TEST" = "1" ] && [ -n "${SKILLSMITH_AUTOHEAL_PROBE_CMD:-}" ]; then
    sh -c "$SKILLSMITH_AUTOHEAL_PROBE_CMD" >/dev/null 2>&1
    return $?
  fi
  ( cd "$MAIN_REPO" 2>/dev/null && node -e "const D=require('better-sqlite3'); new D(':memory:').close()" ) >/dev/null 2>&1
}

# --- Real-time concurrent-install detector (D2) ------------------------------
# An mtime heuristic would false-positive on post-merge's OWN just-finished
# install; a live-process check does not (the heal has spawned no npm yet, so any
# match is foreign). pgrep is on macOS (BSD) and Linux (procps). Absent → skip.
HAVE_PGREP=0
command -v pgrep >/dev/null 2>&1 && HAVE_PGREP=1
foreign_install_running() {
  if [ "$AUTOHEAL_TEST" = "1" ] && [ "${SKILLSMITH_AUTOHEAL_FORCE_INSTALL:-}" = "1" ]; then
    return 0
  fi
  [ "$HAVE_PGREP" = "1" ] || return 1
  pgrep -f 'npm (install|ci)|build-release' >/dev/null 2>&1
}

# --- Lock (D3): flock when present, else non-evicting atomic mkdir lock -------
release_lock() {
  # flock auto-releases when the held fd closes on exit; only mkdir needs cleanup.
  # OWNERSHIP CHECK (audit M1): remove a lock ONLY if THIS process still owns it.
  # If a holder ran past T_MAX and was reclaimed by another heal, that holder's
  # EXIT trap must not delete the reclaimer's live lock (no eviction cascade).
  if [ "$LOCK_MODE" = "mkdir" ]; then
    local owner
    owner="$(awk '{print $1}' "$LOCK_PID_FILE" 2>/dev/null)"
    [ "$owner" = "$$" ] && rm -rf "$LOCK_DIR" 2>/dev/null || true
  fi
}

acquire_lock() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true

  # FORCE_MKDIR_LOCK test seam: exercise the macOS mkdir-lock path (incl. the
  # no-live-eviction reclaim logic) even on a flock-equipped CI host, so that
  # critical path gets real CI coverage rather than host-only coverage.
  local force_mkdir=""
  [ "$AUTOHEAL_TEST" = "1" ] && [ "${SKILLSMITH_AUTOHEAL_FORCE_MKDIR_LOCK:-}" = "1" ] && force_mkdir="1"

  if [ -z "$force_mkdir" ] && command -v flock >/dev/null 2>&1; then
    # fd 9 is held for the script's life; the kernel releases it on ANY exit
    # (incl. crash), so a flock holder is never "held past death".
    if exec 9>"$FLOCK_FILE"; then
      if flock -w "$LOCK_FLOCK_WAIT" 9; then
        LOCK_MODE="flock"
        return 0
      fi
      log "defer: flock held by another heal (waited ${LOCK_FLOCK_WAIT}s)"
      return 1
    fi
    log "warn: could not open flock file; falling back to mkdir lock"
  fi

  # mkdir fallback (stock macOS has no flock). mkdir is atomic; reclaim ONLY a
  # provably-dead/hung holder so a live 30–60s rebuild is never evicted.
  for _ in 1 2; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      printf '%s %s\n' "$$" "$(date +%s)" > "$LOCK_PID_FILE" 2>/dev/null || true
      # M2 (audit): re-verify ownership. If a racer reclaimed our dir during the
      # mkdir→write-pid gap and took it, the pid file is no longer ours → defer.
      # (Closes the common reclaim race; a pathological multi-second preemption
      # mid-statement remains a documented, astronomically-rare residual.)
      if [ "$(awk '{print $1}' "$LOCK_PID_FILE" 2>/dev/null)" != "$$" ]; then
        log "defer: lost mkdir-lock race just after acquire"
        return 1
      fi
      # Release on every exit. INT/TERM MUST exit after releasing — a bare trap
      # would let the script continue running UNLOCKED (audit L4).
      trap 'release_lock' EXIT
      trap 'release_lock; exit 130' INT
      trap 'release_lock; exit 143' TERM
      LOCK_MODE="mkdir"
      return 0
    fi
    # Held — assess the holder. TOCTOU grace: a lock dir whose pid file is not
    # written yet is freshly-acquired, not stale.
    local waited=0
    while [ ! -s "$LOCK_PID_FILE" ] && [ "$waited" -lt "$T_GRACE_MS" ]; do
      sleep 0.2
      waited=$((waited + 200))
    done
    if [ ! -s "$LOCK_PID_FILE" ]; then
      log "lock: reclaiming (pid file absent after ${T_GRACE_MS}ms grace — holder crashed before write)"
      rm -rf "$LOCK_DIR" 2>/dev/null || true
      continue
    fi
    local holder_pid holder_started age
    holder_pid="$(awk '{print $1}' "$LOCK_PID_FILE" 2>/dev/null)"
    holder_started="$(awk '{print $2}' "$LOCK_PID_FILE" 2>/dev/null)"
    if [ -z "${holder_pid:-}" ] || ! kill -0 "$holder_pid" 2>/dev/null; then
      log "lock: reclaiming (holder pid ${holder_pid:-?} not alive)"
      rm -rf "$LOCK_DIR" 2>/dev/null || true
      continue
    fi
    age=0
    [ -n "${holder_started:-}" ] && age=$(( $(date +%s) - holder_started ))
    if [ "$age" -gt "$T_MAX" ]; then
      log "lock: reclaiming (holder pid $holder_pid age ${age}s > T_MAX=${T_MAX}s — hung or pid-reused)"
      rm -rf "$LOCK_DIR" 2>/dev/null || true
      continue
    fi
    # Live, young holder → another heal is actively running. Do NOT evict; no-op.
    log "defer: lock held by live pid $holder_pid (age ${age}s)"
    return 1
  done
  log "warn: could not acquire mkdir lock after reclaim attempts"
  return 1
}

# --- ANSI strip — portable across BSD (macOS) + GNU sed --------------------
# The GNU hex-escape form for ESC is a no-op on BSD/macOS sed (it matches the
# literal characters, not the control byte), so the prior strip silently did
# nothing on the host target (round-2 retro Low-2). A bash $'\033' yields a real
# ESC byte that BOTH seds match.
strip_ansi() { sed $'s/\033\\[[0-9;]*m//g'; }

# --- Reason extraction from repair output (strip ANSI; prefer the Error: line)-
extract_reason() {
  local raw="$1" clean
  clean="$(printf '%s' "$raw" | strip_ansi)"
  local reason
  reason="$(printf '%s\n' "$clean" | grep -m1 -E 'Error:' | sed -E 's/^.*Error:[[:space:]]*//' | cut -c1-200)"
  if [ -z "$reason" ]; then
    reason="$(printf '%s\n' "$clean" | awk 'NF{last=$0} END{print last}' | cut -c1-200)"
  fi
  printf '%s' "$reason"
}

# ============================================================================
# Mode: --print-banner (synchronous, called by the hook BEFORE the detached run)
# ============================================================================
if [ "${1:-}" = "--print-banner" ]; then
  # Healthy host → nothing (no steady-state noise).
  probe_binding && exit 0
  # Broken → render from state via the single-source-of-truth CLI.
  if command -v node >/dev/null 2>&1 && [ -f "$STATE_CLI" ]; then
    run_state_cli banner --cwd "$SCRIPT_DIR" --log "$LOG_FILE" || true
    printf '\n'
  fi
  exit 0
fi

# ============================================================================
# Mode: default (the guarded auto-heal; intended to run detached)
# ============================================================================

# 1. Opt-out — checked FIRST, fail-soft, before any probe.
if [ "${SKILLSMITH_RETRIEVAL_AUTOHEAL_DISABLE:-}" = "1" ]; then
  log "skip: disabled (SKILLSMITH_RETRIEVAL_AUTOHEAL_DISABLE=1)"
  exit 0
fi

# 2. Docker no-op (the container self-heals via its own postinstall path).
#    FORCE_NON_DOCKER test seam: let the scripts/tests suite exercise the heal +
#    lock logic INSIDE the CI container (where /.dockerenv exists) so the core
#    invariants aren't silently skipped exactly where CI runs vitest.
if [ "$AUTOHEAL_TEST" = "1" ] && [ "${SKILLSMITH_AUTOHEAL_FORCE_NON_DOCKER:-}" = "1" ]; then
  : # test override — fall through to the heal logic
elif [ "${IS_DOCKER:-}" = "true" ] || [ -f /.dockerenv ]; then
  log "skip: inside Docker — host-only"
  exit 0
fi

# 3. node is required for both the probe and the repair.
if ! command -v node >/dev/null 2>&1; then
  log "skip: node not on PATH"
  exit 0
fi

# 4. Cheap probe — a healthy binding means nothing to do (no lock, no state).
if probe_binding; then
  log "skip: binding healthy"
  exit 0
fi

# 5. Concurrent-install detector (pre-lock). foreign_install_running() owns the
#    whole decision (incl. the FORCE_INSTALL test seam), so it works regardless
#    of whether pgrep is present; warn separately when pgrep is missing.
if foreign_install_running; then
  log "defer: concurrent npm install/build detected (pre-lock)"
  exit 0
fi
[ "$HAVE_PGREP" = "1" ] || log "warn: pgrep unavailable — concurrent-install detector skipped (residual race accepted)"

# 6. Acquire the lock (defer, never evict a live holder).
if ! acquire_lock; then
  exit 0
fi

# 7. Double-checked locking: another heal may have healed the shared tree while
#    we waited. Re-probe under the lock; if healthy now, record + skip the rebuild.
if probe_binding; then
  log "double-check: binding already healed by another instance — recording ok, skipping rebuild"
  run_state_cli record --cwd "$SCRIPT_DIR" --result ok --module better-sqlite3 || true
  exit 0
fi

# 7b. Re-check the install detector after acquiring the lock (a foreign install
#     may have started during the wait).
if foreign_install_running; then
  log "defer: concurrent npm install/build detected (post-lock)"
  exit 0
fi

# 8. Cooldown / attempt-cap (single source of truth in autoheal-state.ts).
DECISION="$(run_state_cli decision --cwd "$SCRIPT_DIR" || echo run)"
case "$DECISION" in
  capped*)
    log "hold: attempt cap reached — manual reset required (rm $STATE_FILE)"
    exit 0
    ;;
  cooldown*)
    log "defer: in cooldown ($DECISION)"
    exit 0
    ;;
  *) : ;; # run
esac

# 9. Run the repair, then re-probe for the ground-truth verdict (the repair exits
#    0 on [skip] too, so its exit code is not the verdict — the binding load is).
#    RESIDUAL (audit L1, accepted): the install-detector is point-in-time, so a
#    foreign `npm install` that STARTS during this rebuild is not gated (the lock
#    only serializes heals vs heals, not vs an arbitrary human npm install). True
#    install-side exclusion is out of scope for W0.1. Partial mitigation: the
#    post-rebuild re-probe below catches a tree a foreign install corrupted and
#    records a failure → backoff, so the heal self-corrects on the next trigger.
log "heal: binding broken — invoking repair-host-native-deps.sh"
if [ "$AUTOHEAL_TEST" = "1" ] && [ -n "${SKILLSMITH_AUTOHEAL_REPAIR_CMD:-}" ]; then
  REPAIR_OUT="$(sh -c "$SKILLSMITH_AUTOHEAL_REPAIR_CMD" 2>&1)"
  REPAIR_RC=$?
else
  REPAIR_OUT="$(bash "$REPAIR_SCRIPT" 2>&1)"
  REPAIR_RC=$?
fi

if probe_binding; then
  log "heal: success (repair rc=$REPAIR_RC) — binding loads"
  run_state_cli record --cwd "$SCRIPT_DIR" --result ok --module better-sqlite3 || true
else
  REASON="$(extract_reason "$REPAIR_OUT")"
  [ -z "$REASON" ] && REASON="repair rc=$REPAIR_RC; binding still missing"
  log "heal: FAILED (repair rc=$REPAIR_RC): $REASON"
  {
    printf -- '--- repair output (tail) ---\n'
    printf '%s\n' "$REPAIR_OUT" | strip_ansi | tail -20
    printf -- '--- end repair output ---\n'
  } >> "$LOG_FILE" 2>/dev/null || true
  run_state_cli record --cwd "$SCRIPT_DIR" --result fail --reason "$REASON" --module better-sqlite3 || true
fi

exit 0
