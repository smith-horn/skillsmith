/**
 * SMI-1063: Billing Service
 *
 * High-level billing operations that coordinate between:
 * - StripeClient (Stripe API)
 * - Database (subscription/invoice storage)
 * - LicenseKeyGenerator (license key generation)
 */

import { randomUUID } from 'crypto'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { createLogger } from '../utils/logger.js'
import type { StripeClient } from './StripeClient.js'
import type {
  BillingPeriod,
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
  CreatePortalSessionResponse,
  Invoice,
  LicenseTier,
  Subscription,
  StripeCustomerId,
  StripeEventId,
  StripeInvoiceId,
  StripePriceId,
  StripeSubscriptionId,
  SubscriptionStatus,
  WebhookEvent,
} from './types.js'
import { BillingError } from './types.js'

const logger = createLogger('BillingService')

// ============================================================================
// Configuration
// ============================================================================

export interface BillingServiceConfig {
  /**
   * StripeClient instance
   */
  stripeClient: StripeClient

  /**
   * Database connection (better-sqlite3)
   */
  db: BetterSqliteDatabase
}

// ============================================================================
// BillingService Class
// ============================================================================

/**
 * Billing service for subscription management
 *
 * @example
 * ```typescript
 * const billing = new BillingService({
 *   stripeClient,
 *   db,
 * });
 *
 * // Create checkout session
 * const session = await billing.createCheckoutSession({
 *   tier: 'team',
 *   billingPeriod: 'monthly',
 *   seatCount: 5,
 *   email: 'admin@company.com',
 *   successUrl: '/success',
 *   cancelUrl: '/cancel',
 * });
 *
 * // Get subscription
 * const subscription = await billing.getSubscriptionByCustomerId('cust_123');
 * ```
 */
export class BillingService {
  private readonly stripe: StripeClient
  private readonly db: BetterSqliteDatabase

  constructor(config: BillingServiceConfig) {
    this.stripe = config.stripeClient
    this.db = config.db

    logger.info('Billing service initialized')
  }

  // ==========================================================================
  // Checkout Flow
  // ==========================================================================

  /**
   * Create a Stripe Checkout session
   */
  async createCheckoutSession(
    request: CreateCheckoutSessionRequest
  ): Promise<CreateCheckoutSessionResponse> {
    return this.stripe.createCheckoutSession(request)
  }

  // ==========================================================================
  // Subscription Management
  // ==========================================================================

  /**
   * Get subscription by customer ID (our internal ID)
   */
  getSubscriptionByCustomerId(customerId: string): Subscription | null {
    const row = this.db
      .prepare(
        `SELECT
          id,
          customer_id as customerId,
          stripe_subscription_id as stripeSubscriptionId,
          stripe_price_id as stripePriceId,
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
      .get(customerId) as SubscriptionRow | undefined

    if (!row) return null

    return this.mapRowToSubscription(row)
  }

  /**
   * Get subscription by Stripe subscription ID
   */
  getSubscriptionByStripeId(stripeSubscriptionId: StripeSubscriptionId): Subscription | null {
    const row = this.db
      .prepare(
        `SELECT
          id,
          customer_id as customerId,
          stripe_subscription_id as stripeSubscriptionId,
          stripe_price_id as stripePriceId,
          tier,
          status,
          seat_count as seatCount,
          current_period_start as currentPeriodStart,
          current_period_end as currentPeriodEnd,
          canceled_at as canceledAt,
          created_at as createdAt,
          updated_at as updatedAt
        FROM user_subscriptions
        WHERE stripe_subscription_id = ?`
      )
      .get(stripeSubscriptionId) as SubscriptionRow | undefined

    if (!row) return null

    return this.mapRowToSubscription(row)
  }

  /**
   * Create or update subscription from Stripe data
   */
  upsertSubscription(params: {
    customerId: string
    email: string
    stripeCustomerId: StripeCustomerId
    stripeSubscriptionId: StripeSubscriptionId
    stripePriceId: string
    tier: LicenseTier
    status: SubscriptionStatus
    seatCount: number
    currentPeriodStart: Date
    currentPeriodEnd: Date
    canceledAt?: Date | null
  }): Subscription {
    const id = randomUUID()
    const now = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO user_subscriptions (
          id, customer_id, email, stripe_customer_id, stripe_subscription_id,
          stripe_price_id, tier, status, seat_count,
          current_period_start, current_period_end, canceled_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(customer_id) DO UPDATE SET
          stripe_subscription_id = excluded.stripe_subscription_id,
          stripe_price_id = excluded.stripe_price_id,
          tier = excluded.tier,
          status = excluded.status,
          seat_count = excluded.seat_count,
          current_period_start = excluded.current_period_start,
          current_period_end = excluded.current_period_end,
          canceled_at = excluded.canceled_at,
          updated_at = excluded.updated_at`
      )
      .run(
        id,
        params.customerId,
        params.email,
        params.stripeCustomerId,
        params.stripeSubscriptionId,
        params.stripePriceId,
        params.tier,
        params.status,
        params.seatCount,
        params.currentPeriodStart.toISOString(),
        params.currentPeriodEnd.toISOString(),
        params.canceledAt?.toISOString() ?? null,
        now,
        now
      )

    logger.info('Subscription upserted', {
      customerId: params.customerId,
      tier: params.tier,
      status: params.status,
    })

    return this.getSubscriptionByCustomerId(params.customerId)!
  }

  /**
   * Update subscription status
   */
  updateSubscriptionStatus(
    stripeSubscriptionId: StripeSubscriptionId,
    status: SubscriptionStatus,
    canceledAt?: Date | null
  ): void {
    this.db
      .prepare(
        `UPDATE user_subscriptions
        SET status = ?, canceled_at = ?, updated_at = ?
        WHERE stripe_subscription_id = ?`
      )
      .run(
        status,
        canceledAt?.toISOString() ?? null,
        new Date().toISOString(),
        stripeSubscriptionId
      )

    logger.info('Subscription status updated', { stripeSubscriptionId, status })
  }

  /**
   * Update seat count
   */
  async updateSeatCount(
    stripeSubscriptionId: StripeSubscriptionId,
    seatCount: number,
    prorate = true
  ): Promise<Subscription> {
    // Update in Stripe
    await this.stripe.updateSubscription(stripeSubscriptionId, {
      seatCount,
      prorate,
    })

    // Update locally
    this.db
      .prepare(
        `UPDATE user_subscriptions
        SET seat_count = ?, updated_at = ?
        WHERE stripe_subscription_id = ?`
      )
      .run(seatCount, new Date().toISOString(), stripeSubscriptionId)

    logger.info('Seat count updated', { stripeSubscriptionId, seatCount })

    return this.getSubscriptionByStripeId(stripeSubscriptionId)!
  }

  /**
   * Cancel a subscription
   */
  async cancelSubscription(
    customerId: string,
    options?: { immediately?: boolean; feedback?: string }
  ): Promise<Subscription> {
    const subscription = this.getSubscriptionByCustomerId(customerId)
    if (!subscription?.stripeSubscriptionId) {
      throw new BillingError('Subscription not found', 'SUBSCRIPTION_NOT_FOUND')
    }

    await this.stripe.cancelSubscription(
      subscription.stripeSubscriptionId as StripeSubscriptionId,
      options
    )

    // Update local status
    const newStatus = options?.immediately ? 'canceled' : subscription.status
    const canceledAt = options?.immediately ? new Date() : null

    this.updateSubscriptionStatus(
      subscription.stripeSubscriptionId as StripeSubscriptionId,
      newStatus,
      canceledAt
    )

    return this.getSubscriptionByCustomerId(customerId)!
  }

  /**
   * Upgrade subscription tier
   */
  async upgradeTier(
    customerId: string,
    newTier: LicenseTier,
    billingPeriod: BillingPeriod
  ): Promise<Subscription> {
    const subscription = this.getSubscriptionByCustomerId(customerId)
    if (!subscription?.stripeSubscriptionId) {
      throw new BillingError('Subscription not found', 'SUBSCRIPTION_NOT_FOUND')
    }

    // Validate tier upgrade
    const tierOrder: LicenseTier[] = ['community', 'individual', 'team', 'enterprise']
    const currentIndex = tierOrder.indexOf(subscription.tier)
    const newIndex = tierOrder.indexOf(newTier)

    if (newIndex <= currentIndex) {
      throw new BillingError('Can only upgrade to a higher tier', 'DOWNGRADE_NOT_ALLOWED', {
        currentTier: subscription.tier,
        requestedTier: newTier,
      })
    }

    await this.stripe.updateSubscription(
      subscription.stripeSubscriptionId as StripeSubscriptionId,
      {
        tier: newTier,
        billingPeriod,
        prorate: true,
      }
    )

    // Update local tier
    this.db
      .prepare(
        `UPDATE user_subscriptions
        SET tier = ?, updated_at = ?
        WHERE customer_id = ?`
      )
      .run(newTier, new Date().toISOString(), customerId)

    logger.info('Tier upgraded', {
      customerId,
      fromTier: subscription.tier,
      toTier: newTier,
    })

    return this.getSubscriptionByCustomerId(customerId)!
  }

  // ==========================================================================
  // Customer Portal
  // ==========================================================================

  /**
   * Create a Customer Portal session
   */
  async createPortalSession(
    customerId: string,
    returnUrl: string
  ): Promise<CreatePortalSessionResponse> {
    const subscription = this.getSubscriptionByCustomerId(customerId)
    if (!subscription) {
      throw new BillingError('Customer not found', 'CUSTOMER_NOT_FOUND')
    }

    const row = this.db
      .prepare(`SELECT stripe_customer_id FROM user_subscriptions WHERE customer_id = ?`)
      .get(customerId) as { stripe_customer_id: string } | undefined

    if (!row?.stripe_customer_id) {
      throw new BillingError('No Stripe customer found', 'CUSTOMER_NOT_FOUND')
    }

    return this.stripe.createPortalSession({
      customerId: row.stripe_customer_id,
      returnUrl,
    })
  }

  // ==========================================================================
  // Invoice Management
  // ==========================================================================

  /**
   * Get invoices for a customer
   */
  getInvoices(customerId: string, limit = 10): Invoice[] {
    const rows = this.db
      .prepare(
        `SELECT
          id,
          customer_id as customerId,
          stripe_invoice_id as stripeInvoiceId,
          subscription_id as subscriptionId,
          amount_cents as amountCents,
          currency,
          status,
          pdf_url as pdfUrl,
          hosted_invoice_url as hostedInvoiceUrl,
          invoice_number as invoiceNumber,
          paid_at as paidAt,
          period_start as periodStart,
          period_end as periodEnd,
          created_at as createdAt
        FROM invoices
        WHERE customer_id = ?
        ORDER BY created_at DESC
        LIMIT ?`
      )
      .all(customerId, limit) as InvoiceRow[]

    return rows.map(this.mapRowToInvoice)
  }

  /**
   * Store an invoice from Stripe
   */
  storeInvoice(params: {
    customerId: string
    stripeInvoiceId: string
    subscriptionId?: string
    amountCents: number
    currency: string
    status: string
    pdfUrl?: string
    hostedInvoiceUrl?: string
    invoiceNumber?: string
    paidAt?: Date
    periodStart?: Date
    periodEnd?: Date
  }): Invoice {
    const id = randomUUID()
    const now = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO invoices (
          id, customer_id, stripe_invoice_id, subscription_id,
          amount_cents, currency, status, pdf_url, hosted_invoice_url,
          invoice_number, paid_at, period_start, period_end, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stripe_invoice_id) DO UPDATE SET
          status = excluded.status,
          pdf_url = excluded.pdf_url,
          paid_at = excluded.paid_at`
      )
      .run(
        id,
        params.customerId,
        params.stripeInvoiceId,
        params.subscriptionId ?? null,
        params.amountCents,
        params.currency,
        params.status,
        params.pdfUrl ?? null,
        params.hostedInvoiceUrl ?? null,
        params.invoiceNumber ?? null,
        params.paidAt?.toISOString() ?? null,
        params.periodStart?.toISOString() ?? null,
        params.periodEnd?.toISOString() ?? null,
        now
      )

    logger.info('Invoice stored', {
      invoiceId: id,
      stripeInvoiceId: params.stripeInvoiceId,
      status: params.status,
    })

    const row = this.db
      .prepare(
        `SELECT
          id,
          customer_id as customerId,
          stripe_invoice_id as stripeInvoiceId,
          subscription_id as subscriptionId,
          amount_cents as amountCents,
          currency,
          status,
          pdf_url as pdfUrl,
          hosted_invoice_url as hostedInvoiceUrl,
          invoice_number as invoiceNumber,
          paid_at as paidAt,
          period_start as periodStart,
          period_end as periodEnd,
          created_at as createdAt
        FROM invoices WHERE stripe_invoice_id = ?`
      )
      .get(params.stripeInvoiceId) as InvoiceRow

    return this.mapRowToInvoice(row)
  }

  // ==========================================================================
  // Webhook Event Tracking (Idempotency)
  // ==========================================================================

  /**
   * Check if a webhook event has already been processed
   */
  isEventProcessed(stripeEventId: StripeEventId): boolean {
    const row = this.db
      .prepare(`SELECT id FROM stripe_webhook_events WHERE stripe_event_id = ?`)
      .get(stripeEventId)

    return !!row
  }

  /**
   * Record a processed webhook event
   */
  recordWebhookEvent(params: {
    stripeEventId: StripeEventId
    eventType: string
    payload?: string
    success?: boolean
    errorMessage?: string
  }): WebhookEvent {
    const id = randomUUID()
    const now = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO stripe_webhook_events (
          id, stripe_event_id, event_type, processed_at,
          payload, success, error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.stripeEventId,
        params.eventType,
        now,
        params.payload ?? null,
        params.success !== false ? 1 : 0,
        params.errorMessage ?? null,
        now
      )

    logger.info('Webhook event recorded', {
      eventId: params.stripeEventId,
      eventType: params.eventType,
      success: params.success !== false,
    })

    return {
      id,
      stripeEventId: params.stripeEventId,
      eventType: params.eventType as WebhookEvent['eventType'],
      processedAt: new Date(now),
      payload: params.payload ?? '',
      success: params.success !== false,
      errorMessage: params.errorMessage ?? null,
      createdAt: new Date(now),
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private mapRowToSubscription(row: SubscriptionRow): Subscription {
    return {
      id: row.id,
      customerId: row.customerId,
      stripeSubscriptionId: row.stripeSubscriptionId as StripeSubscriptionId | null,
      stripePriceId: row.stripePriceId as StripePriceId | null,
      tier: row.tier as LicenseTier,
      status: row.status as SubscriptionStatus,
      seatCount: row.seatCount ?? 1,
      currentPeriodStart: row.currentPeriodStart ? new Date(row.currentPeriodStart) : null,
      currentPeriodEnd: row.currentPeriodEnd ? new Date(row.currentPeriodEnd) : null,
      canceledAt: row.canceledAt ? new Date(row.canceledAt) : null,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    }
  }

  private mapRowToInvoice(row: InvoiceRow): Invoice {
    return {
      id: row.id,
      customerId: row.customerId,
      stripeInvoiceId: row.stripeInvoiceId as StripeInvoiceId,
      subscriptionId: row.subscriptionId,
      amountCents: row.amountCents,
      currency: row.currency,
      status: row.status as Invoice['status'],
      pdfUrl: row.pdfUrl,
      hostedInvoiceUrl: row.hostedInvoiceUrl,
      invoiceNumber: row.invoiceNumber,
      paidAt: row.paidAt ? new Date(row.paidAt) : null,
      periodStart: row.periodStart ? new Date(row.periodStart) : null,
      periodEnd: row.periodEnd ? new Date(row.periodEnd) : null,
      createdAt: new Date(row.createdAt),
    }
  }
}

// ============================================================================
// Row Types (SQLite results)
// ============================================================================

interface SubscriptionRow {
  id: string
  customerId: string
  stripeSubscriptionId: string | null
  stripePriceId: string | null
  tier: string
  status: string
  seatCount: number | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  canceledAt: string | null
  createdAt: string
  updatedAt: string
}

interface InvoiceRow {
  id: string
  customerId: string
  stripeInvoiceId: string
  subscriptionId: string | null
  amountCents: number
  currency: string
  status: string
  pdfUrl: string | null
  hostedInvoiceUrl: string | null
  invoiceNumber: string | null
  paidAt: string | null
  periodStart: string | null
  periodEnd: string | null
  createdAt: string
}
