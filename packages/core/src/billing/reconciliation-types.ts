/**
 * SMI-1069: Stripe Reconciliation Types
 *
 * Type definitions for the reconciliation job.
 */

import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { StripeClient } from './StripeClient.js'

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
// Discrepancy Types
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

// ============================================================================
// Result Types
// ============================================================================

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
// Internal Types
// ============================================================================

export interface LocalSubscription {
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

export interface LocalInvoice {
  id: string
  customerId: string
  stripeInvoiceId: string
  amountCents: number
  status: string
}
