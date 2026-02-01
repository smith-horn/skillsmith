# ADR-107: Async/Sync Context Separation Pattern

**Status**: Accepted
**Date**: 2026-02-01
**Related Issues**: SMI-2207, SMI-2223

## Context

The Skillsmith MCP server needs to support both native SQLite (better-sqlite3) and WASM SQLite (sql.js) database drivers for cross-platform compatibility. better-sqlite3 provides a synchronous API, while sql.js requires asynchronous initialization when loading WASM modules.

### The Race Condition Problem

The original singleton pattern cached the first context created, regardless of whether it was sync or async:

```typescript
// Original problematic pattern
let globalContext: ToolContext | null = null

export function getToolContext(options?: ToolContextOptions): ToolContext {
  if (!globalContext) {
    globalContext = createToolContext(options) // Sync creation
  }
  return globalContext
}

export async function getToolContextAsync(options?: ToolContextOptions): Promise<ToolContext> {
  if (!globalContext) {
    globalContext = await createToolContextAsync(options) // Async creation
  }
  return globalContext
}
```

This created a race condition where:
1. If sync code called `getToolContext()` first, it cached a sync-initialized context
2. If async code later called `getToolContextAsync()`, it returned the cached sync context
3. The WASM fallback never triggered, causing failures on platforms without native modules

### Platform Requirements

| Platform | Native Module Support | Required Driver |
|----------|----------------------|-----------------|
| Linux (glibc) | ✅ better-sqlite3 works | better-sqlite3 (sync) |
| macOS | ✅ better-sqlite3 works | better-sqlite3 (sync) |
| Windows | ✅ better-sqlite3 works | better-sqlite3 (sync) |
| Alpine Linux | ❌ No glibc (musl) | sql.js (async) |
| Browser/Edge | ❌ No native modules | sql.js (async) |

## Decision

Maintain **separate singleton caches** for sync and async contexts to prevent caching conflicts.

### Implementation

```typescript
// Separate singleton for sync context
let globalContext: ToolContext | null = null

// Separate singleton for async context (prevents caching conflict)
let asyncGlobalContext: ToolContext | null = null

export function getToolContext(options?: ToolContextOptions): ToolContext {
  if (!globalContext) {
    globalContext = createToolContext(options) // Sync-only cache
  }
  return globalContext
}

export async function getToolContextAsync(options?: ToolContextOptions): Promise<ToolContext> {
  if (!asyncGlobalContext) {
    asyncGlobalContext = await createToolContextAsync(options) // Async-only cache
  }
  return asyncGlobalContext
}
```

### Key Principles

1. **Cache Isolation**: Sync and async contexts use separate caches
2. **Async Initialization**: Main MCP server function initializes async context before handlers
3. **Fallback Transparency**: Callers use async functions; fallback happens automatically
4. **Testing Support**: Separate `resetToolContext()` and `resetAsyncToolContext()` functions

## Consequences

### Positive

1. **WASM fallback works reliably** - No sync context cached when async is needed
2. **No race conditions** - Each initialization path has its own cache
3. **Platform compatibility** - Supports both native and WASM environments
4. **Clear separation of concerns** - Sync and async consumers don't interfere

### Negative

1. **Two caches to manage** - Increases memory usage if both are initialized
2. **Potential confusion** - Developers must choose correct function (`getToolContext` vs `getToolContextAsync`)
3. **Code duplication** - `createToolContext` and `createToolContextAsync` have similar logic

### Neutral

1. **Testing isolation** - Must reset both caches in test cleanup
2. **Migration path** - Existing sync code continues working unchanged
3. **Memory overhead** - In practice, only one cache is used per process

## Implementation Details

### Database Initialization Paths

**Sync Path (Native Modules)**:
```typescript
export function createToolContext(options: ToolContextOptions = {}): ToolContext {
  // Validate path
  const dbPath = getValidatedDbPath(options.dbPath)

  // Sync database creation (better-sqlite3)
  let db: DatabaseType
  if (dbPath !== ':memory:' && existsSync(dbPath)) {
    db = openDatabase(dbPath) // Sync
  } else {
    db = createDatabase(dbPath) // Sync
  }

  // Initialize services
  return createContext(db, options)
}
```

**Async Path (WASM Fallback)**:
```typescript
export async function createToolContextAsync(options: ToolContextOptions = {}): Promise<ToolContext> {
  // Validate path
  const dbPath = getValidatedDbPath(options.dbPath)

  // Async database creation with WASM fallback
  let db: DatabaseType
  if (dbPath !== ':memory:' && existsSync(dbPath)) {
    db = await openDatabaseAsync(dbPath) // Tries better-sqlite3, falls back to sql.js
  } else {
    db = await createDatabaseAsync(dbPath) // Tries better-sqlite3, falls back to sql.js
  }

  // Initialize services
  return createContext(db, options)
}
```

### MCP Server Initialization

The MCP server's `main()` function ensures async context is initialized before any handlers access it:

```typescript
async function main() {
  // Initialize async context BEFORE server starts
  await getToolContextAsync({
    backgroundSyncConfig: { enabled: true, debug: DEBUG },
    llmFailoverConfig: { enabled: false },
  })

  // Start MCP server - handlers can now safely use the cached context
  const server = new Server({
    name: 'skillsmith',
    version: '0.3.14',
  }, {
    capabilities: { tools: {} },
  })

  // Handlers use getToolContextAsync() - returns cached context
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const context = await getToolContextAsync() // Returns cached instance
    // ...
  })
}
```

### Testing Pattern

Tests must reset both caches to ensure isolation:

```typescript
import { resetToolContext, resetAsyncToolContext } from '../src/context.js'

describe('Context Tests', () => {
  afterEach(async () => {
    // Reset both singleton caches
    await resetToolContext()
    await resetAsyncToolContext()
  })

  it('async context is separate from sync singleton', async () => {
    const asyncCtx = await getToolContextAsync({ dbPath: ':memory:' })
    await resetAsyncToolContext()

    // Can create new async context (not affected by resetToolContext)
    const newAsyncCtx = await getToolContextAsync({ dbPath: ':memory:' })
    expect(newAsyncCtx).not.toBe(asyncCtx)
  })
})
```

## Migration Guidance

### For Existing Code (Sync)

No changes required. Existing sync code continues working:

```typescript
// Works as before
const context = getToolContext({ dbPath: ':memory:' })
```

### For New Code (Async Recommended)

Use async functions for cross-platform compatibility:

```typescript
// Recommended for new code
const context = await getToolContextAsync({ dbPath: ':memory:' })
```

### For MCP Server Handlers

Always use async context:

```typescript
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const context = await getToolContextAsync()
  // Handler logic
})
```

## Alternatives Considered

### Option 1: Unified Singleton with Lazy Async Upgrade

Use a single cache that upgrades from sync to async on first async call.

**Pros**:
- Single cache to manage
- Automatic upgrade path

**Cons**:
- Complex state machine
- Risk of upgrading mid-request
- Database recreation overhead

**Rejected**: Too complex and error-prone.

### Option 2: Always Async

Make all functions async and always use WASM fallback.

**Pros**:
- Simplest API
- No cache separation needed

**Cons**:
- Performance penalty on native platforms
- Breaking change for existing sync code

**Rejected**: Unnecessary performance penalty.

### Option 3: Feature Detection at Import Time

Detect native module availability at import time and choose path.

**Pros**:
- Single cache works correctly
- Automatic path selection

**Cons**:
- Import-time side effects
- Harder to test both paths
- Doesn't handle dynamic fallback

**Rejected**: Less flexible than runtime selection.

## Related Decisions

- **ADR-009**: Embedding Service Fallback Strategy (established mock/real dual-mode pattern)
- **ADR-002**: Docker glibc Requirement (establishes native module dependency challenges)

## Verification

Tested with commit series implementing SMI-2207:

| Test Case | Result |
|-----------|--------|
| Sync-only consumers (CLI tools) | ✅ Use `globalContext` |
| Async-only consumers (MCP server) | ✅ Use `asyncGlobalContext` |
| Mixed sync/async in tests | ✅ Separate reset functions work |
| WASM fallback on Alpine Linux | ✅ No sync context cached |

## Future Considerations

1. **Cache Unification**: If sync code is fully deprecated, remove `globalContext`
2. **Memory Optimization**: Add option to disable unused cache
3. **Type Safety**: Consider TypeScript branded types to prevent mixing sync/async contexts
4. **Monitoring**: Add telemetry to track which cache is used in production

## References

- Implementation: `packages/mcp-server/src/context.ts` lines 426-685
- Tests: `packages/mcp-server/tests/context-async.test.ts`
- Database fallback: `packages/core/src/database/index.ts` (`createDatabaseAsync`, `openDatabaseAsync`)
- MCP server initialization: `packages/mcp-server/src/index.ts` (`main()` function)
