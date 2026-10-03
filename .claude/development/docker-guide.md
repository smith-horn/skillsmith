# Docker Development Guide

Developer reference for Docker container management, rebuild scenarios, and troubleshooting.

## Container Management

```bash
docker compose --profile dev up -d      # Start container
docker compose --profile dev down       # Stop container
docker logs skillsmith-dev-1            # View logs
```

**Throwaway containers**: start any ad-hoc verification container (a scratch `postgres:*`, a one-off image test) with `--rm`, and stop it with `docker stop <name>`. Images that declare a `VOLUME`, such as `postgres`, create an anonymous data volume per container. `--rm` removes it with the container; a bare `docker rm` leaves it dangling (SMI-6619).

## Host-side install workflow (SMI-4672)

`.npmrc` sets `ignore-scripts=true` (Wave 3a, SMI-4672). All `npm install` invocations — host or container — skip lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`). The container path is fully covered: `Dockerfile:73` rebuilds the four native modules at image build, and `docker-entrypoint.sh` re-validates and rebuilds them at every container start.

The host path needs three follow-ups after a fresh `npm install`:

```bash
# 1. Compile better-sqlite3 binding for the host-side retrieval-logs writer
#    (SMI-4549). Idempotent — sub-second [skip] on subsequent runs.
./scripts/repair-host-native-deps.sh

# 2. If you edit packages/enterprise/ source locally without committing,
#    refresh the Turborepo cache-invalidation sentinel before `npm run build`.
npm run postinstall

# 3. If git hooks don't fire on a fresh clone of the main repo (worktrees
#    inherit hooksPath from create-worktree.sh), set it once OR run husky:
git config core.hooksPath .husky/_
# OR
npm run prepare
```

`onnxruntime-node` (embeddings) and `hnswlib-node` (vector index) previously had no host repair scope in `scripts/repair-host-native-deps.sh` — despite the claim once made here, both modules DO run on host whenever an MCP server is launched via a host-executing launcher script (`scripts/mcp-skillsmith-launcher.sh`, SMI-5049), since `@skillsmith/core`'s embeddings module pulls both in on that same host path. See CLAUDE.md's Troubleshooting table (`skillsmith` MCP CONNECTION_CLOSED row) for the host-side symptom and interim manual fix, and the [SMI-6221](https://linear.app/smith-horn-group/issue/SMI-6221/host-native-module-repair-and-mcp-preflight-have-zero-coverage-for) tracking issue for closing this repair-script gap durably. The entrypoint rebuild loop still covers all four native modules (better-sqlite3, onnxruntime-node, esbuild, hnswlib-node) per the SMI-4672 C1 fix for the CONTAINER side, which was never the affected surface.

## Worktree First Start

When starting a Docker container in a **fresh git worktree** for the first time, `docker-entrypoint.sh` automatically runs `npm run build` before validating native modules.

**Why this happens**: The `docker-compose.yml` bind mount (`- .:/app`) overlays the host working directory over `/app` at container start. This erases `packages/*/dist/` compiled into the Docker image during build. In a fresh worktree, the host has no `dist/` (gitignored and never committed), so the entrypoint rebuilds it. After the first start, `dist/` exists on the host and all subsequent starts skip the build.

```bash
# First start — expect ~30-45 seconds of build output:
docker compose --profile dev up -d
docker logs <worktree-container-name>
# [entrypoint] Checking dist/ outputs...
#   ✗ dist/ not found (first container start) — building packages...
#   This is a one-time cost per worktree (until dist/ is manually removed).
#   ✓ Build complete.
# [entrypoint] dist/ outputs ready.

# Subsequent starts are instant (dist/ now on host):
docker compose --profile dev down && docker compose --profile dev up -d
# [entrypoint] Checking dist/ outputs...
#   ✓ dist/ found — skipping build.
# [entrypoint] dist/ outputs ready.
```

**If the build fails**, the container exits with code 1. Run the build manually to see the full TypeScript error, fix it, then restart:

```bash
docker exec <container-name> npm run build    # See full Turbo/tsc output
docker compose --profile dev down
docker compose --profile dev up -d
```

**If `node_modules` is genuinely missing or partial**, the entrypoint exits before attempting the build:

```bash
docker compose --profile dev up -d            # Exits 1: "node_modules not initialised"
```

**`docker volume rm skillsmith_node_modules` does not trip that check (SMI-6674).** On the main checkout the root `node_modules` named volume re-seeds from the image's own `npm ci` output the first time it is mounted, so the pre-check above passes instead of exiting 1. That is measured, and it is all that is measured — the rest of startup (dist checks, native-module validation) can still fail for its own reasons, so treat a wipe as "not blocked at this gate", not as "known good".

It also leaves a **mixed** dependency state, which is the part to refresh before trusting a build: the root volume is back to the image's `npm ci` output, the eight per-package `*-node-modules` volumes still hold whatever they held (that command removes one volume, not nine), and neither necessarily matches your current lockfile. Use the ordered refresh sequence (`sh scripts/lib/print-deps-refresh-advice.sh <main-checkout-path>`, shown below) — the same one README's Troubleshooting section prints — rather than any single install step.

The exit-1 case above is instead a **worktree** container, whose `node_modules` is a read-only bind of the HOST tree with no volume to re-seed from, or a main-checkout container whose image is itself broken.

A worktree container's `node_modules` is bind-mounted **read-only** from the HOST (SMI-5560/5626) — an ungated container `npm install` here would `EROFS` by design, not silently fix anything (SMI-6614, ADR-158). Fix it on the HOST, from the MAIN checkout — this then propagates to every worktree automatically. Print the full ordered refresh sequence (stops worktree containers, clears the SMI-6034 ACLs, regenerates + syncs, repairs Tier-B mount sources, restarts worktrees) rather than jumping straight to one step of it:

```bash
( cd <main-checkout-path> && sh scripts/lib/print-deps-refresh-advice.sh <main-checkout-path> )
docker compose --profile dev up -d            # (from this worktree) retry, after following the printed steps
```

**After `docker volume rm skillsmith_node_modules`** (common troubleshooting step), Turbo's cache is also lost. The next `npm run build` is a full cold build (~30-45s). This is expected. It is not a clean slate, though: that command removes only the **root** volume. The eight per-package `*-node-modules` volumes and `website-vercel-output` declared in `docker-compose.yml` survive it, so a problem living in one of those is untouched — remove the specific volume instead of assuming the root wipe covered it (§ Full Rebuild below shows how to find its Compose-prefixed name).

## Container Rebuild

The Docker volume `node_modules` persists across container restarts. Use the appropriate method based on change scope.

### Restart (Fast)

For minor changes and adding dependencies:

```bash
docker compose --profile dev down
docker compose --profile dev up -d
docker exec -w /app skillsmith-dev-1 sh -c 'sh scripts/lib/node-modules-mount-gate.sh && npm install'
# Exit non-zero with no npm output means at least one node_modules named
# volume (root, or a packages/*/node_modules) isn't currently mounted
# (SMI-6516/SMI-6520/SMI-6614, ADR-158; round-2b widened this from root-only) —
# recreate instead (`docker compose --profile dev up -d --force-recreate
# dev`), then retry, rather than assuming the install itself failed.
```

### Full Rebuild (Thorough)

For major version upgrades, native module changes, or dependency conflicts:

```bash
docker compose --profile dev down
docker volume rm skillsmith_node_modules
docker compose --profile dev build --no-cache
docker compose --profile dev up -d
```

"Thorough" is about the image, not the volumes: this removes the **root** `node_modules` volume only. The eight per-package `*-node-modules` volumes are not named here and are not removed. If the fault you are chasing could live in one of those — a native module or a nested version pin under `packages/<pkg>/node_modules` — remove that volume as well, rather than assuming this recipe reached it (SMI-6674). Compose prefixes each volume with the project name, so find the real name first — and filter, because a bare `grep skillsmith` also matches ~130 `native-seed-*` volumes:

```bash
docker volume ls --format '{{.Name}}' | grep -E '^skillsmith_[a-z-]+-node-modules$'   # the 8 per-package volumes
```

The one backing `packages/core/node_modules` is `skillsmith_core-node-modules`. The root volume is `skillsmith_node_modules` and does not match that pattern.

### When to Use Which

| Scenario | Method |
|----------|--------|
| Adding a new dependency | Restart |
| Updating patch/minor versions | Restart |
| Major version upgrade (e.g., Stripe v14 to v20) | Full Rebuild |
| Native module issues (better-sqlite3, onnxruntime) | Full Rebuild |
| TypeScript errors after `npm install` | Full Rebuild |
| `NODE_MODULE_VERSION` mismatch | Full Rebuild |
| Fresh worktree (no dist/ on host) | Automatic — entrypoint builds on first start |

See [ADR-012: Native Module Version Management](../adr/012-native-module-version-management.md).

## Troubleshooting

**Worktree note (SMI-5559)**: the `docker exec skillsmith-dev-1 <cmd>` recipes below
assume the main checkout — its container is long-lived, so that exact command silently
"succeeds" from any worktree even if the worktree's own container never started. From a
worktree, replace `docker exec skillsmith-dev-1` with `./scripts/worktree-docker.sh exec --`
(resolves the container from cwd, errors loudly if it isn't running) and drop the
container-name volume/recipe substitutions below down to whatever `docker ps` shows for
that worktree.

### Worktree Host-Port Collisions (SMI-4298)

Docker Compose **concatenates** `ports:` across `-f` files instead of replacing them, so the base
`docker-compose.yml`'s `${DEV_PORT:-3001}:3001` is published in *every* worktree in addition to that
worktree's own bucketed ports. `.env` is a symlink shared by main and all worktrees, so `DEV_PORT`
cannot be set per-worktree there — it must be exported at `docker compose up` time.

Use the wrapper, which reads the port back out of the worktree's own override and exports it:

```bash
./scripts/worktree-docker.sh start .        # from inside the worktree ONLY
# From the MAIN checkout this hard-errors (SMI-5836) — use plain
# `docker compose --profile dev up -d` there.
```

By hand, the prefix is required — take the value from the worktree's own override
(`grep ':3001' docker-compose.override.yml`), never from a fresh guess:

```bash
DEV_PORT=$(grep -oE '"[0-9]+:3001"' docker-compose.override.yml | head -1 | tr -d '"' | cut -d: -f1) \
  docker compose --profile dev up -d
```

Symptom without it: `EADDRINUSE` on 3001 if the main checkout's `skillsmith-dev-1` is up — or, if
it is down, a *silent* squat on 3001 that breaks main's next `up` instead.

### Container Won't Start

```bash
docker compose --profile dev down
docker volume rm skillsmith_node_modules
docker compose --profile dev up -d
# The container comes back — the root volume re-seeds from the image — but the
# wipe leaves a mixed dependency state (it removes one volume, not the eight
# per-package ones). Finish with the ordered refresh sequence, not a single
# install step (SMI-6674). Its step 0 is the node_modules mount check, and it
# tells you to recreate with --force-recreate if that check fails
# (SMI-6516/SMI-6520/SMI-6614, ADR-158).
( cd <main-checkout-path> && sh scripts/lib/print-deps-refresh-advice.sh <main-checkout-path> )
```

### Native Module Errors

If you see `ERR_DLOPEN_FAILED` or `NODE_MODULE_VERSION` mismatch (mount-gated, SMI-6614 — a non-zero exit with no rebuild output means a node_modules mount is detached or not a volume; recreate first, `docker compose --profile dev up -d --force-recreate dev`):

```bash
docker exec -w /app skillsmith-dev-1 sh -c 'sh scripts/lib/node-modules-mount-gate.sh && npm rebuild better-sqlite3'
docker exec -w /app skillsmith-dev-1 sh -c 'sh scripts/lib/node-modules-mount-gate.sh && npm rebuild onnxruntime-node'
```

### VSCode Extension esbuild Not Found

Occurs when `npm ci --ignore-scripts` skips esbuild's postinstall script:

```bash
docker exec -w /app skillsmith-dev-1 sh -c 'sh scripts/lib/node-modules-mount-gate.sh && npm rebuild esbuild'
```

The Dockerfile already handles this via `npm rebuild better-sqlite3 onnxruntime-node esbuild`.

### Native Module Platform Mismatch (SMI-2222)

**Symptoms**: SIGKILL exit 137, "wrong ELF class" errors, process crashes during database initialization when running outside Docker.

**Root Cause**: Package-level `node_modules` (e.g., `packages/core/node_modules/better-sqlite3`) can contain binaries compiled for a different platform (Linux binaries from Docker when running on macOS).

**Fix**:

```bash
rm -rf packages/*/node_modules/better-sqlite3 packages/*/node_modules/onnxruntime-node
docker exec -w /app skillsmith-dev-1 sh -c 'sh scripts/lib/node-modules-mount-gate.sh && npm rebuild better-sqlite3 onnxruntime-node'
```

**Prevention**: Always rebuild native modules after switching between Docker and host development. The root `node_modules/` is fine (managed by Docker volume), but package-level duplicates can cause issues.

See [ADR-107: Async/Sync Context Separation](../adr/107-async-sync-context-separation.md) for related WASM fallback architecture.

### Node ABI Mismatch After Node Upgrade

**Symptoms**: `dlopen(...better_sqlite3.node): slice is not valid mach-o file` or `NODE_MODULE_VERSION` mismatch when running the MCP server outside Docker. The server fails to start.

**Root Cause**: The `better-sqlite3` native binary was compiled against the old Node ABI. After upgrading Node, the binary can't load.

**Behavior since core 0.4.10**: The WASM fallback (`sql.js`) auto-activates. `isBetterSqlite3Available()` now instantiates an in-memory database to trigger the actual `dlopen`, catching ABI mismatches before the fallback decision. The MCP server logs: `[Skillsmith] Native SQLite unavailable, using WASM driver`.

**To restore native performance**:

```bash
npm rebuild better-sqlite3
```

Or full rebuild in Docker:

```bash
docker compose --profile dev down
docker volume rm skillsmith_node_modules
docker compose --profile dev up -d
```

### Docker DNS Failure (SMI-2367)

**Symptoms**: `getaddrinfo EAI_AGAIN registry.npmjs.org`, `npm audit` / `npm install` fail inside container, all outbound network calls time out.

**Root Cause**: Stale Docker bridge networks from old worktrees/containers accumulate and degrade Docker Desktop's internal DNS proxy.

**Diagnosis**:

```bash
# Check network count (more than 5 is suspicious)
docker network ls | wc -l

# Test DNS inside container
docker exec skillsmith-dev-1 node -e "require('dns').resolve('registry.npmjs.org', console.log)"
```

**Fix**:

```bash
# 1. Restart Docker Desktop
# 2. Prune stale networks
docker network prune -f

# 3. Restart container
docker compose --profile dev up -d

# 4. Verify DNS works
docker exec skillsmith-dev-1 npm audit --production --audit-level=high
```

**Prevention**: Use `scripts/remove-worktree.sh --prune` when removing worktrees. It automatically checks network count and optionally prunes stale networks.

### Stale Build Artifacts in Container

**Symptoms**: `ReferenceError: exports is not defined in ES module scope`, `Object.defineProperty(exports, "__esModule", ...)` errors in source files.

**Root Cause**: Stale CJS-compiled `.js` files from previous builds sitting in `src/` directories inside the Docker container, conflicting with `"type": "module"`.

**Diagnosis**:

```bash
docker exec skillsmith-dev-1 bash -c 'find /app/packages -path "*/src/*.js" -not -path "*/node_modules/*" -not -path "*/dist/*" -type f'
```

**Fix**:

```bash
docker exec skillsmith-dev-1 bash -c 'find /app/packages -path "*/src/*.js" -not -path "*/node_modules/*" -not -path "*/dist/*" -type f -delete'
```

### Docker Desktop Hung on "Turning off the Docker Engine..." (SMI-5616/SMI-5750)

**Symptoms**: Docker Desktop's UI shows "Turning off the Docker Engine..." indefinitely (with the "pause instead" tip) and never completes. Every `docker` CLI command (`docker info`, `docker ps`, `docker compose up`) hangs forever instead of erroring, across all concurrent sessions/worktrees.

**Root Cause**: Host disk full. Docker Desktop's macOS VM disk (`~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw`) can't be written to when the host has no free space, which hangs engine shutdown/startup. Check:

```bash
df -h / /System/Volumes/Data   # if Avail is near 0, this is the cause
du -sh ~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw
```

Continuous multi-session concurrent worktree usage accumulates orphaned Docker volumes/images unboundedly — `docker system df` after the fact showed 215 of 241 local volumes orphaned (35GB+ reclaimable). See SMI-5616 (incident) and SMI-5750 (proposed durable fix — a targeted prune that doesn't require an idle window).

**Fix**:

```bash
# 1. Force-quit the hung Docker Desktop process and backend (graceful quit will not work — it's already hung mid-quit)
pkill -9 -f "Docker Desktop.app/Contents/MacOS/Docker Desktop"
pkill -9 -f "com.docker.backend"
pkill -9 -f "com.docker.build"

# 2. Relaunch
open -a "Docker Desktop"

# 3. Wait ~5-30s, then confirm the daemon responds
docker info

# 4. Containers with `restart: unless-stopped` (all skillsmith dev containers) auto-restart —
#    no need to manually `docker compose up -d` per worktree.

# 5. Reclaim disk space — this is the actual fix, not just the restart
docker system df                        # see what's reclaimable
docker system prune -a -f --volumes     # removes unused images/volumes/build cache/networks
df -h / /System/Volumes/Data            # confirm space recovered

# Routine cleanup (when Docker is healthy): `./scripts/prune-orphaned-docker-volumes.sh` is the safe, concurrency-safe targeted path; reserve the aggressive `docker system prune -a -f --volumes` for the incident-recovery scenario above.
```

**Caveat**: `docker system prune -a -f --volumes` removes ANY volume/image not attached to a currently-running container — including cached `node_modules` volumes for worktrees that exist but whose containers are temporarily stopped, forcing a slower next start (native-module rebuild) for those. Safe to run without hesitation only when Docker Desktop itself is already down for everyone (no live containers to disrupt, as in this failure mode). If Docker is otherwise healthy and you just want routine cleanup, prefer `./scripts/remove-worktree.sh --prune` (safe subset: networks + dangling images + build cache) and only reach for the aggressive `--volumes` prune when you've confirmed via `docker ps` that no other worktree session needs to resume.

### Orphaned Agent Processes

If background agents don't terminate properly:

```bash
./scripts/cleanup-orphans.sh --dry-run   # Preview
./scripts/cleanup-orphans.sh             # Kill
```
