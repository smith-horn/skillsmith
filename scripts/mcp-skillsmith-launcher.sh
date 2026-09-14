#!/usr/bin/env bash
#
# Launcher for the skillsmith MCP server.
#
# Sibling to scripts/mcp-doc-retrieval-launcher.sh (SMI-5718) — same probe
# contract (dependency-integrity check + emit_error shape), duplicated
# rather than extracted into a shared lib (see that plan's Open Questions).
# If you change the probe contract here, check whether the sibling needs
# the same change. SMI-6618's platform-skip + Tier-B guard (check 3 below)
# was applied to both in the same change for exactly this reason.
#
# Wraps `node packages/mcp-server/dist/src/index.js` with pre-flight checks.
# Node's failure modes for a broken install are opaque MODULE_NOT_FOUND
# crashes that the MCP host swallows and surfaces as "Failed to reconnect
# to skillsmith". This wrapper detects three states and prints an actionable
# message to stderr (which the MCP host's per-server log expansion does
# surface) before invoking Node:
#   1. node_modules/ not installed (root sentinel missing)
#   2. packages/mcp-server/dist/src/index.js not built
#   3. a runtime dependency of @skillsmith/mcp-server that cannot resolve
#      from the dist entry: an empty/corrupt nested dir shadowing the
#      hoisted copy (SMI-5451 incident), a missing package, or an unbuilt
#      @skillsmith/* workspace dep.
#
#      SMI-6618: an empty nested dir for a package this runtime never loads
#      (a Tier-B mount source, SMI-6050) is expected state, not corruption,
#      and is SKIPPED via a platform-match check against the root
#      package-lock.json descriptor. A genuinely broken Tier-B directory for
#      a package this runtime DOES use is a fourth state, tier-b-mount-source
#      — never nested-corrupt — whose remedy never deletes the path.
#
# The dependency probe (check 3) runs in ESM context with cwd at the dist
# entry dir so its resolution walk matches the server's own imports. CJS
# require() falls through an empty nested dir to the hoisted copy and would
# miss the SMI-5451 incident class; ESM resolution stops at the first
# existing package dir, exactly like the server.
#
# Probe failure semantics (SMI-5451 M5):
#   - confirmed unresolvable dependency -> fail-closed (exit 1, per-state
#     remediation). @skillsmith/* workspace deps are symlinks to real
#     source, so their remediation is npm install + build — NEVER rm -rf.
#   - probe infrastructure error (unreadable package.json, unexpected
#     exception, probe syntax error) -> fail-open with a stderr warning;
#     a bug in the check must not brick the MCP server.
#
# Canonical path source: packages/mcp-server/package.json `main` / `bin`.
# Sibling sentinel: docker-entrypoint.sh:42 (in-container coverage, SMI-2621).
#
# References: SMI-5049, SMI-5451, GitHub issue smith-horn/skillsmith#1260.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_ENTRY="$REPO_ROOT/packages/mcp-server/dist/src/index.js"
DIST_DIR="$REPO_ROOT/packages/mcp-server/dist/src"
NM_SENTINEL="$REPO_ROOT/node_modules/.package-lock.json"

# emit_error <state> <remediation-block>
# Keeps the "MCP server cannot start:" prefix — tests assert on it.
emit_error() {
  local state="$1"
  local remediation="$2"
  {
    echo "[skillsmith] MCP server cannot start: $state."
    echo "[skillsmith] Run these commands in the repo root, then reconnect via /mcp:"
    echo ""
    echo "$remediation"
    echo ""
    echo "[skillsmith] (See CLAUDE.md > Docker-First Development)"
  } >&2
}

# SMI-6454: "npm install" runs on the HOST, not via `docker exec` -- root
# node_modules is a Docker named volume (docker-compose.yml), a completely
# separate filesystem from the host tree this host-run launcher (and its
# dependency probe below) actually reads. `npm run build` stays container-side:
# dist/ is NOT volume-migrated, so a container-side build's output lands on
# the shared bind mount and is visible to the host unchanged.
REMEDIATION_INSTALL_BUILD="    npm install
    docker compose --profile dev up -d
    docker exec skillsmith-dev-1 npm run build"

if [ ! -f "$NM_SENTINEL" ]; then
  emit_error "node_modules missing" "$REMEDIATION_INSTALL_BUILD"
  exit 1
fi

if [ ! -f "$DIST_ENTRY" ]; then
  emit_error "dist/ missing" "$REMEDIATION_INSTALL_BUILD"
  exit 1
fi

# Check 3: dependency-integrity probe (SMI-5451).
# stdout protocol: one "FAIL <name> <state>" line per unresolvable dep,
# exit 1. Exit 0 = all resolve. Exit 2 = probe infrastructure error.
DEP_PROBE_JS='
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

// pkgDir keeps its ORIGINAL inline process.env.SKILLSMITH_LAUNCHER_REPO_ROOT
// form (not routed through a repoRoot variable, unlike the doc-retrieval
// sibling) -- scripts/audit-standards.mjs Check 66 (SMI-6457) statically
// traces this exact join() shape to allowlist this line as a confirmed
// host-side op; routing it through an intermediate variable makes the
// heuristic lose the trace and silently drop the allowlist match (measured
// via npm run audit:standards after an earlier draft did exactly that).
const pkgDir = join(process.env.SKILLSMITH_LAUNCHER_REPO_ROOT, "packages", "mcp-server");
const repoRoot = process.env.SKILLSMITH_LAUNCHER_REPO_ROOT;
const pkgNestedPrefix = "packages/mcp-server/node_modules/";

// SMI-6618: platform-skip + Tier-B mount-source guard. Sibling to the SAME
// addition in scripts/mcp-doc-retrieval-launcher.sh -- see that file for
// the fuller rationale comment; kept in sync here rather than extracted
// into a shared lib (see this scripts own header note on duplication).

const PROBE_TEST_MODE = process.env.SKILLSMITH_LAUNCHER_PROBE_TEST === "1";

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

function classify(name) {
  try {
    const resolved = import.meta.resolve(name);
    // Existence of the resolved target is only checked for @skillsmith/*
    // workspace deps (exports maps are not stat-checked by resolution, and
    // a missing file there means "not built"). Third-party packages may
    // ship a phantom "." export while being consumed via subpaths only —
    // @modelcontextprotocol/sdk resolves "." to a non-existent
    // dist/esm/index.js — so resolution success is the health signal there.
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
    if (existsSync(join(pkgDir, "node_modules", name))) return "nested-corrupt";
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
process.exit(failed ? 1 : 0);
'

set +e
# SMI-6618 test seam: SKILLSMITH_LAUNCHER_PROBE_TEST/_PLATFORM/_ARCH/_LIBC are
# inherited naturally here (this probe runs host-side, no docker exec), so no
# explicit forwarding is needed -- currentPlatform()s own PROBE_TEST_MODE
# gate inside DEP_PROBE_JS ignores them unless the gate var is exactly "1".
probe_out="$(cd "$DIST_DIR" && SKILLSMITH_LAUNCHER_REPO_ROOT="$REPO_ROOT" node --input-type=module -e "$DEP_PROBE_JS" 2>&1)"
probe_status=$?
set -e

# SMI-6618: forward every PROBE_WARN line to stderr on EVERY exit path (0, 1,
# or 2) -- previously only "^FAIL " lines survived a recognized failure.
if printf '%s\n' "$probe_out" | grep -q '^PROBE_WARN '; then
  printf '%s\n' "$probe_out" | grep '^PROBE_WARN ' | sed 's/^PROBE_WARN /[skillsmith] preflight: /' >&2
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
      # SMI-6618: packages/mcp-server/node_modules/$dep_name is a Tier-B
      # mount source (SMI-6050) -- a matching-platform FAIL here can only
      # occur on a Linux host (every Tier-B path is os:["linux"], so macOS
      # always skips it above). Never rm -rf, never a host npm install
      # (SMI-6546: that would prune the other Tier-B placeholders too).
      emit_error "$dep_name is a Tier-B mount source at packages/mcp-server/node_modules/$dep_name and must not be removed; run from the main checkout (not a worktree)" \
"    ./scripts/repair-worktrees.sh"
      ;;
    nested-corrupt)
      # SMI-6454: packages/mcp-server/node_modules is ALSO a named volume
      # (docker-compose.yml) -- both the rm -rf and the reinstall must be
      # host-side, no container involved, or the fix never reaches the
      # bytes this host-run launcher's probe actually reads.
      if [ "$tier_b_list_unavailable" -eq 1 ]; then
        # SMI-6618: cannot confirm this is NOT a Tier-B path -- fail safe.
        emit_error "$dep_name dependency corrupt at packages/mcp-server/node_modules/$dep_name; the Tier-B mount-source list was unavailable, so automatic removal is not suggested" \
"    npm install"
      else
        emit_error "$dep_name dependency corrupt at packages/mcp-server/node_modules/$dep_name" \
"    rm -rf packages/mcp-server/node_modules/$dep_name
    npm install"
      fi
      ;;
    *)
      # SMI-6454: same named-volume reasoning as nested-corrupt above.
      emit_error "$dep_name dependency missing" \
"    npm install"
      ;;
  esac
  # Diagnostic: every failing dep, one line each (first drives the message).
  printf '%s\n' "$probe_out" | grep '^FAIL ' | sed 's/^/[skillsmith] preflight: /' >&2
  exit 1
elif [ "$probe_status" -ne 0 ]; then
  # Fail-open: the probe itself broke; do not block the server (SMI-5451 M5).
  echo "[skillsmith] preflight warning: dependency probe failed to run (status $probe_status); continuing. First output: $(printf '%s' "$probe_out" | head -1)" >&2
fi

exec node "$DIST_ENTRY" "$@"
