/**
 * SMI-1070: Stripe Webhook Event Handlers
 *
 * Individual event handler functions for Stripe webhooks.
 * These are extracted to reduce the size of the main handler file.
 */

import type Stripe from 'stripe'
import { createHash, randomUUID } from 'crypto'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import { createLogger } from '../utils/logger.js'
import { StripeClient } from './StripeClient.js'
import type { BillingService } from './BillingService.js'
import type { LicenseTier, StripeCustomerId, StripeSubscriptionId } from './types.js'
import { BillingError } from './types.js'

const logger = createLogger('WebhookHandlers')

// ============================================================================
// Handler Context
// ============================================================================

export interface WebhookHandlerContext {
  stripe: StripeClient
  billing: BillingService
  db: BetterSqliteDatabase
  onLicenseKeyNeeded?: (params: {
    customerId: string
    tier: LicenseTier
    expiresAt: Date
    subscriptionId: string
  }) => Promise<string>
  onEmailNeeded?: (params: {
    type: 'license_key' | 'payment_failed' | 'subscription_canceled'
    email: string
    data: Record<string, unknown>
  }) => Promise<void>
}

// ============================================================================
// Subscription Event Handlers
// ============================================================================

export async function handleSubscriptionCreated(
  ctx: WebhookHandlerContext,
  subscription: Stripe.Subscription
): Promise<void> {
  logger.info('Processing subscription.created', {
    subscriptionId: subscription.id,
    customerId: subscription.customer,
    status: subscription.status,
  })

  const customer = await ctx.stripe.getCustomer(subscription.customer as StripeCustomerId)
  if (!customer) {
    throw new BillingError('Customer not found', 'CUSTOMER_NOT_FOUND')
  }

  const tier = extractTier(subscription)
  const seatCount = extractSeatCount(subscription)

  // Create/update subscription record
  const sub = ctx.billing.upsertSubscription({
    customerId: customer.id,
    email: customer.email!,
    stripeCustomerId: customer.id as StripeCustomerId,
    stripeSubscriptionId: subscription.id as StripeSubscriptionId,
    stripePriceId: subscription.items.data[0]?.price.id ?? '',
    tier,
    status: StripeClient.mapSubscriptionStatus(subscription.status),
    seatCount,
    currentPeriodStart: new Date(getCurrentPeriodStart(subscription) * 1000),
    currentPeriodEnd: new Date(getCurrentPeriodEnd(subscription) * 1000),
  })

  // Generate license key if subscription is active
  if (subscription.status === 'active' && ctx.onLicenseKeyNeeded) {
    const periodEnd = getCurrentPeriodEnd(subscription)
    const licenseKey = await ctx.onLicenseKeyNeeded({
      customerId: customer.id,
      tier,
      expiresAt: new Date(periodEnd * 1000),
      subscriptionId: sub.id,
    })

    // Store license key
    storeLicenseKey(ctx.db, {
      subscriptionId: sub.id,
      organizationId: customer.id,
      keyJwt: licenseKey,
      keyExpiry: new Date(periodEnd * 1000),
    })

    // Send license key email
    if (ctx.onEmailNeeded) {
      await ctx.onEmailNeeded({
        type: 'license_key',
        email: customer.email!,
        data: {
          licenseKey,
          tier,
          expiresAt: new Date(periodEnd * 1000).toISOString(),
        },
      })
    }
  }
}

export async function handleSubscriptionUpdated(
  ctx: WebhookHandlerContext,
  subscription: Stripe.Subscription
): Promise<void> {
  logger.info('Processing subscription.updated', {
    subscriptionId: subscription.id,
    status: subscription.status,
  })

  const existingSub = ctx.billing.getSubscriptionByStripeId(subscription.id as StripeSubscriptionId)

  if (!existingSub) {
    // Subscription doesn't exist locally, create it
    await handleSubscriptionCreated(ctx, subscription)
    return
  }

  // Update status
  const newStatus = StripeClient.mapSubscriptionStatus(subscription.status)
  const canceledAt = subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null

  ctx.billing.updateSubscriptionStatus(
    subscription.id as StripeSubscriptionId,
    newStatus,
    canceledAt
  )

  // Check if tier changed (regenerate license key)
  const newTier = extractTier(subscription)
  if (existingSub.tier !== newTier && ctx.onLicenseKeyNeeded) {
    const customer = await ctx.stripe.getCustomer(subscription.customer as StripeCustomerId)
    if (customer) {
      // Revoke old license key
      revokeLicenseKey(ctx.db, existingSub.id, 'tier_change')

      // Generate new license key
      const periodEnd = getCurrentPeriodEnd(subscription)
      const licenseKey = await ctx.onLicenseKeyNeeded({
        customerId: customer.id,
        tier: newTier,
        expiresAt: new Date(periodEnd * 1000),
        subscriptionId: existingSub.id,
      })

      storeLicenseKey(ctx.db, {
        subscriptionId: existingSub.id,
        organizationId: customer.id,
        keyJwt: licenseKey,
        keyExpiry: new Date(periodEnd * 1000),
      })
    }
  }
}

export async function handleSubscriptionDeleted(
  ctx: WebhookHandlerContext,
  subscription: Stripe.Subscription
): Promise<void> {
  logger.info('Processing subscription.deleted', {
    subscriptionId: subscription.id,
  })

  const existingSub = ctx.billing.getSubscriptionByStripeId(subscription.id as StripeSubscriptionId)

  if (existingSub) {
    // Update status to canceled
    ctx.billing.updateSubscriptionStatus(
      subscription.id as StripeSubscriptionId,
      'canceled',
      new Date()
    )

    // Revoke license key
    revokeLicenseKey(ctx.db, existingSub.id, 'subscription_canceled')

    // Send cancellation email
    if (ctx.onEmailNeeded) {
      const customer = await ctx.stripe.getCustomer(subscription.customer as StripeCustomerId)
      if (customer?.email) {
        await ctx.onEmailNeeded({
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

// ============================================================================
// Invoice Event Handlers
// ============================================================================

export async function handleInvoicePaymentSucceeded(
  ctx: WebhookHandlerContext,
  invoice: Stripe.Invoice
): Promise<void> {
  logger.info('Processing invoice.payment_succeeded', {
    invoiceId: invoice.id,
    customerId: invoice.customer,
    amount: invoice.amount_paid,
  })

  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id

  if (!customerId) return

  // Store invoice
  ctx.billing.storeInvoice({
    customerId,
    stripeInvoiceId: invoice.id,
    subscriptionId: extractSubscriptionIdFromInvoice(invoice),
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

export async function handleInvoicePaymentFailed(
  ctx: WebhookHandlerContext,
  invoice: Stripe.Invoice
): Promise<void> {
  logger.warn('Processing invoice.payment_failed', {
    invoiceId: invoice.id,
    customerId: invoice.customer,
    amount: invoice.amount_due,
  })

  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id

  if (!customerId) return

  // Get subscription ID from parent.subscription_details (Stripe v20+ structure)
  const subscriptionId = extractSubscriptionIdFromInvoice(invoice)

  // Store invoice with failed status
  ctx.billing.storeInvoice({
    customerId,
    stripeInvoiceId: invoice.id,
    subscriptionId,
    amountCents: invoice.amount_due,
    currency: invoice.currency,
    status: 'open',
    pdfUrl: invoice.invoice_pdf ?? undefined,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? undefined,
    invoiceNumber: invoice.number ?? undefined,
  })

  // Send payment failed email
  if (ctx.onEmailNeeded) {
    const customer = await ctx.stripe.getCustomer(customerId as StripeCustomerId)
    if (customer?.email) {
      await ctx.onEmailNeeded({
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

// ============================================================================
// Checkout Event Handlers
// ============================================================================

export function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): void {
  logger.info('Processing checkout.session.completed', {
    sessionId: session.id,
    customerId: session.customer,
    subscriptionId: session.subscription,
  })

  // The subscription.created event will handle the actual subscription setup
  // This handler is useful for tracking successful checkouts and analytics
}

// ============================================================================
// License Key Management
// ============================================================================

export function storeLicenseKey(
  db: BetterSqliteDatabase,
  params: {
    subscriptionId: string
    organizationId: string
    keyJwt: string
    keyExpiry: Date
  }
): void {
  const id = randomUUID()
  const keyHash = createHash('sha256').update(params.keyJwt).digest('hex')
  const now = new Date().toISOString()

  db.prepare(
    `INSERT INTO license_keys (
      id, subscription_id, organization_id, key_jwt, key_hash,
      key_expiry, is_active, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
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

export function revokeLicenseKey(
  db: BetterSqliteDatabase,
  subscriptionId: string,
  reason: string
): void {
  const now = new Date().toISOString()

  db.prepare(
    `UPDATE license_keys
    SET is_active = 0, revoked_at = ?, revocation_reason = ?
    WHERE subscription_id = ? AND is_active = 1`
  ).run(now, reason, subscriptionId)

  logger.info('License key revoked', { subscriptionId, reason })
}

// ============================================================================
// Helper Functions
// ============================================================================

export function extractTier(subscription: Stripe.Subscription): LicenseTier {
  // Try to get tier from metadata first
  const metadataTier = subscription.metadata?.tier as LicenseTier | undefined
  if (metadataTier && ['community', 'individual', 'team', 'enterprise'].includes(metadataTier)) {
    return metadataTier
  }

  // Fallback: infer from price ID or default to individual
  return 'individual'
}

export function extractSeatCount(subscription: Stripe.Subscription): number {
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

/**
 * Get current period end from subscription (Stripe v20+ moved this to items)
 */
export function getCurrentPeriodEnd(subscription: Stripe.Subscription): number {
  const periodEnd = subscription.items.data[0]?.current_period_end
  if (!periodEnd) {
    logger.warn('No subscription items found for period end', {
      subscriptionId: subscription.id,
      itemCount: subscription.items.data.length,
    })
    return Math.floor(Date.now() / 1000)
  }
  return periodEnd
}

/**
 * Get current period start from subscription (Stripe v20+ moved this to items)
 */
export function getCurrentPeriodStart(subscription: Stripe.Subscription): number {
  const periodStart = subscription.items.data[0]?.current_period_start
  if (!periodStart) {
    logger.warn('No subscription items found for period start', {
      subscriptionId: subscription.id,
      itemCount: subscription.items.data.length,
    })
    return Math.floor(Date.now() / 1000)
  }
  return periodStart
}

/**
 * Extract subscription ID from invoice (Stripe v20+ structure)
 * The subscription is now at invoice.parent.subscription_details.subscription
 */
export function extractSubscriptionIdFromInvoice(invoice: Stripe.Invoice): string | undefined {
  const subscription = invoice.parent?.subscription_details?.subscription
  if (!subscription) {
    return undefined
  }
  return typeof subscription === 'string' ? subscription : subscription.id
}
