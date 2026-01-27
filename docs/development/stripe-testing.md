# Stripe CLI Integration Testing

This guide covers testing Stripe webhook integration using the Stripe CLI.

## Prerequisites

### Install Stripe CLI

**macOS (Homebrew):**
```bash
brew install stripe/stripe-cli/stripe
```

**Windows (Scoop):**
```bash
scoop install stripe
```

**Linux (apt):**
```bash
curl -s https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public | gpg --dearmor | sudo tee /usr/share/keyrings/stripe.gpg
echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" | sudo tee /etc/apt/sources.list.d/stripe.list
sudo apt update && sudo apt install stripe
```

### Authenticate

```bash
stripe login
```

This opens a browser window to authenticate with your Stripe account.

---

## Webhook Forwarding

### Local Development

Forward webhooks to your local Supabase edge function:

```bash
stripe listen --forward-to http://localhost:54321/functions/v1/stripe-webhook
```

### Forwarding to Deployed Function

```bash
stripe listen --forward-to https://your-project.supabase.co/functions/v1/stripe-webhook
```

### Webhook Signing Secret

When `stripe listen` starts, it displays a webhook signing secret:

```
Ready! Your webhook signing secret is whsec_xxxxx...
```

Set this in your environment:
```bash
export STRIPE_WEBHOOK_SECRET=whsec_xxxxx
```

Or add to `.env`:
```
STRIPE_WEBHOOK_SECRET=whsec_xxxxx
```

---

## Triggering Test Events

### Checkout Session Completed

```bash
stripe trigger checkout.session.completed
```

### Subscription Events

```bash
# New subscription
stripe trigger customer.subscription.created

# Subscription updated
stripe trigger customer.subscription.updated

# Subscription canceled
stripe trigger customer.subscription.deleted
```

### Payment Events

```bash
# Successful payment
stripe trigger payment_intent.succeeded

# Failed payment
stripe trigger invoice.payment_failed
```

### All Available Events

```bash
stripe trigger --list
```

---

## Test Card Numbers

Use these card numbers in test mode:

| Card Number | Scenario |
|-------------|----------|
| `4242424242424242` | Successful payment |
| `4000000000000002` | Card declined |
| `4000002500003155` | Requires 3D Secure authentication |
| `4000000000009995` | Insufficient funds |
| `4000000000000069` | Expired card |
| `4000000000000127` | Incorrect CVC |
| `4100000000000019` | Flagged as potentially fraudulent |

All test cards use:
- **Expiry:** Any future date (e.g., 12/34)
- **CVC:** Any 3 digits (e.g., 123)
- **ZIP:** Any 5 digits (e.g., 12345)

---

## Testing Workflow

### 1. Start Local Services

```bash
# Start Supabase locally
supabase start

# In another terminal, start webhook forwarding
stripe listen --forward-to http://localhost:54321/functions/v1/stripe-webhook
```

### 2. Trigger Events

```bash
# Test the complete checkout flow
stripe trigger checkout.session.completed

# Test subscription updates
stripe trigger customer.subscription.updated
```

### 3. Verify Database State

Check that webhook handlers properly update Supabase:

```sql
-- Check subscription records
SELECT * FROM subscriptions ORDER BY created_at DESC LIMIT 5;

-- Check payment events
SELECT * FROM payment_events ORDER BY created_at DESC LIMIT 5;
```

---

## Troubleshooting

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

## CI/CD Integration

For automated testing in CI, use Stripe's test mode API directly:

```typescript
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

// Create a test checkout session
const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  payment_method_types: ['card'],
  line_items: [{ price: 'price_xxx', quantity: 1 }],
  success_url: 'https://example.com/success',
  cancel_url: 'https://example.com/cancel',
});
```

---

## E2E Test Verification

**IMPORTANT:** Run E2E tests before deploying any payment page changes.

### Run Checkout E2E Tests

```bash
# Create the E2E config (if not exists)
cat > vitest.e2e.config.ts << 'EOF'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.spec.ts'],
    exclude: [],
    testTimeout: 30000,
  },
})
EOF

# Run checkout tests
docker exec skillsmith-dev-1 npx vitest run tests/e2e/checkout-flow.spec.ts --config vitest.e2e.config.ts

# Run webhook tests
docker exec skillsmith-dev-1 npx vitest run tests/e2e/webhook-handling.spec.ts --config vitest.e2e.config.ts
```

### What the Tests Verify

| Test Category | Verification |
|---------------|--------------|
| Signup page accessibility | Page loads, tier params work |
| Checkout session creation | All tiers (individual, team, enterprise) |
| Billing periods | Monthly and annual |
| Validation | Invalid tier, malformed email, seat limits |
| Security | XSS handling, no 500 errors |
| Performance | Response under 3 seconds |

---

## Manual Testing Flow

### Quick Checkout Verification

```bash
# Test Individual tier (replace $SUPABASE_URL with your project URL)
curl -s -X POST "${SUPABASE_URL}/functions/v1/checkout" \
  -H 'Content-Type: application/json' \
  -d '{"tier":"individual","period":"monthly","email":"test@example.com"}' | jq .

# Test Team tier with seats
curl -s -X POST "${SUPABASE_URL}/functions/v1/checkout" \
  -H 'Content-Type: application/json' \
  -d '{"tier":"team","period":"monthly","seatCount":3,"email":"test@example.com"}' | jq .
```

### Browser Testing

1. Go to https://www.skillsmith.app/signup?tier=team
2. Verify correct tier is displayed (Team - $25/user/mo)
3. Click "Start Trial"
4. Enter test card: `4242 4242 4242 4242`
5. Use any future expiry, any CVC, any ZIP
6. Complete checkout
7. Verify redirect to `/signup/success`

---

## Pre-Deployment Checklist

Before deploying payment page changes, verify:

- [ ] **E2E tests pass**: `npx vitest run tests/e2e/checkout-flow.spec.ts --config vitest.e2e.config.ts`
- [ ] **Tier parameter works**: `/signup?tier=team` shows Team tier
- [ ] **All tiers accessible**: Individual, Team, Enterprise
- [ ] **Pricing correct**: Matches `packages/website/src/lib/pricing.ts`
- [ ] **Success page works**: `/signup/success` loads after checkout
- [ ] **Cancel returns to pricing**: Canceling checkout returns to `/pricing`

### API Endpoint Reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/functions/v1/checkout` | POST | Create Stripe checkout session |
| `/functions/v1/stripe-webhook` | POST | Handle Stripe webhooks |
| `/functions/v1/verify-subscription` | POST | Verify subscription status |

### Request Parameters

```typescript
// POST /functions/v1/checkout
{
  tier: 'individual' | 'team' | 'enterprise',  // required
  period: 'monthly' | 'annual',                 // required
  seatCount?: number,                           // optional, 1-1000
  email?: string,                               // optional
  successUrl?: string,                          // optional
  cancelUrl?: string                            // optional
}
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

- [Stripe CLI Documentation](https://stripe.com/docs/stripe-cli)
- [Stripe Webhooks Guide](https://stripe.com/docs/webhooks)
- [Testing Stripe Integrations](https://stripe.com/docs/testing)
- [Edge Function Patterns](edge-function-patterns.md)
- [Checkout E2E Tests](../../tests/e2e/checkout-flow.spec.ts)
- [Webhook E2E Tests](../../tests/e2e/webhook-handling.spec.ts)
- [Pricing Configuration](../../packages/website/src/lib/pricing.ts)
