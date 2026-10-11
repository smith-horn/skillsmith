#!/bin/bash
# Host port of the lifecycle-lock cases that the Linux container cannot cover
# (SMI-6981 plan 7.1): bash 3.2, the BSD userland, APFS and the real Go docker
# CLI. Run it by hand before merge, under the SYSTEM bash, and paste the output:
#
#   /bin/bash scripts/tests/worktree-lifecycle-lock.host.sh
#
# Every case records its own return code on its line; a case that cannot run on
# this machine says SKIP rather than passing.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILS=0

git init -q "$TMP/repo"
git -C "$TMP/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m i
REPO="$TMP/repo"
# shellcheck source=/dev/null
source "$ROOT/scripts/_lib.sh"
# shellcheck source=/dev/null
source "$ROOT/scripts/lib/worktree-lifecycle.sh"

check() { # name expected actual
    if [ "$2" = "$3" ]; then
        echo "PASS $1 (rc=$3)"
    else
        echo "FAIL $1 (expected $2, got $3)"
        FAILS=$((FAILS + 1))
    fi
}

# A fresh process that tries the lock; prints its code.
contend() {
    /bin/bash -c "source '$ROOT/scripts/_lib.sh'; source '$ROOT/scripts/lib/worktree-lifecycle.sh'; worktree_lifecycle_lock_acquire '$REPO' $1 contender; echo \$?"
}

# T10b (Darwin branch): the real repo directory is supported, /dev (devfs) is not.
worktree_lifecycle_fs_supported "$REPO/.git"; check "T10b $(uname -s) allow-list: temp repo" 0 $?
worktree_lifecycle_fs_supported /dev; check "T10b negative control: /dev" 1 $?

# T16: re-entry refused, and an outsider is still excluded after it.
worktree_lifecycle_lock_acquire "$REPO" 0 host; check "T16 first acquire" 0 $?
worktree_lifecycle_lock_acquire "$REPO" 0 host; check "T16 second acquire refused" 2 $?
check "T16 outsider while held" 75 "$(contend 0)"

# T7a: replacing the common directory is detected by the identity check.
worktree_lifecycle_lock_assert_held; check "T7a assert before replacement" 0 $?
mv "$REPO/.git" "$REPO/.git.old" && cp -R "$REPO/.git.old" "$REPO/.git"
worktree_lifecycle_lock_assert_held; check "T7a assert after replacement" 72 $?
worktree_lifecycle_lock_release
rm -rf "$REPO/.git" && mv "$REPO/.git.old" "$REPO/.git"

# T3: the kernel releases the lock when its holder is killed.
( worktree_lifecycle_lock_acquire "$REPO" 0 holder && : > "$TMP/ready" && exec sleep 60 ) &
HOLDER=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -e "$TMP/ready" ] && break; sleep 0.1; done
check "T3 contender while held" 75 "$(contend 0)"
kill -9 "$HOLDER"; wait "$HOLDER" 2>/dev/null
check "T3 contender after kill -9" 0 "$(contend 2)"

# T17: a child run through the supervisor does not inherit the lock.
worktree_lifecycle_lock_acquire "$REPO" 0 host
worktree_lifecycle_bounded 5 /bin/sh -c 'sleep 20 >/dev/null 2>&1 &'
worktree_lifecycle_lock_release
check "T17 contender after release (supervised child)" 0 "$(contend 1)"
# Negative control: an UNWRAPPED backgrounded child keeps the lock alive.
worktree_lifecycle_lock_acquire "$REPO" 0 host
/bin/sh -c 'sleep 20 >/dev/null 2>&1 &'
worktree_lifecycle_lock_release
check "T17 negative control (unwrapped child keeps it)" 75 "$(contend 1)"
pkill -f 'sleep 20' 2>/dev/null

# T11c: the supervisor bounds a child that ignores ALRM and TERM, and the real
# Go docker CLI (alarm+exec does not: measured).
t0=$(date +%s)
worktree_lifecycle_bounded 2 /bin/bash -c "trap '' ALRM TERM; sleep 30"; rc=$?
check "T11c TERM-ignoring child" 124 "$rc"
echo "     elapsed $(( $(date +%s) - t0 ))s (expect about 4)"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    t0=$(date +%s)
    worktree_lifecycle_bounded 2 docker events --filter type=plugin; rc=$?
    check "T11c real docker CLI" 124 "$rc"
    echo "     elapsed $(( $(date +%s) - t0 ))s (expect about 2-4)"
else
    echo "SKIP T11c real docker CLI (docker not reachable)"
fi

# Status passthrough and a missing binary.
worktree_lifecycle_bounded 5 /bin/sh -c 'exit 3'; check "bounded passes the child status" 3 $?
worktree_lifecycle_bounded 5 /nonexistent/binary; check "bounded missing binary" 127 $?

echo "failures: $FAILS"
[ "$FAILS" -eq 0 ]
