/**
 * SMI-1062: Stripe Client Wrapper
 *
 * Provides a type-safe wrapper around the Stripe SDK with:
 * - Customer management
 * - Subscription management
 * - Checkout session creation
 * - Customer portal sessions
 * - Invoice retrieval
 * - Webhook signature verification
 */

import Stripe from 'stripe'
import { createLogger } from '../utils/logger.js'
import type {
  BillingPeriod,
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
  CreatePortalSessionRequest,
  CreatePortalSessionResponse,
  LicenseTier,
  StripeCheckoutSessionId,
  StripeCustomerId,
  StripePriceId,
  StripeSubscriptionId,
  SubscriptionStatus,
} from './types.js'
import { BillingError } from './types.js'

const logger = createLogger('StripeClient')

// ============================================================================
// Configuration
// ============================================================================

/**
 * Stripe client configuration
 */
export interface StripeClientConfig {
  /**
   * Stripe secret key (sk_test_xxx or sk_live_xxx)
   */
  secretKey: string

  /**
   * Stripe webhook signing secret (whsec_xxx)
   */
  webhookSecret: string

  /**
   * Price ID mappings for each tier
   */
  prices: TierPriceConfigs

  /**
   * Base URL for success/cancel redirects
   */
  appUrl?: string
}

/**
 * Price configurations for all tiers
 */
export interface TierPriceConfigs {
  individual: {
    monthly: StripePriceId
    annual: StripePriceId
  }
  team: {
    monthly: StripePriceId
    annual: StripePriceId
  }
  enterprise: {
    monthly: StripePriceId
    annual: StripePriceId
  }
}

// ============================================================================
// StripeClient Class
// ============================================================================

/**
 * Stripe API client wrapper
 *
 * @example
 * ```typescript
 * const client = new StripeClient({
 *   secretKey: process.env.STRIPE_SECRET_KEY!,
 *   webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
 *   prices: {
 *     individual: { monthly: 'price_xxx', annual: 'price_yyy' },
 *     team: { monthly: 'price_xxx', annual: 'price_yyy' },
 *     enterprise: { monthly: 'price_xxx', annual: 'price_yyy' },
 *   },
 * });
 *
 * const session = await client.createCheckoutSession({
 *   tier: 'team',
 *   billingPeriod: 'monthly',
 *   seatCount: 5,
 *   successUrl: 'https://app.example.com/success',
 *   cancelUrl: 'https://app.example.com/cancel',
 * });
 * ```
 */
export class StripeClient {
  private readonly stripe: Stripe
  private readonly webhookSecret: string
  private readonly prices: TierPriceConfigs
  private readonly appUrl: string

  constructor(config: StripeClientConfig) {
    this.stripe = new Stripe(config.secretKey, {
      apiVersion: '2023-10-16',
      typescript: true,
    })
    this.webhookSecret = config.webhookSecret
    this.prices = config.prices
    this.appUrl = config.appUrl ?? 'https://skillsmith.app'

    logger.info('Stripe client initialized')
  }

  // ==========================================================================
  // Customer Management
  // ==========================================================================

  /**
   * Create a new Stripe customer
   */
  async createCustomer(params: {
    email: string
    name?: string
    metadata?: Record<string, string>
  }): Promise<StripeCustomerId> {
    try {
      const customer = await this.stripe.customers.create({
        email: params.email,
        name: params.name,
        metadata: {
          ...params.metadata,
          source: 'skillsmith',
        },
      })

      logger.info('Customer created', { customerId: customer.id })
      return customer.id as StripeCustomerId
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error('Failed to create customer', undefined, {
        errorDetails: errorMsg,
        email: params.email,
      })
      throw new BillingError('Failed to create customer', 'STRIPE_API_ERROR', {
        originalError: errorMsg,
      })
    }
  }

  /**
   * Get a Stripe customer by ID
   */
  async getCustomer(customerId: StripeCustomerId): Promise<Stripe.Customer | null> {
    try {
      const customer = await this.stripe.customers.retrieve(customerId)
      if (customer.deleted) {
        return null
      }
      return customer
    } catch (error: unknown) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
        return null
      }
      throw error
    }
  }

  /**
   * Update a Stripe customer
   */
  async updateCustomer(
    customerId: StripeCustomerId,
    params: {
      email?: string
      name?: string
      metadata?: Record<string, string>
    }
  ): Promise<Stripe.Customer> {
    return this.stripe.customers.update(customerId, params)
  }

  // ==========================================================================
  // Checkout Session
  // ==========================================================================

  /**
   * Create a Stripe Checkout session for subscription
   */
  async createCheckoutSession(
    request: CreateCheckoutSessionRequest
  ): Promise<CreateCheckoutSessionResponse> {
    const priceId = this.getPriceId(request.tier, request.billingPeriod)

    if (!priceId) {
      throw new BillingError(`No price configured for tier: ${request.tier}`, 'INVALID_TIER', {
        tier: request.tier,
        billingPeriod: request.billingPeriod,
      })
    }

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        price: priceId,
        quantity: request.seatCount ?? 1,
      },
    ]

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      line_items: lineItems,
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      metadata: {
        tier: request.tier,
        billingPeriod: request.billingPeriod,
        seatCount: String(request.seatCount ?? 1),
        ...request.metadata,
      },
      subscription_data: {
        metadata: {
          tier: request.tier,
          seatCount: String(request.seatCount ?? 1),
        },
      },
    }

    // Attach to existing customer or create new
    if (request.customerId) {
      sessionParams.customer = request.customerId
    } else if (request.email) {
      sessionParams.customer_email = request.email
    }

    // Allow seat quantity changes for team/enterprise
    if (request.tier === 'team' || request.tier === 'enterprise') {
      sessionParams.line_items![0].adjustable_quantity = {
        enabled: true,
        minimum: 1,
        maximum: 1000,
      }
    }

    try {
      const session = await this.stripe.checkout.sessions.create(sessionParams)

      logger.info('Checkout session created', {
        sessionId: session.id,
        tier: request.tier,
        seatCount: request.seatCount,
      })

      return {
        sessionId: session.id as StripeCheckoutSessionId,
        url: session.url!,
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error('Failed to create checkout session', undefined, { errorDetails: errorMsg })
      throw new BillingError('Failed to create checkout session', 'STRIPE_API_ERROR', {
        originalError: errorMsg,
      })
    }
  }

  /**
   * Retrieve a checkout session
   */
  async getCheckoutSession(sessionId: StripeCheckoutSessionId): Promise<Stripe.Checkout.Session> {
    return this.stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription', 'customer'],
    })
  }

  // ==========================================================================
  // Subscription Management
  // ==========================================================================

  /**
   * Get a subscription by ID
   */
  async getSubscription(subscriptionId: StripeSubscriptionId): Promise<Stripe.Subscription | null> {
    try {
      return await this.stripe.subscriptions.retrieve(subscriptionId)
    } catch (error: unknown) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
        return null
      }
      throw error
    }
  }

  /**
   * List subscriptions for a customer
   */
  async listSubscriptions(customerId: StripeCustomerId): Promise<Stripe.Subscription[]> {
    const subscriptions = await this.stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      expand: ['data.default_payment_method'],
    })
    return subscriptions.data
  }

  /**
   * Update a subscription (tier change or seat count)
   */
  async updateSubscription(
    subscriptionId: StripeSubscriptionId,
    params: {
      tier?: LicenseTier
      billingPeriod?: BillingPeriod
      seatCount?: number
      prorate?: boolean
    }
  ): Promise<Stripe.Subscription> {
    const subscription = await this.getSubscription(subscriptionId)
    if (!subscription) {
      throw new BillingError('Subscription not found', 'SUBSCRIPTION_NOT_FOUND')
    }

    const updateParams: Stripe.SubscriptionUpdateParams = {
      proration_behavior: params.prorate !== false ? 'create_prorations' : 'none',
    }

    // Update price if tier or billing period changed
    if (params.tier && params.billingPeriod) {
      const newPriceId = this.getPriceId(params.tier, params.billingPeriod)
      if (newPriceId) {
        updateParams.items = [
          {
            id: subscription.items.data[0].id,
            price: newPriceId,
            quantity: params.seatCount ?? subscription.items.data[0].quantity,
          },
        ]
        updateParams.metadata = {
          ...subscription.metadata,
          tier: params.tier,
          seatCount: String(params.seatCount ?? subscription.items.data[0].quantity),
        }
      }
    } else if (params.seatCount !== undefined) {
      // Just update seat count
      updateParams.items = [
        {
          id: subscription.items.data[0].id,
          quantity: params.seatCount,
        },
      ]
      updateParams.metadata = {
        ...subscription.metadata,
        seatCount: String(params.seatCount),
      }
    }

    try {
      const updated = await this.stripe.subscriptions.update(subscriptionId, updateParams)
      logger.info('Subscription updated', { subscriptionId, params })
      return updated
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error('Failed to update subscription', undefined, {
        errorDetails: errorMsg,
        subscriptionId,
      })
      throw new BillingError('Failed to update subscription', 'STRIPE_API_ERROR', {
        originalError: errorMsg,
      })
    }
  }

  /**
   * Cancel a subscription
   */
  async cancelSubscription(
    subscriptionId: StripeSubscriptionId,
    options?: {
      immediately?: boolean
      feedback?: string
    }
  ): Promise<Stripe.Subscription> {
    try {
      if (options?.immediately) {
        return await this.stripe.subscriptions.cancel(subscriptionId, {
          cancellation_details: {
            comment: options.feedback,
          },
        })
      } else {
        // Cancel at period end
        return await this.stripe.subscriptions.update(subscriptionId, {
          cancel_at_period_end: true,
          cancellation_details: {
            comment: options?.feedback,
          },
        })
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error('Failed to cancel subscription', undefined, {
        errorDetails: errorMsg,
        subscriptionId,
      })
      throw new BillingError('Failed to cancel subscription', 'STRIPE_API_ERROR', {
        originalError: errorMsg,
      })
    }
  }

  /**
   * Reactivate a canceled subscription (before period end)
   */
  async reactivateSubscription(subscriptionId: StripeSubscriptionId): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    })
  }

  // ==========================================================================
  // Customer Portal
  // ==========================================================================

  /**
   * Create a Stripe Customer Portal session
   */
  async createPortalSession(
    request: CreatePortalSessionRequest
  ): Promise<CreatePortalSessionResponse> {
    try {
      // Need to get Stripe customer ID from our customer ID
      // This assumes customerId is the Stripe customer ID
      const session = await this.stripe.billingPortal.sessions.create({
        customer: request.customerId,
        return_url: request.returnUrl,
      })

      logger.info('Portal session created', { customerId: request.customerId })

      return {
        url: session.url,
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error('Failed to create portal session', undefined, {
        errorDetails: errorMsg,
        customerId: request.customerId,
      })
      throw new BillingError('Failed to create portal session', 'STRIPE_API_ERROR', {
        originalError: errorMsg,
      })
    }
  }

  // ==========================================================================
  // Invoice Management
  // ==========================================================================

  /**
   * List invoices for a customer
   */
  async listInvoices(
    customerId: StripeCustomerId,
    options?: {
      limit?: number
      startingAfter?: string
    }
  ): Promise<{
    invoices: Stripe.Invoice[]
    hasMore: boolean
  }> {
    const invoices = await this.stripe.invoices.list({
      customer: customerId,
      limit: options?.limit ?? 10,
      starting_after: options?.startingAfter,
    })

    return {
      invoices: invoices.data,
      hasMore: invoices.has_more,
    }
  }

  /**
   * Get a specific invoice
   */
  async getInvoice(invoiceId: string): Promise<Stripe.Invoice | null> {
    try {
      return await this.stripe.invoices.retrieve(invoiceId)
    } catch (error: unknown) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') {
        return null
      }
      throw error
    }
  }

  /**
   * Get upcoming invoice (preview of next charge)
   */
  async getUpcomingInvoice(customerId: StripeCustomerId): Promise<Stripe.UpcomingInvoice | null> {
    try {
      return await this.stripe.invoices.retrieveUpcoming({
        customer: customerId,
      })
    } catch (error: unknown) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'invoice_upcoming_none') {
        return null
      }
      throw error
    }
  }

  // ==========================================================================
  // Webhook Handling
  // ==========================================================================

  /**
   * Verify and parse a webhook event
   */
  verifyWebhookSignature(payload: string, signature: string): Stripe.Event {
    try {
      return this.stripe.webhooks.constructEvent(payload, signature, this.webhookSecret)
    } catch (error: unknown) {
      logger.warn('Webhook signature verification failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw new BillingError('Invalid webhook signature', 'WEBHOOK_SIGNATURE_INVALID')
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Get the price ID for a tier and billing period
   */
  getPriceId(tier: LicenseTier, billingPeriod: BillingPeriod): StripePriceId | null {
    if (tier === 'community') {
      return null // Community tier is free, no Stripe price
    }

    const tierPrices = this.prices[tier as keyof TierPriceConfigs]
    if (!tierPrices) {
      return null
    }

    return tierPrices[billingPeriod]
  }

  /**
   * Map Stripe subscription status to our status
   */
  static mapSubscriptionStatus(stripeStatus: Stripe.Subscription.Status): SubscriptionStatus {
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

  /**
   * Get the underlying Stripe instance (for advanced operations)
   */
  getStripeInstance(): Stripe {
    return this.stripe
  }
}
