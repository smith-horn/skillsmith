/**
 * SMI-1062: Stripe ID Validators
 *
 * Validation and sanitization functions for Stripe IDs.
 * Extracted from sanitization.ts for file size compliance.
 */

import { createLogger } from '../utils/logger.js'

const logger = createLogger('StripeValidators')

/**
 * Stripe ID prefixes for validation
 */
const STRIPE_ID_PREFIXES = {
  customer: 'cus_',
  subscription: 'sub_',
  price: 'price_',
  invoice: 'in_',
  paymentIntent: 'pi_',
  paymentMethod: 'pm_',
  product: 'prod_',
  checkout: 'cs_',
  event: 'evt_',
} as const

type StripeIdType = keyof typeof STRIPE_ID_PREFIXES

/**
 * Validate a Stripe ID format
 *
 * Stripe IDs follow the pattern: prefix_alphanumeric
 * - Prefix identifies the object type (cus_, sub_, price_, etc.)
 * - Suffix is alphanumeric, typically 14-24 characters
 *
 * @param id - The Stripe ID to validate
 * @param type - The expected ID type (customer, subscription, price, etc.)
 * @param maxLength - Maximum allowed input length (default: 100)
 * @returns true if valid, false otherwise
 *
 * @example
 * ```typescript
 * isValidStripeId('cus_OtLqEJvHu1Mvxm', 'customer')  // true
 * isValidStripeId('sub_1234567890abcd', 'subscription')  // true
 * isValidStripeId('invalid_id', 'customer')  // false
 * ```
 */
export function isValidStripeId(id: string, type: StripeIdType, maxLength = 100): boolean {
  if (!id || typeof id !== 'string') {
    return false
  }

  if (id.length > maxLength || id.length < 5) {
    return false
  }

  const prefix = STRIPE_ID_PREFIXES[type]
  if (!id.startsWith(prefix)) {
    return false
  }

  // Validate suffix is alphanumeric only
  const suffix = id.slice(prefix.length)
  if (!/^[a-zA-Z0-9]+$/.test(suffix)) {
    return false
  }

  return true
}

/**
 * Sanitize a Stripe customer ID
 *
 * @param customerId - Raw customer ID
 * @param maxLength - Maximum allowed input length (default: 100)
 * @returns Sanitized customer ID or empty string if invalid
 *
 * @example
 * ```typescript
 * sanitizeStripeCustomerId('cus_OtLqEJvHu1Mvxm')
 * // Returns: 'cus_OtLqEJvHu1Mvxm'
 *
 * sanitizeStripeCustomerId('cus_<script>')
 * // Returns: ''
 * ```
 */
export function sanitizeStripeCustomerId(customerId: string, maxLength = 100): string {
  if (!isValidStripeId(customerId, 'customer', maxLength)) {
    logger.warn('Invalid Stripe customer ID', { customerId: customerId?.slice(0, 20) })
    return ''
  }
  return customerId
}

/**
 * Sanitize a Stripe subscription ID
 *
 * @param subscriptionId - Raw subscription ID
 * @param maxLength - Maximum allowed input length (default: 100)
 * @returns Sanitized subscription ID or empty string if invalid
 */
export function sanitizeStripeSubscriptionId(subscriptionId: string, maxLength = 100): string {
  if (!isValidStripeId(subscriptionId, 'subscription', maxLength)) {
    logger.warn('Invalid Stripe subscription ID', { subscriptionId: subscriptionId?.slice(0, 20) })
    return ''
  }
  return subscriptionId
}

/**
 * Sanitize a Stripe price ID
 *
 * @param priceId - Raw price ID
 * @param maxLength - Maximum allowed input length (default: 100)
 * @returns Sanitized price ID or empty string if invalid
 */
export function sanitizeStripePriceId(priceId: string, maxLength = 100): string {
  if (!isValidStripeId(priceId, 'price', maxLength)) {
    logger.warn('Invalid Stripe price ID', { priceId: priceId?.slice(0, 20) })
    return ''
  }
  return priceId
}

/**
 * Sanitize a Stripe invoice ID
 *
 * @param invoiceId - Raw invoice ID
 * @param maxLength - Maximum allowed input length (default: 100)
 * @returns Sanitized invoice ID or empty string if invalid
 */
export function sanitizeStripeInvoiceId(invoiceId: string, maxLength = 100): string {
  if (!isValidStripeId(invoiceId, 'invoice', maxLength)) {
    logger.warn('Invalid Stripe invoice ID', { invoiceId: invoiceId?.slice(0, 20) })
    return ''
  }
  return invoiceId
}

/**
 * Sanitize a Stripe event ID (for webhooks)
 *
 * @param eventId - Raw event ID
 * @param maxLength - Maximum allowed input length (default: 100)
 * @returns Sanitized event ID or empty string if invalid
 */
export function sanitizeStripeEventId(eventId: string, maxLength = 100): string {
  if (!isValidStripeId(eventId, 'event', maxLength)) {
    logger.warn('Invalid Stripe event ID', { eventId: eventId?.slice(0, 20) })
    return ''
  }
  return eventId
}
