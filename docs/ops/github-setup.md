# GitHub Repository Setup Guide

This document provides instructions for configuring GitHub repository settings including secrets and branch protection rules.

## Required Secrets

Navigate to: **Settings → Secrets and variables → Actions → New repository secret**

### Indexer Workflow Secrets (SMI-1252)

| Secret Name | Description | How to Obtain |
|------------|-------------|---------------|
| `SUPABASE_URL` | Supabase project URL | Supabase Dashboard → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | Supabase Dashboard → Settings → API → service_role key |

### Publish Workflow Secrets

| Secret Name | Description | How to Obtain |
|------------|-------------|---------------|
| `SKILLSMITH_NPM_TOKEN` | npm publish token | npm.com → Access Tokens → Generate New Token (Automation) |
| `GITHUB_TOKEN` | Automatic | Provided by GitHub Actions automatically |

### Optional Secrets

| Secret Name | Description | Usage |
|------------|-------------|-------|
| `CODECOV_TOKEN` | Codecov upload token | CI coverage reporting |
| `LINEAR_API_KEY` | Linear API key | E2E test issue creation |

## Branch Protection Rules (SMI-1254)

Navigate to: **Settings → Branches → Add branch protection rule**

### Main Branch Protection

**Branch name pattern**: `main`

#### Required Settings

```
☑ Require a pull request before merging
  ☑ Require approvals: 1
  ☑ Dismiss stale pull request approvals when new commits are pushed
  ☐ Require review from Code Owners (optional)

☑ Require status checks to pass before merging
  ☑ Require branches to be up to date before merging

  Required status checks:
    ✓ Lint
    ✓ Type Check
    ✓ Test
    ✓ Security Audit
    ✓ Standards Compliance
    ✓ Build

☑ Require conversation resolution before merging

☐ Require signed commits (optional - team decision)

☑ Do not allow bypassing the above settings
  (Ensures even admins follow the rules)

☑ Restrict who can push to matching branches
  ☐ Allow force pushes (NEVER enable)
  ☐ Allow deletions (NEVER enable)
```

#### Status Check Names

These must match the job names in `.github/workflows/ci.yml`:

| CI Job | Status Check Name |
|--------|-------------------|
| `lint` | Lint |
| `typecheck` | Type Check |
| `test` | Test |
| `security` | Security Audit |
| `compliance` | Standards Compliance |
| `build` | Build |

### Implementation Steps

1. Go to repository Settings
2. Click "Branches" in the left sidebar
3. Click "Add branch protection rule"
4. Enter `main` as the branch name pattern
5. Enable the settings listed above
6. Click "Create" to save

### Verification

After enabling branch protection:

1. Create a test branch: `git checkout -b test-protection`
2. Make a small change and push
3. Open a PR to main
4. Verify:
   - CI runs automatically
   - Cannot merge until CI passes
   - Cannot merge without approval (if enabled)
   - Cannot push directly to main

### Troubleshooting

#### Status checks not appearing

- Ensure CI workflow has run at least once on main
- Status check names are case-sensitive
- May take a few minutes after first run to appear

#### Cannot find status check

- Run the CI workflow manually first: Actions → CI → Run workflow
- Refresh the branch protection page after CI completes

## Testing the Indexer Workflow

After configuring secrets:

```bash
# Trigger manual run with dry_run=true
gh workflow run indexer.yml -f dry_run=true -f max_pages=1

# Check workflow status
gh run list --workflow=indexer.yml --limit=5

# View run logs
gh run view <run-id> --log
```

## Workflow Permissions (SMI-1277)

GitHub Actions workflows need explicit permissions to interact with PRs and issues.

### Adding Workflow Permissions

When a workflow needs to post comments, create issues, or modify PRs:

```yaml
# At the top of your workflow file, after 'on:' block
permissions:
  contents: read
  pull-requests: write  # For PR comments
  issues: write         # For issue comments
```

### Common Permission Errors

**Error**: `Resource not accessible by integration`

**Cause**: Workflow lacks required permissions

**Solution**: Add explicit permissions block:

```yaml
name: E2E Tests

on:
  pull_request:
    branches: [main]

# SMI-1277: Required for PR comments
permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  test:
    # ...
```

### Fallback Pattern

For non-critical steps (like posting status comments), use `continue-on-error`:

```yaml
- name: Post summary to PR
  if: github.event_name == 'pull_request'
  continue-on-error: true  # Don't fail workflow if comment fails
  uses: actions/github-script@v7
  with:
    script: |
      github.rest.issues.createComment({...})
```

### Permission Reference

| Action | Required Permission |
|--------|---------------------|
| Read code | `contents: read` |
| Push commits | `contents: write` |
| Comment on PRs | `pull-requests: write` |
| Comment on issues | `issues: write` |
| Modify checks | `checks: write` |
| Create releases | `contents: write` |

## Security Notes

- Never commit secrets to the repository
- Use repository secrets, not environment secrets for CI
- Rotate tokens periodically
- Use least-privilege tokens where possible
- Service role key should only be used in trusted automation

## References

- [GitHub Branch Protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)
- [GitHub Encrypted Secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
- [Supabase API Settings](https://supabase.com/docs/guides/api)
