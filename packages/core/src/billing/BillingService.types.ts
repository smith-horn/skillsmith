/**
 * BillingService Types
 * @module billing/BillingService.types
 */

import type { Database as DatabaseType } from '../db/database-interface.js'
import type { StripeClient } from './StripeClient.js'

/**
 * BillingService configuration
 */
export interface BillingServiceConfig {
  /** StripeClient instance */
  stripeClient: StripeClient
  /** Database connection (better-sqlite3) */
  db: DatabaseType
}

/**
 * Subscription row from SQLite
 */
export interface SubscriptionRow {
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

/**
 * Invoice row from SQLite
 */
export interface InvoiceRow {
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
