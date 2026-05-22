/**
 * SMI-5006: Billing module — relocated from @skillsmith/core/billing.
 *
 * Stripe billing integration for Skillsmith subscriptions.
 * Provides subscription management, checkout, and invoice handling.
 *
 * Import path:
 *   import { ... } from '@smith-horn/enterprise/billing'
 *
 * The previous `@skillsmith/core/billing` subpath was removed in core 0.7.0
 * (BREAKING). No shim is shipped — consumers must update imports.
 */

// Types
export * from './types.js'

// Stripe Client
export { StripeClient } from './StripeClient.js'
export type { StripeClientConfig, TierPriceConfigs } from './StripeClient.js'

// Billing Service
export { BillingService } from './BillingService.js'
export type { BillingServiceConfig } from './BillingService.js'

// Webhook Handler
export { StripeWebhookHandler } from './StripeWebhookHandler.js'
export type { StripeWebhookHandlerConfig } from './StripeWebhookHandler.js'
export type {
  StripeWebhookHandlerContract,
  StripeWebhookResult,
} from './webhook-contract.js'

// GDPR Compliance (SMI-1068)
export { GDPRComplianceService } from './GDPRComplianceService.js'
export type {
  GDPRComplianceServiceConfig,
  CustomerDataExport,
  SubscriptionExportData,
  InvoiceExportData,
  LicenseKeyExportData,
  WebhookEventExportData,
  DeletionResult,
} from './GDPRComplianceService.js'

// Reconciliation Job (SMI-1069)
export { StripeReconciliationJob } from './StripeReconciliationJob.js'
export type {
  StripeReconciliationJobConfig,
  DiscrepancyType,
  Discrepancy,
  ReconciliationResult,
} from './StripeReconciliationJob.js'
