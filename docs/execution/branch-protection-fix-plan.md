# Branch Protection Fix Plan

## Context

Branch protection was configured with incorrect job context names (job IDs instead of job names). The CI optimization work (paths-ignore, classify job) must be preserved.

## Current State

- Branch protection set with 11 required checks using job IDs
- CI uses `paths-ignore` for docs-only changes → docs-only PRs won't satisfy required checks
- `docs-only.yml` provides only `Secret Scan` and `Markdown Lint`

## Constraints

1. **Preserve CI optimizations** - Keep `paths-ignore`, classify job, Turborepo caching
2. **Docs-only PRs** - Accept that admin bypass is needed (solo dev workflow)
3. **Dynamic matrix** - Cannot require specific test matrix combinations

## Plan

### Wave 1: Fix Job Names in Branch Protection

**Task 1.1: Update branch protection with correct job names**

Update GitHub API call to use actual job names from `ci.yml`:

| Job ID | Correct Job Name |
|--------|------------------|
| `secret-scan` | `Secret Scan` |
| `classify` | `Classify Changes` |
| `package-validation` | `Package Validation` |
| `edge-function-validation` | `Edge Function Validation` |
| `docker-build` | `Build Docker Image` |
| `lint` | `Lint` |
| `typecheck` | `Type Check` |
| `security` | `Security Audit` |
| `compliance` | `Standards Compliance` |
| `build` | `Build` |

**Excluded from required checks:**
- `Test (${{ matrix.package }})` - Dynamic matrix, cannot require specific combinations
- `Test (root)` - May not run on all PRs
- `Website Build` - Conditional (website changes only)
- `Performance Benchmarks` - Informational only
- `Code Review` - Non-blocking (continue-on-error)
- `Fresh Install Test` - Main branch only

### Wave 2: Verify Configuration

**Task 2.1: Verify branch protection API response**

Confirm all 10 checks are correctly configured with proper names.

**Task 2.2: Document docs-only PR limitation**

Add note to CLAUDE.md explaining:
- Docs-only PRs require admin bypass
- This is expected behavior to preserve CI optimization
- Alternative: Use `[skip ci]` in commit message (but loses secret scanning)

### Wave 3: Test the Configuration

**Task 3.1: Create test branch with code change**

Verify required checks appear and block merge until green.

**Task 3.2: Document admin bypass for docs-only**

Ensure `enforce_admins: false` allows bypass when needed.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Docs-only PRs blocked | High | Low | Admin bypass, documented workflow |
| Wrong job names again | Low | Medium | Verify via API response |
| Test matrix changes break protection | Low | Low | Tests excluded from required checks |

## Success Criteria

1. Branch protection uses correct job names
2. Code PRs blocked until 10 required checks pass
3. Docs-only PRs can be merged via admin bypass
4. CI optimization settings preserved (paths-ignore, classify, Turbo)

## Rollback Plan

Remove branch protection entirely if blocking legitimate work:

```bash
gh api repos/Smith-Horn/skillsmith/branches/main/protection -X DELETE
```

## Files Changed

| File | Change |
|------|--------|
| (GitHub API) | Update branch protection settings |
| `CLAUDE.md` | Add docs-only PR guidance (optional) |

## Execution Commands

```bash
# Update branch protection with correct names
cat > /tmp/branch-protection.json << 'EOF'
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
      "Build"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF

gh api repos/Smith-Horn/skillsmith/branches/main/protection -X PUT \
  -H "Accept: application/vnd.github+json" \
  --input /tmp/branch-protection.json
```
