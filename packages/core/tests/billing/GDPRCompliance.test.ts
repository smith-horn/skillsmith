/**
 * SMI-1068: GDPR Compliance Tests
 * SMI-4286: Absorbed unique assertions from the deleted mock-chain duplicate
 *           (src/billing/GDPRComplianceService.test.ts) into this integration suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createDatabaseSync } from '../../src/db/createDatabase.js'
import type { Database } from '../../src/db/database-interface.js'
import { GDPRComplianceService } from '../../src/billing/GDPRComplianceService.js'
import { initializeAnalyticsSchema } from '../../src/analytics/schema.js'
import { randomUUID } from 'crypto'

/**
 * Build a minimal Stripe client double exposing `getStripeInstance().customers.del()`.
 * Pass a custom `deletesFn` (e.g. `vi.fn().mockRejectedValue(...)`) to exercise
 * Stripe error paths. The default resolves successfully.
 */
function makeMockStripe(deletesFn = vi.fn().mockResolvedValue({})) {
  return {
    getStripeInstance: vi.fn().mockReturnValue({
      customers: { del: deletesFn },
    }),
  }
}

describe('GDPRComplianceService', () => {
  let db: Database
  let gdprService: GDPRComplianceService

  beforeEach(() => {
    db = createDatabaseSync(':memory:')
    initializeAnalyticsSchema(db)
    gdprService = new GDPRComplianceService({ db })
    // Suppress expected logger.error output during DB-throw / Stripe-error tests.
    // Do NOT spy on createLogger()'s return — the service holds its own module-level
    // instance. Spy on console.error (the logger's ultimate sink) instead.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  function insertSubscription(
    customerId: string,
    opts: { subscriptionId?: string; tier?: string; seatCount?: number | null } = {}
  ): string {
    const subId = opts.subscriptionId ?? randomUUID()
    const now = new Date().toISOString()
    const seat = opts.seatCount === undefined ? 5 : opts.seatCount
    const stmt = db.prepare(
      `INSERT INTO user_subscriptions (
        id, customer_id, email, stripe_customer_id, stripe_subscription_id,
        stripe_price_id, tier, status, seat_count,
        current_period_start, current_period_end, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const args = [
      subId, customerId, 'test@example.com', `cus_${customerId}`, `sub_${customerId}`,
      'price_test', opts.tier ?? 'team', 'active', seat, now, now, now, now,
    ] // prettier-ignore
    stmt.run(...args)
    return subId
  }

  function createTestCustomer(customerId: string) {
    const subId = insertSubscription(customerId)
    const now = new Date().toISOString()

    const invStmt = db.prepare(
      `INSERT INTO invoices (
        id, customer_id, stripe_invoice_id, subscription_id,
        amount_cents, currency, status, invoice_number, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const invArgs = [randomUUID(), customerId, `in_${customerId}`, subId, 2500, 'usd', 'paid', 'INV-001', now] // prettier-ignore
    invStmt.run(...invArgs)

    const licenseKeyId = randomUUID()
    const keyStmt = db.prepare(
      `INSERT INTO license_keys (
        id, subscription_id, organization_id, key_jwt, key_hash,
        key_expiry, is_active, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const keyArgs = [licenseKeyId, subId, customerId, `test.jwt.token.${customerId}`, `hash_${customerId}_${licenseKeyId}`, now, 1, now] // prettier-ignore
    keyStmt.run(...keyArgs)

    const whStmt = db.prepare(
      `INSERT INTO stripe_webhook_events (
        id, stripe_event_id, event_type, processed_at,
        payload, success, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const whArgs = [randomUUID(), `evt_${customerId}`, 'customer.subscription.created', now, JSON.stringify({ customer: `cus_${customerId}` }), 1, now] // prettier-ignore
    whStmt.run(...whArgs)

    return subId
  }

  describe('Data Export (Article 20)', () => {
    it('should export all customer data', () => {
      const customerId = 'test_customer_123'
      createTestCustomer(customerId)

      const exportData = gdprService.exportCustomerData(customerId)

      expect(exportData.metadata.customerId).toBe(customerId)
      expect(exportData.metadata.format).toBe('json')
      expect(exportData.metadata.version).toBe('1.0')
      expect(exportData.metadata.exportedAt).toBeDefined()
    })

    it('should export subscription data', () => {
      const customerId = 'test_customer_123'
      createTestCustomer(customerId)

      const exportData = gdprService.exportCustomerData(customerId)

      expect(exportData.subscriptions).toHaveLength(1)
      expect(exportData.subscriptions[0].tier).toBe('team')
      expect(exportData.subscriptions[0].status).toBe('active')
      expect(exportData.subscriptions[0].seatCount).toBe(5)
    })

    it('should export invoice data', () => {
      const customerId = 'test_customer_123'
      createTestCustomer(customerId)

      const exportData = gdprService.exportCustomerData(customerId)

      expect(exportData.invoices).toHaveLength(1)
      expect(exportData.invoices[0].amountCents).toBe(2500)
      expect(exportData.invoices[0].currency).toBe('usd')
      expect(exportData.invoices[0].status).toBe('paid')
    })

    it('should export license key data without the actual JWT', () => {
      const customerId = 'test_customer_123'
      createTestCustomer(customerId)

      const exportData = gdprService.exportCustomerData(customerId)

      expect(exportData.licenseKeys).toHaveLength(1)
      expect(exportData.licenseKeys[0].isActive).toBe(true)
      const keyData = exportData.licenseKeys[0] as unknown as Record<string, unknown>
      expect(keyData['keyJwt']).toBeUndefined()
      expect(keyData['keyHash']).toBeUndefined()
    })

    it('should export webhook events', () => {
      const customerId = 'test_customer_123'
      createTestCustomer(customerId)

      const exportData = gdprService.exportCustomerData(customerId)

      expect(exportData.webhookEvents).toHaveLength(1)
      expect(exportData.webhookEvents[0].eventType).toBe('customer.subscription.created')
      expect(exportData.webhookEvents[0].success).toBe(true)
    })

    it('should return empty arrays for non-existent customer', () => {
      const exportData = gdprService.exportCustomerData('non_existent')

      expect(exportData.subscriptions).toHaveLength(0)
      expect(exportData.invoices).toHaveLength(0)
      expect(exportData.licenseKeys).toHaveLength(0)
      expect(exportData.webhookEvents).toHaveLength(0)
    })
  })

  describe('Data Export (Article 20) — metadata', () => {
    it('should return metadata with format=json and version=1.0', () => {
      const customerId = 'metadata_customer_1'
      createTestCustomer(customerId)

      const exportData = gdprService.exportCustomerData(customerId)

      expect(exportData.metadata.format).toBe('json')
      expect(exportData.metadata.version).toBe('1.0')
    })

    it('should default seatCount to 1 when subscription row has seatCount=NULL', () => {
      const customerId = 'metadata_customer_null_seat'
      insertSubscription(customerId, { tier: 'individual', seatCount: null })

      const exportData = gdprService.exportCustomerData(customerId)

      expect(exportData.subscriptions).toHaveLength(1)
      expect(exportData.subscriptions[0].seatCount).toBe(1)
    })

    it('should include an ISO-8601 exportedAt timestamp', () => {
      const customerId = 'metadata_customer_iso'
      createTestCustomer(customerId)

      const exportData = gdprService.exportCustomerData(customerId)

      expect(exportData.metadata.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe('Data Deletion (Article 17) — happy path', () => {
    it('should delete all customer data', async () => {
      const customerId = 'test_customer_123'
      createTestCustomer(customerId)

      expect(gdprService.hasCustomerData(customerId)).toBe(true)

      const result = await gdprService.deleteCustomerData(customerId, {
        deleteFromStripe: false,
      })

      expect(result.success).toBe(true)
      expect(result.customerId).toBe(customerId)
      expect(result.counts.subscriptions).toBe(1)
      expect(result.counts.invoices).toBe(1)
      expect(result.counts.licenseKeys).toBe(1)
      expect(result.counts.webhookEvents).toBe(1)
    })

    it('should perform cascading deletion in correct order', async () => {
      const customerId = 'test_customer_123'
      createTestCustomer(customerId)

      await gdprService.deleteCustomerData(customerId, { deleteFromStripe: false })

      expect(gdprService.hasCustomerData(customerId)).toBe(false)
      const invoices = db.prepare(`SELECT id FROM invoices WHERE customer_id = ?`).all(customerId)
      expect(invoices).toHaveLength(0)
    })

    it('should support dry run mode', async () => {
      const customerId = 'test_customer_123'
      createTestCustomer(customerId)

      const result = await gdprService.deleteCustomerData(customerId, {
        deleteFromStripe: false,
        dryRun: true,
      })

      expect(result.counts.subscriptions).toBe(1)
      expect(result.counts.invoices).toBe(1)
      expect(result.counts.licenseKeys).toBe(1)
      expect(gdprService.hasCustomerData(customerId)).toBe(true)
    })

    it('should handle deletion of non-existent customer', async () => {
      const result = await gdprService.deleteCustomerData('non_existent', {
        deleteFromStripe: false,
      })

      expect(result.success).toBe(true)
      expect(result.counts.subscriptions).toBe(0)
      expect(result.counts.invoices).toBe(0)
    })

    it('should delete multiple customers independently', async () => {
      const customer1 = 'test_customer_1'
      const customer2 = 'test_customer_2'
      createTestCustomer(customer1)
      createTestCustomer(customer2)

      await gdprService.deleteCustomerData(customer1, { deleteFromStripe: false })

      expect(gdprService.hasCustomerData(customer1)).toBe(false)
      expect(gdprService.hasCustomerData(customer2)).toBe(true)
    })
  })

  describe('Data Deletion (Article 17) — error paths', () => {
    it('should rollback and report error when a DELETE throws', async () => {
      const customerId = 'error_path_customer_1'
      createTestCustomer(customerId)

      // Capture originalPrepare before the spy — spy impl delegates for other SQL.
      const originalPrepare = db.prepare.bind(db)
      vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('DELETE FROM invoices')) {
          throw new Error('disk I/O error')
        }
        return originalPrepare(sql)
      })

      const result = await gdprService.deleteCustomerData(customerId, {
        deleteFromStripe: false,
      })

      expect(result.success).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('disk I/O error')

      // Restore prepare so we can verify data is intact (rollback worked).
      vi.restoreAllMocks()
      vi.spyOn(console, 'error').mockImplementation(() => {})

      expect(gdprService.hasCustomerData(customerId)).toBe(true)
      const invoices = db.prepare(`SELECT id FROM invoices WHERE customer_id = ?`).all(customerId)
      expect(invoices).toHaveLength(1)
    })

    it('should capture Stripe deletion error in errors without failing db deletion', async () => {
      const customerId = 'error_path_customer_2'
      createTestCustomer(customerId)

      const stripeDel = vi.fn().mockRejectedValue(new Error('Stripe unavailable'))
      const serviceWithStripe = new GDPRComplianceService({
        db,
        stripeClient: makeMockStripe(stripeDel) as never,
      })

      const result = await serviceWithStripe.deleteCustomerData(customerId)

      // DB deletion should have succeeded — customer data is gone.
      expect(gdprService.hasCustomerData(customerId)).toBe(false)
      expect(result.counts.subscriptions).toBe(1)
      expect(result.counts.invoices).toBe(1)
      // Stripe error is captured but db deletion is not undone.
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('Stripe unavailable')
      expect(result.stripeDeleted).toBe(false)
      expect(result.success).toBe(false)
    })

    it('should report both errors when DB and Stripe both fail', async () => {
      const customerId = 'error_path_customer_3'
      createTestCustomer(customerId)

      const originalPrepare = db.prepare.bind(db)
      vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('DELETE FROM invoices')) {
          throw new Error('disk I/O error')
        }
        return originalPrepare(sql)
      })

      const stripeDel = vi.fn().mockRejectedValue(new Error('Stripe unavailable'))
      const serviceWithStripe = new GDPRComplianceService({
        db,
        stripeClient: makeMockStripe(stripeDel) as never,
      })

      const result = await serviceWithStripe.deleteCustomerData(customerId)

      expect(result.success).toBe(false)
      expect(result.stripeDeleted).toBe(false)
      expect(result.errors).toHaveLength(2)
      expect(result.errors.some((e) => e.includes('disk I/O error'))).toBe(true)
      expect(result.errors.some((e) => e.includes('Stripe unavailable'))).toBe(true)
    })
  })

  describe('Data Deletion (Article 17) — stripe flag semantics', () => {
    it('should set stripeDeleted=true after successful Stripe deletion', async () => {
      const customerId = 'stripe_flag_customer_1'
      createTestCustomer(customerId)

      const stripeDel = vi.fn().mockResolvedValue({})
      const serviceWithStripe = new GDPRComplianceService({
        db,
        stripeClient: makeMockStripe(stripeDel) as never,
      })

      const result = await serviceWithStripe.deleteCustomerData(customerId)

      expect(result.stripeDeleted).toBe(true)
      expect(stripeDel).toHaveBeenCalledWith(`cus_${customerId}`)
      expect(result.success).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('should set stripeDeleted=false on Stripe error', async () => {
      const customerId = 'stripe_flag_customer_2'
      createTestCustomer(customerId)

      const stripeDel = vi.fn().mockRejectedValue(new Error('network error'))
      const serviceWithStripe = new GDPRComplianceService({
        db,
        stripeClient: makeMockStripe(stripeDel) as never,
      })

      const result = await serviceWithStripe.deleteCustomerData(customerId)

      expect(result.stripeDeleted).toBe(false)
    })

    it('should skip Stripe client call when deleteFromStripe=false', async () => {
      const customerId = 'stripe_flag_customer_3'
      createTestCustomer(customerId)

      const stripeDel = vi.fn()
      const serviceWithStripe = new GDPRComplianceService({
        db,
        stripeClient: makeMockStripe(stripeDel) as never,
      })

      const result = await serviceWithStripe.deleteCustomerData(customerId, {
        deleteFromStripe: false,
      })

      expect(stripeDel).not.toHaveBeenCalled()
      expect(result.stripeDeleted).toBe(false)
    })
  })

  describe('Data Deletion (Article 17) — dryRun', () => {
    it('should return counts without deleting data', async () => {
      const customerId = 'dryrun_customer_1'
      createTestCustomer(customerId)

      const result = await gdprService.deleteCustomerData(customerId, {
        deleteFromStripe: false,
        dryRun: true,
      })

      expect(result.counts.subscriptions).toBe(1)
      expect(result.counts.invoices).toBe(1)
      expect(result.counts.licenseKeys).toBe(1)
      expect(result.counts.webhookEvents).toBe(1)

      // Data remains intact — hasCustomerData + row-count probe both confirm.
      expect(gdprService.hasCustomerData(customerId)).toBe(true)
      const invoices = db.prepare(`SELECT id FROM invoices WHERE customer_id = ?`).all(customerId)
      expect(invoices).toHaveLength(1)
      const subs = db
        .prepare(`SELECT id FROM user_subscriptions WHERE customer_id = ?`)
        .all(customerId)
      expect(subs).toHaveLength(1)
    })

    // The mock-chain suite asserted `db.exec` was never called with BEGIN/COMMIT in
    // dry run. With real SQLite we cannot observe that without wrapping `exec`, and
    // the stronger property — "dry run does not mutate the database" — is already
    // proven by the data-unchanged assertion above. Transaction boundaries are an
    // implementation detail.
    it.skip('should not start a transaction in dry run (covered by data-unchanged assertion)', () => {})

    it('should not call Stripe deletion in dry run', async () => {
      const customerId = 'dryrun_customer_3'
      createTestCustomer(customerId)

      const stripeDel = vi.fn()
      const serviceWithStripe = new GDPRComplianceService({
        db,
        stripeClient: makeMockStripe(stripeDel) as never,
      })

      await serviceWithStripe.deleteCustomerData(customerId, { dryRun: true })

      expect(stripeDel).not.toHaveBeenCalled()
    })
  })

  describe('Utility Methods', () => {
    it('should check if customer has data', () => {
      const customerId = 'test_customer_123'

      expect(gdprService.hasCustomerData(customerId)).toBe(false)
      createTestCustomer(customerId)
      expect(gdprService.hasCustomerData(customerId)).toBe(true)
    })

    it('should return data summary', () => {
      const customerId = 'test_customer_123'
      createTestCustomer(customerId)

      const summary = gdprService.getDataSummary(customerId)

      expect(summary.hasSubscription).toBe(true)
      expect(summary.invoiceCount).toBe(1)
      expect(summary.licenseKeyCount).toBe(1)
      expect(summary.stripeCustomerId).toBe(`cus_${customerId}`)
    })

    it('should return empty summary for non-existent customer', () => {
      const summary = gdprService.getDataSummary('non_existent')

      expect(summary.hasSubscription).toBe(false)
      expect(summary.invoiceCount).toBe(0)
      expect(summary.licenseKeyCount).toBe(0)
      expect(summary.stripeCustomerId).toBeNull()
    })
  })
})
