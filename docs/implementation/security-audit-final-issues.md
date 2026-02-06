# Security Audit Final Issues Implementation Plan

**Project**: Public Repository Security Audit
**Date**: 2026-02-05
**Status**: Ready for Implementation

## Overview

This document outlines the implementation plan for the two remaining actionable issues from the security audit:

1. **SMI-2277**: Persist multi-approval state to database
2. **SMI-2137**: Add CodeQL workflow (partial - CodeQL component)

The remaining issues (SMI-2138, SMI-2125, SMI-2126) are blocked pending repository going public or require coordination.

---

## SMI-2277: Persist Multi-Approval State to Database

### Problem Statement

The `QuarantineService.pendingApprovals` Map stores multi-approval workflow state in memory. If the service restarts, all pending multi-approval workflows are silently lost, potentially allowing a malicious actor to exploit the reset.

**Current Implementation:**
```typescript
// packages/core/src/services/quarantine/QuarantineService.ts:77
private pendingApprovals: Map<string, MultiApprovalStatus> = new Map()
```

**Attack Vector:** An attacker who has obtained one approval for a MALICIOUS skill could:
1. Trigger a service restart (through OOM, deployment, or other means)
2. The in-memory Map resets, losing the first approval
3. Start a fresh multi-approval workflow
4. Potentially manipulate the second reviewer to approve again

### Original Schema Issues

The originally proposed schema had several issues:

| Issue | Severity | Description |
|-------|----------|-------------|
| Table name mismatch | High | References `quarantine_entries` but actual table is `quarantine` |
| Missing workflow state | High | No `started_at`, `required_approvals`, `is_complete` columns |
| SQLite vs PostgreSQL | Medium | Need both SQLite (core) and Supabase (production) migrations |
| Missing RLS policies | Medium | Supabase migration needs Row Level Security |

### Revised Schema

#### SQLite (packages/core/src/db/quarantine-schema.ts)

```sql
-- Individual approval records
CREATE TABLE IF NOT EXISTS quarantine_approvals (
  id TEXT PRIMARY KEY,
  quarantine_id TEXT NOT NULL REFERENCES quarantine(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL,
  reviewer_email TEXT NOT NULL,
  approved_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(quarantine_id, reviewer_id)
);

CREATE INDEX IF NOT EXISTS idx_approvals_quarantine ON quarantine_approvals(quarantine_id);
CREATE INDEX IF NOT EXISTS idx_approvals_reviewer ON quarantine_approvals(reviewer_id);

-- Workflow tracking (separate table for clean separation)
CREATE TABLE IF NOT EXISTS quarantine_approval_workflows (
  quarantine_id TEXT PRIMARY KEY REFERENCES quarantine(id) ON DELETE CASCADE,
  required_approvals INTEGER NOT NULL DEFAULT 2,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  is_complete INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflows_incomplete
  ON quarantine_approval_workflows(is_complete) WHERE is_complete = 0;
```

#### Supabase Migration (supabase/migrations/040_quarantine_approvals.sql)

```sql
-- Migration: 040_quarantine_approvals.sql
-- Description: Persist multi-approval workflow state for MALICIOUS severity quarantine entries
-- Issue: SMI-2277

-- Individual approval records
CREATE TABLE IF NOT EXISTS quarantine_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quarantine_id UUID NOT NULL REFERENCES quarantine_entries(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES auth.users(id),
  reviewer_email TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(quarantine_id, reviewer_id)
);

CREATE INDEX idx_approvals_quarantine ON quarantine_approvals(quarantine_id);
CREATE INDEX idx_approvals_reviewer ON quarantine_approvals(reviewer_id);

-- Workflow tracking
CREATE TABLE IF NOT EXISTS quarantine_approval_workflows (
  quarantine_id UUID PRIMARY KEY REFERENCES quarantine_entries(id) ON DELETE CASCADE,
  required_approvals INTEGER NOT NULL DEFAULT 2,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  is_complete BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workflows_incomplete
  ON quarantine_approval_workflows(is_complete) WHERE is_complete = FALSE;

-- RLS Policies
ALTER TABLE quarantine_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE quarantine_approval_workflows ENABLE ROW LEVEL SECURITY;

-- Only authenticated users with admin role can view/modify approvals
CREATE POLICY "Admins can view approvals" ON quarantine_approvals
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Admins can insert approvals" ON quarantine_approvals
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Admins can view workflows" ON quarantine_approval_workflows
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Admins can manage workflows" ON quarantine_approval_workflows
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role = 'admin')
  );

-- Trigger for updated_at
CREATE TRIGGER update_approval_workflows_updated_at
  BEFORE UPDATE ON quarantine_approval_workflows
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

### Code Changes Required

#### Files to Modify

| File | Changes |
|------|---------|
| `packages/core/src/db/quarantine-schema.ts` | Add new table schemas |
| `packages/core/src/services/quarantine/QuarantineService.ts` | Replace Map with repository calls |
| `packages/core/src/services/quarantine/types.ts` | Add repository types if needed |
| `packages/core/src/repositories/quarantine/` | Create ApprovalRepository |
| `packages/core/tests/integration/QuarantineService.test.ts` | Add persistence tests |

#### Map Operations to Replace

| Line | Method | Operation | Replacement |
|------|--------|-----------|-------------|
| 266 | `handleMaliciousApproval` | `.get(quarantineId)` | `approvalRepo.getWorkflow(quarantineId)` |
| 277 | `handleMaliciousApproval` | `.set(quarantineId, ...)` | `approvalRepo.createWorkflow(...)` |
| 295 | `handleMaliciousApproval` | `.delete(quarantineId)` | `approvalRepo.deleteWorkflow(quarantineId)` |
| 344 | `handleMaliciousApproval` | `.delete(quarantineId)` | `approvalRepo.completeWorkflow(quarantineId)` |
| 414 | `getMultiApprovalStatus` | `.get(quarantineId)` | `approvalRepo.getWorkflow(quarantineId)` |
| 427-432 | `cancelMultiApproval` | `.get()` and `.delete()` | `approvalRepo.cancelWorkflow(quarantineId)` |
| 477 | `delete` | `.delete(id)` | Handled by CASCADE |

### Implementation Steps

1. **Create Schema Migration**
   - Add tables to `quarantine-schema.ts`
   - Create Supabase migration `040_quarantine_approvals.sql`
   - Run migrations in Docker

2. **Create ApprovalRepository**
   - Follow patterns from `QuarantineRepository`
   - Implement: `createWorkflow`, `getWorkflow`, `addApproval`, `completeWorkflow`, `deleteWorkflow`, `cancelWorkflow`
   - Use prepared statements for performance
   - Add transaction support

3. **Refactor QuarantineService**
   - Inject `ApprovalRepository` in constructor
   - Replace all Map operations with repository calls
   - Wrap `handleMaliciousApproval` in transaction
   - Update timeout logic to use database timestamps

4. **Add Timeout Cleanup**
   - Option A: Check at query time (simpler)
   - Option B: Scheduled cleanup job (more robust)
   - Recommend: Both - query-time check + periodic cleanup

5. **Update Tests**
   - Add persistence tests (restart recovery)
   - Add concurrent approval tests
   - Verify UNIQUE constraint prevents duplicates
   - Test CASCADE deletion

### Acceptance Criteria

- [ ] Multi-approval state persisted to SQLite database
- [ ] Service restart does not lose pending approvals
- [ ] Timeout logic uses database timestamps
- [ ] Existing multi-approval tests still pass
- [ ] New tests verify persistence across service recreation
- [ ] Migration script created for both SQLite and Supabase
- [ ] Audit logging preserved for approvals

---

## SMI-2137: CodeQL Workflow (Partial)

### Problem Statement

While SECURITY.md and branch protection are configured, there is no CodeQL workflow for static analysis of the Skillsmith source code. The existing `security-scan.yml` scans skills, not the codebase.

### Current State

| Component | Status |
|-----------|--------|
| SECURITY.md | ✅ Complete |
| Branch Protection | ✅ Configured |
| Gitleaks (secret scanning) | ✅ In CI |
| npm audit | ✅ In CI |
| Security test suite | ✅ Present |
| CodeQL source analysis | ❌ Missing |

### Recommended Workflow

Create `.github/workflows/codeql.yml`:

```yaml
# .github/workflows/codeql.yml
# SMI-2137: CodeQL semantic code analysis for security vulnerabilities
name: CodeQL

# SMI-2266 compliance: Explicit minimal permissions
permissions:
  security-events: write  # Required for uploading SARIF results
  contents: read          # Required for checkout

on:
  push:
    branches: [main]
    paths-ignore:
      - 'docs/**'
      - '**/*.md'
      - 'LICENSE'
      - '.github/ISSUE_TEMPLATE/**'
      - '.github/CODEOWNERS'
  pull_request:
    branches: [main]
    paths-ignore:
      - 'docs/**'
      - '**/*.md'
      - 'LICENSE'
      - '.github/ISSUE_TEMPLATE/**'
      - '.github/CODEOWNERS'
  schedule:
    # Run weekly on Sunday at 3 AM UTC (after weekly security scan at 2 AM)
    - cron: '0 3 * * 0'
  workflow_dispatch:  # Allow manual triggering

concurrency:
  group: codeql-${{ github.ref }}
  cancel-in-progress: true

jobs:
  analyze:
    name: CodeQL Analysis
    runs-on: ubuntu-latest
    timeout-minutes: 45

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
          # Use security-extended for comprehensive coverage
          queries: security-extended

      # No build step needed - CodeQL auto-detects TS/JS

      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@v3
        with:
          category: "/language:javascript-typescript"

      - name: Generate summary
        if: always()
        run: |
          echo "## CodeQL Analysis Complete" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "Results are available in the Security tab." >> $GITHUB_STEP_SUMMARY
```

### Implementation Steps

1. **Create Workflow File**
   - Add `.github/workflows/codeql.yml`
   - Push to feature branch and test

2. **Stabilization Period (1-2 weeks)**
   - Monitor for false positives
   - Review initial findings
   - Tune if necessary

3. **Add to Branch Protection**
   - Update `.github/branch-protection.json`
   - Add `CodeQL Analysis` to required checks
   - Apply via GitHub API

4. **Documentation Updates**
   - Update CLAUDE.md CI section
   - Update SECURITY.md security measures table

### Post-Implementation

After workflow is stable:

```json
// Add to .github/branch-protection.json required_status_checks.contexts
"CodeQL Analysis"
```

Apply with:
```bash
gh api repos/Smith-Horn/skillsmith/branches/main/protection -X PUT --input .github/branch-protection.json
```

### Expected Findings

CodeQL may flag:
- SQL injection patterns (mitigated by parameterized queries)
- Path traversal (already tested)
- Log injection
- Prototype pollution risks
- Insecure randomness

Review findings carefully - existing security measures may already address many.

---

## Blocked Issues

The following issues cannot be implemented until the repository goes public:

| Issue | Blocker | Notes |
|-------|---------|-------|
| SMI-2138 | Coordination | Git history rewrite requires backup, no open PRs, collaborator notification |
| SMI-2125 | Depends on SMI-2138 | Audit is complete, execution pending |
| SMI-2126 | Public repo only | GitHub secret scanning/push protection free only for public repos |

---

## Timeline

| Phase | Duration | Issues |
|-------|----------|--------|
| Phase 1 | 2-3 days | SMI-2277 (database persistence) |
| Phase 2 | 1 day | SMI-2137 (CodeQL workflow) |
| Phase 3 | 1-2 weeks | CodeQL stabilization |
| Phase 4 | TBD | Add CodeQL to branch protection |
| Phase 5 | Post-public | SMI-2126, SMI-2138, SMI-2125 |

---

## References

- [QuarantineService.ts](../../packages/core/src/services/quarantine/QuarantineService.ts)
- [quarantine-schema.ts](../../packages/core/src/db/quarantine-schema.ts)
- [Security Audit Wave Plan](./sparc-security-audit-wave-plan.md)
- [Public Repository Security Wave Plan](./public-repository-security-wave-plan.md)
