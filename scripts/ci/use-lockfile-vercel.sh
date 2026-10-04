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
# Reads:  GITHUB_WORKSPACE (absolute); install mode also RUNNER_TEMP, GITHUB_PATH
#         and GITHUB_OUTPUT; verify mode also VERCEL_CLI_DIGEST
#   exit 0 - lockfile CLI verified (install mode: shim dir appended to $GITHUB_PATH,
#            `digest=sha256:<hex>` appended to $GITHUB_OUTPUT)
#   exit 1 - a check failed; an ::error:: line names the failing check
#
# `vercel build` runs vercel.json's installCommand (`npm install`) and may fetch
# builders, so the tree is not guaranteed unchanged after the install-mode step.
# --verify-only re-runs identity + canary + content digest + version immediately
# before each credentialed `vercel deploy`: at the top of the deploy step where
# the build ran in an earlier step (website-deploy-staging.yml), and mid-step,
# after `vercel build` and its log check, where build and deploy share one step
# (website-preview-pr.yml). It verifies the digest BEFORE it executes the binary
# at all (`--version`), so a rewritten CLI is refused without being run.
# --check-build-log fails on a runtime builder install.
#
# CONTENT DIGEST. Install mode hashes the CLI's runtime closure (node_modules/vercel
# plus every package it can require, from the lockfile; scope and exclusions in
# scripts/ci/vercel-cli-digest.cjs) and publishes it as the STEP OUTPUT `digest`.
# The deploy step receives it as `env: VERCEL_CLI_DIGEST: ${{ steps.vercel_cli.
# outputs.digest }}`. A later step cannot change an earlier step's recorded output,
# so the expected value is never read from the workspace or RUNNER_TEMP (the
# manifest written to RUNNER_TEMP is a diagnostic only, used to name changed files).
# --verify-only recomputes and fails closed on a mismatch or a missing/empty value.
#
# RESIDUAL (not closed, and not closable inside one job): the verifier itself, the
# digest module and `node` are all writable by any code `vercel build` runs (same
# uid, same job), and a step can rewrite later steps' environment through
# GITHUB_ENV / GITHUB_PATH. Code that targets this verifier can therefore rewrite
# it, or the `node` that runs it, before the deploy step. Copying the verifier to
# RUNNER_TEMP before the build, or inlining it in YAML, does not change that: the
# copy, the runner's own step-script file and the tool-cache `node` sit in the same
# writable filesystem. The digest catches an in-place change made by anything that
# does not know about this check (an `npm install` that re-resolves the tree, a
# postinstall that patches node_modules, a generic payload). What closes the gap is
# a deploy job on a fresh runner that never executes build-produced code: build in
# one job, hand off only the prebuilt output as an artifact, `npm ci` + verify +
# deploy in another; SMI-6964's token split removes the production capability from
# the build-time token. See the plan's Residual Risk section.
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
    # The CLI may colour its output or redraw a line with \r, so ANSI CSI/OSC
    # sequences are stripped and \r is treated as a line break before matching.
    HIT="$(node -e '
const t = require("fs").readFileSync(process.argv[1], "latin1")
  .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
  .replace(/(?:\x1b\[|\x9b)[0-?]*[ -\/]*[@-~]/g, "")
  .replace(/\x1b[@-Z\\-_]/g, "")
  .split(/\r\n|\r|\n/)
// vercel 52.x prints it through output.log: `${chalk.grey(">")} Installing
// ${pluralize("Builder", n)}: a, b` (dist chunks: the Output class `log`, and the
// builder installer), so after ANSI stripping the line is `> Installing Builder: x`
// or `> Installing Builders: x, y`. The `>` prefix is optional; anchoring at line
// start keeps a mid-line mention of the phrase clean.
const hit = t.find((l) => /^[ \t]*(?:>[ \t]*)?Installing Builders?\b/.test(l))
if (hit !== undefined) console.log(hit.trim())
' "$BUILD_LOG")" || fail "build-log" "could not read $BUILD_LOG"
    if [ -n "$HIT" ]; then
      fail "builder-install" "vercel build fetched a builder at runtime (outside the lockfile): $HIT"
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
  [ -n "${GITHUB_OUTPUT:-}" ] || fail "environment" "GITHUB_OUTPUT is not set"
fi

WS="$GITHUB_WORKSPACE"
BIN="$WS/node_modules/.bin/vercel"
VC_JS="$WS/node_modules/vercel/dist/vc.js"
SHIM_DIR="${RUNNER_TEMP:-}/vercel-bin"
DIGEST_JS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/vercel-cli-digest.cjs"
MANIFEST="${RUNNER_TEMP:-}/vercel-cli-digest.manifest"

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
# Executes the binary. Install mode runs it here; verify mode runs it only after
# the content digest has matched (step 5c), so a rewritten CLI never executes.
check_installed_version() {
  local installed
  installed="$("$BIN" --version 2>/dev/null || true)"
  if [ "$installed" != "$LOCKED" ]; then
    fail "installed-version" "$BIN reports '$installed', lockfile says '$LOCKED'"
  fi
}
if [ "$MODE" = "install" ]; then
  check_installed_version
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

# 5b. Content. Identity proves WHICH file runs, not WHAT it holds: a same-uid
#     process can rewrite dist/vc.js, or any file the CLI requires, in place and
#     keep the locked version string. Install mode records the closure digest;
#     verify mode recomputes it and compares against the earlier step's output.
#     It runs after the canary so a known-bad nested smol-toml is named as such.
if [ "$MODE" = "install" ]; then
  DIGEST_LINE="$(node "$DIGEST_JS" "$WS" --manifest-out "$MANIFEST")" || fail "cli-digest" "could not hash the CLI closure (reason above)"
else
  EXPECTED_DIGEST="${VERCEL_CLI_DIGEST:-}"
  case "$EXPECTED_DIGEST" in
    sha256:*) ;;
    "") fail "cli-digest" "VERCEL_CLI_DIGEST is missing or empty; pass the install step's output as env (VERCEL_CLI_DIGEST: \${{ steps.vercel_cli.outputs.digest }})" ;;
    *) fail "cli-digest" "VERCEL_CLI_DIGEST '$EXPECTED_DIGEST' is not a sha256: digest" ;;
  esac
  DIGEST_LINE="$(node "$DIGEST_JS" "$WS")" || fail "cli-digest" "could not hash the CLI closure (reason above)"
fi
DIGEST="${DIGEST_LINE%% *}"
if ! printf '%s\n' "$DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
  fail "cli-digest" "the digest module returned '$DIGEST_LINE'"
fi
if [ "$MODE" = "verify" ] && [ "$DIGEST" != "$EXPECTED_DIGEST" ]; then
  if [ -n "${RUNNER_TEMP:-}" ] && [ -f "$MANIFEST" ]; then
    node "$DIGEST_JS" "$WS" --diff-against "$MANIFEST" >/dev/null || true
  fi
  fail "cli-digest" "the CLI closure changed since the install step: now $DIGEST, recorded $EXPECTED_DIGEST"
fi

# 5c. Verify mode: the version check executes the binary, so it runs only now,
#     after the digest proved the closure is the one the install step recorded.
if [ "$MODE" = "verify" ]; then
  check_installed_version
fi

# 6. Install mode: expose the shim dir to later steps (only this dir), and the
#    digest as this step's output.
if [ "$MODE" = "install" ]; then
  echo "$SHIM_DIR" >> "$GITHUB_PATH"
  echo "digest=$DIGEST" >> "$GITHUB_OUTPUT"
fi

if [ "$MODE" = "verify" ]; then
  echo "vercel $LOCKED from lockfile (verify-only, digest matches); $CANARY_MSG"
else
  echo "vercel $LOCKED from lockfile; ${DIGEST_LINE}; $CANARY_MSG"
fi
