#!/usr/bin/env bash
#
# Launcher for the skillsmith-doc-retrieval MCP server (SMI-5718).
#
# Sibling to scripts/mcp-skillsmith-launcher.sh (SMI-5451) — same contract,
# adapted for this server: doc-retrieval-mcp depends on the native module
# better-sqlite3 (CLAUDE.md Docker-First Development), so it runs INSIDE
# the container (`docker exec ... node .../server.js`), not on the host
# directly like `skillsmith`'s launcher does. If you change the probe
# contract here, check whether mcp-skillsmith-launcher.sh needs the same
# change — the two scripts are intentionally duplicated (not extracted into
# a shared lib; see the plan's Open Questions) and can drift. SMI-6618's
# platform-skip + Tier-B guard (check 3 below) was applied to both.
#
# This wrapper detects four states and prints an actionable message to
# stderr (surfaced in the MCP host's per-server log expansion) before
# invoking Node:
#   0. the skillsmith-dev-1 container is not running (new — doc-retrieval-mcp
#      is Docker-only, so `docker exec` itself fails opaquely otherwise)
#   1. node_modules/ not installed (root sentinel missing)
#   2. packages/doc-retrieval-mcp/dist/src/server.js not built
#   3. a runtime dependency of @skillsmith/doc-retrieval-mcp that cannot
#      resolve from the dist entry: an empty/corrupt nested dir shadowing
#      the hoisted copy (the SMI-5452 hazard — the trigger for the SMI-5718
#      incident this launcher exists to guard against), a missing package,
#      an unbuilt @skillsmith/* workspace dep, or a missing/corrupt
#      root-hoisted zod-to-json-schema (a new transitive dependency the
#      SMI-5718 code hardening makes load-bearing — see the plan's "New
#      transitive-dependency exposure" section).
#
#      SMI-6618: an empty nested dir for a package this runtime never loads
#      (a Tier-B mount source, SMI-6050) is expected state, not corruption,
#      and is SKIPPED via a platform-match check against the root
#      package-lock.json descriptor. A genuinely broken Tier-B directory for
#      a package this runtime DOES use is a fifth state, tier-b-mount-source
#      — never nested-corrupt — whose remedy never deletes the path.
#
# The dependency probe (check 3) runs in ESM context with cwd at the dist
# entry dir, INSIDE THE CONTAINER via `docker exec` (SMI-6453). `/app/node_modules`
# and every `/app/packages/*/node_modules` are NAMED VOLUMES (docker-compose.yml
# SMI-5957 correction #5), which shadow the `.:/app` bind mount at exactly
# those paths — the host directory and the container directory are
# independent filesystems, so a host-side probe inspects bytes the server
# never loads (false positives on host-only debris, false negatives on
# container-only corruption). Only `dist/` is still plain bind-mounted (host
# == container), which is why check 2 stays host-side.
#
# Probe failure semantics (mirrors SMI-5451 M5):
#   - confirmed unresolvable dependency -> fail-closed (exit 1, per-state
#     remediation). @skillsmith/* workspace deps are symlinks to real
#     source, so their remediation is npm install + build — NEVER rm -rf.
#   - probe infrastructure error (unreadable package.json, unexpected
#     exception, probe syntax error) -> fail-open with a stderr warning;
#     a bug in the check must not brick the MCP server.
#
# Canonical path source: packages/doc-retrieval-mcp/package.json `main`/`bin`.
# Container name source: docker-compose.yml `container_name`.
#
# References: SMI-5718, SMI-5451 (precedent), SMI-5452 (the trigger hazard),
# SMI-6453 (container-side probe correction).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/doc-retrieval-mcp"
DIST_ENTRY="$PKG_DIR/dist/src/server.js"
CONTAINER_NAME="skillsmith-dev-1"
CONTAINER_APP_ROOT="/app"                                   # docker-compose.yml:40 `.:/app`
CONTAINER_DIST_DIR="$CONTAINER_APP_ROOT/packages/doc-retrieval-mcp/dist/src"
CONTAINER_NM_SENTINEL="$CONTAINER_APP_ROOT/node_modules/.package-lock.json"

# SMI-6507/SMI-6496 plan §4: this launcher always targets the shared
# "skillsmith-dev-1" container (the doc-retrieval corpus is main-repo-shared
# by design — never patched per-worktree, confirmed correct in every
# branch). But when THIS COPY of the script lives inside a worktree checkout
# (its own .mcp.json invokes the worktree's own tracked copy), REPO_ROOT
# above resolves to the WORKTREE root, not main's — so a reader sitting in
# that worktree who copy-pastes a bare `docker compose --profile dev up -d`
# risks the exact SMI-4298 port collision, even though the fix has nothing
# to do with their worktree. Resolve the actual MAIN checkout path the same
# way scripts/lib/check-node-modules-fresh.sh already does (git-common-dir
# vs git-dir), anchored via `git -C "$REPO_ROOT"` rather than ambient cwd
# since this launcher's invoking cwd is controlled by the MCP host, not a
# human shell. Fail-soft: falls back to REPO_ROOT itself (today's behavior)
# if git is unavailable or the checkout is unreadable.
MAIN_CHECKOUT="$REPO_ROOT"
_gcd="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null || echo '')"
if [ -n "$_gcd" ]; then
  case "$_gcd" in
    /*) _abs_gcd="$_gcd" ;;
    *) _abs_gcd="$REPO_ROOT/$_gcd" ;;
  esac
  _resolved_main="$(cd "$_abs_gcd/.." 2>/dev/null && pwd || echo '')"
  [ -n "$_resolved_main" ] && MAIN_CHECKOUT="$_resolved_main"
fi

# emit_error <state> <remediation-block>
# Tag is [doc-retrieval] throughout (plan-review, VP Design) — distinct from
# mcp-skillsmith-launcher.sh's [skillsmith] tag, and matching the
# [doc-retrieval]-tagged errors jsonSchemaOf() throws in server.ts, so both
# halves of this issue's fix speak with one diagnostic identity.
emit_error() {
  local state="$1"
  local remediation="$2"
  {
    echo "[doc-retrieval] MCP server cannot start: $state."
    echo "[doc-retrieval] Run these commands, then reconnect via /mcp:"
    echo ""
    echo "$remediation"
    echo ""
    echo "[doc-retrieval] (See CLAUDE.md > Docker-First Development)"
  } >&2
}

REMEDIATION_START_CONTAINER="    ( cd \"$MAIN_CHECKOUT\" && docker compose --profile dev up -d )"

# SMI-6614 (ADR-158, round-2 Finding C): mount-gated (SMI-6516/SMI-6520) — a
# bare install/build would silently write into the HOST tree if detached.
REMEDIATION_INSTALL_BUILD="    ( cd \"$MAIN_CHECKOUT\" && docker compose --profile dev up -d )
    docker exec -w /app $CONTAINER_NAME sh -c 'sh scripts/lib/node-modules-mount-gate.sh && npm install && npm run build'
    # exit non-zero, no npm/build output => a node_modules mount is detached or not a volume — recreate (--force-recreate dev), retry"

# Check 0: container liveness. doc-retrieval-mcp's actual server process
# runs inside the container (native module better-sqlite3), so every
# subsequent check and the final invocation depend on it being up.
if [ -z "$(docker ps --filter "name=^/${CONTAINER_NAME}\$" --filter "status=running" -q 2>/dev/null || true)" ]; then
  emit_error "$CONTAINER_NAME container is not running" "$REMEDIATION_START_CONTAINER"
  exit 1
fi

# Check 1: node_modules installed — CONTAINER-side (SMI-6453). /app/node_modules
# is a named volume (docker-compose.yml:41); the host's node_modules/ is a
# different filesystem from the one server.js loads. No -i (see check 3).
#
# Content-based, not exit-code-based (plan-review finding, GPT-5.6-Sol,
# 2026-09-08): a bare `docker exec … test -f …`'s exit 1 is ambiguous — it is
# also what `docker exec` itself returns on a daemon-level failure (confirmed
# live: `docker exec __nonexistent__ test -f /x` -> exit 1 on this repo's
# Docker CLI, not only 125-127). Check 3 avoids this by gating on the probe's
# own FAIL-line stdout content, not exit code; Check 1 does the same: the
# inner `sh -c` always exits 0 and always emits one of two unambiguous
# tokens when docker exec itself succeeds, so branch on TEXT, never on
# docker exec's raw exit status.
set +e
nm_out="$(docker exec "$CONTAINER_NAME" sh -c '[ -f "$1" ] && echo SMI6453_PRESENT || echo SMI6453_ABSENT' _ "$CONTAINER_NM_SENTINEL" 2>&1)"
nm_status=$?
set -e
if [ "$nm_status" -eq 0 ] && [ "$nm_out" = "SMI6453_ABSENT" ]; then
  emit_error "node_modules missing" "$REMEDIATION_INSTALL_BUILD"
  exit 1
elif [ "$nm_status" -ne 0 ] || [ "$nm_out" != "SMI6453_PRESENT" ]; then
  # Fail-open: docker exec itself failed, or returned something other than
  # our own two known tokens — never trust a bare exit code here.
  echo "[doc-retrieval] preflight warning: could not inspect container node_modules (docker exec status $nm_status, output: $nm_out); continuing." >&2
fi

# Check 2: dist/ built — HOST-side, deliberately. packages/doc-retrieval-mcp/dist
# is under the `.:/app` bind mount and no docker-compose.yml volume targets a
# `dist` path, so host bytes == container bytes here. This check passing is
# what guarantees $CONTAINER_DIST_DIR exists as check 3's probe cwd below.
if [ ! -f "$DIST_ENTRY" ]; then
  emit_error "dist/ missing" "$REMEDIATION_INSTALL_BUILD"
  exit 1
fi

# Check 3: dependency-integrity probe (SMI-5718, mirrors SMI-5451).
# stdout protocol: one "FAIL <name> <state>" line per unresolvable dep,
# exit 1. Exit 0 = all resolve. Exit 2 = probe infrastructure error.
DEP_PROBE_JS='
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const repoRoot = process.env.SKILLSMITH_LAUNCHER_REPO_ROOT;
const pkgDir = join(repoRoot, "packages", "doc-retrieval-mcp");
const pkgNestedPrefix = "packages/doc-retrieval-mcp/node_modules/";

// SMI-6618: platform-skip + Tier-B mount-source guard. An empty nested
// placeholder for a package this runtime never loads (a Tier-B mount
// source, SMI-6050) is expected state, not corruption. A nested name is
// skipped only on a DEFINITE platform mismatch drawn from its
// package-lock.json descriptor, using the same matching rules as
// npm-install-checks (checkList / current-env, npm 10.9.7). A FAIL that IS a
// Tier-B mount source is reported as tier-b-mount-source below, never
// nested-corrupt, so no remedy branch in the shell wrapper can ever print an
// rm -rf for it.

const PROBE_TEST_MODE = process.env.SKILLSMITH_LAUNCHER_PROBE_TEST === "1";

// Mirrors npm-install-checks checkList(): match none of the negated
// entries, and at least one of the non-negated entries, if any are
// present. A single ["any"] entry matches everything.
function checkList(value, list) {
  if (typeof list === "string") list = [list];
  if (list.length === 1 && list[0] === "any") return true;
  let negated = 0;
  let match = false;
  for (const entry of list) {
    const negate = entry.charAt(0) === "!";
    const test = negate ? entry.slice(1) : entry;
    if (negate) {
      negated++;
      if (value === test) return false;
    } else {
      match = match || value === test;
    }
  }
  return match || negated === list.length;
}

// Mirrors npm-install-checks current-env.js libc(): /usr/bin/ldd content
// first, then a process.report fallback. Returns null/undefined when the
// libc family cannot be determined -- treated as UNKNOWN by the caller, not
// as a mismatch.
function detectLibc(platform) {
  if (platform !== "linux") return undefined;
  try {
    const content = readFileSync("/usr/bin/ldd", "utf8");
    if (content.includes("musl")) return "musl";
    if (content.includes("GNU C Library")) return "glibc";
    return null;
  } catch {
    // fall through to the process.report fallback below
  }
  try {
    const originalExclude = process.report.excludeNetwork;
    process.report.excludeNetwork = true;
    const report = process.report.getReport();
    process.report.excludeNetwork = originalExclude;
    if (report.header && report.header.glibcVersionRuntime) return "glibc";
    if (
      Array.isArray(report.sharedObjects) &&
      report.sharedObjects.some((s) => s.includes("libc.musl-") || s.includes("ld-musl-"))
    ) {
      return "musl";
    }
    return null;
  } catch {
    return null;
  }
}

// SMI-6618 test seam: the four SKILLSMITH_LAUNCHER_PROBE_* overrides apply
// ONLY when the gate is set to exactly "1" -- without it every override is
// ignored and the real process.platform / process.arch / detected libc are
// used, even if the variables happen to be present in this process env.
function currentPlatform() {
  const platform =
    (PROBE_TEST_MODE && process.env.SKILLSMITH_LAUNCHER_PROBE_PLATFORM) || process.platform;
  const arch = (PROBE_TEST_MODE && process.env.SKILLSMITH_LAUNCHER_PROBE_ARCH) || process.arch;
  const libc =
    PROBE_TEST_MODE && process.env.SKILLSMITH_LAUNCHER_PROBE_LIBC !== undefined
      ? process.env.SKILLSMITH_LAUNCHER_PROBE_LIBC || null
      : detectLibc(platform);
  return { platform, arch, libc };
}

let lockfilePackages = null;
try {
  const lockRaw = readFileSync(join(repoRoot, "package-lock.json"), "utf8");
  const lockParsed = JSON.parse(lockRaw);
  // A lockfile with no "packages" map is unusable, not empty: throw so the
  // Tier-B list counts as unavailable and no rm -rf is printed.
  if (!lockParsed || !lockParsed.packages || typeof lockParsed.packages !== "object")
    throw new Error("no packages map");
  lockfilePackages = lockParsed.packages;
} catch (err) {
  console.log(
    "PROBE_WARN lockfile unreadable or unparseable at " +
      join(repoRoot, "package-lock.json") +
      ": " +
      (err && err.message ? err.message : err)
  );
}

// True when `name` (nested under pkgNestedPrefix) is DEFINITELY excluded on
// this runtime by its package-lock.json descriptor. No descriptor, or no
// usable lockfile at all, means never skip -- the "check it" default.
function platformExcluded(name) {
  if (!lockfilePackages) return false;
  const descriptor = lockfilePackages[pkgNestedPrefix + name];
  if (!descriptor || typeof descriptor !== "object") return false;

  const { platform, arch, libc } = currentPlatform();

  if (descriptor.os && !checkList(platform, descriptor.os)) return true;
  if (descriptor.cpu && !checkList(arch, descriptor.cpu)) return true;
  if (descriptor.libc && libc && !checkList(libc, descriptor.libc)) return true;

  return false;
}

// Tier-B mount-source paths (SMI-6050), derived from the SAME lockfile.
// Attempted only when the lockfile itself parsed above -- a broken lockfile
// already produced the warning above, and a second, independent read here
// would only throw for the identical reason.
let tierBPaths = null;
if (lockfilePackages) {
  try {
    const tierBModuleUrl = pathToFileURL(
      join(repoRoot, "scripts", "lib", "linux-optional-packages.mjs")
    ).href;
    const tierBModule = await import(tierBModuleUrl);
    tierBPaths = new Set(
      tierBModule.deriveLinuxOptionalPackagePaths(join(repoRoot, "package-lock.json"))
    );
  } catch (err) {
    console.log(
      "PROBE_WARN tier-b list unavailable: " + (err && err.message ? err.message : err)
    );
  }
}

function classify(name, { rootOnly = false } = {}) {
  try {
    const resolved = import.meta.resolve(name);
    if (
      name.startsWith("@skillsmith/") &&
      resolved.startsWith("file:") &&
      !existsSync(fileURLToPath(resolved))
    ) {
      return "unbuilt-workspace";
    }
    return null;
  } catch (err) {
    if (err && err.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return null; // intact, no "." export
    if (name.startsWith("@skillsmith/")) return "unbuilt-workspace";
    if (!rootOnly && existsSync(join(pkgDir, "node_modules", name))) return "nested-corrupt";
    if (rootOnly && existsSync(join(repoRoot, "node_modules", name))) return "root-hoisted-corrupt";
    return "missing";
  }
}

let names;
try {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const declared = Object.keys(pkg.dependencies ?? {});
  let nested = [];
  try {
    nested = readdirSync(join(pkgDir, "node_modules"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .flatMap((e) =>
        e.name.startsWith("@")
          ? readdirSync(join(pkgDir, "node_modules", e.name)).map((s) => e.name + "/" + s)
          : [e.name]
      );
  } catch {
    nested = []; // no nested node_modules — nothing extra to check
  }
  names = [...new Set([...declared, ...nested])];
} catch (err) {
  console.error("PROBE_INFRA_ERROR " + (err && err.message ? err.message : err));
  process.exit(2);
}

let failed = false;
for (const name of names) {
  if (platformExcluded(name)) continue;
  let state = classify(name);
  if (state === "nested-corrupt" && tierBPaths && tierBPaths.has(pkgNestedPrefix + name)) {
    state = "tier-b-mount-source";
  }
  if (state) {
    console.log("FAIL " + name + " " + state);
    failed = true;
  }
}

// SMI-5718: zod-to-json-schema is not a doc-retrieval-mcp-declared
// dependency — it is a transitive dependency of @modelcontextprotocol/sdk,
// resolved solely via the ROOT-hoisted node_modules (not nested under this
// package). jsonSchemaOf()s v3 conversion path now depends on it being
// resolvable, so it is checked explicitly here rather than relying on the
// declared-deps ∪ nested-node_modules scan above (which would never see it).
const ztjsState = classify("zod-to-json-schema", { rootOnly: true });
if (ztjsState) {
  console.log("FAIL zod-to-json-schema " + ztjsState);
  failed = true;
}

process.exit(failed ? 1 : 0);
'

# SMI-6618 test seam: forward the SKILLSMITH_LAUNCHER_PROBE_* vars into the
# container only when the gate is set here (docker exec inherits no host env);
# the JS-side gate in DEP_PROBE_JS is a second, independent layer.
declare -a probe_test_env_args=()
if [ "${SKILLSMITH_LAUNCHER_PROBE_TEST:-}" = "1" ]; then
  probe_test_env_args+=(-e "SKILLSMITH_LAUNCHER_PROBE_TEST=$SKILLSMITH_LAUNCHER_PROBE_TEST")
  if [ -n "${SKILLSMITH_LAUNCHER_PROBE_PLATFORM:-}" ]; then
    probe_test_env_args+=(-e "SKILLSMITH_LAUNCHER_PROBE_PLATFORM=$SKILLSMITH_LAUNCHER_PROBE_PLATFORM")
  fi
  if [ -n "${SKILLSMITH_LAUNCHER_PROBE_ARCH:-}" ]; then
    probe_test_env_args+=(-e "SKILLSMITH_LAUNCHER_PROBE_ARCH=$SKILLSMITH_LAUNCHER_PROBE_ARCH")
  fi
  if [ "${SKILLSMITH_LAUNCHER_PROBE_LIBC+set}" = "set" ]; then
    probe_test_env_args+=(-e "SKILLSMITH_LAUNCHER_PROBE_LIBC=$SKILLSMITH_LAUNCHER_PROBE_LIBC")
  fi
fi

set +e
# SMI-6453: run INSIDE the container. /app/node_modules and
# /app/packages/*/node_modules are named volumes (docker-compose.yml:41,
# :65-72), so the host's view of those paths is a different filesystem
# from the one server.js resolves against. No -i: never attach the MCP
# host's stdin to a preflight exec.
# "${arr[@]+"${arr[@]}"}": bash 3.2 (macOS) errors on an EMPTY array under set -u.
probe_out="$(docker exec -w "$CONTAINER_DIST_DIR" -e "SKILLSMITH_LAUNCHER_REPO_ROOT=$CONTAINER_APP_ROOT" "${probe_test_env_args[@]+"${probe_test_env_args[@]}"}" "$CONTAINER_NAME" node --input-type=module -e "$DEP_PROBE_JS" 2>&1)"
probe_status=$?
set -e

# SMI-6618: forward every PROBE_WARN line to stderr on EVERY exit path (0, 1,
# or 2) — previously only "^FAIL " lines survived a recognized failure, and a
# probe-level warning (unreadable lockfile, unavailable Tier-B list) was
# silently dropped.
if printf '%s\n' "$probe_out" | grep -q '^PROBE_WARN '; then
  printf '%s\n' "$probe_out" | grep '^PROBE_WARN ' | sed 's/^PROBE_WARN /[doc-retrieval] preflight: /' >&2
fi
tier_b_list_unavailable=0
if printf '%s\n' "$probe_out" | grep -qE '^PROBE_WARN (lockfile unreadable|tier-b list unavailable)'; then
  tier_b_list_unavailable=1
fi

if [ "$probe_status" -eq 1 ] && printf '%s\n' "$probe_out" | grep -q '^FAIL '; then
  first_fail="$(printf '%s\n' "$probe_out" | grep '^FAIL ' | head -1)"
  dep_name="$(printf '%s' "$first_fail" | cut -d' ' -f2)"
  dep_state="$(printf '%s' "$first_fail" | cut -d' ' -f3)"
  case "$dep_state" in
    unbuilt-workspace)
      emit_error "$dep_name dependency unresolvable (workspace package not built)" \
        "$REMEDIATION_INSTALL_BUILD"
      ;;
    tier-b-mount-source)
      # SMI-6618: a Tier-B mount source (SMI-6050) — worktree containers
      # bind-mount it, so no remedy here may delete it. Always targets the
      # SHARED skillsmith-dev-1 (never a worktree's own container), so a
      # force-recreate restarts both MCP servers for every session. Checks
      # the host-side placeholder (ensure_tier_b_mount_sources, _lib.sh)
      # directly; only when IT is missing does repair-worktrees.sh run first.
      host_mount_source="$MAIN_CHECKOUT/packages/doc-retrieval-mcp/node_modules/$dep_name"
      if [ -d "$host_mount_source" ]; then
        tier_b_remedy_prereq=""
        tier_b_mount_detail="the host mount-source directory is present at $host_mount_source"
      else
        tier_b_remedy_prereq="    ( cd \"$MAIN_CHECKOUT\" && ./scripts/repair-worktrees.sh )
"
        tier_b_mount_detail="the host mount-source directory is MISSING at $host_mount_source"
      fi
      emit_error "$dep_name is a Tier-B mount source at packages/doc-retrieval-mcp/node_modules/$dep_name and must not be removed ($tier_b_mount_detail)" \
"${tier_b_remedy_prereq}    ( cd \"$MAIN_CHECKOUT\" && docker compose --profile dev up -d --force-recreate dev )
    # restarts BOTH MCP servers for every session; verify the mount recovers —
    # see docs/internal/implementation/smi-6516-6520-native-binding-mount-topology.md"
      ;;
    nested-corrupt)
      # packages/doc-retrieval-mcp/node_modules is a NAMED VOLUME
      # (docker-compose.yml:67, SMI-5957 correction #5): the host directory at
      # that path is a different filesystem from the container's copy, so the
      # rm -rf must run INSIDE the container, then npm install repopulates the
      # volume (SMI-6453). A host-side rm -rf here was a confirmed no-op.
      if [ "$tier_b_list_unavailable" -eq 1 ]; then
        # SMI-6618: the Tier-B mount-source list could not be derived (see
        # the forwarded PROBE_WARN above), so this FAIL cannot be confirmed
        # NOT to be a Tier-B path. Fail safe: never print an rm -rf.
        emit_error "$dep_name dependency corrupt at packages/doc-retrieval-mcp/node_modules/$dep_name (container-side, not host); the Tier-B mount-source list was unavailable, so automatic removal is not suggested" \
"    ( cd \"$MAIN_CHECKOUT\" && docker compose --profile dev up -d )
    docker exec -w /app $CONTAINER_NAME sh -c 'sh scripts/lib/node-modules-mount-gate.sh && npm install'
    # exit non-zero, no npm output => a node_modules mount is detached or not a volume — recreate (--force-recreate dev), retry"
      else
        emit_error "$dep_name dependency corrupt at packages/doc-retrieval-mcp/node_modules/$dep_name (container-side, not host)" \
"    ( cd \"$MAIN_CHECKOUT\" && docker compose --profile dev up -d )
    docker exec -w /app $CONTAINER_NAME sh -c 'sh scripts/lib/node-modules-mount-gate.sh && rm -rf $CONTAINER_APP_ROOT/packages/doc-retrieval-mcp/node_modules/$dep_name && npm install'
    # exit non-zero, no output => a node_modules mount is detached or not a volume — recreate (--force-recreate dev), retry"
      fi
      ;;
    root-hoisted-corrupt)
      # Root node_modules is likewise a NAMED VOLUME (docker-compose.yml:41);
      # npm install inside the container repairs the volume directly. No rm -rf
      # is needed for a root-hoisted package (npm reifies over it).
      emit_error "$dep_name dependency corrupt at root node_modules/$dep_name (container-side, not host)" \
"    ( cd \"$MAIN_CHECKOUT\" && docker compose --profile dev up -d )
    docker exec -w /app $CONTAINER_NAME sh -c 'sh scripts/lib/node-modules-mount-gate.sh && npm install'
    # exit non-zero, no npm output => a node_modules mount is detached or not a volume — recreate (--force-recreate dev), retry"
      ;;
    *)
      emit_error "$dep_name dependency missing" \
"    ( cd \"$MAIN_CHECKOUT\" && docker compose --profile dev up -d )
    docker exec -w /app $CONTAINER_NAME sh -c 'sh scripts/lib/node-modules-mount-gate.sh && npm install'
    # exit non-zero, no npm output => a node_modules mount is detached or not a volume — recreate (--force-recreate dev), retry"
      ;;
  esac
  # Diagnostic: every failing dep, one line each (first drives the message).
  printf '%s\n' "$probe_out" | grep '^FAIL ' | sed 's/^/[doc-retrieval] preflight: /' >&2
  exit 1
elif [ "$probe_status" -ne 0 ]; then
  # Fail-open: the probe itself broke; do not block the server.
  echo "[doc-retrieval] preflight warning: dependency probe failed to run (status $probe_status); continuing. First output: $(printf '%s' "$probe_out" | head -1)" >&2
fi

exec docker exec -i "$CONTAINER_NAME" node "$CONTAINER_DIST_DIR/server.js" "$@"
