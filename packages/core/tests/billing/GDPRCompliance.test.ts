/**
 * SMI-1068: GDPR Compliance Tests
 *
 * Tests for GDPR data export and deletion functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { GDPRComplianceService } from '../../src/billing/GDPRComplianceService.js'
import { initializeAnalyticsSchema } from '../../src/analytics/schema.js'
import { randomUUID } from 'crypto'

describe('GDPRComplianceService', () => {
  let db: Database.Database
  let gdprService: GDPRComplianceService

  beforeEach(() => {
    // Create in-memory database
    db = new Database(':memory:')
    initializeAnalyticsSchema(db)

    gdprService = new GDPRComplianceService({ db })
  })

  afterEach(() => {
    db.close()
  })

  // Helper to create test data
  function createTestCustomer(customerId: string) {
    const subscriptionId = randomUUID()
    const now = new Date().toISOString()

    // Create subscription
    db.prepare(
      `INSERT INTO user_subscriptions (
        id, customer_id, email, stripe_customer_id, stripe_subscription_id,
        stripe_price_id, tier, status, seat_count,
        current_period_start, current_period_end, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      subscriptionId,
      customerId,
      'test@example.com',
      `cus_${customerId}`,
      `sub_${customerId}`,
      'price_test',
      'team',
      'active',
      5,
      now,
      now,
      now,
      now
    )

    // Create invoice
    db.prepare(
      `INSERT INTO invoices (
        id, customer_id, stripe_invoice_id, subscription_id,
        amount_cents, currency, status, invoice_number, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      customerId,
      `in_${customerId}`,
      subscriptionId,
      2500,
      'usd',
      'paid',
      'INV-001',
      now
    )

    // Create license key with unique hash per customer
    const licenseKeyId = randomUUID()
    db.prepare(
      `INSERT INTO license_keys (
        id, subscription_id, organization_id, key_jwt, key_hash,
        key_expiry, is_active, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      licenseKeyId,
      subscriptionId,
      customerId,
      `test.jwt.token.${customerId}`,
      `hash_${customerId}_${licenseKeyId}`, // Unique hash per customer
      now,
      1,
      now
    )

    // Create webhook event
    db.prepare(
      `INSERT INTO stripe_webhook_events (
        id, stripe_event_id, event_type, processed_at,
        payload, success, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      `evt_${customerId}`,
      'customer.subscription.created',
      now,
      JSON.stringify({ customer: `cus_${customerId}` }),
      1,
      now
    )

    return subscriptionId
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
      // Ensure the actual JWT is not exported - use unknown cast for property check
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

  describe('Data Deletion (Article 17)', () => {
    it('should delete all customer data', async () => {
      const customerId = 'test_customer_123'
      createTestCustomer(customerId)

      // Verify data exists
      expect(gdprService.hasCustomerData(customerId)).toBe(true)

      const result = await gdprService.deleteCustomerData(customerId, {
        deleteFromStripe: false, // No Stripe client configured
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

      await gdprService.deleteCustomerData(customerId, {
        deleteFromStripe: false,
      })

      // Verify all data is deleted
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

      // Dry run should report counts but not delete
      expect(result.counts.subscriptions).toBe(1)
      expect(result.counts.invoices).toBe(1)
      expect(result.counts.licenseKeys).toBe(1)

      // Data should still exist
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

      // Delete first customer
      await gdprService.deleteCustomerData(customer1, {
        deleteFromStripe: false,
      })

      // First customer deleted, second still exists
      expect(gdprService.hasCustomerData(customer1)).toBe(false)
      expect(gdprService.hasCustomerData(customer2)).toBe(true)
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
