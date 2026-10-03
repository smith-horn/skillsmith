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
# Usage: bash scripts/ci/use-lockfile-vercel.sh   (no arguments)
# Reads:  GITHUB_WORKSPACE, RUNNER_TEMP, GITHUB_PATH (set by the runner)
#   exit 0 - lockfile CLI verified, shim dir appended to $GITHUB_PATH
#   exit 1 - a check failed; an ::error:: line names the failing check
#
# Credentialed `vercel pull|build|deploy|dev` calls in the workflows use the
# absolute "$GITHUB_WORKSPACE/node_modules/.bin/vercel" and never resolve through
# this shim; the shim is defence in depth for anything that resolves `vercel` by
# name (a child process of the CLI). There is NO fallback to a global binary.
#
# Bash 3.2 compatible (no arrays, no mapfile, no ${var,,}). ASCII only.
set -euo pipefail

fail() {
  echo "::error::use-lockfile-vercel: $1: $2" >&2
  exit 1
}

[ -n "${GITHUB_WORKSPACE:-}" ] || fail "environment" "GITHUB_WORKSPACE is not set"
[ -n "${RUNNER_TEMP:-}" ] || fail "environment" "RUNNER_TEMP is not set"
[ -n "${GITHUB_PATH:-}" ] || fail "environment" "GITHUB_PATH is not set"

WS="$GITHUB_WORKSPACE"
BIN="$WS/node_modules/.bin/vercel"
VC_JS="$WS/node_modules/vercel/dist/vc.js"
SHIM_DIR="$RUNNER_TEMP/vercel-bin"

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

# 3. One-binary shim dir. Created now, appended to GITHUB_PATH only once every
#    check has passed, so a failed run leaves PATH untouched.
mkdir -p "$SHIM_DIR"
ln -sf "$BIN" "$SHIM_DIR/vercel"

# 4. Identity through the shim: the shim must resolve to the lockfile tree's
#    dist/vc.js, and the version check runs THROUGH the shim.
SHIM_REAL="$(njs 'console.log(require("fs").realpathSync(process.argv[1]))' "$SHIM_DIR/vercel")"
VC_REAL="$(njs 'console.log(require("fs").realpathSync(process.argv[1]))' "$VC_JS")"
if [ "$SHIM_REAL" != "$VC_REAL" ]; then
  fail "binary-identity" "shim resolves to '$SHIM_REAL', expected '$VC_REAL'"
fi
SHIM_VERSION="$("$SHIM_DIR/vercel" --version 2>/dev/null || true)"
if [ "$SHIM_VERSION" != "$LOCKED" ]; then
  fail "shim-version" "shim reports '$SHIM_VERSION', lockfile says '$LOCKED'"
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

# 6. Expose the shim dir to later steps. Only this dir, nothing else.
echo "$SHIM_DIR" >> "$GITHUB_PATH"

echo "vercel $LOCKED from lockfile; $CANARY_MSG"
