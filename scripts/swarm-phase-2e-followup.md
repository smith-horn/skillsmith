# Phase 2e Follow-up Swarm Execution Prompt

## Token Effort Estimates

| Issue | Title | Size | Est. Tokens | Batch |
|-------|-------|------|-------------|-------|
| SMI-757 | Fix unused imports and type exports | S | ~5K | 1 |
| SMI-759 | Refactor CLI search to iterative loop | S | ~8K | 1 |
| SMI-762 | Document swarm recovery procedures | S | ~6K | 1 |
| SMI-763 | Create mock vs production checklist | S | ~5K | 1 |
| SMI-755 | Add graceful fallback for OpenTelemetry | M | ~20K | 2 |
| SMI-758 | Add telemetry unit tests | M | ~25K | 2 |
| SMI-760 | Add dependency validation to pre-flight | M | ~20K | 2 |
| SMI-754 | Replace mock data with real services | L | ~60K | 3 |
| SMI-756 | Add integration tests for MCP tools | L | ~50K | 3 |
| SMI-761 | Implement session health monitoring | L | ~70K | 4 |

**Total Estimate**: ~270K tokens across 4 batches

---

## Batch 1: Quick Wins (4 issues, ~24K tokens)

Run this in a fresh terminal:

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

claude -p "Execute Phase 2e Follow-up Batch 1: Quick Wins

## Context
You are continuing work on the Skillsmith project. Phase 2e is complete but code review identified follow-up items. This batch contains 4 small issues that can be completed quickly.

## Memory Coordination
Before starting, retrieve context:
- npx claude-flow memory get swarm/phase-2e/context

Store your progress after each issue:
- npx claude-flow memory store swarm/batch1/SMI-XXX '{\"status\": \"done\", \"files\": [...]}'

## Issues to Complete

### SMI-757: Fix unused imports and type exports [~5K tokens]
**Files:** packages/mcp-server/src/tools/recommend.ts, validate.ts
**Task:**
1. Remove unused imports (SkillsmithError, ErrorCodes from recommend.ts)
2. Remove or properly export unused types (RecommendParsed, ValidateParsed)
3. Run: docker exec skillsmith-dev-1 npm run lint -- --fix
4. Verify: docker exec skillsmith-dev-1 npm run typecheck

### SMI-759: Refactor CLI search to iterative loop [~8K tokens]
**File:** packages/cli/src/commands/search.ts:243
**Task:**
1. Replace recursive runInteractiveSearch call with while loop
2. Use a state machine pattern instead of recursion
3. Add tests for multiple consecutive searches
4. Verify: docker exec skillsmith-dev-1 npm run typecheck && docker exec skillsmith-dev-1 npm test

### SMI-762: Document swarm recovery procedures [~6K tokens]
**File:** Create docs/guides/swarm-recovery.md
**Task:**
1. Document how to detect a stuck session
2. Document memory retrieval: npx claude-flow memory list
3. Document agent restart procedures
4. Add troubleshooting FAQ
5. Link from main README or CLAUDE.md

### SMI-763: Create mock vs production checklist [~5K tokens]
**Files:** .github/PULL_REQUEST_TEMPLATE.md, docs/architecture/standards.md
**Task:**
1. Add checklist item to PR template for mock data review
2. Document mock vs production separation in standards.md
3. Add examples of proper patterns

## Completion Criteria
- All 4 issues complete
- docker exec skillsmith-dev-1 npm run typecheck passes
- docker exec skillsmith-dev-1 npm run lint passes
- Commit with message referencing all 4 issues
- Mark issues Done in Linear: docker exec skillsmith-dev-1 npm run linear:done SMI-757 SMI-759 SMI-762 SMI-763

## Important
- Use Docker for tests: docker exec skillsmith-dev-1 npm test
- Commit frequently to save progress
- If context gets large, commit and summarize what's done"
```

---

## Batch 2: Medium Improvements (3 issues, ~65K tokens)

Run after Batch 1 completes:

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

claude -p "Execute Phase 2e Follow-up Batch 2: Medium Improvements

## Context
Batch 1 is complete (SMI-757, 759, 762, 763). Now tackling 3 medium-sized issues.

## Memory Coordination
Retrieve Batch 1 status:
- npx claude-flow memory get swarm/batch1/status

Store progress after each issue.

## Issues to Complete

### SMI-755: Add graceful fallback for OpenTelemetry [~20K tokens]
**File:** packages/core/src/telemetry/tracer.ts
**Task:**
1. Wrap OpenTelemetry initialization in try-catch
2. Create NoOpTracer fallback when OTel unavailable
3. Add SKILLSMITH_TELEMETRY_ENABLED env var check
4. Log warning when falling back to no-op
5. Add tests for fallback behavior
6. Update telemetry/index.ts exports

### SMI-758: Add telemetry unit tests [~25K tokens]
**Files:** Create packages/core/tests/telemetry.test.ts
**Task:**
1. Mock @opentelemetry/api for testing
2. Test tracer initialization and shutdown
3. Test span creation and attributes
4. Test metrics recording
5. Test graceful fallback (from SMI-755)
6. Aim for 80% coverage on telemetry module

### SMI-760: Add dependency validation to pre-flight [~20K tokens]
**Files:** Create scripts/preflight-check.ts, update package.json
**Task:**
1. Parse TypeScript files for import statements
2. Extract package names from imports
3. Compare against package.json dependencies
4. Report missing dependencies with install command
5. Add npm script: \"preflight\": \"tsx scripts/preflight-check.ts\"
6. Document in CLAUDE.md

## Completion Criteria
- All 3 issues complete
- Tests pass with good coverage
- Commit with message referencing issues
- Mark issues Done: docker exec skillsmith-dev-1 npm run linear:done SMI-755 SMI-758 SMI-760

## Important
- These are more complex - take time to design before implementing
- Run tests after each change
- If approaching context limit, commit partial progress"
```

---

## Batch 3: Service Integration (2 issues, ~110K tokens)

⚠️ **CRITICAL**: These are large issues. Consider splitting into sub-tasks if context grows.

Run after Batch 2 completes:

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

claude -p "Execute Phase 2e Follow-up Batch 3: Service Integration

## Context
Batches 1-2 complete. Now tackling the 2 largest code issues.

## ⚠️ Context Management
These issues are LARGE. To avoid context overflow:
1. Complete one issue fully before starting the next
2. Commit after each issue
3. If context > 100K tokens, stop, commit, and start new session

## Issues to Complete

### SMI-754: Replace mock data with real service integration [~60K tokens]
**Files:**
- packages/mcp-server/src/tools/recommend.ts
- packages/mcp-server/src/tools/compare.ts

**Task:**
1. Import SearchService and SkillRepository from @skillsmith/core
2. Create service factory or dependency injection pattern
3. Replace mockSkillDatabase with real database queries
4. Add database path configuration
5. Keep mock data as fallback for development/testing
6. Add SKILLSMITH_USE_MOCK=true env var for testing
7. Update tests to work with both modes
8. Document configuration in tool schemas

**Sub-steps if needed:**
- Step A: Refactor recommend.ts (commit)
- Step B: Refactor compare.ts (commit)
- Step C: Add tests (commit)

### SMI-756: Add integration tests for MCP tools [~50K tokens]
**Files:** Create packages/mcp-server/tests/integration/

**Task:**
1. Create test database fixtures
2. Add integration test for recommend tool with real DB
3. Add integration test for validate tool with real files
4. Add integration test for compare tool with real DB
5. Add CI job for integration tests
6. Document test setup in CONTRIBUTING.md

## Completion Criteria
- Both issues complete
- Integration tests pass
- Commit referencing both issues
- Mark Done: docker exec skillsmith-dev-1 npm run linear:done SMI-754 SMI-756"
```

---

## Batch 4: Session Monitoring (1 issue, ~70K tokens)

⚠️ **COMPLEX**: This issue touches claude-flow infrastructure, not just skillsmith.

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

claude -p "Execute Phase 2e Follow-up Batch 4: Session Monitoring

## Context
Batches 1-3 complete. Final issue is complex infrastructure work.

## Issue

### SMI-761: Implement swarm session health monitoring [~70K tokens]

**Note:** This may require changes to claude-flow itself, not just skillsmith.

**Research First:**
1. Check claude-flow source for session management
2. Identify where sessions are tracked
3. Determine if this should be a skillsmith feature or claude-flow PR

**If Skillsmith Feature:**
1. Create scripts/session-monitor.ts
2. Implement heartbeat mechanism
3. Add session state persistence
4. Create recovery CLI command
5. Document in swarm-recovery.md

**If Claude-Flow PR:**
1. Document requirements
2. Create issue in claude-flow repo
3. Mark SMI-761 as blocked/external

## Completion Criteria
- Either implementation complete OR external issue created
- Documentation updated
- Mark Done or update status in Linear"
```

---

## Alternative: Parallel Execution with Haiku

For faster execution, use haiku for small issues:

```bash
claude -p "..." --model haiku  # For Batch 1 (small issues)
claude -p "..." --model sonnet # For Batches 2-4 (complex issues)
```

---

## Recovery Commands

If a session dies mid-batch:

```bash
# Check what's committed
git log --oneline -5

# Check memory for progress
npx claude-flow memory list --namespace swarm

# Resume from last known state
npx claude-flow memory get swarm/batch1/status
```

---

## Pre-flight Checklist

Before starting any batch:

```bash
# 1. Ensure Docker is running
docker ps | grep skillsmith

# 2. Start container if needed
docker compose --profile dev up -d

# 3. Verify build works
docker exec skillsmith-dev-1 npm run typecheck

# 4. Check Linear access
docker exec skillsmith-dev-1 npm run linear:check 2>/dev/null || echo "Linear access OK"

# 5. Create fresh branch
git checkout -b feature/phase-2e-followup
```
