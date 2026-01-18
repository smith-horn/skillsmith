/**
 * SMI-1069: Stripe Reconciliation Job
 *
 * Periodically reconciles local subscription and invoice data with Stripe.
 * Identifies and reports discrepancies to ensure data consistency.
 *
 * Features:
 * - Subscription status sync
 * - Invoice status verification
 * - Missing data detection
 * - Automatic correction (optional)
 * - Detailed reporting
 */

import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type Stripe from 'stripe'
import { createLogger } from '../utils/logger.js'
import type { StripeClient } from './StripeClient.js'
import type { StripeSubscriptionId, SubscriptionStatus } from './types.js'

const logger = createLogger('StripeReconciliation')

// ============================================================================
// Configuration
// ============================================================================

export interface StripeReconciliationJobConfig {
  /**
   * StripeClient for API calls
   */
  stripeClient: StripeClient

  /**
   * Database connection
   */
  db: BetterSqliteDatabase

  /**
   * Whether to automatically fix discrepancies
   * @default false
   */
  autoFix?: boolean

  /**
   * Maximum subscriptions to process per run
   * @default 100
   */
  batchSize?: number
}

// ============================================================================
// Types
// ============================================================================

export type DiscrepancyType =
  | 'status_mismatch'
  | 'missing_local'
  | 'missing_stripe'
  | 'tier_mismatch'
  | 'seat_count_mismatch'
  | 'period_mismatch'
  | 'invoice_status_mismatch'
  | 'invoice_amount_mismatch'

export interface Discrepancy {
  type: DiscrepancyType
  entityType: 'subscription' | 'invoice'
  entityId: string
  stripeId: string
  localValue: string | number | null
  stripeValue: string | number | null
  description: string
  fixed: boolean
}

export interface ReconciliationResult {
  success: boolean
  startedAt: string
  completedAt: string
  durationMs: number
  stats: {
    subscriptionsChecked: number
    invoicesChecked: number
    discrepanciesFound: number
    discrepanciesFixed: number
  }
  discrepancies: Discrepancy[]
  errors: string[]
}

// ============================================================================
// StripeReconciliationJob Class
// ============================================================================

/**
 * Stripe Reconciliation Job
 *
 * @example
 * ```typescript
 * const job = new StripeReconciliationJob({
 *   stripeClient,
 *   db,
 *   autoFix: true,
 * });
 *
 * // Run reconciliation
 * const result = await job.run();
 * console.log(`Found ${result.discrepancies.length} discrepancies`);
 * ```
 */
export class StripeReconciliationJob {
  private readonly stripe: StripeClient
  private readonly db: BetterSqliteDatabase
  private readonly autoFix: boolean
  private readonly batchSize: number

  constructor(config: StripeReconciliationJobConfig) {
    this.stripe = config.stripeClient
    this.db = config.db
    this.autoFix = config.autoFix ?? false
    this.batchSize = config.batchSize ?? 100

    logger.info('Stripe reconciliation job initialized', {
      autoFix: this.autoFix,
      batchSize: this.batchSize,
    })
  }

  // ==========================================================================
  // Main Entry Point
  // ==========================================================================

  /**
   * Run the reconciliation job
   */
  async run(): Promise<ReconciliationResult> {
    const startedAt = new Date()
    const discrepancies: Discrepancy[] = []
    const errors: string[] = []
    let subscriptionsChecked = 0
    let invoicesChecked = 0
    let discrepanciesFixed = 0

    logger.info('Starting Stripe reconciliation job')

    try {
      // 1. Get all local subscriptions with Stripe IDs
      const localSubscriptions = this.getLocalSubscriptions()
      subscriptionsChecked = localSubscriptions.length

      // 2. Reconcile each subscription
      for (const local of localSubscriptions) {
        try {
          const subDiscrepancies = await this.reconcileSubscription(local)
          discrepancies.push(...subDiscrepancies)
        } catch (error: unknown) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          errors.push(`Subscription ${local.stripeSubscriptionId}: ${errorMsg}`)
        }
      }

      // 3. Reconcile invoices
      const localInvoices = this.getLocalInvoices()
      invoicesChecked = localInvoices.length

      for (const invoice of localInvoices) {
        try {
          const invDiscrepancies = await this.reconcileInvoice(invoice)
          discrepancies.push(...invDiscrepancies)
        } catch (error: unknown) {
          const errorMsg = error instanceof Error ? error.message : String(error)
          errors.push(`Invoice ${invoice.stripeInvoiceId}: ${errorMsg}`)
        }
      }

      // 4. Apply fixes if autoFix is enabled
      if (this.autoFix) {
        for (const discrepancy of discrepancies) {
          if (this.fixDiscrepancy(discrepancy)) {
            discrepancy.fixed = true
            discrepanciesFixed++
          }
        }
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      errors.push(`Job failed: ${errorMsg}`)
      logger.error('Reconciliation job failed', undefined, { error: errorMsg })
    }

    const completedAt = new Date()
    const result: ReconciliationResult = {
      success: errors.length === 0,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      stats: {
        subscriptionsChecked,
        invoicesChecked,
        discrepanciesFound: discrepancies.length,
        discrepanciesFixed,
      },
      discrepancies,
      errors,
    }

    logger.info('Stripe reconciliation job completed', {
      success: result.success,
      subscriptionsChecked,
      invoicesChecked,
      discrepanciesFound: discrepancies.length,
      discrepanciesFixed,
      durationMs: result.durationMs,
    })

    return result
  }

  // ==========================================================================
  // Subscription Reconciliation
  // ==========================================================================

  private getLocalSubscriptions(): LocalSubscription[] {
    return this.db
      .prepare(
        `SELECT
          id,
          customer_id as customerId,
          stripe_subscription_id as stripeSubscriptionId,
          stripe_customer_id as stripeCustomerId,
          tier,
          status,
          seat_count as seatCount,
          current_period_start as currentPeriodStart,
          current_period_end as currentPeriodEnd
        FROM user_subscriptions
        WHERE stripe_subscription_id IS NOT NULL
        LIMIT ?`
      )
      .all(this.batchSize) as LocalSubscription[]
  }

  private async reconcileSubscription(local: LocalSubscription): Promise<Discrepancy[]> {
    const discrepancies: Discrepancy[] = []

    // Fetch from Stripe
    const stripeSubscription = await this.stripe.getSubscription(
      local.stripeSubscriptionId as StripeSubscriptionId
    )

    if (!stripeSubscription) {
      discrepancies.push({
        type: 'missing_stripe',
        entityType: 'subscription',
        entityId: local.id,
        stripeId: local.stripeSubscriptionId,
        localValue: local.status,
        stripeValue: null,
        description: 'Subscription exists locally but not in Stripe',
        fixed: false,
      })
      return discrepancies
    }

    // Compare status
    const stripeStatus = mapStripeStatus(stripeSubscription.status)
    if (local.status !== stripeStatus) {
      discrepancies.push({
        type: 'status_mismatch',
        entityType: 'subscription',
        entityId: local.id,
        stripeId: local.stripeSubscriptionId,
        localValue: local.status,
        stripeValue: stripeStatus,
        description: `Status mismatch: local=${local.status}, stripe=${stripeStatus}`,
        fixed: false,
      })
    }

    // Compare tier (from metadata)
    const stripeTier = stripeSubscription.metadata?.tier
    if (stripeTier && local.tier !== stripeTier) {
      discrepancies.push({
        type: 'tier_mismatch',
        entityType: 'subscription',
        entityId: local.id,
        stripeId: local.stripeSubscriptionId,
        localValue: local.tier,
        stripeValue: stripeTier,
        description: `Tier mismatch: local=${local.tier}, stripe=${stripeTier}`,
        fixed: false,
      })
    }

    // Compare seat count
    const stripeQuantity = stripeSubscription.items.data[0]?.quantity ?? 1
    if (local.seatCount !== stripeQuantity) {
      discrepancies.push({
        type: 'seat_count_mismatch',
        entityType: 'subscription',
        entityId: local.id,
        stripeId: local.stripeSubscriptionId,
        localValue: local.seatCount,
        stripeValue: stripeQuantity,
        description: `Seat count mismatch: local=${local.seatCount}, stripe=${stripeQuantity}`,
        fixed: false,
      })
    }

    return discrepancies
  }

  // ==========================================================================
  // Invoice Reconciliation
  // ==========================================================================

  private getLocalInvoices(): LocalInvoice[] {
    return this.db
      .prepare(
        `SELECT
          id,
          customer_id as customerId,
          stripe_invoice_id as stripeInvoiceId,
          amount_cents as amountCents,
          status
        FROM invoices
        WHERE stripe_invoice_id IS NOT NULL
        LIMIT ?`
      )
      .all(this.batchSize) as LocalInvoice[]
  }

  private async reconcileInvoice(local: LocalInvoice): Promise<Discrepancy[]> {
    const discrepancies: Discrepancy[] = []

    // Fetch from Stripe
    const stripeInvoice = await this.stripe.getInvoice(local.stripeInvoiceId)

    if (!stripeInvoice) {
      discrepancies.push({
        type: 'missing_stripe',
        entityType: 'invoice',
        entityId: local.id,
        stripeId: local.stripeInvoiceId,
        localValue: local.status,
        stripeValue: null,
        description: 'Invoice exists locally but not in Stripe',
        fixed: false,
      })
      return discrepancies
    }

    // Compare status
    const stripeStatus = mapInvoiceStatus(stripeInvoice.status)
    if (local.status !== stripeStatus) {
      discrepancies.push({
        type: 'invoice_status_mismatch',
        entityType: 'invoice',
        entityId: local.id,
        stripeId: local.stripeInvoiceId,
        localValue: local.status,
        stripeValue: stripeStatus,
        description: `Invoice status mismatch: local=${local.status}, stripe=${stripeStatus}`,
        fixed: false,
      })
    }

    // Compare amount
    const stripeAmount = stripeInvoice.amount_paid ?? stripeInvoice.amount_due
    if (local.amountCents !== stripeAmount) {
      discrepancies.push({
        type: 'invoice_amount_mismatch',
        entityType: 'invoice',
        entityId: local.id,
        stripeId: local.stripeInvoiceId,
        localValue: local.amountCents,
        stripeValue: stripeAmount,
        description: `Invoice amount mismatch: local=${local.amountCents}, stripe=${stripeAmount}`,
        fixed: false,
      })
    }

    return discrepancies
  }

  // ==========================================================================
  // Fix Discrepancies
  // ==========================================================================

  private fixDiscrepancy(discrepancy: Discrepancy): boolean {
    try {
      if (discrepancy.entityType === 'subscription') {
        return this.fixSubscriptionDiscrepancy(discrepancy)
      } else if (discrepancy.entityType === 'invoice') {
        return this.fixInvoiceDiscrepancy(discrepancy)
      }
      return false
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error('Failed to fix discrepancy', undefined, {
        type: discrepancy.type,
        entityId: discrepancy.entityId,
        error: errorMsg,
      })
      return false
    }
  }

  private fixSubscriptionDiscrepancy(discrepancy: Discrepancy): boolean {
    switch (discrepancy.type) {
      case 'status_mismatch':
        this.db
          .prepare(`UPDATE user_subscriptions SET status = ?, updated_at = ? WHERE id = ?`)
          .run(discrepancy.stripeValue, new Date().toISOString(), discrepancy.entityId)
        logger.info('Fixed subscription status', {
          entityId: discrepancy.entityId,
          newStatus: discrepancy.stripeValue,
        })
        return true

      case 'tier_mismatch':
        this.db
          .prepare(`UPDATE user_subscriptions SET tier = ?, updated_at = ? WHERE id = ?`)
          .run(discrepancy.stripeValue, new Date().toISOString(), discrepancy.entityId)
        logger.info('Fixed subscription tier', {
          entityId: discrepancy.entityId,
          newTier: discrepancy.stripeValue,
        })
        return true

      case 'seat_count_mismatch':
        this.db
          .prepare(`UPDATE user_subscriptions SET seat_count = ?, updated_at = ? WHERE id = ?`)
          .run(discrepancy.stripeValue, new Date().toISOString(), discrepancy.entityId)
        logger.info('Fixed subscription seat count', {
          entityId: discrepancy.entityId,
          newSeatCount: discrepancy.stripeValue,
        })
        return true

      case 'missing_stripe':
        // Mark local subscription as canceled if missing in Stripe
        this.db
          .prepare(
            `UPDATE user_subscriptions SET status = 'canceled', canceled_at = ?, updated_at = ? WHERE id = ?`
          )
          .run(new Date().toISOString(), new Date().toISOString(), discrepancy.entityId)
        logger.info('Marked missing subscription as canceled', { entityId: discrepancy.entityId })
        return true

      default:
        return false
    }
  }

  private fixInvoiceDiscrepancy(discrepancy: Discrepancy): boolean {
    switch (discrepancy.type) {
      case 'invoice_status_mismatch':
        this.db
          .prepare(`UPDATE invoices SET status = ? WHERE id = ?`)
          .run(discrepancy.stripeValue, discrepancy.entityId)
        logger.info('Fixed invoice status', {
          entityId: discrepancy.entityId,
          newStatus: discrepancy.stripeValue,
        })
        return true

      case 'invoice_amount_mismatch':
        this.db
          .prepare(`UPDATE invoices SET amount_cents = ? WHERE id = ?`)
          .run(discrepancy.stripeValue, discrepancy.entityId)
        logger.info('Fixed invoice amount', {
          entityId: discrepancy.entityId,
          newAmount: discrepancy.stripeValue,
        })
        return true

      default:
        return false
    }
  }
}

// ============================================================================
// Helper Types
// ============================================================================

interface LocalSubscription {
  id: string
  customerId: string
  stripeSubscriptionId: string
  stripeCustomerId: string
  tier: string
  status: string
  seatCount: number
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
}

interface LocalInvoice {
  id: string
  customerId: string
  stripeInvoiceId: string
  amountCents: number
  status: string
}

// ============================================================================
// Helper Functions
// ============================================================================

function mapStripeStatus(stripeStatus: Stripe.Subscription.Status): SubscriptionStatus {
  switch (stripeStatus) {
    case 'active':
      return 'active'
    case 'past_due':
      return 'past_due'
    case 'canceled':
      return 'canceled'
    case 'trialing':
      return 'trialing'
    case 'paused':
      return 'paused'
    case 'incomplete':
      return 'incomplete'
    case 'incomplete_expired':
      return 'incomplete_expired'
    case 'unpaid':
      return 'unpaid'
    default:
      return 'active'
  }
}

function mapInvoiceStatus(stripeStatus: Stripe.Invoice.Status | null): string {
  switch (stripeStatus) {
    case 'paid':
      return 'paid'
    case 'open':
      return 'open'
    case 'draft':
      return 'draft'
    case 'void':
      return 'void'
    case 'uncollectible':
      return 'uncollectible'
    default:
      return 'open'
  }
}
