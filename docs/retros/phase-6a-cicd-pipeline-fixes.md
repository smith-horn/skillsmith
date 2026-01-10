# Phase 6A Retrospective: CI/CD Pipeline Fixes

**Date**: January 10, 2026
**Duration**: ~2 hours
**Issues**: SMI-1278, SMI-1279, SMI-1296

---

## Summary

This effort resolved multiple CI/CD pipeline issues blocking the publish workflow, culminating in the successful publication of all four Skillsmith packages to their respective registries.

---

## Issues Resolved

| Issue | Title | Root Cause | Resolution |
|-------|-------|------------|------------|
| SMI-1278 | Publish workflow fails with 403 on duplicate version | npm returns 403 when attempting to publish an already-published version | Added version check before each publish step |
| SMI-1279 | Test files bloating npm package | Missing .npmignore files caused test files to be included | Created .npmignore for all packages |
| SMI-1296 | Enterprise package fails to publish to GitHub Packages | Package scope `@skillsmith` didn't match org name `Smith-Horn-Group` | Renamed package to `@smith-horn-group/enterprise` |

---

## Technical Details

### SMI-1278: Version Check Implementation

Added pre-publish version check to all four package jobs in `publish.yml`:

```yaml
- name: Check if version already published
  id: version-check
  run: |
    PACKAGE_VERSION=$(node -p "require('./packages/core/package.json').version")
    NPM_VERSION=$(npm view @skillsmith/core version 2>/dev/null || echo 'not-found')
    if [ "$PACKAGE_VERSION" = "$NPM_VERSION" ]; then
      echo "exists=true" >> $GITHUB_OUTPUT
      echo "::notice::@skillsmith/core@$PACKAGE_VERSION already published, skipping..."
    else
      echo "exists=false" >> $GITHUB_OUTPUT
    fi

- name: Publish core
  if: steps.version-check.outputs.exists != 'true'
  run: npm publish -w @skillsmith/core --access public
```

### SMI-1279: Package Size Reduction

Created `.npmignore` files for all packages excluding:
- `dist/tests/` - Compiled test files
- `dist/**/*.test.js` - Test JavaScript files
- `vitest.config.ts` - Test configuration
- `tests/` - Source test files
- Development files (tsconfig, eslint, etc.)

### SMI-1296: Enterprise Package Rename

**Files Modified**:
1. `packages/enterprise/package.json` - Changed name to `@smith-horn-group/enterprise`
2. `package-lock.json` - Updated workspace reference
3. `package.json` (root) - Updated build script
4. `.github/workflows/publish.yml` - Updated all enterprise references
5. `docs/publishing/npm-setup.md` - Updated documentation
6. `docs/enterprise/ENTERPRISE_PACKAGE.md` - Updated documentation

**Key Learning**: GitHub Packages requires the package scope to match the repository owner. For org `Smith-Horn-Group`, packages must be scoped as `@smith-horn-group/*`.

---

## Additional Fixes

### Artifact Storage Quota Handling

Added fallback handling when GitHub artifact storage quota is exceeded:

```yaml
- name: Upload Docker image artifact
  uses: actions/upload-artifact@v4
  continue-on-error: true  # Don't fail if storage quota exceeded

- name: Download Docker image
  uses: actions/download-artifact@v4
  id: download-docker
  continue-on-error: true

- name: Setup Node.js (fallback if no artifacts)
  if: steps.download-docker.outcome == 'failure'
  uses: actions/setup-node@v4

- name: Build all packages (fallback)
  if: steps.download-docker.outcome == 'failure'
  run: npm run build
```

### GitHub Packages Permissions

Added `packages: write` permission to the workflow:

```yaml
permissions:
  contents: read
  packages: write
```

### Billing Configuration

Configured org billing limits ($20 each for Actions and Packages) to enable GitHub Packages publishing.

---

## Commits

| Hash | Message |
|------|---------|
| `bdc926c` | fix(ci): add artifact fallback for storage quota issues |
| `c79829e` | fix(enterprise): rename to @smith-horn-group/enterprise |
| `eae5942` | chore: update package-lock.json for enterprise rename |
| `d19f08e` | fix: update build script for enterprise package rename |
| `f9f6803` | fix(ci): update publish workflow for enterprise package rename |
| `5afda6e` | docs: update enterprise package name in documentation |

---

## Final State

### Published Packages

| Package | Registry | Version | Status |
|---------|----------|---------|--------|
| `@skillsmith/core` | npm | 0.2.0 | Published |
| `@skillsmith/mcp-server` | npm | 0.2.0 | Published |
| `@skillsmith/cli` | npm | 0.2.0 | Published |
| `@smith-horn-group/enterprise` | GitHub Packages | 0.1.2 | Published |

### Workflow Status

- Build Docker Image: ✅ Passing
- Validate: ✅ Passing (with fallback support)
- Publish @skillsmith/core: ✅ Passing
- Publish @skillsmith/mcp-server: ✅ Passing
- Publish @skillsmith/cli: ✅ Passing
- Publish @smith-horn-group/enterprise: ✅ Passing

---

## What Went Well

1. **Systematic debugging** - Methodically identified and resolved each issue in sequence
2. **Graceful degradation** - Added fallback handling for artifact storage issues
3. **Version safety** - Publish workflow now safely handles re-runs without failing
4. **Documentation updates** - All relevant docs updated to reflect changes

---

## What Could Be Improved

1. **Earlier scope validation** - The `@skillsmith` scope mismatch with GitHub org could have been caught during initial setup
2. **Pre-flight checks** - Could add a CI job to validate package.json configurations before attempting publish
3. **Billing alerts** - Should set up alerts before hitting billing limits

---

## Lessons Learned

1. **GitHub Packages scope requirements**: Package scope must match the repository owner (org or user)
2. **npm 403 errors**: Can mean "already published" not just "permission denied"
3. **Artifact storage**: GitHub Actions artifact storage has quotas that affect caching strategies
4. **Fallback patterns**: Always design workflows with graceful degradation for transient failures

---

## Action Items

- [ ] Consider adding pre-publish validation job to catch configuration issues early
- [ ] Set up billing alerts for GitHub Actions/Packages
- [ ] Document the scope requirement in onboarding docs
- [ ] Consider moving enterprise to npm with restricted access for scope consistency

---

## Related Documentation

- [ADR-013: Open-Core Licensing Model](../adr/013-open-core-licensing.md)
- [npm Publishing Setup](../publishing/npm-setup.md)
- [Enterprise Package Specification](../enterprise/ENTERPRISE_PACKAGE.md)
