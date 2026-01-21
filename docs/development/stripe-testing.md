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

## Related Documentation

- [Stripe CLI Documentation](https://stripe.com/docs/stripe-cli)
- [Stripe Webhooks Guide](https://stripe.com/docs/webhooks)
- [Testing Stripe Integrations](https://stripe.com/docs/testing)
- [Webhook E2E Tests](../../tests/e2e/webhook-handling.spec.ts)
