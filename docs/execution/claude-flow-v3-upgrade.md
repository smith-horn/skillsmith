# Claude-Flow V3 Upgrade Status

## Current State

| Aspect | Status |
|--------|--------|
| Package Version | `3.0.0-alpha.83` (pre-release) |
| Build | Passing |
| Typecheck | Passing |
| Stable Release | Not yet available |

## Version History

- **V2 (Previous)**: `2.7.47` - stable release
- **V3 (Current)**: `3.0.0-alpha.83` - pre-release alpha

## Breaking Changes Identified

### 1. No Stable V3 Release

The V3 release is currently only available as alpha versions (`3.0.0-alpha.44` through `3.0.0-alpha.83`). There is no stable `^3.0.0` release on npm yet.

**Impact**: This migration uses pre-release software which may have breaking changes between alpha versions.

**Mitigation**: Pin to specific alpha version (`3.0.0-alpha.83`) rather than using semver range.

### 2. API Changes (Pending Verification)

The following APIs need verification for V3 compatibility:

| API | V2 Usage | V3 Status |
|-----|----------|-----------|
| `memory store --key X --value Y` | SessionManager.ts:415-423 | TBD |
| `memory get --key X` | SessionManager.ts:447-455 | TBD |
| `memory delete --key X` | SessionManager.ts:480-486 | TBD |
| `hooks pre-task --description X` | SessionManager.ts:503-517 | TBD |
| `hooks post-task --task-id X` | SessionManager.ts:531-537 | TBD |
| `hooks post-edit --file X` | .claude/settings.json:51 | TBD |
| `hooks session-end` | .claude/settings.json:110 | TBD |

### 3. Package Tag Change

V2 code references `claude-flow@alpha` tag. V3 may use different tagging:

```bash
# V2 pattern
npx claude-flow@alpha memory store --key X --value Y

# V3 pattern (TBD - may be different)
npx claude-flow memory store --key X --value Y
```

## Migration Locations

### High Priority (Code Changes Required)

1. **SessionManager.ts** (lines 407-543)
   - 6 spawn-based memory operations
   - 4 spawn-based hooks operations
   - Currently using `claude-flow@alpha` tag

2. **SessionRecovery.ts** (lines 79, 289, 307)
   - Uses string-based `execute()` instead of spawn
   - Security concern: should migrate to spawn()
   - 3 memory/hooks operations

3. **.claude/settings.json** (lines 42-117)
   - 5 hook command definitions
   - 2 MCP server references

### Medium Priority (Test Updates)

4. **SessionManager.test.ts** - Mock command patterns
5. **SessionManager.security.test.ts** - Mock command patterns

### Low Priority (Documentation/Scripts)

6. Shell scripts in `scripts/` directory (6 files)
7. Prompt templates in `scripts/prompts/` (10 files)
8. Agent definitions in `.claude/agents/` (2 files)
9. Skill definitions in `.claude/skills/` (5 files)

## Verification Checklist

- [x] package.json updated to V3 alpha
- [x] npm install succeeds
- [x] npm run build succeeds
- [x] npm run typecheck succeeds
- [x] Memory commands work with V3 (SMI-1518: feature flag `CLAUDE_FLOW_USE_V3_API`)
- [x] Hooks commands work with V3 (SMI-1518: V3 MCP tool API with spawn fallback)
- [ ] MCP server compatible with V3
- [x] All tests pass with V3 (58 SessionManager tests, 28 HNSW tests, 36 ReasoningBank tests, 56 SONA tests, 44 PatternStore tests, 46 MultiLLMProvider tests, 33 LLMFailoverChain tests)

## Completed Tasks

### SMI-1517: Upgrade claude-flow to V3 (Done)
- Updated package.json to `claude-flow: 3.0.0-alpha.83`
- Build and typecheck pass

### SMI-1518: Migrate SessionManager to V3 Memory API (Done)
- Added V3 API imports: `storeEntry`, `getEntry`, `callMCPTool`
- Implemented feature flag `CLAUDE_FLOW_USE_V3_API` for gradual rollout
- V3 API with spawn fallback for backwards compatibility
- 58 tests pass

### SMI-1519: Implement HNSW + SQLite hybrid embedding storage (Done)
- Created `packages/core/src/embeddings/hnsw-store.ts`
- Uses V3 VectorDB API with automatic HNSW/fallback selection
- SQLite for metadata persistence
- Feature flag `SKILLSMITH_USE_HNSW` for opt-in
- Presets for different dataset sizes (small, medium, large, xlarge)
- 28 tests pass

### SMI-1520: Integrate ReasoningBank for skill recommendation learning (Done)
- Created `packages/core/src/learning/ReasoningBankIntegration.ts`
- Implements `ISignalCollector` interface for drop-in replacement
- Converts user signals to trajectories with reward values:
  - Accept: +1.0, Dismiss: -0.5, Usage: +0.3, Abandonment: -0.3, Uninstall: -0.7
- `getVerdict()` method for querying learned confidence
- Batch verdict queries and top skills by confidence
- Dual-write mode for backwards compatibility with legacy storage
- Stub ReasoningBank for testing without V3 dependencies
- 36 tests pass

### SMI-1521: Implement SONA routing for MCP tool optimization (Done)
- Created `packages/core/src/routing/SONARouter.ts`
- 8-expert MoE (Mixture of Experts) network:
  - 2 accuracy experts (semantic search, validation)
  - 2 latency experts (cache-first, index lookup)
  - 2 balanced experts (default, reliability)
  - 2 specialized experts (recommend, compare)
- Tool weight profiles: search (accuracy), get_skill (latency), install (reliability)
- LRU cache for routing decisions with configurable TTL
- V3 MoERouter and SONAOptimizer integration with fallback
- Feature flags for gradual rollout (`sona.enabled`, `sona.tools.*`, `sona.tiers.*`)
- Metrics collection for observability
- Architecture document: `docs/architecture/sona-router-architecture.md`
- 56 tests pass

### SMI-1522: Add EWC++ pattern storage for successful matches (Done)
- Created `packages/core/src/learning/PatternStore.ts`
- Implements Elastic Weight Consolidation++ for catastrophic forgetting prevention
- Key features:
  - `storePattern()`: Encodes successful matches with Fisher Information tracking
  - `findSimilarPatterns()`: Importance-weighted similarity search
  - `consolidate()`: Prunes low-importance patterns while preserving 95%+ of important ones
  - `FisherInformationMatrix`: Tracks dimension importance with decay and serialization
- Pattern outcome types aligned with ReasoningBankIntegration rewards
- SQLite persistence for patterns, Fisher matrix, and consolidation history
- V3 ReasoningBank integration with standalone fallback
- EWC++ hyperparameters: lambda=5.0, fisherDecay=0.95, importanceThreshold=0.01
- Architecture document: `docs/architecture/pattern-store-ewc-architecture.md`
- 44 tests pass including catastrophic forgetting prevention tests

### SMI-1523: Configure multi-LLM provider chain (Done)
- Created `packages/core/src/testing/MultiLLMProvider.ts`
- Implements multi-provider LLM support with 5 providers:
  - Anthropic (Claude) - primary, quality-focused
  - OpenAI (GPT) - fallback 1, speed-focused
  - Google (Gemini) - fallback 2, cost-focused
  - Cohere (Command) - fallback 3, cost-focused
  - Ollama (local) - fallback 4, privacy-focused
- Key features:
  - Automatic failover with configurable strategy (rate_limit, unavailable, timeout, error)
  - Circuit breaker pattern with half-open state for recovery
  - Load balancing strategies: round-robin, least-loaded, latency-based, cost-based
  - Cost optimization with provider preferences and max cost per request
  - Skill compatibility testing across all enabled providers
  - Metrics collection: latency, error rates, costs, request counts
  - Event emission for monitoring (initialized, v3_integration, metrics, provider_error)
- V3 ProviderManager integration with standalone fallback
- Factory function `createMultiLLMProvider()` for easy initialization
- 46 tests pass

### SMI-1524: Implement LLM failover with circuit breaker (Done)
- Created `packages/mcp-server/src/llm/failover.ts` - MCP server wrapper
- Implements LLMFailoverChain class that wraps MultiLLMProvider for MCP tool handlers
- Key features:
  - Compliant with SMI-1524 acceptance criteria:
    - Failover triggers within 3 seconds (`failoverTimeoutMs: 3000`)
    - Circuit breaker opens after 5 failures (`circuitOpenThreshold: 5`)
    - Circuit resets after 60 seconds (`circuitResetTimeoutMs: 60000`)
  - Health check endpoint via `getHealthStatus()` for monitoring
  - Per-provider health and circuit state reporting
  - Environment variable control (`SKILLSMITH_LLM_FAILOVER_ENABLED`)
  - Debug mode for troubleshooting
- Updated `packages/mcp-server/src/context.ts`:
  - Added `llmFailover` to `ToolContext` interface
  - Added `llmFailoverConfig` to `ToolContextOptions`
  - Background initialization with cleanup handlers
- Added exports in `packages/core/package.json`:
  - `./testing` - MultiLLMProvider and types
  - `./learning` - ReasoningBank and PatternStore
- 33 tests pass

### Code Review Fixes (SMI-1523, SMI-1524)
Post-implementation code review identified and resolved critical issues:

1. **Race Condition Fix**: Added initialization promise pattern to prevent concurrent access before async initialization completes. Methods calling `ensureInitialized()` now properly await it.

2. **Memory Leak Fix**: Signal handlers (SIGTERM, SIGINT) are now stored in `_signalHandlers` array and properly removed in `closeToolContext()` to prevent listener accumulation.

3. **Silent Error Fix**: LLM failover initialization errors are now always logged to stderr, not just in debug mode.

4. **Test Organization**: Moved `failover.test.ts` from `src/__tests__/llm/` to `tests/llm/` to match vitest include patterns.

## Next Steps

1. Update tests to mock V3 API patterns
2. Phase 4: Security Hardening (SMI-1613, SMI-1609, SMI-1610)

## Rollback Plan

To rollback to V2:

```bash
# In package.json
"claude-flow": "2.7.47"

# Then reinstall
npm install
```

---

*Document created: January 16, 2026*
*Issue: SMI-1517*
