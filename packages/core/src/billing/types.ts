/**
 * SMI-1062: Billing Types and Interfaces
 *
 * Type definitions for Stripe billing integration including:
 * - Subscription management
 * - Customer management
 * - Invoice handling
 * - Webhook events
 */

// ============================================================================
// License Tier (defined locally to avoid circular dependency)
// ============================================================================

/**
 * Available license tiers
 * - community: Free tier (1,000 API calls/month)
 * - individual: Solo developers ($9.99/mo, 10,000 API calls/month)
 * - team: Teams ($25/user/mo, 100,000 API calls/month)
 * - enterprise: Full enterprise ($55/user/mo, unlimited)
 */
export type LicenseTier = 'community' | 'individual' | 'team' | 'enterprise'

// ============================================================================
// Stripe ID Types (branded types for type safety)
// ============================================================================

/**
 * Stripe Customer ID (cus_xxx)
 */
export type StripeCustomerId = string & { readonly __brand: 'StripeCustomerId' }

/**
 * Stripe Subscription ID (sub_xxx)
 */
export type StripeSubscriptionId = string & { readonly __brand: 'StripeSubscriptionId' }

/**
 * Stripe Price ID (price_xxx)
 */
export type StripePriceId = string & { readonly __brand: 'StripePriceId' }

/**
 * Stripe Invoice ID (in_xxx)
 */
export type StripeInvoiceId = string & { readonly __brand: 'StripeInvoiceId' }

/**
 * Stripe Checkout Session ID (cs_xxx)
 */
export type StripeCheckoutSessionId = string & { readonly __brand: 'StripeCheckoutSessionId' }

/**
 * Stripe Event ID (evt_xxx)
 */
export type StripeEventId = string & { readonly __brand: 'StripeEventId' }

// ============================================================================
// Subscription Status
// ============================================================================

/**
 * Subscription status values
 */
export type SubscriptionStatus =
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'trialing'
  | 'paused'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid'

// ============================================================================
// Customer Types
// ============================================================================

/**
 * Customer record in our database
 */
export interface Customer {
  id: string
  customerId: string
  email: string
  stripeCustomerId: StripeCustomerId | null
  tier: LicenseTier
  status: SubscriptionStatus
  createdAt: Date
  updatedAt: Date
}

/**
 * Create customer request
 */
export interface CreateCustomerRequest {
  email: string
  name?: string
  metadata?: Record<string, string>
}

/**
 * Create customer response
 */
export interface CreateCustomerResponse {
  customerId: string
  stripeCustomerId: StripeCustomerId
}

// ============================================================================
// Subscription Types
// ============================================================================

/**
 * Subscription record in our database
 */
export interface Subscription {
  id: string
  customerId: string
  stripeSubscriptionId: StripeSubscriptionId | null
  stripePriceId: StripePriceId | null
  tier: LicenseTier
  status: SubscriptionStatus
  seatCount: number
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  canceledAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Billing period (monthly or annual)
 */
export type BillingPeriod = 'monthly' | 'annual'

/**
 * Create checkout session request
 */
export interface CreateCheckoutSessionRequest {
  tier: LicenseTier
  billingPeriod: BillingPeriod
  seatCount?: number
  successUrl: string
  cancelUrl: string
  customerId?: string
  email?: string
  metadata?: Record<string, string>
}

/**
 * Create checkout session response
 */
export interface CreateCheckoutSessionResponse {
  sessionId: StripeCheckoutSessionId
  url: string
}

/**
 * Update subscription request
 */
export interface UpdateSubscriptionRequest {
  subscriptionId: StripeSubscriptionId
  tier?: LicenseTier
  seatCount?: number
  prorate?: boolean
}

/**
 * Cancel subscription request
 */
export interface CancelSubscriptionRequest {
  subscriptionId: StripeSubscriptionId
  immediately?: boolean
  feedback?: string
}

// ============================================================================
// Invoice Types
// ============================================================================

/**
 * Invoice status values
 */
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible'

/**
 * Invoice record in our database
 */
export interface Invoice {
  id: string
  customerId: string
  stripeInvoiceId: StripeInvoiceId
  subscriptionId: string | null
  amountCents: number
  currency: string
  status: InvoiceStatus
  pdfUrl: string | null
  hostedInvoiceUrl: string | null
  invoiceNumber: string | null
  paidAt: Date | null
  periodStart: Date | null
  periodEnd: Date | null
  createdAt: Date
}

/**
 * Invoice list request
 */
export interface ListInvoicesRequest {
  customerId: string
  limit?: number
  startingAfter?: string
}

/**
 * Invoice list response
 */
export interface ListInvoicesResponse {
  invoices: Invoice[]
  hasMore: boolean
}

// ============================================================================
// Webhook Event Types
// ============================================================================

/**
 * Stripe webhook event types we handle
 */
export type StripeWebhookEventType =
  | 'customer.subscription.created'
  | 'customer.subscription.updated'
  | 'customer.subscription.deleted'
  | 'invoice.payment_succeeded'
  | 'invoice.payment_failed'
  | 'checkout.session.completed'
  | 'customer.created'
  | 'customer.updated'

/**
 * Webhook event record in our database
 */
export interface WebhookEvent {
  id: string
  stripeEventId: StripeEventId
  eventType: StripeWebhookEventType
  processedAt: Date
  payload: string
  success: boolean
  errorMessage: string | null
  createdAt: Date
}

/**
 * Webhook processing result
 */
export interface WebhookProcessResult {
  success: boolean
  message: string
  eventId: StripeEventId
  processed: boolean
  error?: string
}

// ============================================================================
// Customer Portal Types
// ============================================================================

/**
 * Create portal session request
 */
export interface CreatePortalSessionRequest {
  customerId: string
  returnUrl: string
}

/**
 * Create portal session response
 */
export interface CreatePortalSessionResponse {
  url: string
}

// ============================================================================
// Seat Management Types
// ============================================================================

/**
 * Seat update request
 */
export interface UpdateSeatsRequest {
  subscriptionId: StripeSubscriptionId
  seatCount: number
  prorate?: boolean
}

/**
 * Seat update response
 */
export interface UpdateSeatsResponse {
  success: boolean
  seatCount: number
  proratedAmount?: number
  message: string
}

// ============================================================================
// Price Configuration Types
// ============================================================================

/**
 * Price configuration for a tier
 */
export interface TierPriceConfig {
  tier: LicenseTier
  monthlyPriceId: StripePriceId
  annualPriceId: StripePriceId
  monthlyPrice: number
  annualPrice: number
  perUser: boolean
}

/**
 * All price configurations
 */
export type PriceConfigs = Record<LicenseTier, TierPriceConfig>

// ============================================================================
// Error Types
// ============================================================================

/**
 * Billing-specific error codes
 */
export type BillingErrorCode =
  | 'CUSTOMER_NOT_FOUND'
  | 'SUBSCRIPTION_NOT_FOUND'
  | 'INVALID_TIER'
  | 'PAYMENT_FAILED'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'WEBHOOK_DUPLICATE_EVENT'
  | 'STRIPE_API_ERROR'
  | 'SEAT_LIMIT_EXCEEDED'
  | 'DOWNGRADE_NOT_ALLOWED'

/**
 * Billing error class
 */
export class BillingError extends Error {
  constructor(
    message: string,
    public readonly code: BillingErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'BillingError'
  }
}
