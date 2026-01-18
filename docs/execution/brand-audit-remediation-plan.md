# Brand Audit Remediation Plan

**Approved:** 2026-01-18
**Project:** Skillsmith Phase 6: Website & Portal
**Linear Project ID:** `59345241-3a70-4bbc-aed3-6d286f632143`
**Git Worktree:** `feature/brand-audit`

## Reference Documents

- Brand Audit Report: `docs/design/review/2026-01-18-brand-audit.md`
- Brand Guidelines: `docs/design/brand_guidelines.md`

## Brand Colors Reference

```css
--bg-primary: #0D0D0F;
--accent-coral: #E07A5F;
--accent-coral-dark: #D4694E;
--text-primary: #FAFAFA;
/* CTA: linear-gradient(135deg, #E07A5F 0%, #D4694E 100%) */
```

**Font:** Satoshi from Fontshare (not Inter)

---

## Phase 1: Linear Issue Creation

### Issue Structure

| Parent Issue | Labels | Sub-issues |
|--------------|--------|------------|
| P0 Critical: 404 Fixes | `p0-critical`, `website` | /blog page, /login page |
| P1 High: Brand Compliance | `p1-high`, `website`, `ux` | Satoshi font (5 files), gradient-text class, Header CTA buttons, Button primary style, pricing dark theme, signup dark theme |
| P2 Medium: Component Polish | `p2-medium`, `website`, `ux` | PricingCard badges, FeatureCard gradients, contact/license/changelog colors |

### Issue Count by Priority

- **P0 Critical:** 2 sub-issues
- **P1 High:** 6 sub-issues
- **P2 Medium:** 3 sub-issues
- **Total:** 11 issues + 3 parent issues = 14 issues

---

## Phase 2: Skillsmith Investigation

Search for skills across these categories to predict which will help achieve milestones:

| Category | Search Terms | Expected Use Case |
|----------|--------------|-------------------|
| CSS/Styling | css, styling, gradients, colors, design-system | Color fixes, gradient corrections |
| Astro Framework | astro, framework, components, pages | Page creation, component updates |
| Typography | fonts, typography, satoshi, fontshare | Font migration from Inter to Satoshi |
| Code Review | review, lint, quality, standards | Validate changes meet brand guidelines |
| Deployment | vercel, deploy, preview, staging | Deploy and verify fixes |

### Skill Tracking

Skills will be tracked in: `docs/execution/brand-audit-skill-report.md`

---

## Phase 3: Project Update

Post to Linear project with:

1. Summary of brand audit initiative
2. Links to audit report and brand guidelines (GitHub paths)
3. Issue count breakdown by priority
4. Skill investigation plan overview
5. Timeline/milestones

---

## Phase 4: Execution & Reporting

### Definition of Done Criteria

Each issue includes:

1. **Audit-derived criteria** - Specific colors, fonts, values from brand guidelines
2. **Manual verification steps** - Browser checks, visual inspection
3. **Automated checks** - CSS linting, 404 detection, build success

### Final Report

At worktree completion, produce report comparing:

- **Predicted skills** - Which skills Skillsmith recommended
- **Actual usage** - Which skills were actually used
- **Impact assessment** - How skills affected milestone achievement
- **Recommendations** - Insights for future skill development

---

## P0 Critical Issues Detail

### P0-1: Create /blog page or remove nav links

**Problem:** /blog returns 404
**Definition of Done:**
- [ ] /blog route exists and renders content OR nav links to /blog are removed
- [ ] No 404 errors when clicking blog navigation
- [ ] Build passes without errors

### P0-2: Create /login page or remove nav links

**Problem:** /login returns 404
**Definition of Done:**
- [ ] /login route exists and renders content OR nav links to /login are removed
- [ ] No 404 errors when clicking login navigation
- [ ] Build passes without errors

---

## P1 High Priority Issues Detail

### P1-1: Replace Inter font with Satoshi

**Files to update:**
- `BaseLayout.astro`
- `global.css`
- `signup.astro`
- `pricing.astro`
- `signup/success.astro`

**Definition of Done:**
- [ ] All font-family declarations use Satoshi, not Inter
- [ ] Satoshi font files loaded from Fontshare CDN or local
- [ ] Visual verification: headings and body text render in Satoshi
- [ ] No Inter font references in codebase

### P1-2: Fix `.gradient-text` class

**Problem:** Uses blue/purple gradient instead of coral
**Definition of Done:**
- [ ] `.gradient-text` uses `linear-gradient(135deg, #E07A5F 0%, #D4694E 100%)`
- [ ] Visual verification: gradient text displays coral tones
- [ ] CSS linter passes

### P1-3: Fix Header.astro CTA buttons

**Problem:** Blue/purple gradient instead of coral
**Definition of Done:**
- [ ] CTA buttons use coral gradient `linear-gradient(135deg, #E07A5F 0%, #D4694E 100%)`
- [ ] Hover states maintain coral theme
- [ ] Visual verification in browser

### P1-4: Fix Button.astro primary style

**Problem:** Blue/purple gradient instead of coral
**Definition of Done:**
- [ ] Primary button variant uses coral gradient
- [ ] All button states (hover, active, focus) use coral theme
- [ ] Visual verification across all pages using primary buttons

### P1-5: Convert pricing.astro to dark theme

**Problem:** Light background instead of dark
**Definition of Done:**
- [ ] Background uses `#0D0D0F`
- [ ] Text uses `#FAFAFA` for primary content
- [ ] All pricing cards readable on dark background
- [ ] Visual verification matches brand guidelines

### P1-6: Convert signup.astro to dark theme

**Problem:** Light background instead of dark
**Definition of Done:**
- [ ] Background uses `#0D0D0F`
- [ ] Form inputs styled for dark theme
- [ ] Text uses `#FAFAFA` for primary content
- [ ] Visual verification matches brand guidelines

---

## P2 Medium Priority Issues Detail

### P2-1: PricingCard.astro badge colors

**Definition of Done:**
- [ ] Badge colors align with brand palette
- [ ] Recommended/popular badges use coral accent
- [ ] Visual verification

### P2-2: FeatureCard.astro gradient options

**Definition of Done:**
- [ ] Gradient options use brand-compliant colors
- [ ] No blue/purple gradients remain
- [ ] Visual verification

### P2-3: Other pages color alignment

**Files:** `contact.astro`, `license.astro`, `changelog.astro`
**Definition of Done:**
- [ ] All pages use dark theme (`#0D0D0F` background)
- [ ] Text colors use brand palette
- [ ] Consistent with rest of site
