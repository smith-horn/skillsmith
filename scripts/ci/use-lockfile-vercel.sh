#!/usr/bin/env bash
# SMI-6944 - single source of truth for "the Vercel CLI a credentialed CI job
# runs is the one the lockfile resolved". A global `npm i -g vercel@X` has no
# root package.json, so root `overrides` never reach it (smol-toml 1.5.2 shipped
# in the deploy binary while the lockfile held 1.9.0). This step checks the
# lockfile copy installed by the job's own `npm ci`, and exposes it on PATH
# through a one-binary shim dir so nothing else on PATH moves.
#
# Primary invariant: BINARY IDENTITY. The binary is the one the lockfile
# pinned (realpath + installed version == lockfile packages["node_modules/vercel"]
# .version). The smol-toml check is a named canary on top of it.
#
# Usage: bash scripts/ci/use-lockfile-vercel.sh                       (install mode)
#        bash scripts/ci/use-lockfile-vercel.sh --verify-only         (re-check, no PATH write)
#        bash scripts/ci/use-lockfile-vercel.sh --check-build-log F   (scan a `vercel build` log)
# Reads:  GITHUB_WORKSPACE (absolute), RUNNER_TEMP, GITHUB_PATH (set by the runner;
#         the last two only in install mode)
#   exit 0 - lockfile CLI verified (install mode: shim dir appended to $GITHUB_PATH)
#   exit 1 - a check failed; an ::error:: line names the failing check
#
# `vercel build` runs vercel.json's installCommand (`npm install`) and may fetch
# builders, so the tree is not guaranteed unchanged after the install-mode step.
# --verify-only re-runs identity + version + canary at the top of each credentialed
# `vercel deploy` step; --check-build-log fails on a runtime builder install.
#
# Credentialed `vercel pull|build|deploy|dev` calls in the workflows use the
# absolute "$GITHUB_WORKSPACE/node_modules/.bin/vercel" and never resolve through
# this shim; the shim (`vercel` and its alias `vc`) is defence in depth for
# anything that resolves either name (a child process of the CLI). There is NO
# fallback to a global binary.
#
# Bash 3.2 compatible (no arrays, no mapfile, no ${var,,}). ASCII only.
set -euo pipefail

fail() {
  echo "::error::use-lockfile-vercel: $1: $2" >&2
  exit 1
}

MODE="install"
case "${1:-}" in
  "")
    [ "$#" -eq 0 ] || fail "usage" "unexpected empty argument"
    ;;
  --verify-only)
    [ "$#" -eq 1 ] || fail "usage" "--verify-only takes no further arguments"
    MODE="verify"
    ;;
  --check-build-log)
    [ "$#" -eq 2 ] && [ -n "$2" ] || fail "usage" "--check-build-log takes exactly one file argument"
    BUILD_LOG="$2"
    # A builder fetched at build time is code outside the lockfile. The log must
    # exist AND be non-empty: an empty log is "not evaluated", never "clean".
    [ -s "$BUILD_LOG" ] || fail "build-log" "$BUILD_LOG is missing or empty; the build output was not captured, so it was not evaluated"
    if grep -Eq '^[[:space:]]*Installing Builder' "$BUILD_LOG"; then
      fail "builder-install" "vercel build fetched a builder at runtime (outside the lockfile): $(grep -E '^[[:space:]]*Installing Builder' "$BUILD_LOG" | head -1)"
    fi
    echo "vercel build log $BUILD_LOG holds no runtime builder install"
    exit 0
    ;;
  *)
    fail "usage" "unknown argument '$1' (expected none, --verify-only or --check-build-log FILE)"
    ;;
esac

[ -n "${GITHUB_WORKSPACE:-}" ] || fail "environment" "GITHUB_WORKSPACE is not set"
case "$GITHUB_WORKSPACE" in
  /*) ;;
  *) fail "environment" "GITHUB_WORKSPACE must be an absolute path, got '$GITHUB_WORKSPACE'" ;;
esac
if [ "$MODE" = "install" ]; then
  [ -n "${RUNNER_TEMP:-}" ] || fail "environment" "RUNNER_TEMP is not set"
  [ -n "${GITHUB_PATH:-}" ] || fail "environment" "GITHUB_PATH is not set"
fi

WS="$GITHUB_WORKSPACE"
BIN="$WS/node_modules/.bin/vercel"
VC_JS="$WS/node_modules/vercel/dist/vc.js"
SHIM_DIR="${RUNNER_TEMP:-}/vercel-bin"

# Run a JS snippet with node; arguments are positional (process.argv.slice(1)).
njs() {
  local code="$1"
  shift
  node -e "$code" -- "$@"
}

# 1. The lockfile copy must exist. Never fall back to a global binary.
if [ ! -x "$BIN" ]; then
  fail "binary-present" "$BIN is missing or not executable; run npm ci earlier in this job"
fi

# 2. Pin, lockfile and installed version must agree.
PINNED="$(njs 'console.log(require(process.argv[1]).devDependencies.vercel || "")' "$WS/package.json")"
LOCKED="$(njs 'const p=require(process.argv[1]).packages["node_modules/vercel"];console.log(p&&p.version||"")' "$WS/package-lock.json")"
[ -n "$LOCKED" ] || fail "lockfile-entry" "package-lock.json has no packages[\"node_modules/vercel\"].version"
if [ "$PINNED" != "$LOCKED" ]; then
  fail "pin-matches-lockfile" "package.json devDependencies.vercel is '$PINNED' but the lockfile resolved '$LOCKED'"
fi
INSTALLED="$("$BIN" --version 2>/dev/null || true)"
if [ "$INSTALLED" != "$LOCKED" ]; then
  fail "installed-version" "$BIN reports '$INSTALLED', lockfile says '$LOCKED'"
fi

# 3. Identity. The CLI tree must be the real lockfile install, not a symlink to
#    somewhere else: a symlinked node_modules/vercel (or dist/vc.js) makes every
#    realpath comparison between two paths into the SAME out-of-tree CLI pass, so
#    the expected path is built LITERALLY from the real workspace path.
WS_REAL="$(njs 'console.log(require("fs").realpathSync(process.argv[1]))' "$WS")"
EXPECTED_REAL="$WS_REAL/node_modules/vercel/dist/vc.js"
if [ -L "$WS/node_modules/vercel" ]; then
  fail "binary-identity" "$WS/node_modules/vercel is a symlink; the lockfile install is a real directory"
fi
if [ -L "$VC_JS" ]; then
  fail "binary-identity" "$VC_JS is a symlink; the lockfile install is a real file"
fi
BIN_REAL="$(njs 'console.log(require("fs").realpathSync(process.argv[1]))' "$BIN")"
if [ "$BIN_REAL" != "$EXPECTED_REAL" ]; then
  fail "binary-identity" "$BIN resolves to '$BIN_REAL', expected '$EXPECTED_REAL'"
fi

# 4. Install mode only: one-binary shim dir (`vercel` and its alias `vc`), created
#    now and appended to GITHUB_PATH only once every check has passed, so a failed
#    run leaves PATH untouched. Identity is re-proved through each shim name, and
#    the version check runs THROUGH the shim.
if [ "$MODE" = "install" ]; then
  mkdir -p "$SHIM_DIR"
  ln -sf "$BIN" "$SHIM_DIR/vercel"
  ln -sf "$BIN" "$SHIM_DIR/vc"
  for name in vercel vc; do
    SHIM_REAL="$(njs 'console.log(require("fs").realpathSync(process.argv[1]))' "$SHIM_DIR/$name")"
    if [ "$SHIM_REAL" != "$EXPECTED_REAL" ]; then
      fail "binary-identity" "shim $name resolves to '$SHIM_REAL', expected '$EXPECTED_REAL'"
    fi
  done
  SHIM_VERSION="$("$SHIM_DIR/vercel" --version 2>/dev/null || true)"
  if [ "$SHIM_VERSION" != "$LOCKED" ]; then
    fail "shim-version" "shim reports '$SHIM_VERSION', lockfile says '$LOCKED'"
  fi
fi

# 5. Canary: resolve smol-toml from the CLI's REAL path, the way the CLI does,
#    and require the root override's floor. Skipped when the override is gone
#    (its removal is planned); binary identity above still gates.
FLOOR="$(njs 'const o=(require(process.argv[1]).overrides||{})["smol-toml"]||"";const m=String(o).match(/(\d+)\.(\d+)\.(\d+)/);console.log(m?m[0]:"")' "$WS/package.json")"
if [ -n "$FLOOR" ]; then
  CANARY="$(njs '
const fs = require("fs"), path = require("path")
const cli = fs.realpathSync(path.join(process.argv[1], "node_modules/vercel"))
let entry
try { entry = require.resolve("smol-toml", { paths: [cli] }) }
catch (e) { console.error("cannot resolve smol-toml from " + cli); process.exit(2) }
let dir = path.dirname(entry)
while (true) {
  const pj = path.join(dir, "package.json")
  if (fs.existsSync(pj) && require(pj).name === "smol-toml") break
  const up = path.dirname(dir)
  if (up === dir) { console.error("no smol-toml package.json above " + entry); process.exit(2) }
  dir = up
}
const v = require(path.join(dir, "package.json")).version
const a = v.split(".").map(Number), b = process.argv[2].split(".").map(Number)
let cmp = 0
for (let i = 0; i < 3 && cmp === 0; i++) cmp = (a[i] || 0) - (b[i] || 0)
console.log(v + " " + dir)
process.exit(cmp >= 0 ? 0 : 1)
' "$WS" "$FLOOR")" && CANARY_RC=0 || CANARY_RC=$?
  if [ "$CANARY_RC" -ne 0 ]; then
    fail "smol-toml-canary" "vercel resolves smol-toml '${CANARY:-unresolvable}' (floor >= $FLOOR from package.json overrides)"
  fi
  CANARY_MSG="smol-toml ${CANARY%% *} at ${CANARY#* }"
else
  CANARY_MSG="smol-toml canary skipped: no override recorded"
fi

# 6. Install mode: expose the shim dir to later steps. Only this dir, nothing else.
if [ "$MODE" = "install" ]; then
  echo "$SHIM_DIR" >> "$GITHUB_PATH"
fi

if [ "$MODE" = "verify" ]; then
  echo "vercel $LOCKED from lockfile (verify-only); $CANARY_MSG"
else
  echo "vercel $LOCKED from lockfile; $CANARY_MSG"
fi
