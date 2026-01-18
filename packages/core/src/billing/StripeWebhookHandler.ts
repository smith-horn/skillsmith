/**
 * SMI-1070: Stripe Webhook Handler
 *
 * Processes Stripe webhook events for:
 * - Subscription lifecycle (created, updated, deleted)
 * - Invoice events (payment succeeded, payment failed)
 * - Checkout session completion
 *
 * Features:
 * - Idempotent event processing
 * - Signature verification
 * - License key generation on subscription creation
 * - Status synchronization
 */

import type Stripe from 'stripe'
import { createHash, randomUUID } from 'crypto'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { createLogger } from '../utils/logger.js'
import { StripeClient } from './StripeClient.js'
import type { BillingService } from './BillingService.js'
import type {
  LicenseTier,
  StripeCustomerId,
  StripeEventId,
  StripeSubscriptionId,
  WebhookProcessResult,
} from './types.js'
import { BillingError } from './types.js'

const logger = createLogger('StripeWebhookHandler')

// ============================================================================
// Configuration
// ============================================================================

export interface StripeWebhookHandlerConfig {
  /**
   * StripeClient for API calls
   */
  stripeClient: StripeClient

  /**
   * BillingService for database operations
   */
  billingService: BillingService

  /**
   * Database connection (for license key storage)
   */
  db: BetterSqliteDatabase

  /**
   * Callback for license key generation
   * Called when a subscription is created/activated
   */
  onLicenseKeyNeeded?: (params: {
    customerId: string
    tier: LicenseTier
    expiresAt: Date
    subscriptionId: string
  }) => Promise<string>

  /**
   * Callback for sending emails
   */
  onEmailNeeded?: (params: {
    type: 'license_key' | 'payment_failed' | 'subscription_canceled'
    email: string
    data: Record<string, unknown>
  }) => Promise<void>
}

// ============================================================================
// StripeWebhookHandler Class
// ============================================================================

/**
 * Handles Stripe webhook events
 *
 * @example
 * ```typescript
 * const handler = new StripeWebhookHandler({
 *   stripeClient,
 *   billingService,
 *   db,
 *   onLicenseKeyNeeded: async (params) => {
 *     return licenseGenerator.createLicense(params);
 *   },
 * });
 *
 * // In webhook endpoint:
 * const result = await handler.handleWebhook(payload, signature);
 * ```
 */
export class StripeWebhookHandler {
  private readonly stripe: StripeClient
  private readonly billing: BillingService
  private readonly db: BetterSqliteDatabase
  private readonly onLicenseKeyNeeded?: StripeWebhookHandlerConfig['onLicenseKeyNeeded']
  private readonly onEmailNeeded?: StripeWebhookHandlerConfig['onEmailNeeded']

  constructor(config: StripeWebhookHandlerConfig) {
    this.stripe = config.stripeClient
    this.billing = config.billingService
    this.db = config.db
    this.onLicenseKeyNeeded = config.onLicenseKeyNeeded
    this.onEmailNeeded = config.onEmailNeeded

    logger.info('Stripe webhook handler initialized')
  }

  // ==========================================================================
  // Main Entry Point
  // ==========================================================================

  /**
   * Handle an incoming Stripe webhook
   */
  async handleWebhook(payload: string, signature: string): Promise<WebhookProcessResult> {
    // 1. Verify signature
    let event: Stripe.Event
    try {
      event = this.stripe.verifyWebhookSignature(payload, signature)
    } catch (error: unknown) {
      return {
        success: false,
        message: 'Signature verification failed',
        eventId: '' as StripeEventId,
        processed: false,
        error: error instanceof Error ? error.message : 'Invalid signature',
      }
    }

    const eventId = event.id as StripeEventId

    // 2. Check for duplicate (idempotency)
    if (this.billing.isEventProcessed(eventId)) {
      logger.info('Duplicate webhook event', { eventId, type: event.type })
      return {
        success: true,
        message: 'Event already processed',
        eventId,
        processed: false,
      }
    }

    // 3. Route to appropriate handler
    try {
      await this.routeEvent(event)

      // 4. Record successful processing
      this.billing.recordWebhookEvent({
        stripeEventId: eventId,
        eventType: event.type,
        payload,
        success: true,
      })

      logger.info('Webhook event processed', { eventId, type: event.type })

      return {
        success: true,
        message: `Processed ${event.type}`,
        eventId,
        processed: true,
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Record failed processing
      this.billing.recordWebhookEvent({
        stripeEventId: eventId,
        eventType: event.type,
        payload,
        success: false,
        errorMessage,
      })

      logger.error('Webhook processing failed', undefined, {
        eventId,
        eventType: event.type,
        errorDetails: errorMessage,
      })

      return {
        success: false,
        message: 'Processing failed',
        eventId,
        processed: false,
        error: errorMessage,
      }
    }
  }

  // ==========================================================================
  // Event Routing
  // ==========================================================================

  private async routeEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'customer.subscription.created':
        await this.handleSubscriptionCreated(event.data.object as Stripe.Subscription)
        break

      case 'customer.subscription.updated':
        await this.handleSubscriptionUpdated(event.data.object as Stripe.Subscription)
        break

      case 'customer.subscription.deleted':
        await this.handleSubscriptionDeleted(event.data.object as Stripe.Subscription)
        break

      case 'invoice.payment_succeeded':
        await this.handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice)
        break

      case 'invoice.payment_failed':
        await this.handleInvoicePaymentFailed(event.data.object as Stripe.Invoice)
        break

      case 'checkout.session.completed':
        await this.handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session)
        break

      default:
        logger.debug('Unhandled webhook event type', { type: event.type })
    }
  }

  // ==========================================================================
  // Subscription Event Handlers
  // ==========================================================================

  private async handleSubscriptionCreated(subscription: Stripe.Subscription): Promise<void> {
    logger.info('Processing subscription.created', {
      subscriptionId: subscription.id,
      customerId: subscription.customer,
      status: subscription.status,
    })

    const customer = await this.stripe.getCustomer(subscription.customer as StripeCustomerId)
    if (!customer) {
      throw new BillingError('Customer not found', 'CUSTOMER_NOT_FOUND')
    }

    const tier = this.extractTier(subscription)
    const seatCount = this.extractSeatCount(subscription)

    // Create/update subscription record
    const sub = this.billing.upsertSubscription({
      customerId: customer.id,
      email: customer.email!,
      stripeCustomerId: customer.id as StripeCustomerId,
      stripeSubscriptionId: subscription.id as StripeSubscriptionId,
      stripePriceId: subscription.items.data[0]?.price.id ?? '',
      tier,
      status: StripeClient.mapSubscriptionStatus(subscription.status),
      seatCount,
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    })

    // Generate license key if subscription is active
    if (subscription.status === 'active' && this.onLicenseKeyNeeded) {
      const licenseKey = await this.onLicenseKeyNeeded({
        customerId: customer.id,
        tier,
        expiresAt: new Date(subscription.current_period_end * 1000),
        subscriptionId: sub.id,
      })

      // Store license key
      this.storeLicenseKey({
        subscriptionId: sub.id,
        organizationId: customer.id,
        keyJwt: licenseKey,
        keyExpiry: new Date(subscription.current_period_end * 1000),
      })

      // Send license key email
      if (this.onEmailNeeded) {
        await this.onEmailNeeded({
          type: 'license_key',
          email: customer.email!,
          data: {
            licenseKey,
            tier,
            expiresAt: new Date(subscription.current_period_end * 1000).toISOString(),
          },
        })
      }
    }
  }

  private async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    logger.info('Processing subscription.updated', {
      subscriptionId: subscription.id,
      status: subscription.status,
    })

    const existingSub = this.billing.getSubscriptionByStripeId(
      subscription.id as StripeSubscriptionId
    )

    if (!existingSub) {
      // Subscription doesn't exist locally, create it
      await this.handleSubscriptionCreated(subscription)
      return
    }

    // Update status
    const newStatus = StripeClient.mapSubscriptionStatus(subscription.status)
    const canceledAt = subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null

    this.billing.updateSubscriptionStatus(
      subscription.id as StripeSubscriptionId,
      newStatus,
      canceledAt
    )

    // Check if tier changed (regenerate license key)
    const newTier = this.extractTier(subscription)
    if (existingSub.tier !== newTier && this.onLicenseKeyNeeded) {
      const customer = await this.stripe.getCustomer(subscription.customer as StripeCustomerId)
      if (customer) {
        // Revoke old license key
        this.revokeLicenseKey(existingSub.id, 'tier_change')

        // Generate new license key
        const licenseKey = await this.onLicenseKeyNeeded({
          customerId: customer.id,
          tier: newTier,
          expiresAt: new Date(subscription.current_period_end * 1000),
          subscriptionId: existingSub.id,
        })

        this.storeLicenseKey({
          subscriptionId: existingSub.id,
          organizationId: customer.id,
          keyJwt: licenseKey,
          keyExpiry: new Date(subscription.current_period_end * 1000),
        })
      }
    }
  }

  private async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    logger.info('Processing subscription.deleted', {
      subscriptionId: subscription.id,
    })

    const existingSub = this.billing.getSubscriptionByStripeId(
      subscription.id as StripeSubscriptionId
    )

    if (existingSub) {
      // Update status to canceled
      this.billing.updateSubscriptionStatus(
        subscription.id as StripeSubscriptionId,
        'canceled',
        new Date()
      )

      // Revoke license key
      this.revokeLicenseKey(existingSub.id, 'subscription_canceled')

      // Send cancellation email
      if (this.onEmailNeeded) {
        const customer = await this.stripe.getCustomer(subscription.customer as StripeCustomerId)
        if (customer?.email) {
          await this.onEmailNeeded({
            type: 'subscription_canceled',
            email: customer.email,
            data: {
              subscriptionId: subscription.id,
              canceledAt: new Date().toISOString(),
            },
          })
        }
      }
    }
  }

  // ==========================================================================
  // Invoice Event Handlers
  // ==========================================================================

  private async handleInvoicePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
    logger.info('Processing invoice.payment_succeeded', {
      invoiceId: invoice.id,
      customerId: invoice.customer,
      amount: invoice.amount_paid,
    })

    const customerId =
      typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id

    if (!customerId) return

    // Store invoice
    this.billing.storeInvoice({
      customerId,
      stripeInvoiceId: invoice.id,
      subscriptionId:
        typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id,
      amountCents: invoice.amount_paid,
      currency: invoice.currency,
      status: 'paid',
      pdfUrl: invoice.invoice_pdf ?? undefined,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? undefined,
      invoiceNumber: invoice.number ?? undefined,
      paidAt: invoice.status_transitions?.paid_at
        ? new Date(invoice.status_transitions.paid_at * 1000)
        : new Date(),
      periodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : undefined,
      periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : undefined,
    })
  }

  private async handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    logger.warn('Processing invoice.payment_failed', {
      invoiceId: invoice.id,
      customerId: invoice.customer,
      amount: invoice.amount_due,
    })

    const customerId =
      typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id

    if (!customerId) return

    // Store invoice with failed status
    this.billing.storeInvoice({
      customerId,
      stripeInvoiceId: invoice.id,
      subscriptionId:
        typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id,
      amountCents: invoice.amount_due,
      currency: invoice.currency,
      status: 'open',
      pdfUrl: invoice.invoice_pdf ?? undefined,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? undefined,
      invoiceNumber: invoice.number ?? undefined,
    })

    // Send payment failed email
    if (this.onEmailNeeded) {
      const customer = await this.stripe.getCustomer(customerId as StripeCustomerId)
      if (customer?.email) {
        await this.onEmailNeeded({
          type: 'payment_failed',
          email: customer.email,
          data: {
            invoiceId: invoice.id,
            amount: invoice.amount_due,
            currency: invoice.currency,
            hostedInvoiceUrl: invoice.hosted_invoice_url,
          },
        })
      }
    }
  }

  // ==========================================================================
  // Checkout Event Handlers
  // ==========================================================================

  private async handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
    logger.info('Processing checkout.session.completed', {
      sessionId: session.id,
      customerId: session.customer,
      subscriptionId: session.subscription,
    })

    // The subscription.created event will handle the actual subscription setup
    // This handler is useful for tracking successful checkouts and analytics
  }

  // ==========================================================================
  // License Key Management
  // ==========================================================================

  private storeLicenseKey(params: {
    subscriptionId: string
    organizationId: string
    keyJwt: string
    keyExpiry: Date
  }): void {
    const id = randomUUID()
    const keyHash = createHash('sha256').update(params.keyJwt).digest('hex')
    const now = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO license_keys (
          id, subscription_id, organization_id, key_jwt, key_hash,
          key_expiry, is_active, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        id,
        params.subscriptionId,
        params.organizationId,
        params.keyJwt,
        keyHash,
        params.keyExpiry.toISOString(),
        now
      )

    logger.info('License key stored', {
      subscriptionId: params.subscriptionId,
      keyHash: keyHash.slice(0, 16) + '...',
    })
  }

  private revokeLicenseKey(subscriptionId: string, reason: string): void {
    const now = new Date().toISOString()

    this.db
      .prepare(
        `UPDATE license_keys
        SET is_active = 0, revoked_at = ?, revocation_reason = ?
        WHERE subscription_id = ? AND is_active = 1`
      )
      .run(now, reason, subscriptionId)

    logger.info('License key revoked', { subscriptionId, reason })
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private extractTier(subscription: Stripe.Subscription): LicenseTier {
    // Try to get tier from metadata first
    const metadataTier = subscription.metadata?.tier as LicenseTier | undefined
    if (metadataTier && ['community', 'individual', 'team', 'enterprise'].includes(metadataTier)) {
      return metadataTier
    }

    // Fallback: infer from price ID or default to individual
    return 'individual'
  }

  private extractSeatCount(subscription: Stripe.Subscription): number {
    // Try metadata first
    const metadataSeats = subscription.metadata?.seatCount
    if (metadataSeats) {
      const count = parseInt(metadataSeats, 10)
      if (!isNaN(count) && count > 0) {
        return count
      }
    }

    // Fallback to quantity from first item
    return subscription.items.data[0]?.quantity ?? 1
  }
}
