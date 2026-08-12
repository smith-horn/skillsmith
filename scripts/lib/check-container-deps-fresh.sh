#!/bin/sh
# scripts/lib/check-container-deps-fresh.sh
# SMI-6006: container-internal node_modules freshness self-heal.
#
# skillsmith-dev-1 (the main checkout's own container) uses Docker named
# volumes for node_modules — disconnected from the host filesystem entirely
# (confirmed via `docker inspect --format '{{ range .Mounts }}'`). The
# existing host-tree sentinel (scripts/lib/check-node-modules-fresh.sh,
# SMI-5343/5344) only ever measures the HOST tree, which every worktree
# container reads read-only — it has no visibility into skillsmith-dev-1's
# own, independently-drifting volumes. When a dependency merges to
# origin/main, this container silently falls behind until someone happens to
# run `docker exec skillsmith-dev-1 npm install` by hand; pre-push's
# Docker-routed test phase then fails deep inside vitest with a confusing
# "Cannot find module" that reads like an installation bug. See
# docs/internal/implementation/smi-6006-container-deps-freshness.md.
#
# Scope: main checkout ONLY (USE_DOCKER=1 && IS_WORKTREE=0). A worktree's own
# container mounts node_modules :ro (SMI-5560/5626/5650) — an npm install
# attempt there hits EROFS by design, and a worktree's drift is already
# covered transitively by the host-tree sentinel (every worktree reads that
# same host tree).
#
# Why this is a STANDALONE script, not folded into hook-docker-detect.sh:
# .husky/pre-commit sources hook-docker-detect.sh too, and pre-commit's own
# node_modules guard is explicitly WARN-only / READ-ONLY by policy (see
# .husky/pre-commit's own comment on that guard) — the highest-frequency git
# gate must never manufacture --no-verify pressure. A mutating npm install
# folded into a file pre-commit sources would silently violate that policy.
# This script is invoked ONLY from .husky/pre-push, exactly once, following
# the same idiom as scripts/lib/check-native-modules.sh next to it.
#
# Concurrency: `docker exec` does NOT serialize — each invocation is an
# independent process, so two concurrent pushes could both observe drift and
# both run `npm install` at once. The entire check -> install ->
# write-sentinel sequence therefore runs as ONE continuous in-container
# process (a single `docker exec` invoking check-container-deps-fresh-inner.sh
# as a file), guarded by a `mkdir`-based lock whose owner token is meaningful
# for the whole critical section (every `docker exec` into one container
# shares that container's PID namespace, so `kill -0 <pid>` from a second
# exec correctly reflects whether the first exec's long-lived process is
# still running). A naive design that recorded an owner token from a
# short-lived `mkdir`-only exec would be unsound — that process exits the
# instant `mkdir` returns, leaving no live PID to check staleness against.
# See check-container-deps-fresh-inner.sh for the actual lock/reclaim/release
# implementation and its own unit tests.
#
# This does NOT create mutual exclusion against a test suite already running
# in the same container (session A's self-heal can finish and release the
# lock while A's own tests start, and session B's self-heal can then
# reacquire the lock and mutate node_modules mid-test-run for A). Closing
# that fully would mean extending this lock into pre-push-coverage-check.sh's
# test-execution phase as a proper reader/writer lock — out of scope here,
# and not a new hazard: a human running `docker exec skillsmith-dev-1 npm
# install` by hand today has the identical race. skillsmith-dev-1 is also
# meant to be used by one queen session at a time per CLAUDE.md's default
# execution model — concurrent work happens on worktrees with their own
# independent containers, untouched by this script.
#
# Opt-out: SKILLSMITH_SKIP_CONTAINER_DEPS_FRESHNESS=1 (registered in
# docs/internal/process/guards-and-opt-outs.md).
# Test seam: SKILLSMITH_CONTAINER_DEPS_TEST=ok|fail|stale-heal|lock-timeout
# forces the code path without a real container, mirroring
# check-native-modules.sh's own SKILLSMITH_NATIVE_CHECK_TEST pattern.
#
# POSIX sh — no `local`, no `[[ ]]`, no arrays.

if [ "${SKILLSMITH_SKIP_CONTAINER_DEPS_FRESHNESS:-0}" = "1" ]; then
    exit 0
fi

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

# Test seam — deterministic, no real container.
if [ -n "${SKILLSMITH_CONTAINER_DEPS_TEST:-}" ]; then
    case "$SKILLSMITH_CONTAINER_DEPS_TEST" in
        ok)          exit 0 ;;
        stale-heal)  printf "${YELLOW}🔧 (test) self-healing...${NC}\n"; exit 0 ;;
        fail)
            printf "${RED}✗ (test) npm install failed inside skillsmith-dev-1${NC}\n" >&2
            exit 1
            ;;
        lock-timeout)
            printf "${RED}✗ (test) lock timeout — another push is syncing dependencies${NC}\n" >&2
            exit 1
            ;;
        *) exit 0 ;;
    esac
fi

# Source the shared Docker-vs-host detection (USE_DOCKER, IS_WORKTREE,
# DOCKER_CONTAINER). Graceful degradation: if the helper is absent (older
# branch), skip — nothing to self-heal against without knowing the container.
DETECT_LIB="$(dirname "$0")/hook-docker-detect.sh"
if [ ! -r "$DETECT_LIB" ]; then
    exit 0
fi
# shellcheck source=./hook-docker-detect.sh
. "$DETECT_LIB"

# Only meaningful for the main checkout's own container. Worktree containers
# mount node_modules :ro (self-heal there would EROFS) and are already
# covered by the host-tree sentinel via the shared host mount.
if [ "${USE_DOCKER:-0}" != "1" ] || [ "${IS_WORKTREE:-0}" != "0" ]; then
    exit 0
fi

# Single long-lived in-container process: acquire -> re-check -> install ->
# write-sentinel -> release. $$ inside this one `sh -c` is stable for the
# entire critical section, so it is a meaningful, checkable lock owner.
# Tunables forwarded into the container via `-e` (never interpolated into
# the script text itself — keeps the single-quoted script free of escaping
# hazards). Defaults: ~90s bound (45 * 2s). Tests shrink these via
# SKILLSMITH_LOCK_MAX_TRIES / SKILLSMITH_LOCK_SLEEP_SECS on the HOST side;
# there is no legitimate reason to tune these in production.
LOCK_MAX_TRIES="${SKILLSMITH_LOCK_MAX_TRIES:-45}"
LOCK_SLEEP_SECS="${SKILLSMITH_LOCK_SLEEP_SECS:-2}"
# A non-numeric or negative override (host env drift, typo) would otherwise
# reach the container and corrupt the retry loop there — validate and fall
# back to the safe default rather than propagating garbage.
case "$LOCK_MAX_TRIES" in
    ''|*[!0-9]*) LOCK_MAX_TRIES=45 ;;
esac
case "$LOCK_SLEEP_SECS" in
    ''|*[!0-9]*) LOCK_SLEEP_SECS=2 ;;
esac

# The actual lock + self-heal logic lives in check-container-deps-fresh-inner.sh
# (bind-mounted into the container the same way check-node-modules-fresh.sh
# already is) — invoked directly as a file, not inlined as a string, so
# there's no shell-quoting hazard and the inner script's functions can be
# unit-tested by sourcing it directly (see its own test seam). It still runs
# as ONE continuous docker-exec process — see that file's header for why.
OUTPUT="$(docker exec -w /app -e SKILLSMITH_LOCK_MAX_TRIES="$LOCK_MAX_TRIES" -e SKILLSMITH_LOCK_SLEEP_SECS="$LOCK_SLEEP_SECS" "$DOCKER_CONTAINER" sh scripts/lib/check-container-deps-fresh-inner.sh 2>&1)"
RC=$?

case "$OUTPUT" in
    *SELF_HEAL_START*)
        printf "${YELLOW}🔧 %s's own node_modules is stale vs package-lock.json — self-healing...${NC}\n" "$DOCKER_CONTAINER"
        ;;
esac

if [ "$RC" -eq 0 ]; then
    case "$OUTPUT" in
        *SELF_HEAL_START*)
            printf "${GREEN}  ✓ Self-healed — %s's node_modules now matches package-lock.json${NC}\n" "$DOCKER_CONTAINER"
            ;;
    esac
    exit 0
fi

printf '\n'
printf "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
case "$RC" in
    3)
        printf "${RED}  ✗ Timed out waiting for %s's dependency lock${NC}\n" "$DOCKER_CONTAINER"
        printf "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
        printf '\n'
        printf '  Another push (or session) appears to be syncing this container'\''s\n'
        printf '  dependencies right now. Wait a moment and retry — this is not a\n'
        printf '  problem with your change.\n'
        ;;
    4)
        printf "${RED}  ✗ Failed to self-heal %s's node_modules${NC}\n" "$DOCKER_CONTAINER"
        printf "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
        printf '\n'
        printf '  `npm install` failed inside the container (see output below) —\n'
        printf '  refusing to run tests against a known-stale dependency tree.\n'
        printf '\n'
        printf '  %s\n' "$OUTPUT"
        printf '\n'
        printf "  ${YELLOW}Fix — retry manually:${NC}\n"
        printf '    docker exec %s npm install\n' "$DOCKER_CONTAINER"
        ;;
    *)
        # Any other code (docker itself failing, sh unable to start, an
        # unexpected error inside check-container-deps-fresh-inner.sh) is NOT
        # an npm failure — misreporting it as one would send someone chasing
        # the wrong fix.
        printf "${RED}  ✗ Container dependency guard failed unexpectedly (exit %s)${NC}\n" "$RC"
        printf "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
        printf '\n'
        printf '  This was not an npm install failure — something else went wrong\n'
        printf '  running the self-heal check inside %s (see output below).\n' "$DOCKER_CONTAINER"
        printf '\n'
        printf '  %s\n' "$OUTPUT"
        ;;
esac
printf '\n'
printf "  ${YELLOW}Certain it is a false positive?${NC} SKILLSMITH_SKIP_CONTAINER_DEPS_FRESHNESS=1 git push\n"
printf '\n'
exit 1
