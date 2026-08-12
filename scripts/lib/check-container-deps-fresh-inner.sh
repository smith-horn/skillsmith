#!/bin/sh
# scripts/lib/check-container-deps-fresh-inner.sh
# SMI-6006: the actual lock + self-heal logic, run INSIDE skillsmith-dev-1.
#
# Split out from check-container-deps-fresh.sh (the host-side dispatcher)
# so this file can be executed directly via `docker exec ... sh
# scripts/lib/check-container-deps-fresh-inner.sh` (no shell-quoting/escaping
# hazard from inlining it as a string) AND sourced by tests to unit-test
# acquire()/release()/try_reclaim() in isolation, without any docker/npm
# involved. Runs as ONE continuous process for the whole critical section —
# $$ is stable for the entire acquire -> check -> install -> write-sentinel
# -> release sequence, which is what makes the lock's owner token
# checkable/killable for its full lifetime (see check-container-deps-fresh.sh
# for why a short-lived per-step `docker exec` would NOT have this property).
#
# Paths below are relative to cwd, which the caller (check-container-deps-fresh.sh's
# `docker exec -w /app`) sets to the container's /app — or, in tests, to
# whatever FAKE_APP_DIR stands in for it.
#
# Tunables (SKILLSMITH_LOCK_MAX_TRIES, SKILLSMITH_LOCK_SLEEP_SECS): read from
# the environment this process inherits — forwarded into the container via
# `docker exec -e` by the caller, or set directly by a test sourcing this
# file. Never interpolated into any string here.
#
# Test seam: source this file with SKILLSMITH_LOCK_TEST_SOURCE=1 set first —
# that skips the "main flow" block at the bottom entirely, leaving acquire(),
# release(), and try_reclaim() defined for the test to call directly against
# a controlled LOCK_DIR/OWNER_FILE.
#
# POSIX sh — no `local`, no `[[ ]]`, no arrays.

LOCK_DIR="node_modules/.skillsmith-deps-lock"
OWNER_FILE="$LOCK_DIR/owner"
RECLAIM_DIR="$LOCK_DIR/.reclaiming"
MY_TOKEN="$$:$(od -An -N4 -tu4 /dev/urandom 2>/dev/null | tr -d ' ' || echo 0)"

# Reclaim a lock whose recorded owner is confirmed dead. Mutexed via
# RECLAIM_DIR (its own mkdir is atomic) so only ONE waiter at a time ever
# evaluates + acts on staleness for a given lock — this is what prevents the
# multi-reclaimer race: without it, two waiters can both read the same dead
# owner, and while one is removing the stale lock a third process can
# legitimately acquire a fresh one, which the OTHER waiter (still mid-reclaim
# on stale information) would then delete out from under it. Re-verifying
# ownership immediately before deleting, INSIDE the mutex, closes the window
# where a fresh holder appeared between this waiter's initial staleness read
# and it winning the reclaim mutex.
#
# $1 — the owner token this caller believes is dead (from its own read of
# OWNER_FILE moments earlier). Only removes the lock if OWNER_FILE still says
# exactly that token at the moment this process wins the reclaim mutex.
try_reclaim() {
    if ! mkdir "$RECLAIM_DIR" 2>/dev/null; then
        return 1   # someone else is already evaluating/reclaiming this lock
    fi
    cur=$(cat "$OWNER_FILE" 2>/dev/null)
    if [ "$cur" = "$1" ]; then
        rm -f "$OWNER_FILE"
        rmdir "$RECLAIM_DIR" 2>/dev/null
        rmdir "$LOCK_DIR" 2>/dev/null
    else
        rmdir "$RECLAIM_DIR" 2>/dev/null
    fi
    return 0
}

acquire() {
    tries=0
    while [ "$tries" -lt "${SKILLSMITH_LOCK_MAX_TRIES:-45}" ]; do
        if mkdir "$LOCK_DIR" 2>/dev/null; then
            printf "%s\n" "$MY_TOKEN" > "$OWNER_FILE"
            return 0
        fi
        if [ -f "$OWNER_FILE" ]; then
            owner_token=$(cat "$OWNER_FILE" 2>/dev/null)
            owner_pid=${owner_token%%:*}
            if [ -n "$owner_pid" ] && ! kill -0 "$owner_pid" 2>/dev/null; then
                try_reclaim "$owner_token"
            fi
        fi
        sleep "${SKILLSMITH_LOCK_SLEEP_SECS:-2}"
        tries=$((tries + 1))
    done
    return 1
}

# Ownership check: only ever removes a lock whose owner file still names
# THIS process's own token — a lock legitimately reclaimed and re-acquired
# by someone else since is left completely untouched.
release() {
    if [ -f "$OWNER_FILE" ]; then
        cur=$(cat "$OWNER_FILE" 2>/dev/null)
        if [ "$cur" = "$MY_TOKEN" ]; then
            rm -f "$OWNER_FILE"
            rmdir "$LOCK_DIR" 2>/dev/null
        fi
    fi
}

if [ "${SKILLSMITH_LOCK_TEST_SOURCE:-0}" = "1" ]; then
    return 0 2>/dev/null || exit 0
fi

trap release EXIT INT TERM

if ! acquire; then
    echo "LOCK_TIMEOUT" >&2
    exit 3
fi

if sh scripts/lib/check-node-modules-fresh.sh; then
    exit 0
fi

echo "SELF_HEAL_START"
if ! npm install; then
    exit 4
fi
sh scripts/lib/check-node-modules-fresh.sh --write-sentinel
exit 0
