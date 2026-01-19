# Version Governance Policy

**Issue**: SMI-1585
**Status**: Documented
**Last Updated**: January 2026

## Overview

This document defines the versioning policy for Skillsmith packages, APIs, and database schemas. Following these guidelines ensures backward compatibility and smooth upgrades for users.

## Semantic Versioning

All Skillsmith packages follow [Semantic Versioning 2.0.0](https://semver.org/):

```
MAJOR.MINOR.PATCH
│     │     │
│     │     └── Bug fixes (backward compatible)
│     └──────── New features (backward compatible)
└────────────── Breaking changes
```

### Version Meanings

| Change Type | Version Bump | Examples |
|------------|--------------|----------|
| Breaking change | MAJOR | Removing API endpoints, changing database schema incompatibly |
| New feature | MINOR | New CLI commands, new API endpoints, new tool options |
| Bug fix | PATCH | Fixing errors, performance improvements, documentation |

## Package Versioning

### Monorepo Packages

| Package | Version | Sync Policy |
|---------|---------|-------------|
| `@skillsmith/core` | Independent | Core functionality, versioned independently |
| `@skillsmith/mcp-server` | Linked | Matches core for major/minor |
| `@skillsmith/cli` | Linked | Matches core for major/minor |

### Version Synchronization

Major and minor versions are synchronized across linked packages:
- When `@skillsmith/core` bumps to `0.4.0`, linked packages also bump to `0.4.x`
- Patch versions may differ between packages

## API Versioning

### REST API

The Skillsmith API uses URL path versioning:

```
/api/v1/skills/search
/api/v2/skills/search  (future)
```

**Version Lifecycle**:
1. **Current**: Active development, full support
2. **Deprecated**: 6-month sunset notice, maintenance only
3. **Sunset**: Read-only for 3 months, then removed

### Breaking Changes

Changes that require a new API version:
- Removing or renaming fields in responses
- Changing field types
- Removing endpoints
- Changing authentication requirements

Non-breaking changes (no version bump):
- Adding new fields to responses
- Adding new endpoints
- Adding optional parameters
- Performance improvements

## Database Schema Versioning

### Schema Version Table

```sql
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Migration Policy

1. **Forward-only**: Migrations only move forward
2. **Additive**: Prefer adding columns/tables over modifying
3. **Safe rollback**: Document rollback procedures for each migration

### Version Mapping

| Schema Version | Skillsmith Version | Notes |
|----------------|-------------------|-------|
| 1 | 0.1.x | Initial schema |
| 2 | 0.2.x | Added sync tables |
| 3 | 0.3.x | Added audit logging |

## Pre-release Versions

### Alpha/Beta Tags

```
0.4.0-alpha.1  # Early testing, unstable
0.4.0-beta.1   # Feature complete, may have bugs
0.4.0-rc.1     # Release candidate, final testing
```

### Prerelease Policy

- Alpha: Internal testing only
- Beta: Community testing, breaking changes possible
- RC: No new features, bug fixes only

## Changelog Requirements

Every version must have a CHANGELOG.md entry:

```markdown
## [0.4.0] - 2026-01-24

### Added
- New merge CLI command (SMI-1455)

### Changed
- Updated security scanner output format (SMI-1454)

### Fixed
- Schema version mismatch during imports (SMI-1446)
```

## Release Checklist

Before releasing a new version:

1. [ ] All tests pass
2. [ ] CHANGELOG.md updated
3. [ ] Version bumped in package.json files
4. [ ] API documentation updated (if applicable)
5. [ ] Migration scripts tested
6. [ ] Breaking changes documented

## Deprecation Policy

### Deprecation Timeline

1. **Announcement**: Document deprecation with sunset date
2. **Warning Period**: 3 months minimum
3. **Sunset**: 3 more months for migration
4. **Removal**: Feature/API removed

### Deprecation Notice Format

```typescript
/**
 * @deprecated Since 0.4.0. Use `newFunction()` instead.
 * Will be removed in 0.6.0.
 */
function oldFunction(): void {
  console.warn('oldFunction is deprecated. Use newFunction instead.')
  // ... implementation
}
```

## See Also

- [Engineering Standards](./standards.md)
- [ADR-001: Versioning Strategy](../adr/001-versioning-strategy.md)
- [CHANGELOG.md](../../CHANGELOG.md)
