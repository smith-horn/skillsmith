# ADR-021: Billing Schema Approach

**Status:** Accepted
**Date:** 2026-01-17
**Issues:** SMI-1062 to SMI-1070

## Context

Phase 6 introduces Stripe billing integration for Skillsmith's subscription management. During the pre-implementation audit, we discovered an existing `user_subscriptions` table in the analytics schema (`packages/core/src/analytics/schema.ts`). This ADR documents the decision on whether to extend the existing table or create new billing-specific tables.

### Existing Infrastructure

The analytics schema already contains:

```sql
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('community', 'individual', 'team', 'enterprise')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('active', 'past_due', 'canceled', 'trialing', 'paused')),
  current_period_start TEXT,
  current_period_end TEXT,
  last_active_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

This table was created to support quota enforcement and usage analytics. It already has Stripe ID fields but lacks billing-specific fields.

### Missing Fields for Billing

1. **`seat_count`** - Required for team/enterprise seat-based billing
2. **`price_id`** - Stripe price ID for the current subscription plan
3. **`canceled_at`** - Timestamp when subscription was canceled

### Missing Tables

1. **`stripe_webhook_events`** - Idempotent webhook processing (prevents replay attacks)
2. **`license_keys`** - Links subscriptions to generated JWT license keys
3. **`invoices`** - Invoice history for customer self-service

## Decision

**Extend the existing `user_subscriptions` table** and create new tables only for billing-specific concerns that don't exist.

### Rationale

1. **DRY Principle**: The existing table already has 80% of required fields. Creating a duplicate `subscriptions` table would require foreign key relationships and data synchronization.

2. **Single Source of Truth**: Having one subscription table prevents data inconsistency between analytics and billing systems.

3. **Migration Safety**: Adding columns with `ALTER TABLE` is simpler and safer than creating new tables with complex FK relationships.

4. **Existing Usage**: The analytics system and quota enforcement already reference `user_subscriptions`. Changing the table structure would break existing code.

## Migration Strategy

### Phase 1: Extend user_subscriptions

Add missing columns to the existing table:

```sql
-- Migration 004: Add billing fields to user_subscriptions
ALTER TABLE user_subscriptions ADD COLUMN seat_count INTEGER DEFAULT 1;
ALTER TABLE user_subscriptions ADD COLUMN price_id TEXT;
ALTER TABLE user_subscriptions ADD COLUMN canceled_at TEXT;
```

### Phase 2: Create New Billing Tables

```sql
-- stripe_webhook_events for idempotent processing
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id TEXT PRIMARY KEY,
  stripe_event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  payload TEXT,  -- Store full event for debugging
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_stripe_id ON stripe_webhook_events(stripe_event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_type ON stripe_webhook_events(event_type);

-- license_keys linking subscriptions to JWT tokens
CREATE TABLE IF NOT EXISTS license_keys (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,  -- References user_subscriptions.id
  organization_id TEXT NOT NULL,
  key_jwt TEXT NOT NULL,
  key_expiry TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_license_keys_subscription ON license_keys(subscription_id);
CREATE INDEX IF NOT EXISTS idx_license_keys_org ON license_keys(organization_id);
CREATE INDEX IF NOT EXISTS idx_license_keys_active ON license_keys(is_active);

-- invoices for customer self-service
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,  -- References user_subscriptions.customer_id
  stripe_invoice_id TEXT UNIQUE NOT NULL,
  subscription_id TEXT,  -- References user_subscriptions.id
  amount_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'usd',
  status TEXT NOT NULL CHECK(status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  pdf_url TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_stripe ON invoices(stripe_invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
```

## Alternatives Considered

### 1. Create Separate `stripe_customers` and `subscriptions` Tables

**Rejected because:**
- Would require migrating existing data
- Creates FK relationship complexity
- Duplicates customer/subscription data
- Requires synchronization between analytics and billing

### 2. Use `user_subscriptions` Only (No New Tables)

**Rejected because:**
- Webhook idempotency requires persistent event tracking
- License keys need their own lifecycle (rotation, revocation)
- Invoice history is distinct from subscription state

## Consequences

### Positive

- Simpler data model with single subscription source
- No breaking changes to existing analytics code
- Quota enforcement continues working unchanged
- Cleaner migration path

### Negative

- `user_subscriptions` table becomes larger (3 new columns)
- Analytics schema now has billing concerns (minor coupling)
- Table name doesn't reflect billing purpose (acceptable trade-off)

### Neutral

- New tables (`stripe_webhook_events`, `license_keys`, `invoices`) have clean separation
- Foreign keys use TEXT references (SQLite convention)

## Implementation Notes

### Migration Order

1. Extend `user_subscriptions` (safe - just adds columns)
2. Create `stripe_webhook_events` (required before webhook handling)
3. Create `license_keys` (required before license delivery)
4. Create `invoices` (required before customer portal)

### Analytics Schema Location

Billing tables will be added to `packages/core/src/analytics/schema.ts` with clear section headers:

```typescript
// ============================================================================
// Billing Tables (SMI-1062 - Phase 6)
// ============================================================================
```

### Testing Strategy

- Unit tests for new table operations
- Integration tests for subscription ↔ license key relationship
- E2E tests for webhook → license delivery flow

## References

- [ADR-017: Quota Enforcement System](./017-quota-enforcement-system.md)
- [ADR-013: Open Core Licensing](./013-open-core-licensing.md)
- [Phase 6 Implementation Plan](../execution/phase6-billing-backend-plan.md)
