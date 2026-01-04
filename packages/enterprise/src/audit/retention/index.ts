/**
 * SMI-961: Enterprise Audit Retention Module
 *
 * Exports retention policy types and enforcement implementation.
 */

export type {
  RetentionConfig,
  RetentionResult,
  RetentionAuditEvent,
  LegalHoldConfig,
  CleanupJobConfig,
} from './RetentionPolicy.js'

export {
  ENTERPRISE_MIN_RETENTION_DAYS,
  ENTERPRISE_MAX_RETENTION_DAYS,
  DEFAULT_RETENTION_DAYS,
  validateRetentionConfig,
  createDefaultRetentionConfig,
  getRetentionDaysForEventType,
} from './RetentionPolicy.js'

export { RetentionEnforcer } from './RetentionEnforcer.js'
export type { EnterpriseAuditLogger } from './RetentionEnforcer.js'
