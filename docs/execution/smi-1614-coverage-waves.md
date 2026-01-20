# SMI-1614: MCP Server Test Coverage Waves

**Issue**: [SMI-1614](https://linear.app/smith-horn-group/issue/SMI-1614/mcp-server-test-coverage-gaps-blocking-pre-push-hooks)
**Created**: 2026-01-19
**Last Updated**: 2026-01-19

## Status Summary

| Metric | Before | After | Target | Status |
|--------|--------|-------|--------|--------|
| Branch Coverage (Global) | 67.21% | 67.82% | 72% | 🟡 In Progress |
| `context.ts` Branches | 46.83% | 88.05% | 75% | ✅ Complete |
| `license.ts` Branches | 62.96% | 55.73%* | 75% | 🟡 Needs Work |
| `get-skill.ts` Branches | 66.66% | 46.42%* | 75% | 🟡 Needs Work |

*Note: Coverage may have decreased due to measurement methodology changes or additional code paths.

---

## Completed Work (Wave 1-3)

### Wave 1: context.ts ✅ COMPLETE

**File**: `packages/mcp-server/src/__tests__/context.test.ts` (NEW)
**Tests Added**: 38 tests
**Coverage Improvement**: 46.83% → 88.05% branches

#### Test Groups Implemented:
1. **getDefaultDbPath()** - 6 tests
   - Default path when env var not set
   - Valid custom path via env var
   - Temp directory paths
   - Path traversal rejection
   - In-memory database paths
   - `.claude` directory paths

2. **createToolContext() - basic** - 7 tests
   - In-memory database creation
   - Default options behavior
   - Invalid path rejection
   - Custom search cache TTL
   - API client configuration
   - Directory creation for file-based DB
   - Skip directory for in-memory

3. **createToolContext() - telemetry** - 5 tests
   - Disabled by default
   - Enabled via env var + API key
   - Enabled via config options
   - Not enabled without API key
   - Env var preference over config

4. **createToolContext() - sync/failover** - 5 tests
   - Background sync disabled via env
   - Background sync disabled via config
   - Sync config enabled check
   - LLM failover default disabled
   - LLM failover enabled via env/config

5. **closeToolContext()** - 5 tests
   - Database connection closure
   - Signal handler removal
   - Background sync stop
   - LLM failover close
   - PostHog shutdown

6. **getToolContext() + resetToolContext()** - 7 tests
   - Singleton creation
   - Same context on subsequent calls
   - Warning on late options
   - No warning without options
   - Context clear on reset
   - Proper cleanup before reset
   - Idempotent reset

### Wave 2: license.ts ✅ ENHANCED

**File**: `packages/mcp-server/src/__tests__/middleware/license.test.ts`
**Tests Added**: ~10 new tests

#### New Test Coverage:
- License expiration when already expired (daysUntilExpiry <= 0)
- `createLicenseErrorResponse` without upgradeUrl
- `createLicenseErrorResponse` without feature field
- Cache TTL expiry with fake timers
- Tier validation scenarios (community → team/enterprise)
- Upgrade URL with current tier

### Wave 3: get-skill.ts ✅ ENHANCED

**File**: `packages/mcp-server/src/__tests__/get-skill.test.ts`
**Tests Added**: ~10 new tests

#### New Test Coverage:
- Community trust tier formatting
- Experimental trust tier formatting
- Tags display when present
- N/A for missing version
- Timing information display
- Repository URL display
- Whitespace handling in skill ID
- Whitespace-only ID rejection
- Suggestion for not found skills
- Suggestion for invalid ID format
- Score conversion from decimal to percentage

---

## Remaining Work

### Files Still Needing Coverage

| File | Current Branches | Target | Gap | Priority |
|------|-----------------|--------|-----|----------|
| `license.ts` | 55.73% | 75% | -19% | HIGH |
| `get-skill.ts` | 46.42% | 75% | -29% | HIGH |
| `BackgroundSyncService.ts` | 0% | 50% | -50% | MEDIUM |
| `prometheus.ts` | 0% | 50% | -50% | LOW |

### Recommended Next Steps

1. **Improve license.ts coverage** (Priority: HIGH)
   - Add integration tests with mocked enterprise validator
   - Test tier escalation paths (individual → team, team → enterprise)
   - Test feature not in license.features array

2. **Improve get-skill.ts coverage** (Priority: HIGH)
   - Add tests for API fallback logic (lines 122-167)
   - Test API response mapping with null/undefined fields
   - Test formatScoreBar edge cases (0, 50, 100)

3. **Add BackgroundSyncService tests** (Priority: MEDIUM)
   - Currently at 0% coverage
   - Test start/stop lifecycle
   - Test sync callbacks

---

## Execution Notes

### Hardware Target
- MacBook M4 Pro
- Keep keyboard responsive with ~30-40k tokens per wave

### Commands Used

```bash
# Run specific test file
docker exec skillsmith-dev-1 npx vitest run packages/mcp-server/src/__tests__/context.test.ts

# Check coverage for MCP server
docker exec skillsmith-dev-1 npx vitest run --coverage 2>&1 | grep -E "context\.ts|license\.ts|get-skill\.ts"

# Full coverage report
docker exec skillsmith-dev-1 npm run test:coverage
```

### CI Status
- All new tests pass (171 MCP server tests)
- Global branch coverage: 67.82% (above current 67% threshold)
- Ready to merge current progress

---

## Code Review Follow-up (PR #24)

After PR #23 was merged, a code review identified several issues that were addressed in PR #24.

### Issues Identified

| Issue | Severity | Description |
|-------|----------|-------------|
| Mock-based expiration tests | Major | License expiration tests (lines 418-517) tested mocks instead of actual `getExpirationWarning` implementation |
| Environment restoration | Minor | Manual `process.env` manipulation could cause test pollution |
| Duplicate mock objects | Minor | Similar mock middleware created across multiple tests |
| Magic numbers | Minor | Hard-coded values like `24 * 60 * 60 * 1000` reduced readability |
| Undocumented timeout | Minor | 15s timeout lacked explanation of why it's needed |

### Resolutions

1. **Export `getExpirationWarning`** - Added `@internal` tag and exported the pure function for direct unit testing
2. **Use `vi.stubEnv()`** - Replaced manual env manipulation with proper vitest environment stubbing
3. **Create `createMockMiddleware()`** - Factory function reduces duplication
4. **Add `MS_PER_DAY` constant** - Named constant improves code readability
5. **Document 15s timeout** - Added explanation that monorepo CI loads real enterprise validator

### Test Quality Improvements

The new `getExpirationWarning` tests:
- Use `vi.useFakeTimers()` for deterministic time control
- Test all boundary conditions (0, 1, 30, 31 days)
- Exercise actual implementation logic, not pre-computed mocks
- Include proper cleanup in `finally` blocks

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-01-19 | Commit at 67.82% instead of 72% | Significant progress made on context.ts. Remaining work can be done in follow-up PRs. |
| 2026-01-19 | Skip threshold update to 72% | Need ~4% more branch coverage before raising threshold. |
| 2026-01-19 | Focus on context.ts first | Largest gap (46.83%) with most testable surface area. |
| 2026-01-19 | Export internal function for testing | Pure functions like `getExpirationWarning` are easier to test directly than through integration. |
| 2026-01-19 | Use `vi.stubEnv()` pattern | Vitest's built-in env stubbing is cleaner than manual `process.env` manipulation. |
