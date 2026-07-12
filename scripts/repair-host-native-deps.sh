#!/usr/bin/env bash
# audit:host-npm-required — see SMI-4814 (by-design host-side native binding rebuild per SMI-4549; cannot run in Docker)
#
# repair-host-native-deps.sh - Idempotent host-side native dep repair (SMI-4549, SMI-4912)
#
# The SMI-4381 worktree workflow uses `npm install --ignore-scripts` on the
# host, which skips node-gyp postinstall and leaves host-only consumers
# (the retrieval-logs writer in particular, packages/doc-retrieval-mcp/src/
# retrieval-log/writer.ts) without their compiled native bindings. The
# writer's openDb() silently catches the load error → logRetrievalEvent
# no-ops → instrumentation disappears for days. SMI-4549 RCA documents the
# 7-day soak that ran with zero captured rows.
#
# This script restores the binding. It is intentionally CHEAP on a healthy
# host: the first step is a require() probe that exits in <1s with [skip]
# when the binding already loads. Only on probe failure does it call
# `npm rebuild`.
#
# SMI-4912: it also repairs host-platform *prebuilt* native packages for the
# vitest stack — rollup and esbuild ship per-platform packages
# (@rollup/rollup-<os>-<arch>, @esbuild/<os>-<arch>). A host node_modules
# populated in a Linux context lacks the macOS variants, so the SMI-4681
# host-fallback pre-push vitest run dies with "Cannot find module
# @rollup/rollup-darwin-arm64". That phase runs first and is independent of
# the better-sqlite3 rebuild below.
#
# Host-only. Inside the Docker dev container (IS_DOCKER=true) the writer
# itself no-ops, and Docker's own postinstall handles its bindings — this
# script exits early so it doesn't fight that path.
#
# Usage:  ./scripts/repair-host-native-deps.sh
# Exit:   0 on success ([ok] or [skip]); non-zero with remediation hint on failure.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# --- Test seams (inert unless SKILLSMITH_NATIVE_DEPS_TEST=1) -----------------
# Let scripts/tests/repair-host-native-deps.test.ts (SMI-5654) drive the
# esbuild platform-package hardening below deterministically against a
# fixture tree — without mutating real host state, requiring network access,
# or running the (separate, already-covered) better-sqlite3 rebuild phase.
# Gated behind a single master switch so production behavior can never be
# hijacked by a stray env var, mirroring the SKILLSMITH_AUTOHEAL_TEST
# convention in scripts/retrieval-autoheal.sh.
NATIVE_DEPS_TEST="${SKILLSMITH_NATIVE_DEPS_TEST:-}"

if [[ "$NATIVE_DEPS_TEST" == "1" ]] && [[ -n "${SKILLSMITH_NATIVE_DEPS_REPO_ROOT:-}" ]]; then
  # Test seam: operate on a fixture tree instead of the real repo root.
  REPO_ROOT="$SKILLSMITH_NATIVE_DEPS_REPO_ROOT"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
  if [[ -z "$REPO_ROOT" ]]; then
    error "Not in a git repository."
  fi

  # Resolve to main repo if invoked from a worktree (writer's binding lives in
  # the main-repo node_modules; per-package symlinks resolve to it via SMI-4381).
  MAIN_GIT_DIR="$(get_main_git_dir "$REPO_ROOT")"
  if [[ "$MAIN_GIT_DIR" != "$REPO_ROOT/.git" ]] && [[ -n "$MAIN_GIT_DIR" ]]; then
    REPO_ROOT="$(dirname "$MAIN_GIT_DIR")"
  fi
fi

# Guard 1: don't run inside Docker — the container has its own postinstall path.
# SMI-5654 test seam: FORCE_NON_DOCKER lets scripts/tests exercise this
# script's logic inside the CI container (itself Docker), mirroring
# scripts/retrieval-autoheal.sh's identical seam.
if [[ "${IS_DOCKER:-}" == "true" ]] || [[ -f /.dockerenv ]]; then
  if ! { [[ "$NATIVE_DEPS_TEST" == "1" ]] && [[ "${SKILLSMITH_NATIVE_DEPS_FORCE_NON_DOCKER:-}" == "1" ]]; }; then
    printf '[skip] inside Docker — host-only script; container handles its own postinstall\n'
    exit 0
  fi
fi

cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# Phase 1 (SMI-4912): host-platform prebuilt native packages.
#
# rollup and esbuild ship native code as platform-specific *prebuilt* npm
# packages (@rollup/rollup-<os>-<arch>, @esbuild/<os>-<arch>), selected by
# npm via os/cpu fields. A host node_modules populated in a Linux context
# lacks the macOS variants, so the SMI-4681 macOS+worktree host-fallback
# vitest run dies with "Cannot find module @rollup/rollup-darwin-arm64".
#
# This phase NEVER calls exit — on [ok]/[skip]/warn it falls through to the
# better-sqlite3 repair below, so a doubly-broken host gets both repairs.
# ---------------------------------------------------------------------------
repair_platform_native_packages() {
  local platform arch timeout_cmd
  platform="$(node -p 'process.platform' 2>/dev/null || echo '')"
  arch="$(node -p 'process.arch' 2>/dev/null || echo '')"

  # SMI-5654 test seam: force platform/arch so scripts/tests can exercise
  # this darwin-only phase from the CI container (which reports linux).
  if [[ "$NATIVE_DEPS_TEST" == "1" ]]; then
    [[ -n "${SKILLSMITH_NATIVE_DEPS_TEST_PLATFORM:-}" ]] && platform="$SKILLSMITH_NATIVE_DEPS_TEST_PLATFORM"
    [[ -n "${SKILLSMITH_NATIVE_DEPS_TEST_ARCH:-}" ]] && arch="$SKILLSMITH_NATIVE_DEPS_TEST_ARCH"
  fi

  # macOS-only: the SMI-4681 host-fallback that needs this is macOS-only, and
  # Linux rollup naming carries a gnu/musl split that is out of scope here.
  if [[ "$platform" != "darwin" ]]; then
    printf '[skip] platform packages — host is %s, not darwin (rollup/esbuild repair is macOS-only)\n' "${platform:-unknown}"
    return 0
  fi

  # Bound a git-hook-triggered fetch so it cannot hang offline. macOS BSD
  # ships no `timeout`; Homebrew coreutils provides `gtimeout`. When neither
  # exists the fetch runs unbounded (npm's own retry/timeout still applies).
  timeout_cmd=""
  if command -v timeout >/dev/null 2>&1; then
    timeout_cmd="timeout 120"
  elif command -v gtimeout >/dev/null 2>&1; then
    timeout_cmd="gtimeout 120"
  fi

  # Materialize a zero-dependency prebuilt platform package into node_modules
  # via `npm pack` + extract. `npm install <pkg>` — even with --no-package-lock
  # — re-resolves the entire workspace dependency tree and aborts on any
  # pre-existing unsatisfiable transitive range (this repo currently has one).
  # `npm pack <spec>` fetches ONLY the named package and never touches the
  # project tree; these packages are binary leaves with no dependencies, so
  # pack+extract is complete, correct, and lockfile-neutral.
  # _install_platform_pkg <pkg> <version> <dest-dir>
  _install_platform_pkg() {
    local pkg="$1" version="$2" dest="$3" tmp tgz
    local tgz_glob
    if [[ "$NATIVE_DEPS_TEST" == "1" ]] && [[ -n "${SKILLSMITH_NATIVE_DEPS_FETCH_CMD:-}" ]]; then
      # SMI-5654 test seam: let scripts/tests simulate a fresh `npm pack` +
      # extract without hitting the network. The seam command receives the
      # target package/version/dest via env vars and owns populating $dest
      # (it must itself follow rm-then-mv/rm-then-cp semantics — never write
      # into an existing directory entry in place).
      SKILLSMITH_NATIVE_DEPS_FETCH_PKG="$pkg" \
      SKILLSMITH_NATIVE_DEPS_FETCH_VERSION="$version" \
      SKILLSMITH_NATIVE_DEPS_FETCH_DEST="$dest" \
        sh -c "$SKILLSMITH_NATIVE_DEPS_FETCH_CMD"
      return $?
    fi
    tmp="$(mktemp -d)" || return 1
    if ! $timeout_cmd npm pack "$pkg@$version" --pack-destination "$tmp" --silent >/dev/null 2>&1; then
      rm -rf "$tmp"; return 1
    fi
    # `npm pack` writes exactly one tarball into the fresh temp dir; resolve
    # it via glob (no `ls` parsing). Non-match leaves the literal pattern,
    # which `[[ -f ]]` rejects.
    tgz_glob=( "$tmp"/*.tgz )
    tgz="${tgz_glob[0]}"
    if [[ ! -f "$tgz" ]] || ! tar -xzf "$tgz" -C "$tmp" 2>/dev/null; then
      rm -rf "$tmp"; return 1
    fi
    rm -rf "$dest"
    mkdir -p "$(dirname "$dest")"
    if ! mv "$tmp/package" "$dest" 2>/dev/null; then
      rm -rf "$tmp"; return 1
    fi
    rm -rf "$tmp"
    return 0
  }

  # _repair_one <label> <require-probe> <parent-pkg> <platform-pkg>
  _repair_one_platform_pkg() {
    local label="$1" probe="$2" parent="$3" pkg="$4" version dest
    if node -e "$probe" >/dev/null 2>&1; then
      printf '[skip] %s host-platform package already loads\n' "$label"
      return 0
    fi
    version="$(node -p "require('$REPO_ROOT/node_modules/$parent/package.json').version" 2>/dev/null || echo '')"
    if [[ -z "$version" ]]; then
      warn "$label: probe failed but $parent is not installed at node_modules/$parent — skipping platform-package repair"
      return 0
    fi
    dest="$REPO_ROOT/node_modules/$pkg"
    info "$label host-platform package missing; fetching $pkg@$version ..."
    if _install_platform_pkg "$pkg" "$version" "$dest"; then
      if node -e "$probe" >/dev/null 2>&1; then
        printf '[ok] %s host-platform package installed (%s@%s)\n' "$label" "$pkg" "$version"
      else
        warn "$label: fetched $pkg@$version but the probe still fails — host pre-push may fail; manual recovery: npm pack $pkg@$version"
      fi
    else
      warn "$label: fetching $pkg@$version failed or timed out (offline?) — host pre-push may fail; retry online, or bypass with: git push --no-verify"
    fi
  }

  _repair_one_platform_pkg "rollup" \
    "require('rollup')" \
    "rollup" "@rollup/rollup-${platform}-${arch}"

  # SMI-5654 test seam: let the esbuild JS-API probe itself be overridden so
  # scripts/tests/repair-host-native-deps.test.ts can drive the CLI-dispatch
  # and foreign-platform checks below without a real, working esbuild install.
  local esbuild_js_probe="require('esbuild').transformSync('')"
  if [[ "$NATIVE_DEPS_TEST" == "1" ]] && [[ -n "${SKILLSMITH_NATIVE_DEPS_ESBUILD_API_PROBE:-}" ]]; then
    esbuild_js_probe="$SKILLSMITH_NATIVE_DEPS_ESBUILD_API_PROBE"
  fi

  _repair_one_platform_pkg "esbuild" \
    "$esbuild_js_probe" \
    "esbuild" "@esbuild/${platform}-${arch}"

  # SMI-5654: the JS-API probe above only exercises the require() path that
  # resolves @esbuild/<platform>-<arch>/bin/esbuild directly — it never
  # executes node_modules/esbuild/bin/esbuild, the CLI dispatch entry point
  # used by `npx esbuild`, node_modules/.bin/esbuild, and any npm script that
  # shells out to esbuild rather than requiring it. A corruption hitting only
  # the dispatch file passes the probe above silently. Sibling gap on the
  # container side (docker-entrypoint.sh's own validation loop, NOT touched
  # by this script): SMI-5352.
  _check_esbuild_cli_dispatch() {
    # Only meaningful when the JS-API path itself already works — when it
    # fails too, the repair above already handled (or reported) it.
    if ! node -e "$esbuild_js_probe" >/dev/null 2>&1; then
      return 0
    fi

    local dispatch_bin="$REPO_ROOT/node_modules/esbuild/bin/esbuild"
    local cli_bin="$REPO_ROOT/node_modules/.bin/esbuild"
    local platform_bin="$REPO_ROOT/node_modules/@esbuild/${platform}-${arch}/bin/esbuild"
    local out

    [[ -x "$cli_bin" ]] || return 0

    if out="$("$cli_bin" --version 2>/dev/null)" && [[ -n "$out" ]]; then
      printf '[skip] esbuild CLI dispatch already works (%s)\n' "$out"
      return 0
    fi

    if [[ ! -f "$platform_bin" ]]; then
      warn "esbuild CLI dispatch probe failed but verified-good platform binary $platform_bin is missing — skipping dispatch repair"
      return 0
    fi

    info "esbuild CLI dispatch (node_modules/esbuild/bin/esbuild) broken while the JS API still works; re-deriving from the verified-good platform package..."
    # SMI-5654: rm-then-cp is mandatory here — a plain cp onto the existing
    # (possibly hard-linked) dispatch binary writes into the shared inode in
    # place and corrupts the platform package's binary too.
    rm -f "$dispatch_bin"
    mkdir -p "$(dirname "$dispatch_bin")"
    if cp "$platform_bin" "$dispatch_bin"; then
      chmod +x "$dispatch_bin" 2>/dev/null || true
      if out="$("$cli_bin" --version 2>/dev/null)" && [[ -n "$out" ]]; then
        printf '[ok] esbuild CLI dispatch repaired (%s)\n' "$out"
      else
        warn "esbuild CLI dispatch repair ran but the probe still fails — manual recovery: rm node_modules/esbuild/bin/esbuild && cp node_modules/@esbuild/${platform}-${arch}/bin/esbuild node_modules/esbuild/bin/esbuild"
      fi
    else
      warn "esbuild CLI dispatch repair failed (copy from $platform_bin) — manual recovery: rm node_modules/esbuild/bin/esbuild && cp node_modules/@esbuild/${platform}-${arch}/bin/esbuild node_modules/esbuild/bin/esbuild"
    fi
  }
  _check_esbuild_cli_dispatch

  # SMI-5654 (plan-review addition — this is what would have caught this
  # incident's actual end-state): the CLI-dispatch probe above cannot detect
  # a corruption where the dispatch binary itself still works (it was
  # overwritten, in place, with a working same-shared-inode binary from a
  # DIFFERENT platform) while a platform package's OWN file is wrong — that
  # file is never executed on the host, only inside a Linux container. For
  # each @esbuild/linux-*/bin/esbuild present in the host tree, verify it
  # begins with ELF magic bytes; on mismatch, refetch a clean copy. Sibling
  # gap on the container side (NOT touched by this script): SMI-5352.
  _check_esbuild_foreign_platform_binaries() {
    local esbuild_dir="$REPO_ROOT/node_modules/esbuild"
    [[ -d "$esbuild_dir" ]] || return 0

    local version
    version="$(node -p "require('$esbuild_dir/package.json').version" 2>/dev/null || echo '')"
    [[ -z "$version" ]] && return 0

    local linux_dir bin_file magic pkg_name
    for linux_dir in "$REPO_ROOT"/node_modules/@esbuild/linux-*/; do
      [[ -d "$linux_dir" ]] || continue
      bin_file="${linux_dir}bin/esbuild"
      [[ -f "$bin_file" ]] || continue

      magic="$(head -c 4 "$bin_file" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n')"
      if [[ "$magic" == "7f454c46" ]]; then
        continue
      fi

      pkg_name="@esbuild/$(basename "${linux_dir%/}")"
      warn "$pkg_name/bin/esbuild is not an ELF binary (host-tree corruption, SMI-5654) — refetching..."
      # SMI-5654: rm-then-cp is mandatory here too — _install_platform_pkg's
      # rm-then-mv never writes into the corrupted directory entry in place,
      # so a shared-inode twin elsewhere in the tree is never touched.
      if _install_platform_pkg "$pkg_name" "$version" "${linux_dir%/}"; then
        magic="$(head -c 4 "$bin_file" 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n')"
        if [[ "$magic" == "7f454c46" ]]; then
          printf '[ok] %s repaired (ELF magic verified)\n' "$pkg_name"
        else
          warn "$pkg_name: refetched but bin/esbuild still fails the ELF check — manual recovery: rm -rf node_modules/@esbuild/$(basename "${linux_dir%/}") && npm pack $pkg_name@$version"
        fi
      else
        warn "$pkg_name: refetch failed or timed out (offline?) — manual recovery: npm pack $pkg_name@$version"
      fi
    done
  }
  _check_esbuild_foreign_platform_binaries
}

repair_platform_native_packages

if [[ "$NATIVE_DEPS_TEST" == "1" ]]; then
  # SMI-5654: test mode stops here — the better-sqlite3 rebuild phase below
  # is unrelated to this hardening and would otherwise attempt real rebuilds
  # against the fixture tree.
  exit 0
fi

probe_binding() {
  # Returns 0 if better-sqlite3 loads AND can open a database, non-zero otherwise.
  # The require() alone only loads the JS wrapper — the bindings() lookup
  # for the native .node file fires on `new Database(...)`. Without the open
  # call, a host with a missing binding probes green and bypasses the rebuild.
  # Stderr swallowed — callers print their own diagnostics on failure.
  # Optional first arg: cwd to probe from (defaults to current dir). This lets
  # the script probe workspace-local copies in packages/<pkg>/node_modules/.
  local probe_cwd="${1:-$PWD}"
  (cd "$probe_cwd" && node -e "const D=require('better-sqlite3'); new D(':memory:').close()" >/dev/null 2>&1)
}

# Workspace-local better-sqlite3 copies. SMI-4702 retro learning:
# `npm rebuild` at the workspace root only rebuilds the root copy. Packages
# that have their own `node_modules/better-sqlite3` (because better-sqlite3
# is a direct dep, not hoisted) keep stale binaries until rebuilt
# explicitly. mcp-server and enterprise hoist to root and don't need this.
WORKSPACE_BSQLITE_DIRS=(
  "packages/core/node_modules/better-sqlite3"
  "packages/doc-retrieval-mcp/node_modules/better-sqlite3"
)

probe_workspace_bindings() {
  # Returns 0 only if EVERY workspace-local copy that exists also loads.
  # Missing dirs are not failures — that workspace doesn't have a local copy.
  local d
  for d in "${WORKSPACE_BSQLITE_DIRS[@]}"; do
    if [[ -d "$d" ]]; then
      if ! probe_binding "$d"; then
        return 1
      fi
    fi
  done
  return 0
}

# Guard 2: cheap healthy-path probe. Should be the FIRST thing this script
# does so that calls from repair-worktrees.sh stay sub-second on a healthy host.
# SMI-4702 retro: also probe workspace-local copies; the root probe being
# green doesn't mean packages/<pkg>/node_modules/better-sqlite3 are healthy.
if probe_binding && probe_workspace_bindings; then
  printf '[skip] better-sqlite3 binding already loaded (root + workspace-local)\n'
  exit 0
fi

# Guard 3: Node version sanity — npm rebuild compiles against the *current*
# Node's headers, but the user may be running a Node that doesn't match the
# project's pin. Building against the wrong ABI succeeds and then fails on
# load, which is exactly the failure shape we're trying to prevent recurring.
NODE_CURRENT="$(node --version | sed 's/^v//')"
NODE_PINNED=""
if [[ -f .nvmrc ]]; then
  NODE_PINNED="$(tr -d '[:space:]' < .nvmrc)"
fi

if [[ -n "$NODE_PINNED" ]]; then
  # .nvmrc may be a partial version (e.g. "22.22"); accept any current Node
  # whose version starts with the pinned prefix.
  if [[ "$NODE_CURRENT" != "$NODE_PINNED"* ]]; then
    error "Node version mismatch: current $NODE_CURRENT, pinned $NODE_PINNED (.nvmrc).

  Switch to the pinned Node before rebuilding:
    nvm use            # reads .nvmrc
  Then re-run:
    ./scripts/repair-host-native-deps.sh"
  fi
fi

info "better-sqlite3 binding missing/broken; rebuilding from source..."
info "(this can take 30-60s on first run)"

# Capture rebuild output so we can show the tail on failure without flooding
# the caller's terminal on success.
REBUILD_LOG="$(mktemp -t skillsmith-rebuild-better-sqlite3.XXXXXX)"
trap 'rm -f "$REBUILD_LOG"' EXIT

if ! npm rebuild better-sqlite3 --build-from-source >"$REBUILD_LOG" 2>&1; then
  printf '\n--- npm rebuild output (tail) ---\n'
  tail -20 "$REBUILD_LOG"
  printf '\n'
  error "npm rebuild better-sqlite3 failed.

  Common causes:
    - missing build toolchain (Xcode CLT on macOS, build-essential on Linux)
    - Node header download failure (corporate proxy / offline)
    - C++ toolchain version mismatch

  Diagnose:
    cat $REBUILD_LOG
  Then re-run this script."
fi

# Re-probe — building succeeded, but did the binding actually load?
#
# SMI-4780: `npm rebuild better-sqlite3 --build-from-source` reports exit 0 and
# stdout claims a successful rebuild, but on macOS Docker Desktop the binary
# at build/Release/better_sqlite3.node sometimes isn't actually written. The
# v0.6.0 / v0.5.0 release session (2026-05-06) hit this and only recovered
# by running `cd node_modules/better-sqlite3 && npm run build-release`
# directly — same fallback the workspace-local loop already uses below.
#
# Apply the same fallback at the root level before erroring out: drop the
# stale binary, run `npm run build-release` from inside the package, then
# re-probe. Only if THAT also fails do we surface the ABI mismatch error.
ROOT_BSQLITE_DIR="node_modules/better-sqlite3"
if ! probe_binding; then
  if [[ -d "$ROOT_BSQLITE_DIR" ]]; then
    info "root npm rebuild reported success but binding still missing"
    info "  → applying SMI-4780 fallback: build-release from inside $ROOT_BSQLITE_DIR"
    FALLBACK_LOG="$(mktemp -t skillsmith-rebuild-root-fallback.XXXXXX)"
    if (cd "$ROOT_BSQLITE_DIR" && rm -f build/Release/better_sqlite3.node && npm run build-release) >"$FALLBACK_LOG" 2>&1; then
      rm -f "$FALLBACK_LOG"
    else
      printf '\n--- root build-release fallback output (tail) ---\n'
      tail -20 "$FALLBACK_LOG"
      printf '\n'
      rm -f "$FALLBACK_LOG"
    fi
  fi
fi

if ! probe_binding; then
  printf '\n--- npm rebuild output (tail) ---\n'
  tail -20 "$REBUILD_LOG"
  printf '\n'
  error "rebuild completed but require('better-sqlite3') still fails.

  This usually means the rebuild produced a binary for a different Node ABI
  than the one currently running. Confirm:
    node -p \"process.versions.modules\"
  matches the binding path under node_modules/better-sqlite3/lib/binding/.

  Then:
    rm -rf node_modules/better-sqlite3
    npm install better-sqlite3
    ./scripts/repair-host-native-deps.sh"
fi

printf '[ok] better-sqlite3 binding loaded (root)\n'

# SMI-4702 retro: workspace-local copies. Rebuild any that fail to load.
# This MUST run after the root rebuild because it builds against the same
# Node ABI, and we already validated the toolchain works on the root copy.
WORKSPACE_REBUILT=0
WORKSPACE_FAILED=()
for d in "${WORKSPACE_BSQLITE_DIRS[@]}"; do
  if [[ ! -d "$d" ]]; then
    continue
  fi
  if probe_binding "$d"; then
    continue
  fi
  info "rebuilding workspace-local copy: $d"
  WORKSPACE_LOG="$(mktemp -t skillsmith-rebuild-ws-bsqlite3.XXXXXX)"
  if ! (cd "$d" && rm -f build/Release/better_sqlite3.node && npm run build-release) >"$WORKSPACE_LOG" 2>&1; then
    printf '\n--- workspace rebuild output (tail, %s) ---\n' "$d"
    tail -20 "$WORKSPACE_LOG"
    printf '\n'
    WORKSPACE_FAILED+=("$d")
    rm -f "$WORKSPACE_LOG"
    continue
  fi
  rm -f "$WORKSPACE_LOG"
  if ! probe_binding "$d"; then
    WORKSPACE_FAILED+=("$d")
    continue
  fi
  WORKSPACE_REBUILT=$((WORKSPACE_REBUILT + 1))
  printf '[ok] better-sqlite3 binding loaded (%s)\n' "$d"
done

if [[ ${#WORKSPACE_FAILED[@]} -gt 0 ]]; then
  error "Workspace-local rebuild failed for: ${WORKSPACE_FAILED[*]}.

  Manual recovery:
    cd <failed-dir> && rm -rf build && npm run build-release
  Then re-run this script."
fi

if [[ "$WORKSPACE_REBUILT" -gt 0 ]]; then
  printf '[ok] %d workspace-local copy/copies rebuilt\n' "$WORKSPACE_REBUILT"
fi
