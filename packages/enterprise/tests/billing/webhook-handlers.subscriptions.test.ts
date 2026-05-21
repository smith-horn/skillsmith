/**
 * SMI-3415 / SMI-5036: Webhook handlers — subscription lifecycle + license keys
 *
 * storeLicenseKey / revokeLicenseKey (DB operations) +
 * handleSubscriptionCreated / handleSubscriptionUpdated / handleSubscriptionDeleted.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  storeLicenseKey,
  revokeLicenseKey,
} from '../../src/billing/webhook-handlers.js'
import { createContext, createMockDb, makeSubscription } from './_helpers.js'

// ============================================================================
// License Key DB Operations
// ============================================================================

describe('storeLicenseKey', () => {
  it('should insert a license key record', () => {
    const db = createMockDb()
    const runFn = vi.fn()
    vi.mocked(db.prepare).mockReturnValue({ run: runFn } as never)

    storeLicenseKey(db, {
      subscriptionId: 'sub_1',
      organizationId: 'org_1',
      keyJwt: 'jwt_token_value',
      keyExpiry: new Date('2026-12-31'),
    })

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO license_keys'))
    expect(runFn).toHaveBeenCalledWith(
      expect.any(String), // UUID
      'sub_1',
      'org_1',
      'jwt_token_value',
      expect.any(String), // SHA-256 hash
      '2026-12-31T00:00:00.000Z',
      expect.any(String) // generated_at ISO
    )
  })
})

describe('revokeLicenseKey', () => {
  it('should update license key to inactive', () => {
    const db = createMockDb()
    const runFn = vi.fn()
    vi.mocked(db.prepare).mockReturnValue({ run: runFn } as never)

    revokeLicenseKey(db, 'sub_1', 'tier_change')

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE license_keys'))
    expect(runFn).toHaveBeenCalledWith(expect.any(String), 'tier_change', 'sub_1')
  })
})

// ============================================================================
// handleSubscriptionCreated
// ============================================================================

describe('handleSubscriptionCreated', () => {
  it('should create subscription record when customer found', async () => {
    const ctx = createContext()
    const sub = makeSubscription()
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
      deleted: false,
    } as never)

    await handleSubscriptionCreated(ctx, sub)

    expect(ctx.billing.upsertSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_test_1',
        email: 'user@example.com',
        stripeSubscriptionId: 'sub_test_1',
        tier: 'team',
        seatCount: 5,
      })
    )
  })

  it('should throw when customer not found', async () => {
    const ctx = createContext()
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue(null)

    await expect(handleSubscriptionCreated(ctx, makeSubscription())).rejects.toThrow(
      'Customer not found'
    )
  })

  it('should generate and store license key for active subscription', async () => {
    const onLicenseKeyNeeded = vi.fn().mockResolvedValue('jwt_license_123')
    const db = createMockDb()
    const runFn = vi.fn()
    vi.mocked(db.prepare).mockReturnValue({ run: runFn } as never)

    const ctx = createContext({ onLicenseKeyNeeded, db })
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
      deleted: false,
    } as never)

    await handleSubscriptionCreated(ctx, makeSubscription({ status: 'active' }))

    expect(onLicenseKeyNeeded).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_test_1',
        tier: 'team',
      })
    )
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO license_keys'))
  })

  it('should send license key email when onEmailNeeded provided', async () => {
    const onLicenseKeyNeeded = vi.fn().mockResolvedValue('jwt_license_456')
    const onEmailNeeded = vi.fn().mockResolvedValue(undefined)
    const db = createMockDb()
    vi.mocked(db.prepare).mockReturnValue({ run: vi.fn() } as never)

    const ctx = createContext({ onLicenseKeyNeeded, onEmailNeeded, db })
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
      deleted: false,
    } as never)

    await handleSubscriptionCreated(ctx, makeSubscription({ status: 'active' }))

    expect(onEmailNeeded).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'license_key',
        email: 'user@example.com',
        data: expect.objectContaining({ licenseKey: 'jwt_license_456', tier: 'team' }),
      })
    )
  })

  it('should skip license key for non-active subscription', async () => {
    const onLicenseKeyNeeded = vi.fn()
    const ctx = createContext({ onLicenseKeyNeeded })
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
      deleted: false,
    } as never)

    await handleSubscriptionCreated(ctx, makeSubscription({ status: 'trialing' }))

    expect(onLicenseKeyNeeded).not.toHaveBeenCalled()
  })
})

// ============================================================================
// handleSubscriptionUpdated
// ============================================================================

describe('handleSubscriptionUpdated', () => {
  it('should create subscription if not found locally', async () => {
    const ctx = createContext()
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue(null)
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
      deleted: false,
    } as never)

    await handleSubscriptionUpdated(ctx, makeSubscription())

    expect(ctx.billing.upsertSubscription).toHaveBeenCalled()
  })

  it('should update status for existing subscription', async () => {
    const ctx = createContext()
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue({
      id: 'local_sub_1',
      tier: 'team',
    } as never)

    const sub = makeSubscription({ status: 'past_due', canceled_at: null })
    await handleSubscriptionUpdated(ctx, sub)

    expect(ctx.billing.updateSubscriptionStatus).toHaveBeenCalledWith(
      'sub_test_1',
      'past_due',
      null
    )
  })

  it('should pass canceled_at date when present', async () => {
    const ctx = createContext()
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue({
      id: 'local_sub_1',
      tier: 'team',
    } as never)

    const sub = makeSubscription({ status: 'canceled', canceled_at: 1700000000 })
    await handleSubscriptionUpdated(ctx, sub)

    expect(ctx.billing.updateSubscriptionStatus).toHaveBeenCalledWith(
      'sub_test_1',
      'canceled',
      new Date(1700000000 * 1000)
    )
  })

  it('should regenerate license key on tier change', async () => {
    const onLicenseKeyNeeded = vi.fn().mockResolvedValue('new_jwt')
    const db = createMockDb()
    const runFn = vi.fn()
    vi.mocked(db.prepare).mockReturnValue({ run: runFn } as never)

    const ctx = createContext({ onLicenseKeyNeeded, db })
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue({
      id: 'local_sub_1',
      tier: 'individual', // old tier
    } as never)
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
    } as never)

    // New tier is 'team' from metadata
    await handleSubscriptionUpdated(ctx, makeSubscription({ metadata: { tier: 'team' } }))

    // Should revoke old key
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE license_keys'))
    // Should generate new key
    expect(onLicenseKeyNeeded).toHaveBeenCalledWith(expect.objectContaining({ tier: 'team' }))
    // Should store new key
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO license_keys'))
  })

  it('should not regenerate license key when tier unchanged', async () => {
    const onLicenseKeyNeeded = vi.fn()
    const ctx = createContext({ onLicenseKeyNeeded })
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue({
      id: 'local_sub_1',
      tier: 'team', // same as metadata
    } as never)

    await handleSubscriptionUpdated(ctx, makeSubscription({ metadata: { tier: 'team' } }))

    expect(onLicenseKeyNeeded).not.toHaveBeenCalled()
  })
})

// ============================================================================
// handleSubscriptionDeleted
// ============================================================================

describe('handleSubscriptionDeleted', () => {
  it('should cancel subscription and revoke license key', async () => {
    const db = createMockDb()
    const runFn = vi.fn()
    vi.mocked(db.prepare).mockReturnValue({ run: runFn } as never)

    const ctx = createContext({ db })
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue({
      id: 'local_sub_1',
      tier: 'team',
    } as never)

    await handleSubscriptionDeleted(ctx, makeSubscription())

    expect(ctx.billing.updateSubscriptionStatus).toHaveBeenCalledWith(
      'sub_test_1',
      'canceled',
      expect.any(Date)
    )
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE license_keys'))
  })

  it('should send cancellation email', async () => {
    const onEmailNeeded = vi.fn().mockResolvedValue(undefined)
    const db = createMockDb()
    vi.mocked(db.prepare).mockReturnValue({ run: vi.fn() } as never)

    const ctx = createContext({ onEmailNeeded, db })
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue({
      id: 'local_sub_1',
      tier: 'team',
    } as never)
    vi.mocked(ctx.stripe.getCustomer).mockResolvedValue({
      id: 'cus_test_1',
      email: 'user@example.com',
    } as never)

    await handleSubscriptionDeleted(ctx, makeSubscription())

    expect(onEmailNeeded).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'subscription_canceled',
        email: 'user@example.com',
      })
    )
  })

  it('should do nothing when subscription not found locally', async () => {
    const ctx = createContext()
    vi.mocked(ctx.billing.getSubscriptionByStripeId).mockReturnValue(null)

    await handleSubscriptionDeleted(ctx, makeSubscription())

    expect(ctx.billing.updateSubscriptionStatus).not.toHaveBeenCalled()
  })
})
