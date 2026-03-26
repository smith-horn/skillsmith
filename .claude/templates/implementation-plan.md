# [ISSUE-ID]: [Title]

## Review Summary

Reviewed: YYYY-MM-DD | Reviewers: VP Product, VP Engineering, VP Design

### Changes Applied

| # | Change |
|---|--------|
| 1 | [Change from plan review] |

---

## Context

[Problem background — what's broken/needed and why. Include the root cause, impact, and what prompted this work.]

## What Changes

### 1. [First change area]

**Problem**: [What's wrong or missing]

**Solution**: [How it's fixed]

**Files**:

- `path/to/file.ts` — [what changes]

### 2. [Second change area]

**Problem**: [What's wrong or missing]

**Solution**: [How it's fixed]

**Files**:

- `path/to/file.ts` — [what changes]

## Wave 1: [Title]

_Use waves only for multi-step implementations. Single-wave work can omit this section and list steps directly under "What Changes"._

### Step 1: [Action]

[Details with file paths and line numbers]

### Step 2: [Action]

[Details with file paths and line numbers]

## Wave 2: [Title]

_Add additional waves as needed. Order by risk: database migrations and production behavior changes first (SMI-2596)._

### Step 1: [Action]

[Details]

## Verification

- [ ] `docker exec skillsmith-dev-1 npm run preflight`
- [ ] [Manual testing steps specific to this change]
- [ ] Linear issue(s) updated with commit SHA
