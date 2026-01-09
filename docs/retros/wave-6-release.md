# Wave 6 Retrospective: v0.2.0 Release

**Date:** January 9, 2026
**Issue:** SMI-1186 - Publish v0.2.0 to npm with live API
**Duration:** ~2 hours (including troubleshooting)
**Status:** ✅ Complete

---

## Summary

Wave 6 focused on releasing Skillsmith v0.2.0 to npm with the live skill registry. All three packages (@skillsmith/core, @skillsmith/mcp-server, @skillsmith/cli) were successfully published at version 0.2.0.

## What Went Well

### 1. Pre-release Validation
- Comprehensive pre-flight checks caught potential issues early
- 3,432 tests passed across 126 test files
- Build verification ensured packages were ready
- API health check confirmed live endpoint working

### 2. Version Management
- Clean version bump across all packages using npm workspaces
- VERSION constants updated in source files consistently
- CHANGELOG.md was already prepared from previous waves

### 3. Documentation Updates
- Added Live API section to all package READMEs
- Clear configuration instructions for users
- Privacy-first telemetry documentation

### 4. Git Workflow
- Clean commit with descriptive message
- Tag v0.2.0 created properly
- GitHub Release published with comprehensive notes

## What Didn't Go Well

### 1. NPM_TOKEN Secret Misconfiguration
**Problem:** The publish workflow failed multiple times with `ENEEDAUTH` error.

**Root Cause:** The `SKILLSMITH_NPM_TOKEN` secret was configured in the fork repository (wrsmith108/skillsmith) but not in the organization repository (Smith-Horn-Group/skillsmith). The publish workflow runs from the org repo.

**Resolution:** Added the secret to the correct repository settings.

**Time Lost:** ~45 minutes of debugging and multiple workflow re-runs.

**Lesson Learned:** When working with fork/upstream workflows, verify secrets are configured in the repository where the workflow actually runs, not just where development happens.

### 2. Workflow Dispatch Dry Run Default
**Problem:** First manual workflow trigger ran with `dry_run=true` by default, which skipped actual publishing.

**Resolution:** Explicitly passed `-f dry_run=false` on subsequent runs.

**Lesson Learned:** Always check workflow defaults when using `workflow_dispatch`.

## Metrics

| Metric | Value |
|--------|-------|
| Pre-flight tests passed | 3,432 |
| Test files | 126 |
| Packages published | 3 |
| Workflow runs (total) | 6 |
| Workflow runs (failed) | 4 |
| Time to first success | ~2 hours |

## Action Items

### Immediate
- [x] Add `SKILLSMITH_NPM_TOKEN` to Smith-Horn-Group/skillsmith
- [x] Verify all packages published to npm
- [x] Update Linear issue SMI-1186

### Follow-up
- [ ] Document secret configuration requirements in CONTRIBUTING.md
- [ ] Add CI check that warns if publish will fail due to missing secrets
- [ ] Consider using org-level secrets for consistency

## Technical Details

### Packages Published
```
@skillsmith/core@0.2.0
@skillsmith/mcp-server@0.2.0
@skillsmith/cli@0.2.0
```

### Key Files Changed
- `packages/*/package.json` - version bumps
- `packages/*/src/index.ts` - VERSION constants
- `packages/*/README.md` - Live API documentation

### GitHub Actions Workflow
- Workflow: `publish.yml`
- Trigger: `release` event or `workflow_dispatch`
- Jobs: docker-build → validate → publish-core → publish-mcp-server → publish-cli

## Recommendations for Future Releases

1. **Pre-release Checklist**: Add secret verification step
   ```bash
   # Verify secrets are accessible (dry run)
   gh workflow run publish.yml -f dry_run=true
   ```

2. **Documentation**: Create a release runbook with explicit secret requirements

3. **Automation**: Consider adding a "verify-secrets" job that runs before publish

4. **Monitoring**: Set up npm download tracking for Gate 1 metrics

## Post-Release: Security Fixes

After the v0.2.0 release, Dependabot flagged security vulnerabilities that were promptly addressed.

### Vulnerabilities Resolved (SMI-1281)

| Alert | Package | Severity | Resolution |
|-------|---------|----------|------------|
| #1, #2 | esbuild | Medium | npm override to 0.27.2 |
| #4 | @modelcontextprotocol/sdk | High | Already fixed via override |
| #5 | path-to-regexp | High | Already fixed via override |
| #6, #7 | undici | Medium/Low | Already fixed via override |

### Solution

Added esbuild to npm overrides in `package.json`:

```json
"overrides": {
  "undici": "^7.18.0",
  "path-to-regexp": "^8.3.0",
  "esbuild": "0.27.2"
}
```

The esbuild vulnerability (GHSA-67mh-4wv8-2f99) allowed any website to send requests to the dev server. The override forces all nested dependencies to use the secure version.

**Result:** `npm audit` now reports 0 vulnerabilities.

## Conclusion

Despite the secret configuration hiccup, Wave 6 was ultimately successful. The v0.2.0 release is live on npm and users can now access 9,717+ skills through the Skillsmith MCP server. Post-release security fixes ensured all Dependabot alerts are resolved. The key learning is to ensure secrets are configured in the correct repository when working with fork/upstream patterns.

---

## Links

- [GitHub Release v0.2.0](https://github.com/Smith-Horn-Group/skillsmith/releases/tag/v0.2.0)
- [npm: @skillsmith/mcp-server](https://www.npmjs.com/package/@skillsmith/mcp-server)
- [Linear Issue SMI-1186](https://linear.app/smith-horn-group/issue/SMI-1186)
- [Linear Issue SMI-1281 (Security Fix)](https://linear.app/smith-horn-group/issue/SMI-1281)
- [Phase 6A Project](https://linear.app/smith-horn-group/project/skillsmith-phase-6a-critical-path-to-live-40f0780c7e1f)
