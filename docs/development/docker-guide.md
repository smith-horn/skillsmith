# Docker Development Guide

Developer reference for Docker container management, rebuild scenarios, and troubleshooting.

## Container Management

```bash
docker compose --profile dev up -d      # Start container
docker compose --profile dev down       # Stop container
docker logs skillsmith-dev-1            # View logs
```

## Container Rebuild

The Docker volume `node_modules` persists across container restarts. Use the appropriate method based on change scope.

### Restart (Fast)

For minor changes and adding dependencies:

```bash
docker compose --profile dev down
docker compose --profile dev up -d
docker exec skillsmith-dev-1 npm install
```

### Full Rebuild (Thorough)

For major version upgrades, native module changes, or dependency conflicts:

```bash
docker compose --profile dev down
docker volume rm skillsmith_node_modules
docker compose --profile dev build --no-cache
docker compose --profile dev up -d
```

### When to Use Which

| Scenario | Method |
|----------|--------|
| Adding a new dependency | Restart |
| Updating patch/minor versions | Restart |
| Major version upgrade (e.g., Stripe v14 to v20) | Full Rebuild |
| Native module issues (better-sqlite3, onnxruntime) | Full Rebuild |
| TypeScript errors after `npm install` | Full Rebuild |
| `NODE_MODULE_VERSION` mismatch | Full Rebuild |

See [ADR-012: Native Module Version Management](../adr/012-native-module-version-management.md).

## Troubleshooting

### Container Won't Start

```bash
docker compose --profile dev down
docker volume rm skillsmith_node_modules
docker compose --profile dev up -d
docker exec skillsmith-dev-1 npm install
```

### Native Module Errors

If you see `ERR_DLOPEN_FAILED` or `NODE_MODULE_VERSION` mismatch:

```bash
docker exec skillsmith-dev-1 npm rebuild better-sqlite3
docker exec skillsmith-dev-1 npm rebuild onnxruntime-node
```

### VSCode Extension esbuild Not Found

Occurs when `npm ci --ignore-scripts` skips esbuild's postinstall script:

```bash
docker exec skillsmith-dev-1 npm rebuild esbuild
```

The Dockerfile already handles this via `npm rebuild better-sqlite3 onnxruntime-node esbuild`.

### Native Module Platform Mismatch (SMI-2222)

**Symptoms**: SIGKILL exit 137, "wrong ELF class" errors, process crashes during database initialization when running outside Docker.

**Root Cause**: Package-level `node_modules` (e.g., `packages/core/node_modules/better-sqlite3`) can contain binaries compiled for a different platform (Linux binaries from Docker when running on macOS).

**Fix**:

```bash
rm -rf packages/*/node_modules/better-sqlite3 packages/*/node_modules/onnxruntime-node
docker exec skillsmith-dev-1 npm rebuild better-sqlite3 onnxruntime-node
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

### Orphaned Agent Processes

If background agents don't terminate properly:

```bash
./scripts/cleanup-orphans.sh --dry-run   # Preview
./scripts/cleanup-orphans.sh             # Kill
```
