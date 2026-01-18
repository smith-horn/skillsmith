# Brand Audit Report

**Date:** January 18, 2026
**Auditor:** Claude Code
**Reference:** [Brand Guidelines](../brand_guidelines.md)
**Status:** Open - Issues Identified

---

## Executive Summary

A comprehensive audit of the Skillsmith website revealed **significant brand inconsistencies** across multiple pages. The website currently uses a mix of design systems, fonts, and color palettes that deviate from the established brand guidelines.

### Key Findings

| Category | Severity | Count |
|----------|----------|-------|
| Missing Pages (404) | Critical | 2 |
| Wrong Font (Inter vs Satoshi) | High | 5 files |
| Wrong Gradient Colors | High | 8 files |
| White Backgrounds (vs Dark) | High | 4 files |
| Inconsistent Components | Medium | Multiple |

---

## 1. Missing Pages (404 Errors)

**Severity:** Critical

Links exist in navigation but pages return 404:

| URL | Source | Error |
|-----|--------|-------|
| `/blog` | Navigation links | `404: NOT_FOUND` |
| `/login` | Navigation links | `404: NOT_FOUND` |

### Recommendation
- Create placeholder pages or remove navigation links
- If features are planned, create "Coming Soon" pages

---

## 2. Font Violations

**Severity:** High
**Expected:** Satoshi (per brand guidelines)
**Actual:** Inter font used across multiple files

### Affected Files

| File | Line | Current | Expected |
|------|------|---------|----------|
| `layouts/BaseLayout.astro` | 144, 147 | `Inter` | `Satoshi` |
| `styles/global.css` | 14 | `Inter` | `Satoshi` |
| `pages/signup.astro` | 57, 301 | `Inter` | `Satoshi` |
| `pages/pricing.astro` | 145, 593 | `Inter` | `Satoshi` |
| `pages/signup/success.astro` | 22, 124 | `Inter` | `Satoshi` |

### Brand Guideline Reference

```css
/* Correct (per brand_guidelines.md) */
font-family: 'Satoshi', system-ui, sans-serif;
font-family: 'JetBrains Mono', monospace; /* for code */
```

### Font Source
Satoshi is available free from [Fontshare](https://www.fontshare.com/fonts/satoshi)

---

## 3. Color Gradient Violations

**Severity:** High
**Expected:** Coral gradient `linear-gradient(135deg, #E07A5F 0%, #D4694E 100%)`
**Actual:** Blue/Purple gradients used

### Affected Files

| File | Component | Current | Expected |
|------|-----------|---------|----------|
| `layouts/BaseLayout.astro` | `.gradient-text` class | `#0ea5e9 → #8b5cf6` (blue→purple) | `#E07A5F → #D4694E` (coral) |
| `components/Header.astro` | CTA button (line 71) | `from-purple-600 to-blue-600` | Coral gradient |
| `components/Header.astro` | Mobile CTA (line 115) | `from-purple-600 to-blue-600` | Coral gradient |
| `components/Button.astro` | Primary style (line 25) | `from-purple-600 to-blue-600` | Coral gradient |
| `components/PricingCard.astro` | Badge (line 41) | `from-purple-600 to-blue-600` | Coral gradient |
| `components/FeatureCard.astro` | Color options (lines 23-24) | Purple/blue options | Coral/amber options |
| `pages/contact.astro` | Submit button (line 117) | `from-primary-500 to-purple-500` | Coral gradient |
| `pages/license.astro` | Background (line 21) | `from-primary-900/30 to-purple-900/30` | Coral glow |
| `pages/changelog.astro` | CTA section (line 269) | `from-primary-900/30 to-purple-900/30` | Coral glow |
| `pages/docs/quickstart.astro` | Card (line 169) | `from-primary-900/30 to-purple-900/30` | Coral glow |

### Visual Impact

The `/skills` page displays "Discover **Skills**" with blue ombre text, which conflicts with the coral Neural S logo directly above it.

### Brand Guideline Reference

```css
/* Correct CTA gradient */
background: linear-gradient(135deg, #E07A5F 0%, #D4694E 100%);

/* Correct background atmosphere */
radial-gradient(circle at 20% 30%, rgba(224, 122, 95, 0.08) 0%, transparent 50%)
```

---

## 4. Background Color Violations

**Severity:** High
**Expected:** Dark mode only (`#0D0D0F`)
**Actual:** White backgrounds used

### Brand Guideline Quote

> "All Skillsmith interfaces use dark mode by default"

### Affected Files

| File | Instances | Lines |
|------|-----------|-------|
| `pages/pricing.astro` | 6 | 689, 775, 803, 929, 1001, 1048 |
| `pages/signup.astro` | 2 | 374, 557 |
| `pages/signup/success.astro` | 2 | 238, 313 |
| `styles/global.css` | Multiple | Light mode styles throughout |

### Specific Issues

**pricing.astro:**
- Card backgrounds use `background: white`
- Form elements use white backgrounds
- Overall page has light theme styling

**signup.astro:**
- Form container uses white background
- Input fields styled for light mode

### Brand Guideline Reference

```css
/* Correct backgrounds */
--bg-primary: #0D0D0F;
--bg-secondary: #18181B;
--bg-tertiary: #27272A;
```

---

## 5. Component Inconsistencies

### Navigation
- Header component uses blue/purple CTA buttons
- Should use coral gradient per brand guidelines

### Cards
- Some cards use `shadow-purple-500/25`
- Should use `shadow-[rgba(224,122,95,0.25)]` (coral shadow)

### Badges
- PricingCard "Most Popular" badge uses purple/blue
- Should use coral or sage per brand guidelines

---

## 6. Accessibility Considerations

The brand guidelines specify WCAG AA compliance. Current violations may affect:

| Issue | Impact |
|-------|--------|
| White backgrounds with current text colors | Contrast may fail on some elements |
| Blue gradient text on dark backgrounds | May not meet 4.5:1 contrast ratio |

---

## Remediation Plan

### Phase 1: Critical (404 Fixes)
1. Create `/blog` page or remove links
2. Create `/login` page or remove links

### Phase 2: Typography
1. Replace Inter with Satoshi in all files
2. Add Satoshi font imports from Fontshare
3. Update font-family declarations

### Phase 3: Colors
1. Update `.gradient-text` class to coral gradient
2. Replace all blue/purple gradients with coral
3. Update Button, Header, PricingCard components

### Phase 4: Backgrounds
1. Convert pricing.astro to dark theme
2. Convert signup.astro to dark theme
3. Convert signup/success.astro to dark theme
4. Remove light mode styles from global.css

### Phase 5: Verification
1. Visual regression testing
2. Accessibility audit
3. Cross-browser testing

---

## Files Requiring Changes

| Priority | File | Changes Needed |
|----------|------|----------------|
| P0 | Create `/blog` | New page or redirect |
| P0 | Create `/login` | New page or redirect |
| P1 | `layouts/BaseLayout.astro` | Font, gradient-text class |
| P1 | `styles/global.css` | Font, remove light styles |
| P1 | `components/Header.astro` | CTA button colors |
| P1 | `components/Button.astro` | Primary gradient |
| P1 | `pages/pricing.astro` | Font, dark theme |
| P1 | `pages/signup.astro` | Font, dark theme |
| P2 | `components/PricingCard.astro` | Badge colors |
| P2 | `components/FeatureCard.astro` | Gradient options |
| P2 | `pages/contact.astro` | Button colors |
| P2 | `pages/license.astro` | Background gradient |
| P2 | `pages/changelog.astro` | CTA section colors |
| P2 | `pages/signup/success.astro` | Font, dark theme |
| P3 | `pages/docs/quickstart.astro` | Card colors |

---

## Brand Color Quick Reference

### Correct Palette

```css
/* Backgrounds */
--bg-primary: #0D0D0F;
--bg-secondary: #18181B;
--bg-tertiary: #27272A;

/* Accents */
--accent-coral: #E07A5F;
--accent-coral-dark: #D4694E;
--accent-amber: #F4A261;
--accent-sage: #81B29A;

/* Text */
--text-primary: #FAFAFA;
--text-secondary: #A1A1AA;
--text-muted: #71717A;

/* CTA Gradient */
background: linear-gradient(135deg, #E07A5F 0%, #D4694E 100%);
```

### Incorrect (Remove)

```css
/* DO NOT USE */
from-purple-600 to-blue-600
from-primary-500 to-purple-500
#0ea5e9 (sky blue)
#8b5cf6 (purple)
background: white
```

---

## Sign-off

- [ ] Design review completed
- [ ] Development remediation planned
- [ ] QA verification scheduled

---

*Report generated as part of Skillsmith Phase 6 website consistency initiative.*
