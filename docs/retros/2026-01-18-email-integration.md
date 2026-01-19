# Retrospective: Email Integration & Brand Audit Completion

**Date**: January 18, 2026
**Sprint/Release**: Phase 6 - Website & Portal
**Participants**: Engineering Team
**Linear Issues**: SMI-1573, SMI-1574

---

## Summary

Completed full email infrastructure for Skillsmith using Resend, including contact form notifications and inbound email forwarding. Also completed brand audit remediation for the website. The work involved DNS configuration, Supabase Edge Functions, webhook integration, and troubleshooting Resend's inbound email payload format.

---

## What Went Well ✅

### 1. Resend Integration
- Resend Pro account provided both sending and receiving capabilities
- Domain verification was straightforward via Cloudflare
- Contact form emails working immediately after domain verification
- Clear API documentation for outbound email

### 2. Varlock Security
- All API keys (`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`) properly secured
- `.env.schema` annotations ensure secrets never exposed in Claude's context
- Supabase secrets configured via CLI without exposing values

### 3. Documentation First
- Created `docs/infrastructure/email-configuration.md` during implementation
- Captured DNS records, function flows, testing commands
- Updated documentation when payload format was corrected

### 4. Incremental Testing
- Tested contact form at each stage (function deployed → domain verified → email sent)
- Verified DNS propagation using multiple resolvers (Google DNS, Cloudflare DNS)
- Confirmed both outbound and inbound flows independently

### 5. Brand Audit Completion
- Contact page button fixed (solid coral vs ombre gradient)
- Enterprise email corrected to valid `support@smithhorn.ca`
- Website deployed successfully to production

---

## What Could Be Improved 🔧

### 1. Resend Inbound Webhook Payload Misunderstanding
**Problem**: Initial implementation tried to fetch email content via API using `email_id` from webhook, but Resend's `email.received` webhook includes full email content directly in the payload.

**Impact**: Inbound emails were received by Resend but not forwarded to support.

**Root Cause**: Assumed webhook payload structure based on outbound email patterns rather than checking inbound-specific documentation.

**Action Item**: Always verify webhook payload structure from provider documentation before implementing handlers.

```typescript
// WRONG - What we initially assumed
const emailId = payload.data.email_id
const email = await fetchEmailContent(emailId, apiKey) // Unnecessary!

// CORRECT - Email content is already in payload
const email = payload.data // Contains from, to, subject, text, html directly
```

### 2. MX Record Configuration Confusion
**Problem**: Multiple MX record changes during troubleshooting:
- Initially set to `inbound-smtp.resend.com`
- User had old registrar MX records conflicting
- Resend's Cloudflare auto-config set it to `inbound-smtp.us-east-1.amazonaws.com`

**Impact**: Delayed inbound email testing while DNS propagated and configuration settled.

**Action Item**: Use Resend's Cloudflare integration from the start to auto-configure DNS records correctly.

### 3. No Supabase Function Logs Access
**Problem**: Could not access Supabase Edge Function logs programmatically to debug webhook issues.

**Impact**: Had to rely on user checking dashboard or inferring issues from behavior.

**Action Item**: Investigate Supabase Management API for log access, or add structured logging that can be queried.

### 4. Local DNS Cache Stale
**Problem**: Local DNS queries showed old MX records while public DNS (Google, Cloudflare) showed correct records.

**Impact**: Confusion about whether DNS changes had propagated.

**Action Item**: Always verify DNS changes using public resolvers (`dig @8.8.8.8`), not local cache.

---

## Key Learnings 📚

### Resend Inbound Email Architecture
1. Resend uses Amazon SES infrastructure for both sending and receiving
2. MX record points to `inbound-smtp.us-east-1.amazonaws.com` (not `inbound-smtp.resend.com`)
3. Webhook payload for `email.received` includes full email content - no API fetch needed
4. Svix is used for webhook delivery with signature verification

### DNS for Email
1. Root MX (`@`) handles inbound receiving
2. Subdomain MX (`send`) handles outbound bounce/feedback from SES
3. SPF must include both `amazonses.com` and `resend.com`
4. DMARC via Cloudflare simplifies reporting

### Edge Function Patterns
1. Deploy with `--no-verify-jwt` for public webhook endpoints
2. Log payload structure when debugging webhook integrations
3. Return 200 even on processing errors to prevent webhook retries

---

## Metrics

| Metric | Value |
|--------|-------|
| Linear Issues Closed | 2 (SMI-1573, SMI-1574) |
| Edge Functions Created | 2 (contact-submit, email-inbound) |
| Database Migrations | 1 (contact_submissions table) |
| Commits | 6 |
| Time to First Working Email | ~30 minutes (after domain verification) |
| Time to Debug Inbound | ~45 minutes (payload format issue) |

---

## Action Items

| Action | Priority | Owner | Status |
|--------|----------|-------|--------|
| Add fresh install testing to CI | High | Engineering | Pending |
| Document Resend Cloudflare auto-config in onboarding | Medium | Engineering | Done |
| Investigate Supabase log API access | Low | Engineering | Pending |
| Add `is:inline` directive to Astro scripts (18 hints) | Low | Engineering | Pending |

---

## Files Changed

### New Files
- `supabase/functions/contact-submit/index.ts`
- `supabase/functions/email-inbound/index.ts`
- `supabase/migrations/010_contact_submissions.sql`
- `docs/infrastructure/email-configuration.md`

### Modified Files
- `packages/website/src/pages/contact.astro` (button gradient, email fix)
- `.env.schema` (RESEND_API_KEY, RESEND_WEBHOOK_SECRET)
- `.gitignore` (DNS exports, Cloudflare/Resend configs)

---

## Related Documentation

- [Email Configuration](../infrastructure/email-configuration.md)
- [Resend Inbound Emails](https://resend.com/docs/dashboard/receiving/introduction)
- [Supabase Edge Functions](https://supabase.com/dashboard/project/vrcnzpmndtroqxxoqkzy/functions)
