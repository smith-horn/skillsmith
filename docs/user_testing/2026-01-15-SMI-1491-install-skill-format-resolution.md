# User Testing Report: SMI-1491

**Date**: January 15, 2026
**Reporter**: External user (via screenshot)
**Linear Issue**: [SMI-1491](https://linear.app/smith-horn-group/issue/SMI-1491)
**Severity**: High (blocking user workflow)
**Status**: Fixed

---

## Issue Summary

User experienced ~15 minutes of failed attempts using `install_skill` tool because it didn't accept the skill ID format returned by the `search` tool.

## User Experience

1. User searched for skills using the `search` tool
2. Search returned skill IDs in `author/skill-name` format (e.g., `anthropic/commit`)
3. User tried to install using `install_skill { skillId: "anthropic/commit" }`
4. Tool failed with "Could not find SKILL.md" error
5. User attempted workarounds (manual web search, trying to find the repo)
6. After 15 minutes of back-and-forth, user discovered the workaround: use full GitHub URL

## Root Cause Analysis

**Format Mismatch**:
- `search` tool returns: `author/skill-name` (registry ID format)
- `install_skill` expected: `owner/repo` (GitHub format)

When user passed `anthropic/commit`, the tool treated `commit` as a repository name and tried to fetch:
```
https://raw.githubusercontent.com/anthropic/commit/main/SKILL.md
```

This URL doesn't exist because `commit` is a skill name, not a repository.

**Additional Finding**: Most indexed skills (~5.8k) are either:
- Seed data placeholders (fictional repos)
- Metadata-only entries (no SKILL.md at root)

Only skills with proper `SKILL.md` at repo root are actually installable.

## Screenshot Evidence

User provided screenshot showing:
- Multiple failed fetch attempts (404 errors)
- Discovery that most "anthropic/*" skills are seed data
- `supabasepower` skill successfully installed (has proper SKILL.md)
- Recommendation to "Tell Ryan the install flow needs work"

## Fix Implemented

### Changes Made

| File | Change |
|------|--------|
| `packages/mcp-server/src/tools/install.ts` | Added registry lookup before GitHub fetch |
| `packages/core/src/types.ts` | Added `repository` field to `SkillSearchResult` |
| `packages/mcp-server/src/tools/search.ts` | Include `repo_url` in search results |

### New Functions

1. **`lookupSkillFromRegistry(skillId, context)`**: Queries API/local DB to get actual `repo_url`
2. **`parseRepoUrl(repoUrl)`**: Parses GitHub URLs from registry (handles tree/blob/branch formats)
3. **`parseSkillId()` updated**: Added `isRegistryId` flag to detect 2-part IDs

### Improved Error Messages

**Before** (confusing):
```
Could not find SKILL.md at repository root.
```

**After** (actionable):
```
Skill "anthropic/commit" is indexed for discovery only.
No installation source available (repo_url is missing).
This may be placeholder/seed data or a metadata-only entry.

Tips:
- Use a full GitHub URL instead: install_skill { skillId: "https://github.com/owner/repo" }
- Search for installable skills using the search tool
- Many indexed skills are metadata-only and cannot be installed directly
```

## Test Coverage

Added 8 new unit tests:
- `parseRepoUrl` with various GitHub URL formats (repo root, tree, blob, branches)
- `parseSkillId` with `isRegistryId` flag detection

All 3942 tests pass.

## Recommendations for Future

1. **Add `installable` filter to search**: Allow users to filter for skills that have valid `repo_url`
2. **Clean up seed data**: Remove or clearly mark placeholder entries in registry
3. **Pre-validate repo_url**: Index only skills where SKILL.md is confirmed to exist
4. **UX improvement**: Show repository URL in search results so users know the source

## Workaround (for users on older versions)

Use full GitHub URL format:
```
install_skill { skillId: "https://github.com/owner/repo" }
```

---

## Timeline

- **15:00**: User reports issue via screenshot
- **15:30**: Bug confirmed and root cause identified
- **16:00**: Fix implemented and tested
- **16:15**: Documentation updated, committed, pushed
