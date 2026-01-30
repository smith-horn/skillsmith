# Stripe Troubleshooting & Edge Cases

This guide covers common issues, Deno-specific patterns, and known limitations with Stripe integration.

> **Related**: [Stripe CLI Testing](stripe-testing.md) | [Billing Portal](stripe-billing-portal.md)

---

## Common Issues

### Webhook Not Received

1. **Check `stripe listen` is running** - Ensure the CLI is actively forwarding
2. **Verify endpoint URL** - Confirm the forward URL is correct
3. **Check for errors** - The CLI displays HTTP responses

### Signature Verification Failed

- Ensure `STRIPE_WEBHOOK_SECRET` matches the secret from `stripe listen`
- For production, use the webhook secret from the Stripe Dashboard

### 400 Bad Request

- Check the event payload is valid JSON
- Verify the `stripe-signature` header is present
- Ensure timestamp is within tolerance (default: 300 seconds)

### Edge Function Not Invoked

```bash
# Check Supabase function logs
supabase functions logs stripe-webhook
```

### Rate Limiting

Stripe CLI respects rate limits. If testing rapidly, add delays between triggers:

```bash
stripe trigger checkout.session.completed && sleep 2 && stripe trigger customer.subscription.updated
```

---

## Deno/Edge Function Patterns

When running Stripe webhooks in Supabase Edge Functions (Deno runtime), use these patterns:

### Signature Verification

**Use `constructEventAsync`, NOT `constructEvent`:**

```typescript
// ❌ WRONG - Uses Node.js crypto (not available in Deno)
event = stripe.webhooks.constructEvent(body, signature, secret)

// ✅ CORRECT - Uses Web Crypto API (works in Deno)
event = await stripe.webhooks.constructEventAsync(body, signature, secret)
```

The synchronous `constructEvent` relies on Node.js `crypto` module which isn't available in Deno. The async version uses the Web Crypto API.

### Deployment Flags

Stripe webhooks require anonymous access:

```bash
# ✅ CORRECT - Allow Stripe to call without authentication
npx supabase functions deploy stripe-webhook --no-verify-jwt

# ❌ WRONG - Stripe will get 401 Unauthorized
npx supabase functions deploy stripe-webhook
```

### Error Handling

See [Edge Function Patterns](edge-function-patterns.md) for Supabase query error handling.

---

## Production Webhook Deployment Checklist

When deploying or migrating webhook handlers:

- [ ] **Deploy with `--no-verify-jwt`** - Webhooks need anonymous access
- [ ] **Update webhook URL in Stripe Dashboard** - Developers → Webhooks → Edit endpoint
- [ ] **Copy new signing secret** - Revealed after saving endpoint changes
- [ ] **Set secret in Supabase** - `npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx`
- [ ] **Test with resend** - Use Stripe Dashboard to resend a recent event
- [ ] **Verify 200 response** - Check webhook attempt shows "Delivered"
- [ ] **Update CLAUDE.md** - Document the endpoint in Edge Functions table

### Webhook URL Format

```
https://<project-ref>.supabase.co/functions/v1/stripe-webhook
```

### Required Secrets

| Secret | Purpose |
|--------|---------|
| `STRIPE_SECRET_KEY` | API authentication |
| `STRIPE_WEBHOOK_SECRET` | Signature verification (starts with `whsec_`) |

---

## Multi-Product Stripe Account Filtering (SMI-2069)

If your Stripe account is used by multiple products (e.g., Skillsmith + Substack), the webhook will receive events from ALL products. The webhook filters events by:

| Event Type | Filter Method |
|------------|---------------|
| `checkout.session.completed` | `metadata.source === 'skillsmith-website'` |
| `customer.subscription.*` | Subscription exists in `subscriptions` table |
| `invoice.*` | Associated subscription exists in `subscriptions` table |

Non-Skillsmith events are logged and acknowledged with 200 OK (so Stripe doesn't retry).

---

## Webhook Idempotency (SMI-2068)

Stripe retries webhook events when endpoints return non-2xx responses or time out. The webhook handler MUST be idempotent to handle these retries gracefully.

### Implementation Pattern

```typescript
// ✅ CORRECT - Check before insert
const { data: existing } = await supabase
  .from('subscriptions')
  .select('id')
  .eq('stripe_subscription_id', subscriptionId)
  .single()

if (existing) {
  console.log('Subscription already exists (duplicate event), skipping')
} else {
  await supabase.from('subscriptions').insert({ ... })
}

// ❌ WRONG - Insert without checking (fails on UNIQUE constraint)
await supabase.from('subscriptions').insert({ ... })
```

### Why This Matters

When Stripe retries events, a non-idempotent handler will:
1. Attempt to INSERT duplicate records
2. Fail on UNIQUE constraints (`stripe_subscription_id`, `key_hash`)
3. Return 500 error
4. Trigger MORE retries from Stripe
5. Cascade into 50+ failed webhook attempts

### Current Idempotency Checks

| Check | Table | Column(s) |
|-------|-------|-----------|
| Subscription exists | `subscriptions` | `stripe_subscription_id` |
| License key exists | `license_keys` | `user_id` + `tier` + `status='active'` |
| Pending checkout | `pending_checkouts` | `email` (uses upsert) |

### Monitoring Retries

Check Stripe Dashboard → Developers → Webhooks → select endpoint → view attempts:
- `wasIdempotent: true` in logs = duplicate event handled gracefully
- HTTP 200 for all retries = idempotency working correctly

---

## Known Issues

### Test Mode Webhook Signature Verification (SMI-1845)

**Status:** Under Investigation

Stripe webhook signature verification fails consistently in **test mode** when using Supabase Edge Functions (Deno runtime). The webhook endpoint is reachable but `stripe.webhooks.constructEventAsync()` never successfully verifies the signature.

**Symptoms:**
- Stripe events show `pending_webhooks: 1` indefinitely
- No webhook processing occurs
- Direct POST to endpoint returns correct errors (400 for missing signature)
- **Live mode webhooks work correctly**

**Workarounds:**

1. **Use Stripe CLI for local development** (recommended):
   ```bash
   stripe listen --forward-to http://localhost:54321/functions/v1/stripe-webhook
   ```

2. **Use live mode for production testing** - Live mode webhooks process correctly

3. **Manual verification** - Create subscriptions manually in database for E2E testing

**Investigation Notes:**
- Multiple fresh webhook endpoints tested with new secrets
- Secrets verified to match between Stripe and Supabase
- Function redeployed multiple times
- Endpoint confirmed reachable
- Potentially a Deno/Edge runtime incompatibility with Stripe's crypto signature verification

**Tracking:** [SMI-1845](https://linear.app/smith-horn-group/issue/SMI-1845)

---

## Test Mode vs Live Mode Configuration

| Setting | Test Mode | Live Mode |
|---------|-----------|-----------|
| API Key prefix | `sk_test_` | `sk_live_` |
| Webhook secret prefix | `whsec_` | `whsec_` |
| Price IDs | Different | Different |
| Webhook delivery | ⚠️ Signature fails | ✅ Works |

**Important:** Test and live mode use completely separate:
- API keys
- Webhook endpoints and secrets
- Products and prices
- Customer data

When switching modes, update ALL of these in Supabase secrets:
```bash
npx supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_xxx \
  STRIPE_WEBHOOK_SECRET=whsec_xxx \
  STRIPE_PRICE_INDIVIDUAL_MONTHLY=price_xxx \
  STRIPE_PRICE_INDIVIDUAL_ANNUAL=price_xxx \
  STRIPE_PRICE_TEAM_MONTHLY=price_xxx \
  STRIPE_PRICE_TEAM_ANNUAL=price_xxx \
  STRIPE_PRICE_ENTERPRISE_MONTHLY=price_xxx \
  STRIPE_PRICE_ENTERPRISE_ANNUAL=price_xxx \
  --project-ref <your-project-ref>
```

---

## Related Documentation

- [Stripe CLI Testing](stripe-testing.md) - Core testing guide
- [Billing Portal Testing](stripe-billing-portal.md) - Portal session testing
- [Edge Function Patterns](edge-function-patterns.md) - Supabase patterns
- [Stripe Webhooks Guide](https://stripe.com/docs/webhooks)
