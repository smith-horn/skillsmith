/**
 * BillingService Helper Functions
 * @module billing/BillingService.helpers
 */

import type {
  Invoice,
  LicenseTier,
  StripeInvoiceId,
  StripePriceId,
  StripeSubscriptionId,
  Subscription,
  SubscriptionStatus,
} from './types.js'
import type { SubscriptionRow, InvoiceRow } from './BillingService.types.js'

/**
 * Map subscription database row to Subscription type
 */
export function mapRowToSubscription(row: SubscriptionRow): Subscription {
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

/**
 * Map invoice database row to Invoice type
 */
export function mapRowToInvoice(row: InvoiceRow): Invoice {
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
