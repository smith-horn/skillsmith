# Billing Module Code Review

**Date:** January 17, 2026
**Reviewer:** Code Review Agent
**Module:** `packages/core/src/billing/`
**Related Issues:** SMI-1062, SMI-1063, SMI-1068, SMI-1069, SMI-1070

---

## Executive Summary

The billing module provides a solid foundation for Stripe integration with proper separation of concerns, idempotent webhook processing, and GDPR compliance features. The code demonstrates good TypeScript practices with branded types for Stripe IDs and comprehensive error handling. However, there are opportunities to improve test coverage for the StripeClient and StripeWebhookHandler classes, and some minor security enhancements are recommended.

---

## Review Categories

| Category | Status | Summary |
|----------|--------|---------|
| Security | **WARN** | Good practices overall; license key storage could use encryption |
| Error Handling | **PASS** | Comprehensive error types and logging |
| Type Safety | **PASS** | Excellent use of branded types and interfaces |
| Best Practices | **PASS** | Clean architecture with good documentation |
| Business Logic | **PASS** | Correct state transitions and idempotency |
| Test Coverage | **WARN** | Core services tested; webhook/client need direct tests |

---

## 1. Security Issues

### Status: WARN

### Strengths

1. **No Hardcoded Secrets** - All API keys and secrets are passed via configuration objects
   - `/packages/core/src/billing/StripeClient.ts:43-48` - secretKey and webhookSecret from config

2. **Webhook Signature Verification** - Properly implemented using Stripe SDK
   - `/packages/core/src/billing/StripeClient.ts:531-540` - Uses `stripe.webhooks.constructEvent()`

3. **Parameterized SQL Queries** - All database operations use prepared statements
   - `/packages/core/src/billing/BillingService.ts:183-217` - Prepared statement with placeholders

4. **Stripe ID Validation** - Dedicated sanitization functions exist
   - `/packages/core/tests/billing/stripe-validators.test.ts` - Comprehensive validation tests

5. **Sensitive Data Exclusion in GDPR Export** - License JWT not exported
   - `/packages/core/src/billing/GDPRComplianceService.ts:260-301` - Only exports metadata, not keyJwt

### Issues

| Priority | File:Line | Issue | Recommendation |
|----------|-----------|-------|----------------|
| Medium | `StripeWebhookHandler.ts:505` | License key JWT stored in plaintext in database | Consider encrypting license keys at rest using AES-256-GCM with a key management service |
| Low | `StripeWebhookHandler.ts:253` | Customer email logged in production logs | Mask email in logs (e.g., `t***@example.com`) to reduce PII exposure |
| Low | `GDPRComplianceService.ts:325-326` | LIKE query with customer ID could be slow on large datasets | Consider adding an indexed `customer_id` column to `stripe_webhook_events` table |

### Code Sample - License Key Storage (Medium Priority)
```typescript
// Current: /packages/core/src/billing/StripeWebhookHandler.ts:494-509
private storeLicenseKey(params: {
  subscriptionId: string
  organizationId: string
  keyJwt: string  // Stored as plaintext
  keyExpiry: Date
}): void {
  // ...
  .run(
    id,
    params.subscriptionId,
    params.organizationId,
    params.keyJwt,  // Consider: encryptAES256(params.keyJwt, encryptionKey)
    keyHash,
    // ...
  )
}
```

---

## 2. Error Handling

### Status: PASS

### Strengths

1. **Custom Error Class** - `BillingError` with typed error codes
   - `/packages/core/src/billing/types.ts:350-359` - Includes code, message, and optional details

2. **Comprehensive Error Codes** - 9 specific billing error codes defined
   - `/packages/core/src/billing/types.ts:336-345` - Covers all major failure scenarios

3. **Structured Logging** - All errors logged with context
   - `/packages/core/src/billing/StripeClient.ts:151-153` - Includes customer email and error details

4. **Transaction Rollback** - GDPR deletion uses proper transaction handling
   - `/packages/core/src/billing/GDPRComplianceService.ts:391-464` - BEGIN/COMMIT/ROLLBACK

5. **Webhook Failure Recording** - Failed webhooks stored for debugging
   - `/packages/core/src/billing/StripeWebhookHandler.ts:172-178` - Records error message

### Minor Issues

| Priority | File:Line | Issue | Recommendation |
|----------|-----------|-------|----------------|
| Low | `StripeClient.ts:175-176` | Re-throws error without wrapping in BillingError | Wrap in BillingError for consistent error handling |
| Low | `BillingService.ts:293` | Type assertion on stripeSubscriptionId | Add null check before assertion |

### Code Sample - Inconsistent Error Wrapping
```typescript
// /packages/core/src/billing/StripeClient.ts:171-176
async getCustomer(customerId: StripeCustomerId): Promise<Stripe.Customer | null> {
  try {
    // ...
  } catch (error: unknown) {
    if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
      return null
    }
    throw error  // Consider: throw new BillingError('Failed to get customer', 'STRIPE_API_ERROR', { originalError })
  }
}
```

---

## 3. Type Safety

### Status: PASS

### Strengths

1. **Branded Types for Stripe IDs** - Prevents mixing different ID types
   - `/packages/core/src/billing/types.ts:31-56` - StripeCustomerId, StripeSubscriptionId, etc.

2. **No `any` Types** - All types are explicitly defined
   - All 7 files reviewed have proper TypeScript types

3. **Correct Interface Definitions** - Clear separation between request/response types
   - `/packages/core/src/billing/types.ts:140-157` - CreateCheckoutSessionRequest/Response

4. **Row Type Mappings** - Database rows properly typed and mapped
   - `/packages/core/src/billing/BillingService.ts:615-645` - SubscriptionRow, InvoiceRow interfaces

### Minor Issues

| Priority | File:Line | Issue | Recommendation |
|----------|-----------|-------|----------------|
| Low | `BillingService.ts:578` | Type assertion `as StripeSubscriptionId \| null` | The mapping is safe but could use a type guard |
| Low | `StripeWebhookHandler.ts:537-543` | Loose type check for tier validation | Use a type guard function for LicenseTier validation |

### Code Sample - Tier Validation
```typescript
// Current: /packages/core/src/billing/StripeWebhookHandler.ts:535-544
private extractTier(subscription: Stripe.Subscription): LicenseTier {
  const metadataTier = subscription.metadata?.tier as LicenseTier | undefined
  if (metadataTier && ['community', 'individual', 'team', 'enterprise'].includes(metadataTier)) {
    return metadataTier
  }
  return 'individual'
}

// Recommendation: Use a type guard
function isLicenseTier(value: unknown): value is LicenseTier {
  return typeof value === 'string' &&
    ['community', 'individual', 'team', 'enterprise'].includes(value)
}
```

---

## 4. Best Practices

### Status: PASS

### Strengths

1. **Clean Module Exports** - Barrel file with organized exports
   - `/packages/core/src/billing/index.ts` - Groups exports by category

2. **JSDoc Documentation** - Public APIs well documented
   - `/packages/core/src/billing/StripeClient.ts:84-105` - Example usage in class docs
   - `/packages/core/src/billing/GDPRComplianceService.ts:171-179` - Article references

3. **Consistent Naming** - camelCase for methods, PascalCase for types
   - All files follow TypeScript naming conventions

4. **Separation of Concerns**
   - `StripeClient` - Low-level Stripe API wrapper
   - `BillingService` - Business logic and database operations
   - `StripeWebhookHandler` - Event processing
   - `GDPRComplianceService` - Compliance features
   - `StripeReconciliationJob` - Data consistency

5. **Configuration Objects** - Dependency injection via config interfaces
   - `/packages/core/src/billing/StripeClient.ts:39-59` - StripeClientConfig

### Minor Issues

| Priority | File:Line | Issue | Recommendation |
|----------|-----------|-------|----------------|
| Low | `StripeWebhookHandler.ts:235-293` | `handleSubscriptionCreated` is 58 lines | Extract license key generation to separate method |
| Low | `StripeClient.ts:265` | Non-null assertion `session.url!` | Add null check or default value |
| Low | `BillingService.ts:399-424` | Magic number 10 for default invoice limit | Extract to named constant |

### Code Sample - Magic Number
```typescript
// Current: /packages/core/src/billing/BillingService.ts:399
getInvoices(customerId: string, limit = 10): Invoice[] {

// Recommendation:
const DEFAULT_INVOICE_LIMIT = 10
getInvoices(customerId: string, limit = DEFAULT_INVOICE_LIMIT): Invoice[] {
```

---

## 5. Business Logic

### Status: PASS

### Strengths

1. **Idempotent Webhook Processing** - Duplicate events handled correctly
   - `/packages/core/src/billing/StripeWebhookHandler.ts:138-145` - Checks `isEventProcessed`

2. **License Key Lifecycle** - Complete management from generation to revocation
   - `/packages/core/src/billing/StripeWebhookHandler.ts:265-293` - Generation on subscription create
   - `/packages/core/src/billing/StripeWebhookHandler.ts:328,366` - Revocation on tier change/cancel

3. **Subscription State Transitions** - Proper status mapping from Stripe
   - `/packages/core/src/billing/StripeClient.ts:565-586` - Maps all Stripe statuses

4. **GDPR Compliance** - Complete Article 17 and 20 implementation
   - `/packages/core/src/billing/GDPRComplianceService.ts:181-211` - Data export
   - `/packages/core/src/billing/GDPRComplianceService.ts:363-506` - Data deletion with dry-run

5. **Reconciliation with Auto-Fix** - Discrepancy detection and optional correction
   - `/packages/core/src/billing/StripeReconciliationJob.ts:177-184` - Auto-fix mode

### Issues

| Priority | File:Line | Issue | Recommendation |
|----------|-----------|-------|----------------|
| Medium | `BillingService.ts:313-360` | Only upgrade path implemented; no downgrade | Add `downgradeTier` method or rename to `changeTier` with validation |
| Low | `StripeWebhookHandler.ts:469-478` | Checkout session handler is a no-op | Add analytics tracking or remove if not needed |
| Low | `StripeReconciliationJob.ts:442-449` | Missing subscription marked as canceled | Should notify ops team when this happens |

### Code Sample - Missing Downgrade Logic
```typescript
// Current: /packages/core/src/billing/BillingService.ts:327-333
if (newIndex <= currentIndex) {
  throw new BillingError('Can only upgrade to a higher tier', 'DOWNGRADE_NOT_ALLOWED', {
    currentTier: subscription.tier,
    requestedTier: newTier,
  })
}

// Consider: Support downgrades with different proration or add separate downgradeTier method
```

---

## 6. Test Coverage

### Status: WARN

### Tested Modules

| Module | Test File | Coverage |
|--------|-----------|----------|
| BillingService | `BillingService.test.ts` | Good - CRUD operations, upsert, webhooks |
| GDPRComplianceService | `GDPRCompliance.test.ts` | Excellent - Export, deletion, dry-run |
| StripeReconciliationJob | `StripeReconciliation.test.ts` | Good - Discrepancy detection, auto-fix |
| Stripe ID Validators | `stripe-validators.test.ts` | Excellent - All validation scenarios |

### Missing Test Coverage

| Priority | Area | Recommendation |
|----------|------|----------------|
| High | `StripeClient.ts` | Add unit tests with mocked Stripe SDK |
| High | `StripeWebhookHandler.ts` | Add tests for each webhook event type |
| Medium | Webhook signature failure | Test invalid signature handling end-to-end |
| Medium | License key generation flow | Integration test for subscription -> license key |
| Low | Portal session creation | Test error paths in createPortalSession |

### Specific Missing Tests

1. **StripeClient Tests** (High Priority)
   - `createCustomer` success and failure paths
   - `updateSubscription` with tier change
   - `cancelSubscription` immediate vs end-of-period
   - `verifyWebhookSignature` with invalid signature

2. **StripeWebhookHandler Tests** (High Priority)
   - `handleSubscriptionCreated` with license key generation
   - `handleSubscriptionUpdated` with tier change
   - `handleSubscriptionDeleted` with license revocation
   - `handleInvoicePaymentFailed` with email notification

3. **Edge Cases**
   - Concurrent webhook processing for same subscription
   - Database transaction rollback on partial failure
   - Rate limiting handling from Stripe API

### Recommended Test Structure
```typescript
// Proposed: /packages/core/tests/billing/StripeWebhookHandler.test.ts
describe('StripeWebhookHandler', () => {
  describe('handleWebhook', () => {
    it('should reject invalid signatures', async () => {
      // Test signature verification failure
    })

    it('should handle duplicate events idempotently', async () => {
      // Test processing same event twice
    })
  })

  describe('handleSubscriptionCreated', () => {
    it('should generate license key for active subscription', async () => {
      // Test license key generation flow
    })

    it('should skip license key for incomplete subscription', async () => {
      // Test status check
    })
  })
})
```

---

## Action Items

### High Priority

1. [ ] Add unit tests for `StripeClient.ts` with mocked Stripe SDK
2. [ ] Add unit tests for `StripeWebhookHandler.ts` covering all event types
3. [ ] Add integration test for webhook signature verification failure

### Medium Priority

4. [ ] Encrypt license key JWT at rest in database
5. [ ] Add `downgradeTier` method or rename `upgradeTier` to support tier changes
6. [ ] Add index on `stripe_webhook_events.payload` for GDPR customer lookup performance
7. [ ] Mask customer email in production logs

### Low Priority

8. [ ] Extract license key generation to separate method in webhook handler
9. [ ] Add named constant for default invoice limit
10. [ ] Add null check for `session.url` in checkout response
11. [ ] Consider adding analytics to checkout session completed handler
12. [ ] Add alerting when reconciliation marks subscriptions as canceled

---

## Files Reviewed

| File | Lines | Status |
|------|-------|--------|
| `/packages/core/src/billing/StripeClient.ts` | 595 | Reviewed |
| `/packages/core/src/billing/StripeWebhookHandler.ts` | 559 | Reviewed |
| `/packages/core/src/billing/BillingService.ts` | 646 | Reviewed |
| `/packages/core/src/billing/GDPRComplianceService.ts` | 563 | Reviewed |
| `/packages/core/src/billing/StripeReconciliationJob.ts` | 551 | Reviewed |
| `/packages/core/src/billing/types.ts` | 360 | Reviewed |
| `/packages/core/src/billing/index.ts` | 43 | Reviewed |
| `/packages/core/tests/billing/stripe-validators.test.ts` | 137 | Reviewed |
| `/packages/core/tests/billing/BillingService.test.ts` | 216 | Reviewed |
| `/packages/core/tests/billing/GDPRCompliance.test.ts` | 297 | Reviewed |
| `/packages/core/tests/billing/StripeReconciliation.test.ts` | 385 | Reviewed |

---

## Conclusion

The billing module is well-architected with proper separation of concerns, comprehensive GDPR compliance, and robust error handling. The main areas for improvement are:

1. **Test Coverage** - StripeClient and StripeWebhookHandler need direct unit tests
2. **Security Enhancement** - License key encryption at rest
3. **Business Logic Gap** - Downgrade tier support

Overall, this is production-ready code with clear documentation and good TypeScript practices. The identified issues are mostly enhancements rather than critical defects.

---

*Review generated by Code Review Agent on January 17, 2026*
