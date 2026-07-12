#!/usr/bin/env bash
# SMI-5661: Unit tests for the worktree port-bucket collision-resolution
# helpers added to scripts/_lib.sh — _parse_override_host_ports,
# _worktree_sibling_taken_ports, _worktree_host_port_bound,
# _resolve_worktree_port_offset — plus the acquire_worktree_port_lock /
# release_worktree_port_lock concurrency guard wrapped around
# generate_docker_override and repair_worktrees_compose_override.
#
# Split into its own file (rather than folded into the sibling
# enumerate-compose-mounts*.test.sh files) per CLAUDE.md's 500-line
# guidance — those files already have no headroom for this addition.
#
# Uses REAL `git worktree add` fixtures, NOT enumerate-compose-mounts.test.sh's
# non-git `make_repo` helper: _worktree_sibling_taken_ports reads real
# `git worktree list --porcelain` output, which only a real repo produces.
#
# Deviates from the sibling test files' `set -euo pipefail` in one respect
# (see below `set` line) because of the concurrency section's background
# jobs.
#
# Covers:
#   A. Sibling-file collision + probe, using the SMI-5661 Wave 1 research's
#      verified same-bucket pair: "smi-5641-remove-dead-dep-helpers" and
#      "smi-5651-registry-catchup" both hash to bucket 79.
#   B. Host-bound port collision via a mocked _worktree_host_port_bound
#      (worktree name "wt71", verified deterministic bucket 98).
#   C. Wraparound boundary: buckets 99 and 1 both taken -> bucket 2
#      (worktree name "wt41", verified deterministic bucket 99).
#   D. Self-collision avoidance: (D1) _worktree_sibling_taken_ports excludes
#      the worktree being resolved; (D2) the sticky start-offset keeps a
#      simulated repair regen on a live worktree's OWN bucket ("wt92",
#      verified deterministic bucket 2) even after the bucket that displaced
#      it originally becomes free again.
#   E. Concurrency: (E1) lock active -> two racing resolutions land on
#      disjoint buckets; (E2) SKILLSMITH_WORKTREE_PORT_LOCK_DISABLE=1 negative
#      control -> the SAME race DOES collide, proving the harness has real
#      discriminating power; (E3) SKILLSMITH_WORKTREE_PORT_FORCE_MKDIR_LOCK=1
#      -> same disjoint-buckets assertion as E1, so the macOS mkdir-lock
#      fallback gets exercised even on a flock-equipped Linux CI host.

# No `-e`: the concurrency section (E) intentionally inspects `wait`'s exit
# status and deliberately provokes a FAILING (colliding) negative-control run
# (E2) as evidence the harness can detect a real collision. Mirrors
# retrieval-autoheal.sh's own `set -uo pipefail` (no `-e`) for the same
# reason — a script whose control flow depends on intentional non-zero
# returns must not have `-e` aborting it mid-flight.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../_lib.sh
source "$SCRIPT_DIR/_lib.sh"

fail=0
pass=0

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name: expected='$expected' actual='$actual'"
    fail=$((fail + 1))
  fi
}

assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name: '$needle' not in output"
    echo "  Haystack: $haystack"
    fail=$((fail + 1))
  fi
}

assert_not_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "FAIL $name: '$needle' should NOT be in output"
    fail=$((fail + 1))
  else
    echo "PASS $name"
    pass=$((pass + 1))
  fi
}

# -----------------------------------------------------------------------
# Fixture builders
# -----------------------------------------------------------------------

# Global accumulator of every temp dir created below, removed by a single
# EXIT trap. Single-quoted trap string so $ALL_TMP_DIRS is expanded when the
# trap FIRES (reading its then-current value), not when it was registered.
ALL_TMP_DIRS=""
trap 'rm -rf $ALL_TMP_DIRS' EXIT

# new_fixture_repo -> creates a throwaway git repo with one commit, tracks it
# for cleanup, echoes its path.
new_fixture_repo() {
  local root
  root=$(mktemp -d)
  # Canonicalize eagerly (macOS `mktemp -d` returns a /var/... path that is
  # itself a symlink to /private/var/...): `git worktree list --porcelain`
  # reports the REALPATH, so every path this helper hands back must already
  # be in that same canonical form or self-path comparisons (the
  # self-collision-avoidance exclusion under test) silently fail on macOS
  # even though the underlying resolver logic is correct.
  root=$(cd "$root" && pwd -P)
  ALL_TMP_DIRS="$ALL_TMP_DIRS $root"
  git -C "$root" init -q
  git -C "$root" config user.email test@example.com
  git -C "$root" config user.name "Test"
  git -C "$root" config commit.gpgsign false
  : > "$root/README.md"
  git -C "$root" add README.md
  git -C "$root" commit -qm init >/dev/null
  printf '%s' "$root"
}

# new_lock_home -> a fresh SKILLSMITH_WORKTREE_PORT_LOCK_HOME, tracked for
# cleanup, echoes its path. Isolated per test group so lock state from one
# scenario can never leak into another.
new_lock_home() {
  local home
  home=$(mktemp -d)
  ALL_TMP_DIRS="$ALL_TMP_DIRS $home"
  printf '%s' "$home"
}

# add_worktree <repo_root> <name> -> `git worktree add` on a new branch named
# <name> at <repo_root>/.worktrees/<name>, echoes the path.
add_worktree() {
  local root="$1" name="$2" path
  path="$root/.worktrees/$name"
  git -C "$root" worktree add -q -b "$name" "$path" HEAD >/dev/null 2>&1
  printf '%s' "$path"
}

# write_fixed_override <worktree_path> <name> <base_port> -> hand-writes a
# minimal override whose 4 port lines match the real generator's shape
# (quoted "HOST:CONTAINER") at HOST ports base_port..base_port+3, regardless
# of what bucket <name>'s own cksum hash would produce. Used to manufacture
# an exact bucket collision without needing the fixture name's hash to
# cooperate.
write_fixed_override() {
  local wt_path="$1" name="$2" base="$3"
  cat > "$wt_path/docker-compose.override.yml" << EOF
services:
  dev:
    container_name: ${name}-dev-1
    ports:
      - "$((base)):3000"   # Main app
      - "$((base + 1)):3001"   # MCP server
  test:
    container_name: ${name}-test-1
    ports:
      - "$((base + 2)):3000"      # Test app
  orchestrator:
    container_name: ${name}-orchestrator-1
    ports:
      - "$((base + 3)):3000"  # Orchestrator
EOF
}

# ports_overlap <list1> <list2> -> 0 (true) if any space-separated port in
# list1 also appears in list2; 1 (false) if disjoint.
ports_overlap() {
  local list1="$1" list2="$2" p
  for p in $list1; do
    case " $list2 " in *" $p "*) return 0 ;; esac
  done
  return 1
}

# =========================================================================
# Group A: sibling-file collision + probe (verified same-bucket pair)
# =========================================================================
ROOT_A=$(new_fixture_repo)
export SKILLSMITH_WORKTREE_PORT_LOCK_HOME
SKILLSMITH_WORKTREE_PORT_LOCK_HOME=$(new_lock_home)
export SKILLSMITH_WORKTREE_PORT_SKIP_HOST_CHECK=1

WT_A1=$(add_worktree "$ROOT_A" "smi-5641-remove-dead-dep-helpers")
OUT_A1=$(generate_docker_override "$WT_A1" "smi-5641-remove-dead-dep-helpers" "$ROOT_A" 2>&1)
assert_not_contains "groupA: first worktree (bucket 79, uncontested) -- no reassignment NOTE" "NOTE" "$OUT_A1"
OVERRIDE_A1=$(cat "$WT_A1/docker-compose.override.yml")
assert_contains "groupA: first worktree lands on deterministic bucket 79" '"3790:3000"' "$OVERRIDE_A1"

WT_A2=$(add_worktree "$ROOT_A" "smi-5651-registry-catchup")
OUT_A2=$(generate_docker_override "$WT_A2" "smi-5651-registry-catchup" "$ROOT_A" 2>&1)
assert_contains "groupA: second worktree (same bucket-79 hash) gets a reassignment NOTE" "bucket 79" "$OUT_A2"
assert_contains "groupA: reassignment NOTE names the resolved bucket 80" "reassigned to bucket 80" "$OUT_A2"
OVERRIDE_A2=$(cat "$WT_A2/docker-compose.override.yml")
assert_contains "groupA: second worktree lands on probed bucket 80" '"3800:3000"' "$OVERRIDE_A2"
assert_not_contains "groupA: second worktree's ports do not overlap bucket 79" '"3790:3000"' "$OVERRIDE_A2"

# =========================================================================
# Group B: host-bound collision via a mocked _worktree_host_port_bound
# =========================================================================
ROOT_B=$(new_fixture_repo)
WT_B=$(add_worktree "$ROOT_B" "wt71")

# "wt71" hashes deterministically to bucket 98 (base port 3980). Mock the
# host-bound probe to report exactly that bucket's 4 ports as LISTENing;
# every other port is reported free. Run in a command-substitution subshell
# so the function redefinition never leaks into later groups.
ERR_B=$(mktemp)
ALL_TMP_DIRS="$ALL_TMP_DIRS $ERR_B"
OFFSET_B=$(
  # NOTE: each case arm's pattern is wrapped in a leading `(` -- stock bash
  # 3.2's parser otherwise mis-tracks an unadorned `pattern)` arm terminator
  # as closing the ENCLOSING `$(...)` command substitution one level up
  # (verified live: a bare `3980 | 3981) ... ;; esac` here throws "syntax
  # error near unexpected token \`;;'"). The leading `(` is the standard
  # portable workaround.
  _worktree_host_port_bound() {
    case "$1" in
      (3980 | 3981 | 3982 | 3983) return 0 ;;
      (*) return 1 ;;
    esac
  }
  _resolve_worktree_port_offset "$WT_B" "wt71" "$ROOT_B" 2>"$ERR_B"
)
assert_eq "groupB: host-bound bucket 98 forces reassignment to bucket 99" "99" "$OFFSET_B"
assert_contains "groupB: host-bound reassignment emits a NOTE" "reassigned to bucket 99" "$(cat "$ERR_B")"

# =========================================================================
# Group C: wraparound boundary (bucket 99 AND bucket 1 both taken -> 2)
# =========================================================================
ROOT_C=$(new_fixture_repo)
WT_C_BLOCK99=$(add_worktree "$ROOT_C" "blocker99")
write_fixed_override "$WT_C_BLOCK99" "blocker99" 3990
WT_C_BLOCK1=$(add_worktree "$ROOT_C" "blocker1")
write_fixed_override "$WT_C_BLOCK1" "blocker1" 3010

# "wt41" hashes deterministically to bucket 99. With 99 taken, the resolver
# wraps ((99 % 99) + 1 = 1); with 1 ALSO taken, it wraps again ((1 % 99) + 1
# = 2) and lands there.
WT_C_TARGET=$(add_worktree "$ROOT_C" "wt41")
ERR_C=$(mktemp)
ALL_TMP_DIRS="$ALL_TMP_DIRS $ERR_C"
OFFSET_C=$(_resolve_worktree_port_offset "$WT_C_TARGET" "wt41" "$ROOT_C" 2>"$ERR_C")
assert_eq "groupC: wraparound past 99 and 1 lands on bucket 2" "2" "$OFFSET_C"
assert_contains "groupC: wraparound NOTE cites the original bucket 99" "bucket 99" "$(cat "$ERR_C")"
assert_contains "groupC: wraparound NOTE cites the final bucket 2" "reassigned to bucket 2" "$(cat "$ERR_C")"

# =========================================================================
# Group D: self-collision avoidance
# =========================================================================
ROOT_D=$(new_fixture_repo)

# --- D1: _worktree_sibling_taken_ports excludes the worktree being resolved.
WT_D_SELF=$(add_worktree "$ROOT_D" "self-wt")
WT_D_OTHER=$(add_worktree "$ROOT_D" "other-wt")
write_fixed_override "$WT_D_SELF" "self-wt" 3100
write_fixed_override "$WT_D_OTHER" "other-wt" 3200

SIBLING_PORTS_D1=$(_worktree_sibling_taken_ports "$ROOT_D" "$WT_D_SELF" | tr '\n' ' ')
assert_contains "groupD1: sibling scan reports the OTHER worktree's port" "3200" "$SIBLING_PORTS_D1"
assert_not_contains "groupD1: sibling scan excludes the SELF worktree's own port" "3100" "$SIBLING_PORTS_D1"

# --- D2: sticky start-offset survives a simulated repair regen even after
# the bucket that originally displaced the worktree frees up again.
WT_D_BLOCK2=$(add_worktree "$ROOT_D" "blocker2")
write_fixed_override "$WT_D_BLOCK2" "blocker2" 3020

# "wt92" hashes deterministically to bucket 2; blocker2 occupies it, so the
# FIRST resolution (no override yet for wt92) must land on bucket 3.
WT_D_TARGET=$(add_worktree "$ROOT_D" "wt92")
OFFSET_D_FIRST=$(_resolve_worktree_port_offset "$WT_D_TARGET" "wt92" "$ROOT_D" 2>/dev/null)
assert_eq "groupD2: first resolution avoids blocker2's bucket 2, lands on bucket 3" "3" "$OFFSET_D_FIRST"

# Persist that assignment as the worktree's own override (what
# create-worktree.sh would have written), THEN free bucket 2 by removing the
# blocker entirely.
write_fixed_override "$WT_D_TARGET" "wt92" 3030
git -C "$ROOT_D" worktree remove --force "$WT_D_BLOCK2" >/dev/null 2>&1

OFFSET_D_SECOND=$(_resolve_worktree_port_offset "$WT_D_TARGET" "wt92" "$ROOT_D" 2>/dev/null)
assert_eq "groupD2: repair regen stays STICKY on bucket 3, does not revert to freed bucket 2" "3" "$OFFSET_D_SECOND"

# =========================================================================
# Group E: concurrency (lock active / disabled negative control / forced mkdir)
# =========================================================================
ROOT_E=$(new_fixture_repo)
WT_E1=$(add_worktree "$ROOT_E" "smi-5641-remove-dead-dep-helpers")
WT_E2=$(add_worktree "$ROOT_E" "smi-5651-registry-catchup")

# Both worktree names hash to the SAME deterministic bucket 79 (the verified
# same-bucket pair, reused here to stress the exact real-world race). The
# SKILLSMITH_WORKTREE_PORT_TEST_DELAY seam widens the window between each
# racer's "read siblings" step and its "decide + write" step, so the race is
# reliably provoked rather than depending on real scheduler luck.
run_race() {
  # Runs both generate_docker_override calls concurrently against a clean
  # (no pre-existing override) starting state, waits for both, and prints
  # "PORTS1|PORTS2|RC1|RC2" to stdout.
  rm -f "$WT_E1/docker-compose.override.yml" "$WT_E2/docker-compose.override.yml"
  export SKILLSMITH_WORKTREE_PORT_TEST_DELAY=1

  ( generate_docker_override "$WT_E1" "smi-5641-remove-dead-dep-helpers" "$ROOT_E" ) &
  local pid1=$!
  ( generate_docker_override "$WT_E2" "smi-5651-registry-catchup" "$ROOT_E" ) &
  local pid2=$!

  local rc1=0 rc2=0
  wait "$pid1" || rc1=$?
  wait "$pid2" || rc2=$?
  unset SKILLSMITH_WORKTREE_PORT_TEST_DELAY

  local p1 p2
  p1="$(_parse_override_host_ports "$WT_E1/docker-compose.override.yml" | tr '\n' ' ')"
  p2="$(_parse_override_host_ports "$WT_E2/docker-compose.override.yml" | tr '\n' ' ')"
  printf '%s|%s|%s|%s\n' "$p1" "$p2" "$rc1" "$rc2"
}

# --- E1: lock active (flock if available, else the mkdir fallback -- both
# are the real production path depending on host; see file header).
SKILLSMITH_WORKTREE_PORT_LOCK_HOME=$(new_lock_home)
unset SKILLSMITH_WORKTREE_PORT_LOCK_DISABLE SKILLSMITH_WORKTREE_PORT_FORCE_MKDIR_LOCK 2>/dev/null || true
RESULT_E1="$(run_race)"
P1_E1="$(printf '%s' "$RESULT_E1" | cut -d'|' -f1)"
P2_E1="$(printf '%s' "$RESULT_E1" | cut -d'|' -f2)"
RC1_E1="$(printf '%s' "$RESULT_E1" | cut -d'|' -f3)"
RC2_E1="$(printf '%s' "$RESULT_E1" | cut -d'|' -f4)"
assert_eq "groupE1 (locked): worktree 1 succeeded" "0" "$RC1_E1"
assert_eq "groupE1 (locked): worktree 2 succeeded" "0" "$RC2_E1"
if ports_overlap "$P1_E1" "$P2_E1"; then
  echo "FAIL groupE1 (locked): concurrent resolutions collided (ports1='$P1_E1' ports2='$P2_E1')"
  fail=$((fail + 1))
else
  echo "PASS groupE1 (locked): concurrent resolutions landed on disjoint buckets"
  pass=$((pass + 1))
fi

# --- E2: negative/discrimination control. Locking DISABLED -> the identical
# race must actually COLLIDE, proving this harness has real discriminating
# power (i.e. E1's clean result is because the lock works, not because the
# fixture can't collide in the first place).
SKILLSMITH_WORKTREE_PORT_LOCK_HOME=$(new_lock_home)
export SKILLSMITH_WORKTREE_PORT_LOCK_DISABLE=1
RESULT_E2="$(run_race)"
unset SKILLSMITH_WORKTREE_PORT_LOCK_DISABLE
P1_E2="$(printf '%s' "$RESULT_E2" | cut -d'|' -f1)"
P2_E2="$(printf '%s' "$RESULT_E2" | cut -d'|' -f2)"
if ports_overlap "$P1_E2" "$P2_E2"; then
  echo "PASS groupE2 (lock disabled, negative control): race DOES collide as expected"
  pass=$((pass + 1))
else
  echo "FAIL groupE2 (lock disabled, negative control): race did NOT collide -- harness has no discriminating power (ports1='$P1_E2' ports2='$P2_E2')"
  fail=$((fail + 1))
fi

# --- E3: force the mkdir lock fallback even on a flock-equipped host (e.g.
# Linux CI), so that path gets real coverage everywhere, not just on stock
# macOS.
SKILLSMITH_WORKTREE_PORT_LOCK_HOME=$(new_lock_home)
export SKILLSMITH_WORKTREE_PORT_FORCE_MKDIR_LOCK=1
RESULT_E3="$(run_race)"
unset SKILLSMITH_WORKTREE_PORT_FORCE_MKDIR_LOCK
P1_E3="$(printf '%s' "$RESULT_E3" | cut -d'|' -f1)"
P2_E3="$(printf '%s' "$RESULT_E3" | cut -d'|' -f2)"
RC1_E3="$(printf '%s' "$RESULT_E3" | cut -d'|' -f3)"
RC2_E3="$(printf '%s' "$RESULT_E3" | cut -d'|' -f4)"
assert_eq "groupE3 (forced mkdir lock): worktree 1 succeeded" "0" "$RC1_E3"
assert_eq "groupE3 (forced mkdir lock): worktree 2 succeeded" "0" "$RC2_E3"
if ports_overlap "$P1_E3" "$P2_E3"; then
  echo "FAIL groupE3 (forced mkdir lock): concurrent resolutions collided (ports1='$P1_E3' ports2='$P2_E3')"
  fail=$((fail + 1))
else
  echo "PASS groupE3 (forced mkdir lock): concurrent resolutions landed on disjoint buckets"
  pass=$((pass + 1))
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "===== Results: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ] || exit 1
