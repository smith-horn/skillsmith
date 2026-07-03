#!/bin/sh
# scripts/lib/check-native-modules.sh
# SMI-5513: Container native-binding health preflight.
#
# Catches the failure mode where a bare `npm install` in the dev container
# (with .npmrc ignore-scripts=true) leaves better-sqlite3 unbuilt ("invalid ELF
# header"), which otherwise surfaces DOWNSTREAM as ~51 cryptic
# `db.close()`-on-undefined failures in unrelated test suites during the
# pre-push coverage phase. Turn that invisible failure into a loud, actionable
# one — fail fast with the exact remedy BEFORE the Phase 2/4 test runs.
#
# Probe strategy: load better-sqlite3 THROUGH its real consumer —
# `@skillsmith/core`'s createDatabaseSync — not a root-level
# `require('better-sqlite3')`. better-sqlite3 has non-hoisted workspace-local
# copies (packages/core/node_modules, packages/doc-retrieval-mcp/...), so a root
# probe can pass while the copy the tests actually use is broken. The consumer
# path resolves whichever copy core uses, and the SYNC path has no WASM fallback,
# so a broken binding fails loudly — exactly what the DB/repository tests hit.
#
# Runs only when the pre-push TESTS run in the container (USE_DOCKER=1). On the
# host-fallback route (macOS worktree without SKILLSMITH_PRE_PUSH_DOCKER) the
# tests use the WASM fallback, so a container native binding is irrelevant.
#
# READ-ONLY (P-5): loads a module + opens an in-memory DB; never mutates the tree.
# Opt-out: SKILLSMITH_SKIP_NATIVE_CHECK=1 (see docs/internal/process/guards-and-opt-outs.md).
#
# POSIX sh — no `local`, no `[[ ]]`, no arrays.

# Opt-out escape hatch.
if [ "${SKILLSMITH_SKIP_NATIVE_CHECK:-0}" = "1" ]; then
    exit 0
fi

# Test seam (SMI-5513): let the vitest suite drive the probe deterministically
# without a real container. SKILLSMITH_NATIVE_CHECK_TEST forces the code path:
#   ok   -> behave as if the probe passed (exit 0)
#   fail -> emit the remedy and exit 1
if [ -n "${SKILLSMITH_NATIVE_CHECK_TEST:-}" ]; then
    case "$SKILLSMITH_NATIVE_CHECK_TEST" in
        ok)   exit 0 ;;
        fail) USE_DOCKER=1 ; run_cmd() { return 1; } ;;
        *)    exit 0 ;;
    esac
else
    # Source the shared Docker-vs-host detection (USE_DOCKER, run_cmd, RUN_PREFIX).
    # Graceful degradation: if the helper is absent (older branch), skip.
    DETECT_LIB="$(dirname "$0")/hook-docker-detect.sh"
    if [ ! -r "$DETECT_LIB" ]; then
        exit 0
    fi
    # shellcheck source=./hook-docker-detect.sh
    . "$DETECT_LIB"

    # Only meaningful when the pre-push tests actually run in the container.
    if [ "${USE_DOCKER:-0}" != "1" ]; then
        exit 0
    fi
fi

# Probe better-sqlite3 through its real consumer.
if run_cmd node -e "require('@skillsmith/core').createDatabaseSync(':memory:').close()" >/dev/null 2>&1; then
    exit 0
fi

# Broken (or unbuilt) — surface the one-line remedy instead of a 51-test cascade.
RED="${HOOK_DETECT_RED:-\033[0;31m}"
YELLOW="${HOOK_DETECT_YELLOW:-\033[1;33m}"
NC="${HOOK_DETECT_NC:-\033[0m}"
printf '\n'
printf "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
printf "${RED}  ✗ Native SQLite binding is broken in the dev container${NC}\n"
printf "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
printf '\n'
printf '  @skillsmith/core could not open a database (better-sqlite3 binding).\n'
printf '  This usually follows a bare `npm install` in the container: .npmrc\n'
printf '  ignore-scripts=true leaves the native binding unbuilt ("invalid ELF\n'
printf '  header"). Left unfixed it surfaces later as dozens of cryptic\n'
printf '  `db.close()`-on-undefined test failures in unrelated suites.\n'
printf '\n'
printf "  ${YELLOW}Fix — self-heal the native modules:${NC}\n"
printf '    docker compose --profile dev restart dev\n'
printf '\n'
printf "  ${YELLOW}Regenerate the lockfile WITHOUT wiping natives (never bare npm install):${NC}\n"
printf '    ./scripts/regen-lockfile.sh\n'
printf '\n'
printf "  ${YELLOW}Certain it is a false positive?${NC} SKILLSMITH_SKIP_NATIVE_CHECK=1 git push\n"
printf '\n'
exit 1
