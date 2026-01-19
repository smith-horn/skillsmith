# Skills Search Page Fix Retrospective

**Date**: January 19, 2026
**Issue**: SMI-1587
**Duration**: ~30 minutes

## Summary

Fixed the skills search page that was stuck on "Loading skills..." indefinitely.

## Root Cause Analysis

Two issues combined to break the page:

| Issue | Impact | Fix |
|-------|--------|-----|
| Supabase Edge Function not deployed | API available but returning stale data | `supabase functions deploy skills-search` |
| `import.meta.env?.DEV` in inline script | JavaScript error prevented execution | Removed conditional check |

### The Hidden Bug

The inline `<script>` in Astro uses `define:vars` which creates a regular script, not an ES module. Using `import.meta` outside a module causes:

```
Cannot use 'import.meta' outside a module
```

This silently killed all JavaScript execution, leaving the page in its initial "Loading..." state.

## Timeline

1. **Initial diagnosis**: API appeared working (200 status) but page stuck
2. **Browser testing**: Used dev-browser skill to capture JavaScript errors
3. **Error found**: `Cannot use 'import.meta' outside a module`
4. **Fix applied**: Removed `import.meta.env?.DEV` conditional
5. **Deployment**: Manual `vercel --prod` deployment
6. **Verification**: Page loads 100 skills successfully

## Files Changed

| File | Change |
|------|--------|
| `packages/website/src/pages/skills/index.astro` | Removed `import.meta.env?.DEV` check |

## Lessons Learned

### 1. Astro Inline Scripts Are Not ES Modules

When using `define:vars` in Astro:

```astro
<!-- This creates a regular <script>, NOT type="module" -->
<script define:vars={{ apiBase: 'url' }}>
  // import.meta is NOT available here!
</script>
```

**Fix**: Don't use `import.meta` in inline scripts. Use passed variables or hardcoded values.

### 2. Silent JavaScript Failures

The page looked functional (HTML rendered) but JavaScript never executed. No visible error to users.

**Mitigation**: Add `<noscript>` fallback or server-side rendering for critical content.

### 3. Deployment Verification

Just because code is pushed doesn't mean it's deployed:
- Supabase Edge Functions require explicit `supabase functions deploy`
- Vercel may cache aggressively; manual deploy with `vercel --prod` forces refresh

## Prevention Checklist

- [ ] Never use `import.meta` in Astro inline scripts
- [ ] Deploy Edge Functions after code changes: `supabase functions deploy <name>`
- [ ] Test in incognito to avoid cache issues
- [ ] Use browser dev tools to check for JavaScript errors

## References

- [Astro Script Bundling](https://docs.astro.build/en/guides/client-side-scripts/)
- Commit: `cfdb77d`
