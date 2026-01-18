# Website Consistency and E2E Testing Plan

## Problem Summary

Multiple pages on skillsmith.app have inconsistent styling:

| Issue | Page | Description |
|-------|------|-------------|
| Different design | index.astro | Satoshi font, Neural S branding, dark theme |
| **No Tailwind** | pricing.astro | Own HTML, NO Tailwind CDN - completely unstyled |
| Different fonts | BaseLayout | Inter font instead of Satoshi |
| 404 Error | /features | Linked from pricing.astro but doesn't exist |
| Fetch Error | /skills | "Failed to fetch" - likely CORS or caching |

## Root Cause Analysis

### Design System Fragmentation
```
index.astro          → Custom HTML (Satoshi font, Neural S logo)
pricing.astro        → Custom HTML (Inter font, NO TAILWIND!)
BaseLayout.astro     → Shared layout (Inter font, Tailwind CDN)
DocsLayout.astro     → Extends BaseLayout
```

**Result**: 3 different visual designs across the site.

---

## Implementation Plan

### Phase 1: Critical Fixes (Immediate)

#### 1.1 Fix pricing.astro - Add Tailwind CDN
The page has no Tailwind at all. Add after line 122:
```html
<script is:inline src="https://cdn.tailwindcss.com"></script>
```

#### 1.2 Fix /features 404
**Option A** (Recommended): Remove dead links from pricing.astro (lines 259, 454)
**Option B**: Create a simple features.astro page

#### 1.3 Fix /skills Fetch Error
- Check CORS headers in `supabase/functions/_shared/cors.ts`
- Verify `skillsmith.app` is in allowed origins
- Add better error messaging to show actual error

### Phase 2: Unify Design System

#### 2.1 Choose Authoritative Design
**Recommendation**: Adopt index.astro's design as standard:
- **Font**: Satoshi (distinctive, modern)
- **Mono Font**: JetBrains Mono
- **Logo**: Neural S from `/logo-icon.svg`
- **Theme**: Dark with custom colors

#### 2.2 Update BaseLayout.astro
- Replace Inter with Satoshi font
- Update logo to match index.astro
- Ensure consistent color tokens

#### 2.3 Migrate pricing.astro to BaseLayout
- Extract content into BaseLayout wrapper
- Remove duplicate HTML boilerplate
- Ensure consistent navigation/footer

### Phase 3: E2E Testing with Agent-Browser

#### 3.1 Why Agent-Browser?

[Vercel Agent-Browser](https://github.com/vercel-labs/agent-browser) is a headless browser CLI designed for AI agents:

| Feature | Benefit |
|---------|---------|
| CLI-first design | Perfect for Claude Code automation |
| Semantic selectors | Find by role, text, label - not fragile CSS |
| Accessibility snapshots | Get element references (@e1, @e2) for stable targeting |
| Session management | Multiple isolated browser instances |
| Rust + Node.js | Fast native execution with JS fallback |

#### 3.2 Installation
```bash
npm install -g agent-browser
agent-browser install  # Downloads Chromium
```

#### 3.3 E2E Test Strategy

**Visual Consistency Tests**:
```bash
# Take baseline screenshots
agent-browser open https://www.skillsmith.app/
agent-browser screenshot --path baseline/home.png

agent-browser open https://www.skillsmith.app/pricing
agent-browser screenshot --path baseline/pricing.png

agent-browser open https://www.skillsmith.app/docs/api
agent-browser screenshot --path baseline/docs-api.png
```

**Functional Tests**:
```bash
# Test skills search
agent-browser open https://www.skillsmith.app/skills
agent-browser snapshot  # Get accessibility tree
agent-browser fill "input#search-input" "testing"
agent-browser wait text "test-master"  # Wait for results
agent-browser get text "#results-count"
```

**Navigation Tests**:
```bash
# Test all nav links don't 404
agent-browser open https://www.skillsmith.app/
agent-browser click "a[href='/skills']"
agent-browser wait url "**/skills"
agent-browser click "a[href='/docs']"
agent-browser wait url "**/docs"
```

#### 3.4 Create Test Skill for Skillsmith Website

Create a skill at `.claude/skills/website-e2e/SKILL.md`:
```yaml
---
name: website-e2e
description: E2E testing for Skillsmith website using agent-browser
triggers:
  - test website
  - e2e tests
  - visual regression
tools:
  - Bash
---
```

#### 3.5 CI Integration

Add to `.github/workflows/website-e2e.yml`:
```yaml
name: Website E2E Tests
on:
  push:
    paths:
      - 'packages/website/**'
  pull_request:
    paths:
      - 'packages/website/**'

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm install -g agent-browser
      - run: agent-browser install --with-deps
      - run: ./scripts/e2e-tests.sh
```

---

## Files to Modify

| File | Change | Priority |
|------|--------|----------|
| `pricing.astro` | Add Tailwind CDN script | P0 |
| `pricing.astro` | Remove /features links OR create page | P0 |
| `supabase/functions/_shared/cors.ts` | Verify CORS for skillsmith.app | P1 |
| `BaseLayout.astro` | Update fonts to Satoshi | P2 |
| `BaseLayout.astro` | Update logo to match index.astro | P2 |
| `package.json` | Add agent-browser devDep | P2 |
| `.github/workflows/` | Add E2E workflow | P3 |

---

## Acceptance Criteria

- [ ] All pages render with consistent dark theme
- [ ] All pages use same fonts (Satoshi + JetBrains Mono)
- [ ] All pages use same logo/branding
- [ ] No 404 errors on internal navigation
- [ ] /skills page loads and displays search results
- [ ] E2E tests pass for critical user flows
- [ ] Visual regression baseline established

---

## Skillsmith Skills to Install

Search and install these to help with implementation:

1. **vercel-github-actions** - Already have, use for deployment
2. **test-master** - Comprehensive testing patterns
3. Search for: `agent-browser`, `visual-regression`, `e2e-testing`
