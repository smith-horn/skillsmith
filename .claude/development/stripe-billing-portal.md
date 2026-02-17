# Stripe Billing Portal Testing

This guide covers testing the Stripe Billing Portal integration for subscription management.

> **Related**: [Stripe CLI Testing](stripe-testing.md) | [Troubleshooting](stripe-troubleshooting.md)

---

## Portal Session E2E Tests

The portal session tests verify subscription management via Stripe's billing portal:

```bash
# Run portal session tests
docker exec skillsmith-dev-1 npx vitest run tests/e2e/portal-session.test.ts
```

### Test Scenarios

| Scenario | Expected Result |
|----------|-----------------|
| Active subscription | Portal access granted |
| Canceled subscription | Portal access granted (customer still exists) |
| No subscription | Clear error message |
| Missing stripe_customer_id | Appropriate error handling |
| Multiple subscriptions | Uses most recent |

---

## Cancellation Flow Testing

To test subscription cancellation end-to-end:

### 1. Create subscription via checkout

```bash
# Navigate to signup page and complete checkout
open https://www.skillsmith.app/signup?tier=individual
# Use test card: 4242 4242 4242 4242
```

### 2. Access billing portal

```bash
# Create portal session via API (requires auth)
varlock run -- bash -c 'curl -X POST \
  -H "Authorization: Bearer $USER_JWT" \
  "$SUPABASE_URL/functions/v1/create-portal-session"'
```

### 3. Cancel via portal

- Click "Cancel subscription" in Stripe billing portal
- Confirm cancellation
- Portal shows "Cancels [date]" badge

### 4. Verify database state

```bash
# Check subscription status updated
varlock run -- bash -c 'curl -s "$SUPABASE_URL/rest/v1/subscriptions?user_id=eq.<user-id>" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"' | jq .
```

---

## Portal Session Error Handling

The `create-portal-session` function handles these edge cases:

| Error | HTTP Status | User Message |
|-------|-------------|--------------|
| No subscription found | 404 | "No billing account found" |
| Stripe customer deleted | 404 | "Your billing account could not be found" |
| Portal not configured | 500 | "Billing portal configuration error" |
| API key missing permission | 500 | "Permission error" |

---

## Required Stripe API Key Permissions

For billing portal functionality, the restricted API key needs:

| Permission | Scope |
|------------|-------|
| `rak_customer_portal_write` | Customer portal sessions |
| `rak_checkout_sessions_write` | Checkout session creation |
| `rak_customers_read` | Customer data access |
| `rak_subscriptions_read` | Subscription data access |

---

## Stripe Dashboard Configuration

### Billing Portal Settings

1. Navigate to Stripe Dashboard > Settings > Billing > Customer portal
2. Enable the following features:
   - Update payment methods
   - View invoice history
   - Cancel subscriptions
   - Update subscription quantities (for team/enterprise)

### Webhook Configuration

Ensure these events are enabled for the billing portal:

- `customer.subscription.updated`
- `customer.subscription.deleted`
- `billing_portal.session.created`

---

## Related Documentation

- [Stripe CLI Testing](stripe-testing.md) - Core testing guide
- [Stripe Troubleshooting](stripe-troubleshooting.md) - Known issues
- [Portal Session E2E Tests](../../tests/e2e/portal-session.test.ts)
- [create-portal-session Edge Function](../../supabase/functions/create-portal-session/index.ts)
