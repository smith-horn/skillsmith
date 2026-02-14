# Branch Protection Fix Plan Review

**Plan**: `/Users/williamsmith/Documents/GitHub/Smith-Horn/skillsmith/docs/execution/branch-protection-fix-plan.md`
**Review Date**: 2026-02-01
**Reviewers**: VP Product, VP Engineering, VP Design

---

## Executive Summary

| Aspect | Status | Summary |
|--------|--------|---------|
| **Blockers** | 🔴 1 Critical | Missing validation for job name existence in ci.yml |
| **Anti-patterns** | 🟡 2 Medium | Manual API calls, incomplete documentation |
| **Conflicts** | 🟢 None | Plan aligns with CI optimization architecture |
| **Regressions** | 🟡 1 Medium | Docs-only PRs now require admin intervention |

**Recommendation**: Approve with modifications. Address critical blocker before execution.

---

## VP Product Perspective

### User Value Assessment

**Impact**: Internal tooling improvement with minimal user-facing impact.

| Criteria | Rating | Notes |
|----------|--------|-------|
| User value | Low | Internal CI reliability, not user-facing feature |
| Scope clarity | High | Well-defined scope, single API configuration change |
| Timeline feasibility | High | 3 waves, ~30min estimated execution |
| Dependencies | Low | No external dependencies, GitHub API only |

### Issues Identified

#### BLOCKER-001: Missing Job Name Validation (Critical)

**Category**: Missing Requirements
**Severity**: Critical

**Description**: Plan assumes job names in table (lines 26-39) match actual job names in `ci.yml`. No validation step to confirm this mapping before API call.

**Evidence**:
- Plan line 26-39: Lists 10 job names without verification source
- `ci.yml` line 38: `name: Secret Scan` (job ID: `secret-scan`)
- `ci.yml` line 67: `name: Classify Changes` (job ID: `classify`)
- No automated validation that these names are current and accurate

**Impact**: If job names are incorrect (e.g., someone renamed a job), the entire fix fails silently. Branch protection will require non-existent checks, blocking ALL PRs.

**Recommendation**:
```bash
# Add Wave 0: Pre-flight validation
# Extract actual job names from ci.yml and compare with plan
yq eval '.jobs.*.name' .github/workflows/ci.yml | sort | \
  diff - <(echo "Build
Build Docker Image
Classify Changes
Edge Function Validation
Lint
Package Validation
Secret Scan
Security Audit
Standards Compliance
Type Check" | sort)
```

**Trade-offs**:
- ✅ Prevents silent failures
- ✅ Validates assumptions before API call
- ❌ Adds 1-2 minutes to execution
- ❌ Requires `yq` tool installation

---

#### MEDIUM-001: Docs-Only PR UX Regression (Medium)

**Category**: User Experience
**Severity**: Medium

**Description**: Docs-only PRs will now block on branch protection requiring checks that never run. Solo developer must use admin bypass for every documentation change.

**Evidence**:
- Plan line 54-59: Acknowledges limitation, proposes documentation
- `ci.yml` line 10-23: `paths-ignore` prevents workflow from triggering
- `docs-only.yml` runs only `Secret Scan` and `Markdown Lint` (not in required checks list)
- No automation for admin bypass

**Impact**:
- Every docs PR requires manual admin bypass (adds 30-60s per merge)
- Risk of accidentally merging docs PRs without secret scanning if developer is impatient
- Inconsistent workflow: code PRs auto-enforce, docs PRs manual

**Current Behavior**:
```
Docs-only PR → paths-ignore → docs-only.yml runs → Secret Scan + Markdown Lint pass → ??? (no required checks satisfied)
```

**Recommendation**:
Option A (Conservative): Accept limitation, document workflow in CLAUDE.md
Option B (Ideal): Add `docs-only.yml` jobs to required checks
Option C (Alternative): Use branch protection rulesets with path-based conditions (GitHub Enterprise)

**Option B Implementation**:
```json
{
  "contexts": [
    "Secret Scan",           // Runs in BOTH ci.yml and docs-only.yml
    "Classify Changes",
    // ... other ci.yml jobs ...
    "Markdown Lint"          // Only in docs-only.yml
  ]
}
```

**Trade-offs**:

| Option | Pros | Cons |
|--------|------|------|
| A (Accept) | Simple, no changes | Poor UX, manual overhead |
| B (Ideal) | Consistent UX, auto-merge | Secret Scan runs twice (30s overhead) |
| C (Rulesets) | Perfect solution | Requires GitHub Enterprise plan |

**Recommended**: Option B. The 30s overhead for duplicate Secret Scan is acceptable vs manual admin bypass every time.

---

#### LOW-001: Missing Rollback Documentation (Low)

**Category**: Operational Risk
**Severity**: Low

**Description**: Rollback plan exists (line 86-92) but doesn't document how to recover if PRs are currently blocked.

**Evidence**:
- Plan line 90-92: Only shows DELETE command
- No guidance on communication if production PRs are blocked
- No mention of temporary bypass for urgent fixes

**Recommendation**:
Add to rollback section:
```markdown
## Emergency Bypass (if PRs blocked)

1. Identify affected PR number
2. Use admin bypass: Settings → Branches → Edit protection rule → Allow specific actors to bypass
3. Merge blocked PR
4. Remove bypass permission immediately
5. Execute rollback DELETE command
```

---

## VP Engineering Perspective

### Technical Debt Assessment

**Impact**: Reduces technical debt by fixing incorrect configuration, but introduces operational overhead.

| Criteria | Rating | Notes |
|----------|--------|-------|
| Technical correctness | High | Aligns with GitHub Actions job context naming |
| Architecture alignment | High | Preserves CI optimization (paths-ignore, Turborepo) |
| Maintainability | Medium | Manual API calls increase maintenance burden |
| Performance impact | None | No CI pipeline changes |

### Issues Identified

#### BLOCKER-002: Job Name Mutation Risk (Critical)

**Category**: Anti-pattern
**Severity**: Critical

**Description**: Required checks reference job **names** (mutable) instead of job **IDs** (stable). Future PR renaming a job will silently break branch protection.

**Evidence**:
- GitHub Actions context: `${{ github.job }}` returns job ID, `${{ needs.job-id.name }}` returns job name
- Plan line 109-120: Uses job names in `contexts` array
- `ci.yml` line 38: `name: Secret Scan` can be changed to `name: Secrets Scanning` without breaking workflow
- No CI validation that required check names exist

**Example Failure Scenario**:
```yaml
# Someone renames in ci.yml:
lint:
  name: ESLint  # Changed from "Lint"

# Branch protection still requires "Lint" → ALL PRs BLOCKED
```

**Impact**: Silent failure mode. Branch protection will require non-existent check, blocking all PRs until manually fixed.

**Recommendation**:
Add CI job to validate branch protection configuration:

```yaml
# .github/workflows/validate-branch-protection.yml
name: Validate Branch Protection

on:
  pull_request:
    paths:
      - '.github/workflows/ci.yml'
      - '.github/workflows/docs-only.yml'

jobs:
  validate:
    name: Check Required Job Names
    runs-on: ubuntu-latest
    steps:
      - name: Extract job names from workflows
        run: |
          ACTUAL=$(yq eval '.jobs.*.name' .github/workflows/ci.yml .github/workflows/docs-only.yml | sort | uniq)
          REQUIRED="Build
Build Docker Image
Classify Changes
Edge Function Validation
Lint
Package Validation
Secret Scan
Security Audit
Standards Compliance
Type Check"

          # Check all required checks exist in workflows
          for check in $REQUIRED; do
            if ! echo "$ACTUAL" | grep -q "^$check$"; then
              echo "::error::Required check '$check' not found in workflows"
              exit 1
            fi
          done
```

**Trade-offs**:
- ✅ Prevents silent breakage
- ✅ Validates on every workflow change
- ❌ Adds ~15s to PRs touching workflows
- ❌ Requires maintaining list in two places (branch protection + validation workflow)

**Alternative**: Store required checks in a config file, read by both API script and validation workflow.

---

#### MEDIUM-002: Missing Automation (Medium)

**Category**: Anti-pattern
**Severity**: Medium

**Description**: Branch protection configuration is applied via manual API call instead of Infrastructure-as-Code. No version control, no reproducibility.

**Evidence**:
- Plan line 103-133: Manual `gh api` command with JSON payload
- No `.github/branch-protection.json` config file
- No CI job to apply/validate configuration
- No audit trail of who changed what when

**Impact**:
- Configuration drift: Local state (GitHub API) vs code
- No code review for branch protection changes
- Cannot reproduce configuration in disaster recovery
- Difficult to audit compliance requirements

**Recommendation**:
Option A (Quick): Commit `/tmp/branch-protection.json` to `.github/branch-protection.json`
Option B (Ideal): Use GitHub Action to enforce configuration

```yaml
# .github/workflows/enforce-branch-protection.yml
name: Enforce Branch Protection

on:
  push:
    branches: [main]
    paths:
      - '.github/branch-protection.json'

jobs:
  enforce:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Apply branch protection
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh api repos/${{ github.repository }}/branches/main/protection -X PUT \
            --input .github/branch-protection.json
```

**Trade-offs**:

| Option | Pros | Cons |
|--------|------|------|
| A (Commit) | Version control, code review | Manual application still required |
| B (Automate) | Full IaC, auto-enforce on change | Requires GITHUB_TOKEN with admin perms |

**Recommended**: Option B with admin token stored in GitHub Secrets.

---

#### LOW-002: Incomplete Documentation (Low)

**Category**: Documentation Gap
**Severity**: Low

**Description**: Plan proposes documenting docs-only limitation in CLAUDE.md (line 54-59) but doesn't show exact documentation to add.

**Evidence**:
- Plan line 54: "Add note to CLAUDE.md"
- No draft documentation provided
- Current CLAUDE.md has no branch protection section (grepped, no results)

**Recommendation**:
Add to CLAUDE.md:

```markdown
## Branch Protection

The `main` branch is protected with required status checks to ensure code quality.

### Required Checks (Code PRs)

All code changes must pass these checks before merging:

| Check | Job | Purpose |
|-------|-----|---------|
| Secret Scan | `secret-scan` | Detect accidentally committed credentials |
| Classify Changes | `classify` | Categorize change type (docs/config/code/deps) |
| Package Validation | `package-validation` | Verify package.json scope for GitHub Packages |
| Edge Function Validation | `edge-function-validation` | Validate Supabase function structure |
| Build Docker Image | `docker-build` | Build development container |
| Lint | `lint` | ESLint and Prettier checks |
| Type Check | `typecheck` | TypeScript type checking |
| Security Audit | `security` | npm audit and security test suite |
| Standards Compliance | `compliance` | Governance standards audit |
| Build | `build` | Build all packages via Turborepo |

### Docs-Only PRs

**Important**: Due to CI optimization (`paths-ignore`), documentation-only PRs require admin bypass.

**Workflow**:
1. Create PR with only `docs/**` or `*.md` changes
2. Verify `docs-only.yml` workflow runs successfully
3. Merge using admin bypass (Settings → "Bypass branch protections")

**Why**: The `ci.yml` workflow uses `paths-ignore` to skip expensive builds for docs changes. This means required checks never run. The lightweight `docs-only.yml` runs instead, but its jobs (`Secret Scan`, `Markdown Lint`) are not part of the required checks list to avoid duplication.

**Alternative**: To avoid admin bypass, include a trivial code change (e.g., add newline to a TypeScript file). This triggers full CI and satisfies required checks.
```

---

## VP Design Perspective

### UX Consistency Assessment

**Impact**: Internal developer experience consistency with branch protection enforcement.

| Criteria | Rating | Notes |
|----------|--------|-------|
| Workflow consistency | Low | Code PRs auto-enforce, docs PRs manual |
| Error clarity | Medium | GitHub will show "Required checks not found" (confusing) |
| Recovery path | Low | Admin bypass not obvious to contributors |
| Documentation clarity | Low | Plan lacks explicit user-facing guidance |

### Issues Identified

#### MEDIUM-003: Inconsistent Developer Experience (Medium)

**Category**: UX Inconsistency
**Severity**: Medium

**Description**: Branch protection creates two different merge workflows based on file paths, with no in-UI guidance for docs-only PRs.

**User Journey Comparison**:

**Code PR Flow**:
```
Create PR → CI runs → Checks appear → Wait for green → Merge button enabled → Merge
```

**Docs-only PR Flow**:
```
Create PR → CI skipped → No checks appear → ??? →
GitHub shows "Required checks not found" →
Must remember admin bypass exists →
Navigate to Settings → Find bypass option → Merge
```

**Evidence**:
- GitHub's "Required checks not found" message is not actionable
- No PR comment explaining the docs-only bypass workflow
- Admin bypass option is buried in repository settings (not discoverable)

**Impact**:
- New contributors will be confused when docs PRs can't merge
- Risk of opening support requests: "My docs PR is stuck"
- Temptation to add code changes just to trigger CI (waste resources)

**Recommendation**:
Add GitHub Action to comment on docs-only PRs with bypass instructions:

```yaml
# .github/workflows/docs-pr-helper.yml
name: Docs PR Helper

on:
  pull_request:
    paths:
      - 'docs/**'
      - '**/*.md'

jobs:
  helper:
    runs-on: ubuntu-latest
    steps:
      - name: Check if docs-only
        id: check
        uses: dorny/paths-filter@v3
        with:
          filters: |
            code:
              - '!docs/**'
              - '!**/*.md'
              - '!LICENSE'

      - name: Add helper comment
        if: steps.check.outputs.code == 'false'
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `## 📝 Documentation-only PR

This PR only modifies documentation files. The lightweight \`docs-only.yml\` workflow will run instead of the full CI pipeline.

**To merge this PR**:
1. Wait for \`Secret Scan\` and \`Markdown Lint\` to pass
2. Use admin bypass: **Merge pull request** → **Merge without waiting for requirements to be met**

Why? The main CI workflow uses \`paths-ignore\` to skip expensive builds for docs changes. See [Branch Protection docs](CLAUDE.md#docs-only-prs) for details.`
            });
```

**Trade-offs**:
- ✅ Self-documenting workflow
- ✅ Reduces support burden
- ✅ Educates contributors about CI architecture
- ❌ Adds comment noise to every docs PR
- ❌ Requires GITHUB_TOKEN with write permissions

---

#### LOW-003: Missing Error State Handling (Low)

**Category**: UX Gap
**Severity**: Low

**Description**: Plan doesn't address what happens when required checks fail due to GitHub API outage or workflow bugs.

**Scenarios**:
1. GitHub Actions outage → Required checks never start → All PRs blocked
2. Workflow syntax error → Job fails to run → Check never reports → PRs blocked
3. Transient network error → Check timeout → False negative

**Evidence**:
- Plan assumes happy path (all checks run and report status)
- No mention of `enforce_admins: false` allowing bypass during emergencies
- Risk assessment (line 72-78) doesn't cover GitHub infrastructure failures

**Recommendation**:
Add to CLAUDE.md:

```markdown
### Emergency Bypass Procedure

If required checks are stuck or GitHub Actions is down:

1. **Verify urgency**: Is this blocking production deployment or critical security fix?
2. **Check status**: Visit [GitHub Status](https://www.githubstatus.com/)
3. **Use admin bypass**:
   - Navigate to PR
   - Click "Merge pull request"
   - Select "Merge without waiting for requirements to be met (bypass branch protections)"
4. **Document**: Add comment to PR explaining bypass reason
5. **Follow up**: Re-run checks manually after service restoration

**Note**: `enforce_admins: false` allows repository admins to bypass protection during emergencies.
```

---

## Consolidated Issues Summary

### Critical (Blockers)

| ID | Category | Issue | Owner | Recommendation |
|----|----------|-------|-------|----------------|
| BLOCKER-001 | Product | Missing job name validation | Engineering | Add Wave 0 pre-flight validation |
| BLOCKER-002 | Engineering | Job name mutation risk | Engineering | Add CI validation workflow |

### High (Must Address)

None identified.

### Medium (Should Address)

| ID | Category | Issue | Owner | Recommendation |
|----|----------|-------|-------|----------------|
| MEDIUM-001 | Product | Docs-only PR UX regression | Product | Add `Markdown Lint` to required checks |
| MEDIUM-002 | Engineering | Missing automation | Engineering | Commit config to `.github/branch-protection.json` |
| MEDIUM-003 | Design | Inconsistent developer experience | Design | Add PR comment bot for docs-only PRs |

### Low (Nice to Have)

| ID | Category | Issue | Owner | Recommendation |
|----|----------|-------|-------|----------------|
| LOW-001 | Product | Missing rollback documentation | Product | Add emergency bypass procedure |
| LOW-002 | Engineering | Incomplete documentation | Engineering | Add draft CLAUDE.md section |
| LOW-003 | Design | Missing error state handling | Design | Add emergency procedures to docs |

---

## Recommended Changes

### Wave 0: Pre-flight Validation (NEW)

**Add before Wave 1 execution:**

```bash
# Validate job names exist in ci.yml and docs-only.yml
echo "Validating required check names..."

REQUIRED_CHECKS=(
  "Secret Scan"
  "Classify Changes"
  "Package Validation"
  "Edge Function Validation"
  "Build Docker Image"
  "Lint"
  "Type Check"
  "Security Audit"
  "Standards Compliance"
  "Build"
)

# Extract actual job names from workflows
ACTUAL_JOBS=$(yq eval '.jobs.*.name' .github/workflows/ci.yml .github/workflows/docs-only.yml | sort | uniq)

# Validate each required check exists
for check in "${REQUIRED_CHECKS[@]}"; do
  if ! echo "$ACTUAL_JOBS" | grep -qF "$check"; then
    echo "ERROR: Required check '$check' not found in workflows"
    exit 1
  fi
done

echo "✓ All required check names validated"
```

### Wave 1: Modified Execution (UPDATED)

**Change plan line 109-120 to include Markdown Lint:**

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Secret Scan",
      "Classify Changes",
      "Package Validation",
      "Edge Function Validation",
      "Build Docker Image",
      "Lint",
      "Type Check",
      "Security Audit",
      "Standards Compliance",
      "Build",
      "Markdown Lint"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
```

**Rationale**: Adding `Markdown Lint` (from `docs-only.yml`) enables docs-only PRs to satisfy branch protection without admin bypass. `Secret Scan` runs in both workflows, so no duplication issue.

### Wave 2: Add Documentation (UPDATED)

**Add to CLAUDE.md after line 100 (before "## Support"):**

```markdown
## Branch Protection

The `main` branch is protected with required status checks to ensure code quality.

### Required Checks

All PRs must pass these checks before merging:

| Check | Workflow | Purpose |
|-------|----------|---------|
| Secret Scan | ci.yml, docs-only.yml | Detect accidentally committed credentials |
| Classify Changes | ci.yml | Categorize change type (docs/config/code/deps) |
| Package Validation | ci.yml | Verify package.json scope for GitHub Packages |
| Edge Function Validation | ci.yml | Validate Supabase function structure |
| Build Docker Image | ci.yml | Build development container |
| Lint | ci.yml | ESLint and Prettier checks |
| Type Check | ci.yml | TypeScript type checking |
| Security Audit | ci.yml | npm audit and security test suite |
| Standards Compliance | ci.yml | Governance standards audit |
| Build | ci.yml | Build all packages via Turborepo |
| Markdown Lint | docs-only.yml | Documentation quality checks |

### How It Works

**Code PRs**: All 11 checks must pass (full `ci.yml` pipeline runs)

**Docs-only PRs**: Only 2 checks run (`Secret Scan`, `Markdown Lint` from `docs-only.yml`)
- The full CI is skipped via `paths-ignore` optimization
- Branch protection is satisfied because both checks are in the required list

**Mixed PRs**: Full CI runs (code changes detected)

### Emergency Bypass

If required checks are stuck or GitHub Actions is down:

1. **Verify urgency**: Is this blocking production deployment or critical security fix?
2. **Check status**: Visit [GitHub Status](https://www.githubstatus.com/)
3. **Use admin bypass**:
   - Navigate to PR → "Merge pull request"
   - Select "Merge without waiting for requirements to be met"
4. **Document**: Add comment explaining bypass reason

**Note**: `enforce_admins: false` allows admins to bypass protection during emergencies.

### Troubleshooting

**Issue**: "Required checks not found" error on docs-only PR
- **Cause**: Someone renamed a job in `ci.yml` or `docs-only.yml` without updating branch protection
- **Fix**: Re-run the branch protection API call with updated job names

**Issue**: All PRs blocked after workflow changes
- **Cause**: Required check name no longer exists in workflows
- **Fix**: Use emergency bypass (above), then update branch protection configuration
```

### Wave 3: Infrastructure as Code (NEW)

**Add configuration file:**

```bash
# Commit branch protection config
cp /tmp/branch-protection.json .github/branch-protection.json
git add .github/branch-protection.json
git commit -m "docs: add branch protection configuration (SMI-XXXX)"
```

**Add validation workflow:**

```yaml
# .github/workflows/validate-branch-protection.yml
name: Validate Branch Protection

on:
  pull_request:
    paths:
      - '.github/workflows/ci.yml'
      - '.github/workflows/docs-only.yml'
      - '.github/branch-protection.json'

jobs:
  validate:
    name: Validate Required Check Names
    runs-on: ubuntu-latest
    timeout-minutes: 2

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Install yq
        run: |
          sudo wget -qO /usr/local/bin/yq https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64
          sudo chmod +x /usr/local/bin/yq

      - name: Extract required checks from config
        id: required
        run: |
          REQUIRED=$(jq -r '.required_status_checks.contexts[]' .github/branch-protection.json | sort)
          echo "$REQUIRED" > /tmp/required-checks.txt
          echo "Required checks:"
          cat /tmp/required-checks.txt

      - name: Extract actual job names from workflows
        id: actual
        run: |
          ACTUAL=$(yq eval '.jobs.*.name' .github/workflows/ci.yml .github/workflows/docs-only.yml | sort | uniq)
          echo "$ACTUAL" > /tmp/actual-jobs.txt
          echo "Actual job names:"
          cat /tmp/actual-jobs.txt

      - name: Validate all required checks exist
        run: |
          MISSING=0
          while IFS= read -r check; do
            if ! grep -qF "$check" /tmp/actual-jobs.txt; then
              echo "::error::Required check '$check' not found in workflows"
              MISSING=1
            fi
          done < /tmp/required-checks.txt

          if [ $MISSING -eq 1 ]; then
            echo ""
            echo "::error::One or more required checks are missing from workflows."
            echo "Update .github/branch-protection.json to match current job names."
            exit 1
          fi

          echo "✓ All required checks exist in workflows"
```

---

## Approval Decision Matrix

| Criterion | Status | Blocker? |
|-----------|--------|----------|
| Execution feasibility | ✅ Yes | No |
| Technical correctness | ⚠️ With changes | Yes (add validation) |
| Architecture alignment | ✅ Yes | No |
| Documentation completeness | ⚠️ Needs updates | No |
| User experience impact | ⚠️ Acceptable with docs | No |
| Rollback plan | ✅ Adequate | No |

---

## Final Recommendation

**Status**: **APPROVE WITH MODIFICATIONS**

### Required Changes (Blockers)

1. **Add Wave 0 pre-flight validation** (BLOCKER-001)
   - Validate job names before API call
   - Prevents silent failures from typos/outdated names

2. **Add validation workflow** (BLOCKER-002)
   - Prevent future breakage from job renames
   - Validate on every workflow change

### Recommended Changes (Quality)

3. **Update required checks to include "Markdown Lint"** (MEDIUM-001)
   - Enables docs-only PRs to merge without admin bypass
   - Minimal overhead (~15s per docs PR for duplicate Secret Scan)

4. **Commit configuration to `.github/branch-protection.json`** (MEDIUM-002)
   - Enable version control and code review
   - Foundation for future automation

5. **Add comprehensive documentation to CLAUDE.md** (LOW-002)
   - Include branch protection table
   - Document emergency bypass procedure
   - Add troubleshooting guide

### Optional Enhancements (Nice to Have)

6. **Add PR comment bot for docs-only PRs** (MEDIUM-003)
   - Improve contributor experience
   - Self-documenting workflow

---

## Trade-offs Accepted

| Trade-off | Accepted | Rationale |
|-----------|----------|-----------|
| Docs PRs require bypass | ❌ Rejected | Adding "Markdown Lint" to required checks solves this |
| Manual API calls | ⚠️ Temporary | Commit config for future automation |
| No job rename protection | ❌ Rejected | Validation workflow prevents this |
| Duplicate Secret Scan | ✅ Accepted | 30s overhead acceptable vs manual bypass |

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Code PRs blocked until green | 100% | GitHub API enforcement |
| Docs PRs merge without bypass | 100% | "Markdown Lint" check passes |
| False positives (PRs wrongly blocked) | 0% | Pre-flight validation prevents |
| Time to merge docs PR | < 2 min | No admin navigation required |
| Configuration drift incidents | 0 | Validation workflow catches renames |

---

## Next Steps

1. **Engineering**: Implement Wave 0 validation script
2. **Engineering**: Create validation workflow (`validate-branch-protection.yml`)
3. **Engineering**: Update required checks JSON to include "Markdown Lint"
4. **Product**: Review and approve updated CLAUDE.md documentation
5. **Design**: (Optional) Implement docs-only PR comment bot
6. **All**: Test on feature branch before applying to `main`

---

## Appendix: Alternative Approaches Considered

### Option 1: Use Branch Protection Rulesets (GitHub Enterprise)

**Pros**:
- Path-based conditions: Different rules for docs vs code paths
- No need for admin bypass
- Native GitHub feature

**Cons**:
- Requires GitHub Enterprise plan ($21/user/month)
- Not available on current plan
- Overkill for solo developer workflow

**Decision**: Rejected due to cost

### Option 2: Remove paths-ignore from CI

**Pros**:
- All PRs run full CI
- No special casing for docs
- Branch protection works uniformly

**Cons**:
- Loses CI optimization (11min build for every docs typo fix)
- Wastes GitHub Actions minutes
- Slower developer feedback loop

**Decision**: Rejected - CI optimization is core architecture

### Option 3: Make docs-only.yml jobs match ci.yml required checks

**Pros**:
- Uniform branch protection
- No admin bypass needed

**Cons**:
- Docs-only PRs would run lint/typecheck/build (defeats optimization purpose)
- Complexity: Two workflows with duplicated job logic
- Maintenance burden: Keep two workflows in sync

**Decision**: Rejected - duplicates too much logic

### Option 4: Recommended Approach (Modified Plan)

**Implementation**:
- Add "Markdown Lint" to required checks (runs in docs-only.yml)
- Add "Secret Scan" (already runs in both workflows)
- Docs PRs satisfy requirements without admin bypass
- Maintain CI optimization

**Pros**:
- ✅ No admin bypass required
- ✅ Preserves CI optimization
- ✅ Minimal duplication (Secret Scan runs twice, ~30s overhead)
- ✅ Consistent UX for all PR types

**Cons**:
- ⚠️ Secret Scan runs twice for docs PRs (acceptable overhead)

**Decision**: APPROVED - Best balance of UX and optimization
