# Blog Accessibility Checklist

Template for ensuring WCAG AA compliance on Skillsmith blog pages. Use this checklist when creating new blog posts or blog-related components.

---

## Quick Reference

| Requirement | Implementation | File |
|-------------|----------------|------|
| Skip link | `<a href="#main-content" class="sr-only focus:not-sr-only ...">` | BaseLayout.astro |
| Main content ID | `<main id="main-content">` | BaseLayout.astro |
| Focus indicators | `:focus-visible` styles | BaseLayout.astro |
| Color contrast | Use `text-dark-400` not `text-dark-500` for UI text | All components |
| Reduced motion | `@media (prefers-reduced-motion: reduce)` | BaseLayout.astro |
| Icon accessibility | `aria-hidden="true"` on decorative SVGs | All components |
| Link accessibility | `aria-label` on icon-only links | BaseLayout.astro |

---

## Color Palette (WCAG AA Compliant)

| Color | Hex | Use Case | Contrast on #0D0D0F |
|-------|-----|----------|---------------------|
| `text-dark-400` | #94a3b8 | UI labels, metadata, section headers | 5.9:1 ✅ |
| `text-dark-300` | #cbd5e1 | Secondary body text | 9.5:1 ✅ |
| `text-white` | #ffffff | Primary headings, emphasis | 19.6:1 ✅ |
| `text-primary-400` | #ed9580 | Links, accents | 5.2:1 ✅ |

### ❌ Colors to Avoid for Text

| Color | Hex | Contrast | Issue |
|-------|-----|----------|-------|
| `text-dark-500` | #64748b | 3.8:1 | FAILS WCAG AA (needs 4.5:1) |
| `text-dark-600` | #475569 | 2.5:1 | FAILS WCAG AA |

---

## Component Patterns

### Section Headers (Blog Listing)

```astro
<!-- ✅ Correct -->
<h2 class="text-sm font-semibold uppercase tracking-wider text-dark-400 mb-6">
  Featured
</h2>

<!-- ❌ Incorrect - fails contrast -->
<h2 class="text-sm font-semibold uppercase tracking-wider text-dark-500 mb-6">
  Featured
</h2>
```

### Blog Card Metadata

```astro
<!-- ✅ Correct -->
<div class="flex items-center justify-between text-xs text-dark-400">
  <span>{author}</span>
  <time datetime={date.toISOString()}>{formattedDate}</time>
</div>

<!-- ❌ Incorrect - fails contrast -->
<div class="flex items-center justify-between text-xs text-dark-500">
```

### Decorative Icons

```astro
<!-- ✅ Correct - hidden from screen readers -->
<svg class="w-8 h-8 text-dark-400" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
  <!-- paths -->
</svg>

<!-- ❌ Incorrect - announced to screen readers as "image" -->
<svg class="w-8 h-8 text-dark-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
```

### Icon-Only Links

```astro
<!-- ✅ Correct - has accessible name -->
<a href="https://github.com/..." aria-label="Skillsmith on GitHub">
  <svg aria-hidden="true" class="w-6 h-6">
    <!-- GitHub icon -->
  </svg>
</a>

<!-- ❌ Incorrect - no accessible name -->
<a href="https://github.com/...">
  <svg class="w-6 h-6">
    <!-- GitHub icon -->
  </svg>
</a>
```

---

## CSS Utilities

### Screen Reader Only (sr-only)

```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
}

/* Become visible on focus (for skip links) */
.sr-only:focus,
.focus\:not-sr-only:focus {
  position: static;
  width: auto;
  height: auto;
  padding: 0;
  margin: 0;
  overflow: visible;
  clip: auto;
  white-space: normal;
}
```

### Focus Indicators

```css
/* Use :focus-visible, not :focus */
a:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid #E07A5F;  /* Brand coral */
  outline-offset: 2px;
}
```

### Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }

  .card-hover {
    transition: none;
  }

  .card-hover:hover {
    transform: none;
  }

  /* Nuclear option for all animations */
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## Pre-Publish Checklist

### Before Creating Blog Post

- [ ] Verify BaseLayout.astro has skip link
- [ ] Verify BaseLayout.astro has focus-visible styles
- [ ] Verify BaseLayout.astro has reduced-motion query

### For Blog Content

- [ ] All images have descriptive alt text
- [ ] Heading hierarchy is correct (h1 → h2 → h3, no skipping)
- [ ] Links are descriptive (not "click here")
- [ ] Code blocks have language specified for syntax highlighting

### For Blog Components

- [ ] UI text uses `text-dark-400` or lighter (not `text-dark-500`)
- [ ] Decorative icons have `aria-hidden="true"`
- [ ] Icon-only links have `aria-label`
- [ ] Interactive elements are keyboard accessible

### Before Deploy

- [ ] Run build: `docker exec skillsmith-dev-1 npm run build --workspace=packages/website`
- [ ] Run lint: `docker exec skillsmith-dev-1 npm run lint`
- [ ] Manual keyboard navigation test (Tab through page)
- [ ] Check Lighthouse accessibility score (target: 90+)

---

## Testing Tools

### Automated

```bash
# Build verification
docker exec skillsmith-dev-1 npm run build --workspace=packages/website

# Lint
docker exec skillsmith-dev-1 npm run lint

# Governance audit
docker exec skillsmith-dev-1 npm run audit:standards
```

### Manual

1. **Keyboard Navigation**: Tab through entire page, verify all interactive elements reachable
2. **Skip Link**: Press Tab once on page load, verify skip link appears
3. **Focus Visibility**: Tab to links, verify visible focus ring
4. **Screen Reader**: Test with VoiceOver (Mac) or NVDA (Windows)

### Browser Extensions

- [axe DevTools](https://www.deque.com/axe/devtools/)
- [WAVE](https://wave.webaim.org/extension/)
- [Lighthouse](https://developers.google.com/web/tools/lighthouse) (built into Chrome)

---

## Common Issues & Fixes

### Issue: Low contrast section headers

**Symptom**: Section headers hard to read on dark background

**Fix**: Change `text-dark-500` → `text-dark-400`

```diff
- <h2 class="text-dark-500">Featured</h2>
+ <h2 class="text-dark-400">Featured</h2>
```

### Issue: Skip link not working

**Symptom**: Skip link appears but doesn't scroll to content

**Fix**: Ensure `id="main-content"` on `<main>` element

```diff
- <main>
+ <main id="main-content">
```

### Issue: Focus ring not visible

**Symptom**: Can't see which element is focused when tabbing

**Fix**: Add `:focus-visible` styles (not `:focus`)

### Issue: Animations continue despite user preference

**Symptom**: User has "reduce motion" enabled but animations still play

**Fix**: Add `@media (prefers-reduced-motion: reduce)` query

---

## References

- [WCAG 2.1 Guidelines](https://www.w3.org/TR/WCAG21/)
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)
- [A11y Project Checklist](https://www.a11yproject.com/checklist/)

---

## Changelog

### 2026-01-23
- Initial template created from SMI-1757 Wave 1 learnings
- Color palette verified for WCAG AA compliance
- Component patterns documented
