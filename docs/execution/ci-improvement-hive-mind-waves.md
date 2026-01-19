# CI Improvement: Hive Mind Wave Execution Plan

**Date**: January 19, 2026
**Project**: Skillsmith CI Infrastructure
**Goal**: Coverage 67% → 80%, Fix Lint Issues, Enable Shift-Left
**Status**: 🔄 Ready for Execution

---

## Executive Summary

| Metric | Current | Wave 1 | Wave 2 | Wave 3 | Final |
|--------|---------|--------|--------|--------|-------|
| Branch Coverage | 67% | 72% | 76% | 80% | 80% |
| Lint Errors | 6 | 0 | 0 | 0 | 0 |
| Lint Warnings | 87 | ~30 | 0 | 0 | 0 |
| CI Test Job | ~15 min | ~12 min | ~10 min | ~8 min | ~8 min |
| Shift-Left | None | Pre-push | Pre-push | Pre-push | Pre-push |

**Key Decisions**:
- ✅ Incremental coverage increase (not big-bang)
- ✅ Pre-push hook for local failure detection (not pre-commit)
- ✅ Code review required after each wave before proceeding

---

## Hive Mind Execution Rules

### Wave Completion Criteria

1. All tasks in wave completed
2. All tests pass (`npm run test`)
3. Coverage threshold met (`npm run test:coverage`)
4. Lint check passes (`npm run lint`)
5. **CODE REVIEW PASSED** - issues filed and addressed

### Code Review Gate

After each wave:

```bash
# Run governance skill for automated review
docker exec skillsmith-dev-1 npm run audit:standards

# Manual review checklist:
# [ ] All new tests have meaningful assertions
# [ ] No coverage padding (toBeDefined-only tests)
# [ ] Lint fixes don't break functionality
# [ ] No new TODO/FIXME without Linear issue
```

**If issues found**: Create issues, fix ALL issues, re-review before next wave.

---

## Wave 1: Unblock CI + 72% Coverage

**Branch**: `feature/ci-wave1-lint-coverage`
**Priority**: P0 (CI Blocking)
**Estimated Time**: 2 hours

### Issues to Create

| Issue ID | Title | Type |
|----------|-------|------|
| SMI-XXXX | Fix 6 critical lint errors blocking CI | Bug |
| SMI-XXXX | Fix lint warnings batch 1 (unused imports) | Chore |
| SMI-XXXX | Raise coverage threshold to 72% | Chore |
| SMI-XXXX | Create pre-push coverage hook | Feature |

### Tasks

| Task | File | Action | Est. |
|------|------|--------|------|
| 1.1 | `packages/core/src/db/migration.ts` | Wrap 4 case blocks in braces (lines 106, 294, 295, 323) | 10 min |
| 1.2 | `supabase/functions/_shared/rate-limit-monitor.ts` | Remove/prefix unused `intervals` (line 267) | 5 min |
| 1.3 | `supabase/functions/health/index.ts` | Prefix unused `data` with `_` (line 118) | 5 min |
| 1.4 | Multiple files | Fix ~30 unused import warnings | 30 min |
| 1.5 | `vitest.config.ts` | Change `branches: 67` → `branches: 72` | 5 min |
| 1.6 | `.husky/pre-push` | Create new pre-push hook (see template below) | 15 min |
| 1.7 | Run full test suite | Verify 72% coverage met | 5 min |

### Pre-Push Hook Template

```bash
#!/bin/sh
# SMI-XXXX: Pre-push coverage validation

echo "🔍 Running pre-push coverage check..."

# Check if Docker is available
if ! docker exec skillsmith-dev-1 echo "ok" > /dev/null 2>&1; then
  echo "⚠️  Docker not running - skipping coverage check"
  echo "   Run: docker compose --profile dev up -d"
  exit 0
fi

# Run coverage check
if docker exec skillsmith-dev-1 npm run test:coverage; then
  echo "✅ Coverage check passed"
else
  echo ""
  echo "❌ Coverage threshold not met!"
  echo "   Run: docker exec skillsmith-dev-1 npm run test:coverage"
  echo ""
  echo "   Bypass: git push --no-verify"
  exit 1
fi
```

### Acceptance Criteria

- [ ] CI lint job passes (0 errors)
- [ ] Lint warnings reduced by ~30
- [ ] Branch coverage ≥ 72%
- [ ] Pre-push hook works locally
- [ ] All tests pass (4,670+ tests)

### Code Review Checklist (Wave 1)

- [ ] Case block braces don't change logic
- [ ] Removed variables were truly unused
- [ ] No new warnings introduced
- [ ] Pre-push hook gracefully handles no Docker

---

## Wave 2: 76% Coverage + CI Speed

**Branch**: `feature/ci-wave2-coverage-speed`
**Priority**: P1
**Estimated Time**: 4 hours
**Prerequisite**: Wave 1 complete + code review passed

### Issues to Create

| Issue ID | Title | Type |
|----------|-------|------|
| SMI-XXXX | Fix remaining lint warnings (~57) | Chore |
| SMI-XXXX | Add context.ts comprehensive tests | Test |
| SMI-XXXX | Enhance license middleware tests | Test |
| SMI-XXXX | Add vitest parallelization (2 workers) | Performance |
| SMI-XXXX | Raise coverage threshold to 76% | Chore |

### Tasks

| Task | File | Action | Est. |
|------|------|--------|------|
| 2.1 | Multiple files | Fix remaining ~57 lint warnings | 1 hour |
| 2.2 | `packages/mcp-server/src/__tests__/context.test.ts` | NEW: Test createToolContext branches | 2 hours |
| 2.3 | `packages/mcp-server/src/__tests__/middleware/license.test.ts` | Enhance tier validation coverage | 1 hour |
| 2.4 | `vitest.config.ts` | Add `pool: 'threads', poolOptions: { threads: { maxThreads: 2 }}` | 10 min |
| 2.5 | `vitest.config.ts` | Change `branches: 72` → `branches: 76` | 5 min |

### context.test.ts Coverage Targets

Test these branches in `createToolContext()`:
- `dbPath` provided vs. default
- `dbPath === ':memory:'` (skip directory creation)
- Telemetry enabled vs. disabled
- Background sync enabled vs. disabled
- LLM failover enabled vs. disabled

### Acceptance Criteria

- [ ] CI lint job passes (0 warnings)
- [ ] Branch coverage ≥ 76%
- [ ] `context.ts` coverage > 70%
- [ ] `middleware/license.ts` coverage > 60%
- [ ] CI test job < 12 minutes

### Code Review Checklist (Wave 2)

- [ ] context.test.ts tests behavior not implementation
- [ ] Mocks are minimal and focused
- [ ] Parallelization doesn't introduce flakiness
- [ ] All tests have meaningful assertions

---

## Wave 3: 80% Coverage + Quality

**Branch**: `feature/ci-wave3-80-percent`
**Priority**: P2
**Estimated Time**: 5 hours
**Prerequisite**: Wave 2 complete + code review passed

### Issues to Create

| Issue ID | Title | Type |
|----------|-------|------|
| SMI-XXXX | Add SyncService comprehensive tests (0% → 80%) | Test |
| SMI-XXXX | Add get-skill tool tests | Test |
| SMI-XXXX | Run flaky-test-detector before parallelization increase | Quality |
| SMI-XXXX | Raise coverage threshold to 80% | Chore |
| SMI-XXXX | Add ci:local scripts to package.json | DX |

### Tasks

| Task | File | Action | Est. |
|------|------|--------|------|
| 3.1 | `packages/core/tests/sync/SyncService.test.ts` | NEW: Comprehensive sync tests (0% → 80%) | 3 hours |
| 3.2 | `packages/mcp-server/src/__tests__/tools/get-skill.test.ts` | Enhance coverage | 1 hour |
| 3.3 | Run flaky-test-detector | Trigger: "find flaky tests" | 30 min |
| 3.4 | `vitest.config.ts` | Change `branches: 76` → `branches: 80` | 5 min |
| 3.5 | `package.json` | Add `"ci:local": "npm run lint && npm run typecheck && npm run test:coverage"` | 10 min |

### SyncService.test.ts Coverage Targets

Current: 0% branch coverage (lines 48-281)

Test these scenarios:
- Sync with empty registry
- Sync with existing skills (merge strategies)
- Sync conflict resolution
- Network failure handling
- Rate limiting behavior
- Incremental vs. full sync

### Acceptance Criteria

- [ ] Branch coverage ≥ 80%
- [ ] `SyncService.ts` coverage ≥ 80%
- [ ] No flaky tests detected
- [ ] CI test job < 10 minutes
- [ ] `npm run ci:local` works

### Code Review Checklist (Wave 3)

- [ ] SyncService tests cover error paths
- [ ] No test pollution (each test isolated)
- [ ] Flaky test issues addressed
- [ ] Test quality validated (not just quantity)

---

## Worktree Setup for Each Wave

```bash
# Wave 1
git worktree add ../worktrees/ci-wave1 -b feature/ci-wave1-lint-coverage
cd ../worktrees/ci-wave1

# Wave 2 (after Wave 1 merged)
git worktree add ../worktrees/ci-wave2 -b feature/ci-wave2-coverage-speed
cd ../worktrees/ci-wave2

# Wave 3 (after Wave 2 merged)
git worktree add ../worktrees/ci-wave3 -b feature/ci-wave3-80-percent
cd ../worktrees/ci-wave3
```

---

## Verification Commands

```bash
# After each wave, run these checks:

# 1. Lint check
docker exec skillsmith-dev-1 npm run lint

# 2. Type check
docker exec skillsmith-dev-1 npm run typecheck

# 3. Coverage check
docker exec skillsmith-dev-1 npm run test:coverage

# 4. Standards audit
docker exec skillsmith-dev-1 npm run audit:standards

# 5. Pre-push hook test (Wave 1+)
git push --dry-run  # Should trigger hook
```

---

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| Coverage jump blocks PRs | Incremental thresholds (72 → 76 → 80) |
| Lint fixes break code | Batch fixes with full test run after each |
| Parallelization causes flakiness | Start with 2 workers, run flaky-test-detector |
| Tests are low quality | Code review required, meaningful assertions only |
| Pre-push too slow | Graceful skip if Docker not running |

---

## Related Documentation

- [CI Workflow Reference](../ci/ci-workflow-reference.md)
- [Flakiness Patterns](../ci/flakiness-patterns.md)
- [Engineering Standards](../architecture/standards.md)
- [CI Coverage Fix Plan](./ci-coverage-fix-plan.md)

---

## Skills to Use

| Skill | Wave | Purpose |
|-------|------|---------|
| `governance` | All | Automated standards audit |
| `ci-doctor` | All | Diagnose CI issues |
| `flaky-test-detector` | 3 | Find timing-sensitive tests |
| `github-workflow-automation` | All | PR management |

---

## Linear Project Link

[Live Services Project](https://linear.app/smith-horn/project/live-services-19fbb52a-73f4-49dc-8016-5f705529302e)

---

## Completion Tracking

| Wave | Start Date | PR | Merged | Code Review |
|------|------------|----|----|-------------|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
