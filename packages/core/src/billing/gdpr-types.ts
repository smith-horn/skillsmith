/**
 * SMI-1068: GDPR Compliance Types
 *
 * Type definitions for GDPR data export and deletion operations.
 */

import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { StripeClient } from './StripeClient.js'

// ============================================================================
// Configuration
// ============================================================================

export interface GDPRComplianceServiceConfig {
  /**
   * Database connection (better-sqlite3)
   */
  db: BetterSqliteDatabase

  /**
   * Optional StripeClient for Stripe data operations
   */
  stripeClient?: StripeClient
}

// ============================================================================
// Export Types (Article 20: Right to Data Portability)
// ============================================================================

/**
 * Exported customer data format
 */
export interface CustomerDataExport {
  /**
   * Export metadata
   */
  metadata: {
    exportedAt: string
    customerId: string
    format: 'json'
    version: '1.0'
  }

  /**
   * Subscription data
   */
  subscriptions: SubscriptionExportData[]

  /**
   * Invoice data
   */
  invoices: InvoiceExportData[]

  /**
   * License key data (without the actual JWT for security)
   */
  licenseKeys: LicenseKeyExportData[]

  /**
   * Webhook events related to this customer
   */
  webhookEvents: WebhookEventExportData[]
}

export interface SubscriptionExportData {
  id: string
  stripeSubscriptionId: string | null
  tier: string
  status: string
  seatCount: number
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  canceledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface InvoiceExportData {
  id: string
  stripeInvoiceId: string
  amountCents: number
  currency: string
  status: string
  invoiceNumber: string | null
  paidAt: string | null
  periodStart: string | null
  periodEnd: string | null
  createdAt: string
}

export interface LicenseKeyExportData {
  id: string
  keyExpiry: string
  isActive: boolean
  generatedAt: string
  revokedAt: string | null
  revocationReason: string | null
}

export interface WebhookEventExportData {
  id: string
  stripeEventId: string
  eventType: string
  processedAt: string
  success: boolean
}

// ============================================================================
// Deletion Types (Article 17: Right to Erasure)
// ============================================================================

/**
 * Result of a data deletion operation
 */
export interface DeletionResult {
  success: boolean
  customerId: string
  deletedAt: string
  counts: {
    subscriptions: number
    invoices: number
    licenseKeys: number
    webhookEvents: number
  }
  stripeDeleted: boolean
  errors: string[]
}
