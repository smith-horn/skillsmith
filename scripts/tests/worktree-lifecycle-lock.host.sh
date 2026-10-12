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
TMP="$(mktemp -d "${TMPDIR:-/tmp}/lockhost.XXXXXX")"
trap 'rm -rf "$TMP" "$TMP.link"' EXIT
FAILS=0

git init -q "$TMP/repo"
git -C "$TMP/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m i
REPO="$TMP/repo"
# shellcheck source=/dev/null
source "$ROOT/scripts/_lib.sh"
# shellcheck source=/dev/null
source "$ROOT/scripts/lib/worktree-lifecycle.sh"
# shellcheck source=/dev/null
source "$ROOT/scripts/lib/worktree-lifecycle-docker.sh"
# shellcheck source=/dev/null
source "$ROOT/scripts/lib/worktree-project-attribution.sh"

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
# shellcheck disable=SC2016  # $! and $0 expand in the child shell
worktree_lifecycle_bounded 5 /bin/sh -c 'sleep 20 >/dev/null 2>&1 & echo $! > "$0"' "$TMP/sleep-supervised.pid"
worktree_lifecycle_lock_release
check "T17 contender after release (supervised child)" 0 "$(contend 1)"
# Negative control: an UNWRAPPED backgrounded child keeps the lock alive.
worktree_lifecycle_lock_acquire "$REPO" 0 host
# shellcheck disable=SC2016
/bin/sh -c 'sleep 20 >/dev/null 2>&1 & echo $! > "$0"' "$TMP/sleep-unwrapped.pid"
worktree_lifecycle_lock_release
check "T17 negative control (unwrapped child keeps it)" 75 "$(contend 1)"
# Only the two sleeps this script started, by pid (never a pattern: the host is shared).
kill "$(cat "$TMP/sleep-supervised.pid")" "$(cat "$TMP/sleep-unwrapped.pid")" 2>/dev/null

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

# T19 (SMI-7089): the attribution library under the SYSTEM bash (3.2) and macOS
# userland. `mktemp -d` returns /var/..., which git prints as /private/var/...:
# that is the case that makes the path test `-ef` rather than a string compare.
git -C "$REPO" worktree add -q -b w1 "$TMP/foo"
git -C "$REPO" worktree add -q -b w2 "$TMP/_foo"
git -C "$REPO" worktree add -q -b w3 "$TMP/bar_"
git -C "$REPO" worktree add -q -b w4 "$TMP/bar"
peers="$(worktree_project_peers "$REPO" "$TMP/_foo" foo)"; rc=$?
check "T19 shared project: status" 0 "$rc"
case "$peers" in *"registered worktree|"*"/foo"*) found=found ;; *) found=missing ;; esac
check "T19 shared project: the other worktree is named" found "$found"
peers="$(worktree_project_peers "$REPO" "$TMP/bar" bar)"; rc=$?
check "T19 near miss (bar_ beside bar): status" 0 "$rc"
check "T19 near miss (bar_ beside bar): no peer" "" "$peers"
worktree_project_peers "$REPO" "$TMP/not-a-worktree" foo >/dev/null; check "T19 unlisted path: status" 2 $?
check "T19 json_label reads a key" foo "$(worktree_lifecycle_json_label '{"a":"1","com.docker.compose.project":"foo"}' com.docker.compose.project)"
# shellcheck disable=SC2016
check "T19 json_label: a key spoofed inside a value does not match" "" "$(worktree_lifecycle_json_label '{"x":"y\",\"app.skillsmith.owned\":\"true"}' app.skillsmith.owned)"

# T19b (SMI-7089): worktree_project_attribution_or_die itself, under bash 3.2, with a
# PATH that has NO docker (docker-optional mode skips the Docker reads). error()
# exits, so each call runs in a subshell. The same checks run again through a
# SYMLINK to the temp dir, the equivalent of macOS /var -> /private/var: `-ef` must
# identify the worktree through either spelling.
NODOCKER="$TMP/nodocker-bin"
mkdir -p "$NODOCKER"
for t in git sed tr basename dirname grep cat sort; do
    p="$(command -v "$t")" && ln -s "$p" "$NODOCKER/$t"
done
ln -s "$TMP" "$TMP.link"
attr() { ( PATH="$NODOCKER"; worktree_project_attribution_or_die "$REPO" "$1" "$2" docker-optional ) >/dev/null 2>&1; }
attr "$TMP/_foo" foo; check "T19b colliding _foo beside foo refuses" 1 $?
attr "$TMP.link/_foo" foo; check "T19b colliding _foo through a symlinked path refuses" 1 $?
attr "$TMP/bar" bar; check "T19b near miss bar beside bar_ passes" 0 $?
attr "$TMP.link/bar" bar; check "T19b near miss through a symlinked path passes" 0 $?
# One directory per glob arm: `*/` (plain), `.[!.]*/` (.dot) and `..?*/` (..dd).
# Output is NUL-delimited; translate to newlines to compare.
mkdir -p "$REPO/.worktrees/plain" "$REPO/.worktrees/.dot" "$REPO/.worktrees/..dd"
dirs="$(worktree_lifecycle_worktrees_dirs "$REPO" | tr '\0' '\n')"
check "T19b worktrees_dirs: plain arm" 1 "$(printf '%s\n' "$dirs" | grep -cxF "$REPO/.worktrees/plain")"
check "T19b worktrees_dirs: .[!.]* arm (.dot)" 1 "$(printf '%s\n' "$dirs" | grep -cxF "$REPO/.worktrees/.dot")"
check "T19b worktrees_dirs: ..?* arm (..dd)" 1 "$(printf '%s\n' "$dirs" | grep -cxF "$REPO/.worktrees/..dd")"
check "T19b sanitize_project_name drops an interior newline" foo "$(sanitize_project_name "fo
o")"
mkdir -p "$REPO/.worktrees/new
line"
check "T19b worktrees_dirs: a name with a newline is ONE entry (4 NULs for 4 dirs)" 4 "$(worktree_lifecycle_worktrees_dirs "$REPO" | tr -cd '\000' | wc -c | tr -d ' ')"

echo "failures: $FAILS"
[ "$FAILS" -eq 0 ]
