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
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { createLogger } from '../utils/logger.js'
import type { StripeClient } from './StripeClient.js'
import type { BillingService } from './BillingService.js'
import type { StripeEventId, WebhookProcessResult } from './types.js'
import type { StripeWebhookHandlerConfig } from './webhook-types.js'
import {
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed,
  handleCheckoutSessionCompleted,
  type WebhookHandlerContext,
} from './webhook-handlers.js'

// Re-export types for backward compatibility
export type { StripeWebhookHandlerConfig } from './webhook-types.js'

const logger = createLogger('StripeWebhookHandler')

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
    const ctx: WebhookHandlerContext = {
      stripe: this.stripe,
      billing: this.billing,
      db: this.db,
      onLicenseKeyNeeded: this.onLicenseKeyNeeded,
      onEmailNeeded: this.onEmailNeeded,
    }

    switch (event.type) {
      case 'customer.subscription.created':
        await handleSubscriptionCreated(ctx, event.data.object as Stripe.Subscription)
        break

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(ctx, event.data.object as Stripe.Subscription)
        break

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(ctx, event.data.object as Stripe.Subscription)
        break

      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(ctx, event.data.object as Stripe.Invoice)
        break

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(ctx, event.data.object as Stripe.Invoice)
        break

      case 'checkout.session.completed':
        handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session)
        break

      default:
        logger.debug('Unhandled webhook event type', { type: event.type })
    }
  }
}
