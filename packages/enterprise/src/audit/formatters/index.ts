/**
 * Audit event formatters
 *
 * Provides formatting for audit events:
 * - Timestamp formatting
 * - Field normalization
 * - Sensitive data redaction
 * - Custom field mapping
 */

// Placeholder exports - implementations to be added
export interface AuditFormatter {
  readonly name: string
  format(event: unknown): unknown
}
