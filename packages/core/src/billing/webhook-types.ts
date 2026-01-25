/**
 * SMI-1070: Stripe Webhook Types
 *
 * Configuration and type definitions for the webhook handler.
 */

import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { StripeClient } from './StripeClient.js'
import type { BillingService } from './BillingService.js'
import type { LicenseTier } from './types.js'

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
