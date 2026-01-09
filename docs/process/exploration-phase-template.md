# Repository Exploration Phase Template

## Purpose

Discover existing code, patterns, and infrastructure **before** implementing new features. This phase prevents duplicate work, ensures consistency with existing patterns, and identifies opportunities to leverage existing infrastructure.

**This exploration should run BEFORE any wave execution.**

---

## Step 1: Search for Existing Implementations

Before writing any new code, search for related implementations:

```bash
# Search for keywords related to the feature
grep -r "keyword" packages/

# Find files with similar names
find packages/ -name "*keyword*" -type f

# Check for existing modules
ls packages/core/src/
ls packages/mcp-server/src/

# Search for related types/interfaces
grep -r "interface.*Keyword" packages/ --include="*.ts"
grep -r "type.*Keyword" packages/ --include="*.ts"

# Look for existing tests that might guide implementation
find packages/ -name "*.test.ts" -exec grep -l "keyword" {} \;
```

### Checklist
- [ ] Searched for feature keywords in all packages
- [ ] Found related type definitions
- [ ] Identified existing patterns to follow
- [ ] Located relevant test files

---

## Step 2: Check for Related Infrastructure

Review infrastructure that may already support or affect the feature:

### GitHub Actions Workflows
```bash
ls -la .github/workflows/
grep -l "keyword" .github/workflows/*.yml
```
- [ ] Checked `.github/workflows/` for existing CI/CD

### Supabase Functions
```bash
ls -la supabase/functions/ 2>/dev/null || echo "No Supabase functions directory"
```
- [ ] Checked `supabase/functions/` for serverless functions

### Configuration Files
```bash
# Root level configuration
ls -la *.config.* 2>/dev/null
ls -la *.json 2>/dev/null | grep -v package-lock

# Check for environment configuration
cat .env.schema 2>/dev/null || echo "No .env.schema"
```
- [ ] Reviewed root-level config files
- [ ] Checked `.env.schema` for relevant environment variables

### Database/Storage
```bash
# Check for migrations or schema
find . -name "*.sql" -type f 2>/dev/null
find . -name "*migration*" -type f 2>/dev/null
```
- [ ] Identified existing database schemas
- [ ] Found related migrations

---

## Step 3: Review Architecture Docs

### Architecture Documentation
```bash
ls docs/architecture/
```
- [ ] Check `docs/architecture/` for existing design docs
- [ ] Review system diagrams and data flows

### Architecture Decision Records
```bash
ls docs/adr/
grep -l "keyword" docs/adr/*.md 2>/dev/null
```
- [ ] Review `docs/adr/` for relevant decisions
- [ ] Note any constraints or requirements from ADRs

### Retrospectives and Lessons Learned
```bash
ls docs/retros/
grep -l "keyword" docs/retros/*.md 2>/dev/null
```
- [ ] Check `docs/retros/` for lessons learned
- [ ] Identify pitfalls to avoid

---

## Step 4: Examine Dependencies

### Package Dependencies
```bash
# Check root package.json
cat package.json | grep -A 50 '"dependencies"'

# Check workspace packages
cat packages/core/package.json | grep -A 30 '"dependencies"'
cat packages/mcp-server/package.json | grep -A 30 '"dependencies"'
```
- [ ] Identified relevant packages already installed
- [ ] Checked for version constraints

### Existing Integrations
```bash
# Look for API clients or SDKs
grep -r "import.*from" packages/ --include="*.ts" | grep -i "sdk\|client\|api"
```
- [ ] Found existing API integrations
- [ ] Noted authentication patterns in use

---

## Step 5: Document Findings

Create an exploration report using the template below. Save it to:
`docs/execution/exploration-[feature-name].md`

---

## Exploration Report Template

```markdown
# Exploration Report: [Feature Name]

**Date**: YYYY-MM-DD
**Author**: [Name]
**Related Issues**: SMI-XXX

## Executive Summary
Brief 2-3 sentence summary of findings.

## Existing Code Found

### Implementation Status
- [ ] None - No existing implementation
- [ ] Partial - Some related code exists
- [ ] Complete - Full implementation exists (may need enhancement)

### Locations
| File/Directory | Description | Relevance |
|----------------|-------------|-----------|
| `path/to/file` | Description | High/Medium/Low |

### Code Patterns Discovered
- Pattern 1: Description and location
- Pattern 2: Description and location

## Infrastructure Status

| Component | Status | Notes |
|-----------|--------|-------|
| GitHub Actions | None/Partial/Complete | |
| Supabase Functions | None/Partial/Complete | |
| Database Schema | None/Partial/Complete | |
| Configuration | None/Partial/Complete | |

## Dependencies

### Existing Packages to Leverage
- `package-name`: How it can be used

### New Packages Needed
- `package-name`: Why it's needed

## Recommended Approach

### Option A: [Name]
- Description
- Pros:
- Cons:

### Option B: [Name]
- Description
- Pros:
- Cons:

### Recommendation
Recommended option and rationale.

## Implementation Plan

### Files to Create
| Path | Purpose |
|------|---------|
| `packages/core/src/...` | Description |

### Files to Modify
| Path | Changes Needed |
|------|----------------|
| `packages/core/src/...` | Description |

### Files to Delete (if any)
| Path | Reason |
|------|--------|
| `path/to/file` | Reason |

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Risk 1 | High/Med/Low | High/Med/Low | Mitigation strategy |

## Questions/Blockers

- [ ] Question 1 - Assigned to: @person
- [ ] Question 2 - Assigned to: @person

## Next Steps

1. Step 1
2. Step 2
3. Step 3
```

---

## Quick Exploration Commands

For rapid exploration, run these commands in sequence:

```bash
# Full codebase search
FEATURE="your-keyword"

echo "=== Searching for $FEATURE ==="
grep -r "$FEATURE" packages/ --include="*.ts" -l 2>/dev/null

echo "=== Finding related files ==="
find packages/ -name "*${FEATURE}*" -type f 2>/dev/null

echo "=== Checking infrastructure ==="
ls .github/workflows/ 2>/dev/null
ls supabase/functions/ 2>/dev/null

echo "=== Checking docs ==="
grep -l "$FEATURE" docs/**/*.md 2>/dev/null

echo "=== Checking dependencies ==="
grep "$FEATURE" package.json packages/*/package.json 2>/dev/null
```

---

## When to Skip Exploration

Exploration can be abbreviated when:
- Adding simple bug fixes to well-understood code
- Making documentation-only changes
- Updating existing tests
- Routine dependency updates

**Never skip exploration for:**
- New features
- Architectural changes
- Integration with external services
- Database schema changes
- Security-related changes
