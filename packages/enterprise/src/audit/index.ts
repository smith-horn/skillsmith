/**
 * Audit module exports
 *
 * SMI-957: Enterprise Audit Logger
 * SMI-964: SSO/RBAC Event Types
 * SMI-959: CloudWatch Logs Exporter
 * SMI-963: Real-Time Event Streaming
 */

// Export from AuditLogger (main logger implementation)
export {
  EnterpriseAuditLogger as AuditLogger,
  EnterpriseAuditLogger,
  type EnterpriseAuditEventType,
  type ExtendedAuditEventType,
  type SSOLoginInput,
  type RBACCheckInput,
  type LicenseCheckInput,
  type AuditEvent,
  type AuditExporter,
  type EnterpriseAuditLogEntry,
  type EnterpriseAuditLoggerConfig,
  type AuditQueryFilter,
  type AuditActor,
  type AuditResult,
  type AuditLogEntry,
  type AuditLoggerConfig,
  ENTERPRISE_MIN_RETENTION_DAYS,
  ENTERPRISE_MAX_RETENTION_DAYS,
} from './AuditLogger.js'

// Export from AuditEventTypes (SSO/RBAC/License event types - avoiding SSOAuditEvent conflict)
export {
  // Types
  type SSOProvider,
  type SSOEventType,
  type RBACEventType,
  type LicenseEventType,
  type AuditEventType,
  type AuditSeverity,
  type BaseAuditEvent,
  type SSOFailureReason,
  // SSO events (using AuditEventTypes version with different name to avoid conflict)
  type SSOLoginAttemptEvent,
  type SSOLoginSuccessEvent,
  type SSOLoginFailureEvent,
  type SSOLogoutEvent,
  type SSOSessionRefreshEvent,
  type SSOProviderErrorEvent,
  // RBAC events
  type RBACAuditEvent,
  type RBACPermissionCheckEvent,
  type RBACPermissionDeniedEvent,
  type RBACRoleAssignedEvent,
  type RBACRoleRevokedEvent,
  type RBACPolicyUpdatedEvent,
  // License events
  type LicenseAuditEvent,
  type LicenseValidatedEvent,
  type LicenseExpiredEvent,
  type LicenseFeatureCheckEvent,
  type LicenseSeatsExceededEvent,
} from './AuditEventTypes.js'

// Export from exporters
export * from './exporters/index.js'

// Export from retention
export * from './retention/index.js'

// Export from streaming
export * from './streaming/index.js'
