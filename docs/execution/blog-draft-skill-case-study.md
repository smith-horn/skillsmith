# Blog Post Draft: Skillsmith Case Study

> **Note:** This draft will be moved to `/packages/website/src/content/blog/` once the blog structure is created (P0-1: SMI-1558)

---

## Metadata

```yaml
title: "How We Used Skillsmith to Fix Our Own Website: A Case Study"
slug: "skillsmith-brand-audit-case-study"
description: "We put Skillsmith to the test on our own brand audit remediation project. Here's what we learned about skill coverage, gaps, and real-world impact."
author: "Skillsmith Team"
publishDate: 2026-01-XX  # TBD after execution
tags: ["case-study", "brand-audit", "skills", "astro", "deployment"]
featured: true
```

---

## Blog Post Content

# How We Used Skillsmith to Fix Our Own Website: A Case Study

*We put Skillsmith to the test on our own brand audit remediation project. Here's what we learned about skill coverage, gaps, and real-world impact.*

---

## The Challenge

After conducting a comprehensive brand audit of the Skillsmith website, we identified **11 issues** ranging from critical 404 errors to brand color inconsistencies. The question was: could Skillsmith help us fix our own product faster?

### Issues Identified

| Priority | Count | Examples |
|----------|-------|----------|
| P0 Critical | 2 | 404 errors on /blog and /login |
| P1 High | 6 | Wrong font (Inter instead of Satoshi), blue gradients instead of coral |
| P2 Medium | 3 | Component badge colors, feature card gradients |

---

## The Experiment

We searched Skillsmith across 5 categories to find skills that could help:

1. **CSS/Styling** - for color and gradient fixes
2. **Astro Framework** - for page creation and component updates
3. **Typography** - for font migration
4. **Code Review** - for validating changes
5. **Deployment** - for Vercel deployment verification

---

## Predictions: What Skillsmith Recommended

### Skills Found by Category

| Category | Skills Found | Predicted Coverage |
|----------|-------------|-------------------|
| CSS/Styling | 4 | 60% |
| Astro Framework | 4 | 90% |
| Typography/Fonts | **0** | 0% |
| Code Review | 6 | 95% |
| Deployment | 4 | 95% |

### Top Recommended Skills

1. **`astro`** (user-level) - For creating the missing /blog and /login pages
2. **`clerk`** (user-level) - For login page authentication integration
3. **`021-design`** (user-level) - Design system enforcement with anti-pattern detection
4. **`vercel/web-design-guidelines`** (verified, 0.94 quality) - UI auditing with 100+ rules
5. **`github-code-review`** (project) - PR validation with style checks
6. **`vercel-deploy-claimable`** (verified, 0.93 quality) - Deployment with preview URLs

### The Gap We Found

**No typography-specific skills exist.** The font migration from Inter to Satoshi would require manual CSS work with no skill assistance.

---

## Actuals: What Actually Happened

> **[TO BE COMPLETED AFTER EXECUTION]**

### Skills Actually Used

| Issue | Predicted Skill | Skill Used | Impact (1-5) |
|-------|-----------------|------------|--------------|
| /blog 404 | `astro` | TBD | TBD |
| /login 404 | `astro` + `clerk` | TBD | TBD |
| Satoshi font | None | TBD | TBD |
| Gradient fixes | `021-design` | TBD | TBD |
| Dark theme | `astro` | TBD | TBD |
| Deployment | `vercel-deploy-claimable` | TBD | TBD |

### Prediction Accuracy

- **Predicted coverage:** 91% (10/11 issues)
- **Actual coverage:** TBD
- **Average impact score:** TBD/5

---

## Key Learnings

### What Worked

> [TO BE COMPLETED]

### What Didn't

> [TO BE COMPLETED]

### Gaps Identified

1. **Typography Skill Needed** - Font migration, CDN loading, @font-face management
2. **CSS Variables Skill** - Design token management, brand color enforcement
3. **Gradient Validator** - Verify gradients match brand specifications
4. **Dark Theme Auditor** - Validate dark mode implementation

---

## Recommendations

### For Skillsmith Users

> [TO BE COMPLETED]

### For Skill Authors

Based on our gaps, we'd love to see these skills in the registry:

1. `typography-helper` - Web fonts, font loading, migration patterns
2. `design-system-auditor` - Brand guideline enforcement
3. `astro-design-system` - Astro + design system patterns combined

---

## Conclusion

> [TO BE COMPLETED]

---

## Resources

- [Brand Audit Report](docs/design/review/2026-01-18-brand-audit.md)
- [Brand Guidelines](docs/design/brand_guidelines.md)
- [Execution Plan](docs/execution/brand-audit-remediation-plan.md)
- [Full Skill Report](docs/execution/brand-audit-skill-report.md)

---

## About Skillsmith

Skillsmith is an MCP server for Claude Code skill discovery, installation, and management. [Learn more →](/docs/getting-started)
