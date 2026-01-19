# Retrospective: Phase 6 Website Completion (Waves 3-6)

**Date**: January 18, 2026
**Sprint/Release**: Phase 6 - Website & Portal
**Participants**: Engineering Team
**Linear Issues**: SMI-1178, SMI-1168, SMI-1169, SMI-1177, SMI-1161, SMI-1162, SMI-1164, SMI-1163, SMI-1165, SMI-1167, SMI-1158, SMI-1160, SMI-1166

---

## Summary

Completed Waves 3-6 of the Phase 6 Website & Portal initiative, implementing the full backend infrastructure for user authentication, subscription management, and account features. The work included database schema design, Supabase Auth integration, Stripe webhook handlers, license key generation, and customer-facing account pages.

**Waves 1 & 2** (Brand Compliance, Dark Theme) were already complete before this session.

---

## What Went Well ✅

### 1. Wave-Based Execution with Code Reviews
- Each wave was implemented, committed, then code reviewed before proceeding
- Code review between waves caught issues early (4 separate fix commits)
- Pattern established: implement → commit → review → fix → proceed
- Total of 7 commits with clear separation of concerns

### 2. Shared Utilities Pattern
- Identified code duplication in Wave 4 (license key generation in both `stripe-webhook` and `generate-license`)
- Created `_shared/license.ts` module with reusable functions
- Functions: `generateLicenseKey()`, `hashLicenseKey()`, `getRateLimitForTier()`, `getMaxKeysForTier()`
- Eliminated ~60 lines of duplicated code

### 3. Security-First Approach
- XSS prevention via `escapeHtml()` helper in account pages
- License keys hashed with SHA-256 before database storage
- Only key prefix stored for identification (`sk_live_...`)
- Full key shown only once at generation time

### 4. Astro Script Patterns Established
- Solved `define:vars` + ES module import incompatibility in Wave 3
- Pattern: Use `data-*` attributes on hidden divs for passing server values to client scripts
- Or: Use `import.meta.env.PUBLIC_*` directly in module scripts

### 5. Comprehensive Database Schema
- Single migration (`011_users_subscriptions.sql`) with:
  - 6 tables: profiles, subscriptions, license_keys, teams, team_members, email_verifications
  - Row Level Security policies for all tables
  - Helper functions: `get_user_subscription()`, `validate_license_key()`
  - Auto profile creation trigger on auth.users insert

### 6. Component Reusability
- Created `ComparisonTable.astro` as reusable component with typed props
- Default features data with override capability
- Highlighted tier support for marketing emphasis

---

## What Could Be Improved 🔧

### 1. Astro Script Context Confusion
**Problem**: Initial Wave 3 implementation used `define:vars` with ES module imports, causing runtime errors.

**Root Cause**: `define:vars` creates an inline script (not a module), but `import` syntax requires module context.

**Fix Applied**:
```astro
<!-- WRONG - define:vars creates inline script -->
<script define:vars={{ apiBaseUrl }}>
  import { createClient } from '@supabase/supabase-js' // Error!
</script>

<!-- CORRECT - Use data attributes or import.meta.env -->
<div id="config" data-api-base-url={apiBaseUrl} style="display:none"></div>
<script>
  const apiBaseUrl = document.getElementById('config')?.dataset.apiBaseUrl
</script>

<!-- BETTER - For public env vars, use import.meta.env directly -->
<script>
  const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL
</script>
```

**Action Item**: Document Astro script patterns in engineering standards.

### 2. Stripe Integration Deferred to Placeholders
**Problem**: Several features show "Contact support" or "Coming soon" rather than full Stripe integration:
- Seat management uses alert() instead of Stripe Subscription Item API
- Cancel subscription redirects to support email
- Payment method management defers to Stripe portal

**Impact**: Users cannot self-serve all subscription changes.

**Root Cause**: Stripe Billing Portal and Subscription Item APIs require additional backend work.

**Action Item**: Create follow-up issues for full Stripe self-service:
- SMI-TBD: Implement Stripe Billing Portal integration
- SMI-TBD: Implement seat quantity updates via API
- SMI-TBD: Add Stripe Customer Portal link to billing page

### 3. Email Delivery Not Implemented
**Problem**: License keys generated via webhook are logged but not emailed to users.

**Impact**: Users who complete checkout won't receive their license key automatically.

**Workaround**: Keys can be generated manually from account dashboard.

**Action Item**: Integrate with Resend for welcome email with license key (see existing email infrastructure).

### 4. Invoice Download Placeholder
**Problem**: Billing history page shows "Download" button but it doesn't function.

**Root Cause**: Need Stripe Invoice API to fetch PDF URLs.

**Action Item**: Implement `invoices.retrieve()` with PDF URL from Stripe API.

### 5. Pending Checkouts Table
**Problem**: Created `pending_checkouts` handling for checkout-before-signup flow, but table may not exist in all environments.

**Code Pattern**:
```typescript
const { error: pendingError } = await supabase.from('pending_checkouts').insert({...})
if (pendingError && !pendingError.message.includes('does not exist')) {
  console.error('Failed to store pending checkout:', pendingError)
}
```

**Action Item**: Add `pending_checkouts` table to migration or remove conditional handling.

---

## Key Learnings 📚

### Astro Module vs Inline Scripts
1. `<script>` in Astro = module script (can use `import`, `export`)
2. `<script is:inline>` or `<script define:vars>` = inline script (no imports)
3. `import.meta.env.PUBLIC_*` works in both client and server contexts
4. For complex data, use JSON in data attributes

### Supabase Auth Patterns
1. `createClient()` from anon key for client-side auth checks
2. `createSupabaseAdminClient()` with service role for webhook handlers
3. PKCE flow for email verification with `exchangeCodeForSession()`
4. Session tokens passed via Authorization header to Edge Functions

### License Key Security
1. Generate 32 random bytes → base64url encoding → prepend prefix
2. Store SHA-256 hash only, never the raw key
3. Show full key exactly once at generation
4. Use key prefix for display/identification

### Stripe Webhook Event Handling
1. Always verify signature before processing
2. Return 200 even on internal errors (prevent retry storms)
3. Use idempotency by checking existing records
4. Handle checkout-before-signup gracefully

---

## Metrics

| Metric | Value |
|--------|-------|
| Linear Issues Closed | 13 |
| Commits | 7 (4 feature + 3 fix) |
| New Pages Created | 7 |
| New Components Created | 1 |
| Edge Functions Created | 2 |
| Database Migrations | 1 |
| Tables Created | 6 |
| Shared Utility Modules | 1 |
| Code Review Issues Found | 6 |
| Code Review Issues Fixed | 6 |

---

## Action Items

| Action | Priority | Owner | Status |
|--------|----------|-------|--------|
| Document Astro script patterns | Medium | Engineering | Pending |
| Implement Stripe Billing Portal | High | Engineering | Pending |
| Email license keys via Resend | High | Engineering | Pending |
| Add invoice PDF download | Medium | Engineering | Pending |
| Add `pending_checkouts` migration | Low | Engineering | Pending |
| Test full checkout → license flow E2E | High | QA | Pending |

---

## Files Changed

### Database
- `supabase/migrations/011_users_subscriptions.sql` (6 tables, RLS, functions, triggers)

### Edge Functions
- `supabase/functions/stripe-webhook/index.ts`
- `supabase/functions/generate-license/index.ts`
- `supabase/functions/_shared/license.ts`

### Website Pages
- `packages/website/src/pages/login.astro` (updated)
- `packages/website/src/pages/signup.astro` (updated)
- `packages/website/src/pages/auth/callback.astro`
- `packages/website/src/pages/auth/forgot-password.astro`
- `packages/website/src/pages/auth/reset-password.astro`
- `packages/website/src/pages/account/index.astro`
- `packages/website/src/pages/account/subscription.astro`
- `packages/website/src/pages/account/billing.astro`
- `packages/website/src/pages/faq.astro`

### Components
- `packages/website/src/components/ComparisonTable.astro`

### Types/Utilities
- `packages/website/src/lib/auth.ts`
- `packages/website/src/types/auth.ts`

---

## Commit History

```
2d27e17 feat(content): implement Wave 6 content and polish (SMI-1158, SMI-1160, SMI-1166)
47634bc fix(account): resolve code review issues in Wave 5 account pages
b96145e feat(account): implement Wave 5 account management pages (SMI-1163, SMI-1165, SMI-1167)
2f59fd7 fix(stripe): resolve code review issues in Wave 4 functions
2772de9 feat(stripe): implement Wave 4 Stripe integration (SMI-1177, SMI-1161, SMI-1162, SMI-1164)
3171250 fix(auth): resolve code review issues in Wave 3 auth pages
7262b5b feat(auth): implement Wave 3 database & auth foundation (SMI-1178, SMI-1168, SMI-1169)
```

---

## Related Documentation

- [Phase 6 Plan](../../.claude/plans/phase6-website-completion.md)
- [Email Configuration](../infrastructure/email-configuration.md)
- [ADR-013: Open Core Licensing](../adr/013-open-core-licensing.md)
- [ADR-017: Quota Enforcement](../adr/017-quota-enforcement-system.md)
