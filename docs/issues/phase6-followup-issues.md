# Phase 6 Follow-up Issues

Generated from Phase 6 Website Completion retrospective action items.

---

## SMI-XXXX: Send welcome email with license key after checkout

**Priority**: High (P1)
**Labels**: `backend`, `email`, `stripe`, `license`
**Initiative**: Skillsmith
**Project**: Phase 6 - Website & Portal

### Description

When a user completes Stripe checkout, a license key is generated but only logged to console. Users need to receive their license key via email to use the service.

### Problem

Currently in `stripe-webhook/index.ts`:
```typescript
// TODO: Send welcome email with license key using an email service
// The license key should be included in this email since it's only shown once
// For now, we log it (in production, integrate with email service)
console.log('LICENSE KEY GENERATED (send via email):', {
  email: customerEmail,
  keyPrefix,
})
```

Users who complete checkout have no way to receive their license key unless they log in and generate a new one from the dashboard.

### Acceptance Criteria

- [ ] After successful checkout, send welcome email via Resend
- [ ] Email includes the full license key (shown only once)
- [ ] Email includes tier information and feature summary
- [ ] Email includes link to account dashboard
- [ ] Email includes quick start documentation link
- [ ] Use existing `RESEND_API_KEY` from Supabase secrets
- [ ] Handle email send failures gracefully (log, don't fail webhook)

### Technical Notes

- Resend infrastructure already configured (see `contact-submit` function)
- Use `resend.emails.send()` with branded HTML template
- Consider creating `_shared/email.ts` for reusable email utilities
- Key is only in memory at webhook time - must send before function returns

### Files to Modify

- `supabase/functions/stripe-webhook/index.ts`
- Create: `supabase/functions/_shared/email.ts` (optional)

### Related

- SMI-1573 (Email infrastructure)
- SMI-1164 (License key delivery)

---

## SMI-XXXX: Implement Stripe Billing Portal for self-service subscription management

**Priority**: High (P1)
**Labels**: `backend`, `frontend`, `stripe`, `subscription`
**Initiative**: Skillsmith
**Project**: Phase 6 - Website & Portal

### Description

Enable users to manage their subscription (update payment method, cancel, view invoices) via Stripe's hosted Billing Portal instead of placeholder alerts.

### Problem

Current implementations show placeholder messages:
- `subscription.astro`: "Seat management coming soon. Contact support for seat changes."
- `subscription.astro`: "To cancel your subscription, please contact support@skillsmith.app"
- `billing.astro`: "Payment management is handled via Stripe. Contact support for payment changes."

### Acceptance Criteria

- [ ] Create Edge Function to generate Stripe Billing Portal session
- [ ] Redirect user to Stripe portal for:
  - [ ] Payment method updates
  - [ ] Subscription cancellation
  - [ ] Invoice history viewing
- [ ] Configure portal return URL to `/account/subscription`
- [ ] Handle portal session creation errors
- [ ] Update UI buttons to call portal function

### Technical Implementation

```typescript
// supabase/functions/create-portal-session/index.ts
const session = await stripe.billingPortal.sessions.create({
  customer: stripeCustomerId,
  return_url: `${origin}/account/subscription`,
})
return jsonResponse({ url: session.url })
```

### Stripe Portal Configuration

Configure in Stripe Dashboard → Settings → Billing → Customer portal:
- Allow payment method updates: Yes
- Allow subscription cancellation: Yes
- Allow subscription pausing: No
- Show invoice history: Yes

### Files to Create/Modify

- Create: `supabase/functions/create-portal-session/index.ts`
- Modify: `packages/website/src/pages/account/subscription.astro`
- Modify: `packages/website/src/pages/account/billing.astro`

### Related

- SMI-1165 (Subscription upgrade/downgrade)
- SMI-1166 (Billing history)

---

## SMI-XXXX: Implement seat quantity updates via Stripe API

**Priority**: High (P2)
**Labels**: `backend`, `frontend`, `stripe`, `teams`
**Initiative**: Skillsmith
**Project**: Phase 6 - Website & Portal

### Description

Allow team/enterprise admins to adjust seat count from the subscription page, with real-time billing updates.

### Problem

Current seat management UI exists but shows alert:
```typescript
updateSeatsBtn.addEventListener('click', async () => {
  // TODO: Implement seat update via Stripe
  alert('Seat management coming soon. Contact support for seat changes.')
})
```

### Acceptance Criteria

- [ ] Create Edge Function to update subscription quantity
- [ ] Call Stripe `subscriptions.update()` with new quantity
- [ ] Calculate prorated amount and show preview before confirming
- [ ] Update local `subscriptions` table after Stripe confirmation
- [ ] Show success/error feedback in UI
- [ ] Minimum seats: 1, Maximum: 1000 (configurable)

### Technical Implementation

```typescript
// supabase/functions/update-seat-count/index.ts
const subscription = await stripe.subscriptions.retrieve(subscriptionId)
const itemId = subscription.items.data[0].id

// Preview proration
const preview = await stripe.invoices.retrieveUpcoming({
  customer: customerId,
  subscription: subscriptionId,
  subscription_items: [{ id: itemId, quantity: newQuantity }],
})

// If confirmed, apply change
await stripe.subscriptions.update(subscriptionId, {
  items: [{ id: itemId, quantity: newQuantity }],
  proration_behavior: 'create_prorations',
})
```

### Files to Create/Modify

- Create: `supabase/functions/update-seat-count/index.ts`
- Modify: `packages/website/src/pages/account/subscription.astro`

### Related

- SMI-1167 (Seat management for teams)

---

## SMI-XXXX: Add invoice PDF download to billing history

**Priority**: Medium (P2)
**Labels**: `backend`, `frontend`, `stripe`, `billing`
**Initiative**: Skillsmith
**Project**: Phase 6 - Website & Portal

### Description

Enable users to download PDF invoices from their billing history page.

### Problem

Billing page shows "Download" button but it doesn't function:
```html
<button class="btn btn-ghost btn-sm">Download</button>
```

### Acceptance Criteria

- [ ] Fetch invoice list from Stripe API (not just audit_logs)
- [ ] Display invoice number, date, amount, status
- [ ] Provide direct link to Stripe-hosted invoice PDF
- [ ] Handle cases where invoice PDF is not yet available
- [ ] Show "Generating..." state for recent invoices

### Technical Implementation

```typescript
// In billing.astro script or via Edge Function
const invoices = await stripe.invoices.list({
  customer: stripeCustomerId,
  limit: 12,
})

invoices.data.map(inv => ({
  id: inv.id,
  number: inv.number,
  date: inv.created,
  amount: inv.amount_paid,
  status: inv.status,
  pdfUrl: inv.invoice_pdf, // Direct Stripe-hosted PDF
  hostedUrl: inv.hosted_invoice_url,
}))
```

### Files to Create/Modify

- Create: `supabase/functions/list-invoices/index.ts`
- Modify: `packages/website/src/pages/account/billing.astro`

### Related

- SMI-1166 (Billing history)

---

## SMI-XXXX: Add pending_checkouts table migration

**Priority**: Low (P3)
**Labels**: `backend`, `database`, `stripe`
**Initiative**: Skillsmith
**Project**: Phase 6 - Website & Portal

### Description

Create the `pending_checkouts` table that the stripe-webhook function expects for handling checkout-before-signup flow.

### Problem

Current code handles missing table with conditional error checking:
```typescript
const { error: pendingError } = await supabase.from('pending_checkouts').insert({...})
if (pendingError && !pendingError.message.includes('does not exist')) {
  console.error('Failed to store pending checkout:', pendingError)
}
```

This is a code smell - the table should exist.

### Acceptance Criteria

- [ ] Create migration `012_pending_checkouts.sql`
- [ ] Table stores checkout data for users who don't exist yet
- [ ] Include TTL/expiration mechanism (7 days)
- [ ] Add cleanup function for expired entries
- [ ] Update webhook to remove conditional error handling
- [ ] Add trigger to process pending checkout on user signup

### Schema Design

```sql
CREATE TABLE pending_checkouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'individual',
  billing_period TEXT NOT NULL DEFAULT 'monthly',
  seat_count INTEGER NOT NULL DEFAULT 1,
  checkout_session_id TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days'
);

CREATE INDEX idx_pending_checkouts_email ON pending_checkouts(email);
CREATE INDEX idx_pending_checkouts_expires ON pending_checkouts(expires_at);
```

### Files to Create/Modify

- Create: `supabase/migrations/012_pending_checkouts.sql`
- Modify: `supabase/functions/stripe-webhook/index.ts`

### Related

- SMI-1177 (Stripe webhook handlers)

---

## SMI-XXXX: Document Astro script patterns in engineering standards

**Priority**: Medium (P2)
**Labels**: `documentation`, `frontend`, `standards`
**Initiative**: Skillsmith
**Project**: Phase 6 - Website & Portal

### Description

Document the correct patterns for using client-side scripts in Astro components to prevent the `define:vars` + ES modules issue encountered in Wave 3.

### Problem

Initial Wave 3 implementation used incompatible patterns:
```astro
<!-- WRONG - causes runtime error -->
<script define:vars={{ apiBaseUrl }}>
  import { createClient } from '@supabase/supabase-js'
</script>
```

This was caught in code review but should be documented to prevent recurrence.

### Acceptance Criteria

- [ ] Add "Astro Script Patterns" section to `docs/architecture/standards.md`
- [ ] Document module vs inline script differences
- [ ] Provide examples of correct patterns for:
  - [ ] Passing server data to client scripts
  - [ ] Using environment variables
  - [ ] Importing npm packages in client code
- [ ] Add code snippets showing correct/incorrect approaches
- [ ] Reference in CLAUDE.md for AI assistant awareness

### Content Outline

```markdown
## Astro Script Patterns

### Module Scripts (Default)
- Use `<script>` for ES module scripts
- Can use `import`/`export` syntax
- Can access `import.meta.env.PUBLIC_*`

### Inline Scripts
- Use `<script is:inline>` for non-module scripts
- Use `<script define:vars={{ }}>` to pass server values
- Cannot use `import` statements

### Passing Server Data to Client
1. **For public env vars**: Use `import.meta.env.PUBLIC_*` directly
2. **For other data**: Use data attributes on hidden elements
```

### Files to Modify

- `docs/architecture/standards.md`
- `CLAUDE.md` (add reference)

### Related

- SMI-1168 (User registration - where issue was found)

---

## SMI-XXXX: E2E test for checkout → license key flow

**Priority**: High (P1)
**Labels**: `testing`, `e2e`, `stripe`, `license`
**Initiative**: Skillsmith
**Project**: Phase 6 - Website & Portal

### Description

Create end-to-end test validating the complete flow from Stripe checkout to license key availability.

### Problem

The checkout → subscription → license key flow involves multiple components:
1. Stripe Checkout session creation
2. Payment processing
3. Webhook delivery
4. Subscription record creation
5. License key generation
6. Profile tier update

No automated test validates this entire flow.

### Acceptance Criteria

- [ ] Test with Stripe test mode and test cards
- [ ] Verify subscription record created in database
- [ ] Verify license key record created
- [ ] Verify user profile tier updated
- [ ] Verify license key can authenticate API requests
- [ ] Test webhook retry handling
- [ ] Test checkout-before-signup flow (pending_checkouts)

### Test Scenarios

1. **Happy path**: New user → checkout → verify all records created
2. **Existing user**: Logged in user → checkout → verify upgrade
3. **Webhook retry**: Simulate failed webhook → verify idempotency
4. **Invalid signature**: Send webhook without valid signature → verify rejection

### Technical Notes

- Use Stripe CLI for local webhook testing: `stripe listen --forward-to localhost:54321/functions/v1/stripe-webhook`
- Use Stripe test card: `4242424242424242`
- May need Playwright for full browser flow or API-only tests

### Files to Create

- `tests/e2e/checkout-flow.spec.ts`
- `tests/e2e/webhook-handling.spec.ts`

### Related

- SMI-1177 (Stripe webhook handlers)
- SMI-1164 (License key delivery)

---

## Summary

| Issue | Title | Priority | Labels |
|-------|-------|----------|--------|
| SMI-XXXX | Send welcome email with license key | P1 | backend, email, stripe, license |
| SMI-XXXX | Implement Stripe Billing Portal | P1 | backend, frontend, stripe, subscription |
| SMI-XXXX | Implement seat quantity updates | P2 | backend, frontend, stripe, teams |
| SMI-XXXX | Add invoice PDF download | P2 | backend, frontend, stripe, billing |
| SMI-XXXX | Add pending_checkouts migration | P3 | backend, database, stripe |
| SMI-XXXX | Document Astro script patterns | P2 | documentation, frontend, standards |
| SMI-XXXX | E2E test checkout → license flow | P1 | testing, e2e, stripe, license |

**Total**: 7 issues
**High Priority (P1)**: 3
**Medium Priority (P2)**: 3
**Low Priority (P3)**: 1
