/**
 * SMI-1068: GDPR Compliance Service
 *
 * Provides data subject rights implementation for billing data:
 * - Article 17: Right to Erasure (data deletion)
 * - Article 20: Right to Data Portability (data export)
 *
 * All operations are logged for audit purposes.
 */

import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { createLogger } from '../utils/logger.js'
import type { StripeClient } from './StripeClient.js'
import type {
  GDPRComplianceServiceConfig,
  CustomerDataExport,
  SubscriptionExportData,
  InvoiceExportData,
  LicenseKeyExportData,
  WebhookEventExportData,
  DeletionResult,
} from './gdpr-types.js'

// Re-export types for backward compatibility
export type {
  GDPRComplianceServiceConfig,
  CustomerDataExport,
  SubscriptionExportData,
  InvoiceExportData,
  LicenseKeyExportData,
  WebhookEventExportData,
  DeletionResult,
} from './gdpr-types.js'

const logger = createLogger('GDPRComplianceService')

// ============================================================================
// GDPRComplianceService Class
// ============================================================================

/**
 * GDPR Compliance Service for billing data
 *
 * @example
 * ```typescript
 * const gdpr = new GDPRComplianceService({
 *   db,
 *   stripeClient,
 * });
 *
 * // Export customer data (Article 20)
 * const data = gdpr.exportCustomerData('customer_123');
 *
 * // Delete customer data (Article 17)
 * const result = await gdpr.deleteCustomerData('customer_123');
 * ```
 */
export class GDPRComplianceService {
  private readonly db: BetterSqliteDatabase
  private readonly stripe?: StripeClient

  constructor(config: GDPRComplianceServiceConfig) {
    this.db = config.db
    this.stripe = config.stripeClient

    logger.info('GDPR Compliance service initialized')
  }

  // ==========================================================================
  // Data Export (Article 20: Right to Data Portability)
  // ==========================================================================

  /**
   * Export all billing data for a customer
   *
   * Returns a structured JSON export of all data associated with the customer.
   * This fulfills GDPR Article 20 requirements.
   *
   * @param customerId - The customer ID to export data for
   * @returns Complete data export in JSON format
   */
  exportCustomerData(customerId: string): CustomerDataExport {
    logger.info('Starting customer data export', { customerId })

    const subscriptions = this.exportSubscriptions(customerId)
    const invoices = this.exportInvoices(customerId)
    const licenseKeys = this.exportLicenseKeys(customerId)
    const webhookEvents = this.exportWebhookEvents(customerId)

    const exportData: CustomerDataExport = {
      metadata: {
        exportedAt: new Date().toISOString(),
        customerId,
        format: 'json',
        version: '1.0',
      },
      subscriptions,
      invoices,
      licenseKeys,
      webhookEvents,
    }

    logger.info('Customer data export completed', {
      customerId,
      subscriptionCount: subscriptions.length,
      invoiceCount: invoices.length,
      licenseKeyCount: licenseKeys.length,
      webhookEventCount: webhookEvents.length,
    })

    return exportData
  }

  private exportSubscriptions(customerId: string): SubscriptionExportData[] {
    const rows = this.db
      .prepare(
        `SELECT
          id,
          stripe_subscription_id as stripeSubscriptionId,
          tier,
          status,
          seat_count as seatCount,
          current_period_start as currentPeriodStart,
          current_period_end as currentPeriodEnd,
          canceled_at as canceledAt,
          created_at as createdAt,
          updated_at as updatedAt
        FROM user_subscriptions
        WHERE customer_id = ?`
      )
      .all(customerId) as SubscriptionExportData[]

    return rows.map((row) => ({
      ...row,
      seatCount: row.seatCount ?? 1,
    }))
  }

  private exportInvoices(customerId: string): InvoiceExportData[] {
    const rows = this.db
      .prepare(
        `SELECT
          id,
          stripe_invoice_id as stripeInvoiceId,
          amount_cents as amountCents,
          currency,
          status,
          invoice_number as invoiceNumber,
          paid_at as paidAt,
          period_start as periodStart,
          period_end as periodEnd,
          created_at as createdAt
        FROM invoices
        WHERE customer_id = ?`
      )
      .all(customerId) as InvoiceExportData[]

    return rows
  }

  private exportLicenseKeys(customerId: string): LicenseKeyExportData[] {
    // Get subscription IDs for this customer
    const subscriptionIds = this.db
      .prepare(`SELECT id FROM user_subscriptions WHERE customer_id = ?`)
      .all(customerId) as { id: string }[]

    if (subscriptionIds.length === 0) {
      return []
    }

    const placeholders = subscriptionIds.map(() => '?').join(',')
    const ids = subscriptionIds.map((s) => s.id)

    const rows = this.db
      .prepare(
        `SELECT
          id,
          key_expiry as keyExpiry,
          is_active as isActive,
          generated_at as generatedAt,
          revoked_at as revokedAt,
          revocation_reason as revocationReason
        FROM license_keys
        WHERE subscription_id IN (${placeholders})`
      )
      .all(...ids) as Array<{
      id: string
      keyExpiry: string
      isActive: number
      generatedAt: string
      revokedAt: string | null
      revocationReason: string | null
    }>

    return rows.map((row) => ({
      id: row.id,
      keyExpiry: row.keyExpiry,
      isActive: row.isActive === 1,
      generatedAt: row.generatedAt,
      revokedAt: row.revokedAt,
      revocationReason: row.revocationReason,
    }))
  }

  private exportWebhookEvents(customerId: string): WebhookEventExportData[] {
    // Get stripe customer ID for this customer
    const customer = this.db
      .prepare(`SELECT stripe_customer_id FROM user_subscriptions WHERE customer_id = ? LIMIT 1`)
      .get(customerId) as { stripe_customer_id: string } | undefined

    if (!customer?.stripe_customer_id) {
      return []
    }

    // Find webhook events that contain this customer ID in the payload
    const rows = this.db
      .prepare(
        `SELECT
          id,
          stripe_event_id as stripeEventId,
          event_type as eventType,
          processed_at as processedAt,
          success
        FROM stripe_webhook_events
        WHERE payload LIKE ?`
      )
      .all(`%${customer.stripe_customer_id}%`) as Array<{
      id: string
      stripeEventId: string
      eventType: string
      processedAt: string
      success: number
    }>

    return rows.map((row) => ({
      id: row.id,
      stripeEventId: row.stripeEventId,
      eventType: row.eventType,
      processedAt: row.processedAt,
      success: row.success === 1,
    }))
  }

  // ==========================================================================
  // Data Deletion (Article 17: Right to Erasure)
  // ==========================================================================

  /**
   * Delete all billing data for a customer
   *
   * Performs cascading deletion of:
   * 1. License keys
   * 2. Invoices
   * 3. Webhook events (those containing customer data)
   * 4. Subscriptions
   * 5. Stripe customer (if stripeClient provided)
   *
   * This fulfills GDPR Article 17 requirements.
   *
   * @param customerId - The customer ID to delete data for
   * @param options - Deletion options
   * @returns Result of the deletion operation
   */
  async deleteCustomerData(
    customerId: string,
    options?: {
      deleteFromStripe?: boolean
      dryRun?: boolean
    }
  ): Promise<DeletionResult> {
    const dryRun = options?.dryRun ?? false
    const deleteFromStripe = options?.deleteFromStripe ?? true

    logger.info('Starting customer data deletion', { customerId, dryRun })

    const errors: string[] = []
    const counts = {
      subscriptions: 0,
      invoices: 0,
      licenseKeys: 0,
      webhookEvents: 0,
    }

    // Get Stripe customer ID before deletion
    const stripeCustomerRow = this.db
      .prepare(`SELECT stripe_customer_id FROM user_subscriptions WHERE customer_id = ? LIMIT 1`)
      .get(customerId) as { stripe_customer_id: string } | undefined

    const stripeCustomerId = stripeCustomerRow?.stripe_customer_id

    // Perform deletion in a transaction
    if (!dryRun) {
      this.db.exec('BEGIN TRANSACTION')
    }

    try {
      // 1. Delete license keys (depends on subscriptions)
      const subscriptionIds = this.db
        .prepare(`SELECT id FROM user_subscriptions WHERE customer_id = ?`)
        .all(customerId) as { id: string }[]

      if (subscriptionIds.length > 0) {
        const placeholders = subscriptionIds.map(() => '?').join(',')
        const ids = subscriptionIds.map((s) => s.id)

        if (dryRun) {
          const count = this.db
            .prepare(
              `SELECT COUNT(*) as count FROM license_keys WHERE subscription_id IN (${placeholders})`
            )
            .get(...ids) as { count: number }
          counts.licenseKeys = count.count
        } else {
          const result = this.db
            .prepare(`DELETE FROM license_keys WHERE subscription_id IN (${placeholders})`)
            .run(...ids)
          counts.licenseKeys = result.changes
        }
      }

      // 2. Delete invoices
      if (dryRun) {
        const count = this.db
          .prepare(`SELECT COUNT(*) as count FROM invoices WHERE customer_id = ?`)
          .get(customerId) as { count: number }
        counts.invoices = count.count
      } else {
        const result = this.db.prepare(`DELETE FROM invoices WHERE customer_id = ?`).run(customerId)
        counts.invoices = result.changes
      }

      // 3. Delete related webhook events (containing customer ID in payload)
      if (stripeCustomerId) {
        if (dryRun) {
          const count = this.db
            .prepare(`SELECT COUNT(*) as count FROM stripe_webhook_events WHERE payload LIKE ?`)
            .get(`%${stripeCustomerId}%`) as { count: number }
          counts.webhookEvents = count.count
        } else {
          const result = this.db
            .prepare(`DELETE FROM stripe_webhook_events WHERE payload LIKE ?`)
            .run(`%${stripeCustomerId}%`)
          counts.webhookEvents = result.changes
        }
      }

      // 4. Delete subscriptions
      if (dryRun) {
        const count = this.db
          .prepare(`SELECT COUNT(*) as count FROM user_subscriptions WHERE customer_id = ?`)
          .get(customerId) as { count: number }
        counts.subscriptions = count.count
      } else {
        const result = this.db
          .prepare(`DELETE FROM user_subscriptions WHERE customer_id = ?`)
          .run(customerId)
        counts.subscriptions = result.changes
      }

      if (!dryRun) {
        this.db.exec('COMMIT')
      }
    } catch (error: unknown) {
      if (!dryRun) {
        this.db.exec('ROLLBACK')
      }
      const errorMsg = error instanceof Error ? error.message : String(error)
      errors.push(`Database deletion failed: ${errorMsg}`)
      logger.error('Customer data deletion failed', undefined, { customerId, error: errorMsg })
    }

    // 5. Delete from Stripe if requested
    let stripeDeleted = false
    if (deleteFromStripe && stripeCustomerId && this.stripe && !dryRun) {
      try {
        const stripeInstance = this.stripe.getStripeInstance()
        await stripeInstance.customers.del(stripeCustomerId)
        stripeDeleted = true
        logger.info('Stripe customer deleted', { stripeCustomerId })
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        errors.push(`Stripe deletion failed: ${errorMsg}`)
        logger.error('Stripe customer deletion failed', undefined, {
          stripeCustomerId,
          error: errorMsg,
        })
      }
    }

    const result: DeletionResult = {
      success: errors.length === 0,
      customerId,
      deletedAt: new Date().toISOString(),
      counts,
      stripeDeleted,
      errors,
    }

    logger.info('Customer data deletion completed', {
      customerId,
      success: result.success,
      counts,
      dryRun,
    })

    return result
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Check if a customer has any billing data
   */
  hasCustomerData(customerId: string): boolean {
    const subscription = this.db
      .prepare(`SELECT id FROM user_subscriptions WHERE customer_id = ? LIMIT 1`)
      .get(customerId)

    return !!subscription
  }

  /**
   * Get a summary of customer data (for consent/overview purposes)
   */
  getDataSummary(customerId: string): {
    hasSubscription: boolean
    invoiceCount: number
    licenseKeyCount: number
    stripeCustomerId: string | null
  } {
    const subscription = this.db
      .prepare(
        `SELECT id, stripe_customer_id FROM user_subscriptions WHERE customer_id = ? LIMIT 1`
      )
      .get(customerId) as { id: string; stripe_customer_id: string } | undefined

    if (!subscription) {
      return {
        hasSubscription: false,
        invoiceCount: 0,
        licenseKeyCount: 0,
        stripeCustomerId: null,
      }
    }

    const invoiceCount = this.db
      .prepare(`SELECT COUNT(*) as count FROM invoices WHERE customer_id = ?`)
      .get(customerId) as { count: number }

    const licenseKeyCount = this.db
      .prepare(`SELECT COUNT(*) as count FROM license_keys WHERE subscription_id = ?`)
      .get(subscription.id) as { count: number }

    return {
      hasSubscription: true,
      invoiceCount: invoiceCount.count,
      licenseKeyCount: licenseKeyCount.count,
      stripeCustomerId: subscription.stripe_customer_id,
    }
  }
}
