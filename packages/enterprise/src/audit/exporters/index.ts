/**
 * Audit event exporters
 *
 * Provides export functionality for audit logs in various formats:
 * - JSON: Standard JSON export
 * - CSV: Spreadsheet-compatible export
 * - SIEM: Security Information and Event Management format
 * - CloudWatch: AWS CloudWatch Logs export
 */

import type { RetentionAuditEvent as AuditEvent } from '../retention/RetentionPolicy.js'

/**
 * Result of an export operation
 */
export interface ExportResult {
  /**
   * Whether the export was successful
   */
  success: boolean

  /**
   * Number of events exported
   */
  exportedCount: number

  /**
   * Number of events that failed to export
   */
  failedCount: number

  /**
   * Error message if the export failed
   */
  error?: string

  /**
   * Timestamp when export was executed
   */
  exportedAt: string

  /**
   * Duration of export in milliseconds
   */
  durationMs: number
}

/**
 * Base interface for audit event exporters
 */
export interface AuditExporter {
  /**
   * Export format identifier
   */
  readonly format: string

  /**
   * Export events to a buffer (batch export)
   */
  export(events: AuditEvent[]): Promise<Buffer>

  /**
   * Initialize the exporter (connect to services, create resources)
   */
  initialize?(): Promise<void>

  /**
   * Close the exporter and cleanup resources
   */
  close?(): Promise<void>
}

/**
 * Interface for streaming exporters that send events to external services
 */
export interface StreamingExporter extends AuditExporter {
  /**
   * Stream events to the destination service
   */
  stream(events: AuditEvent[]): Promise<ExportResult>

  /**
   * Flush any buffered events
   */
  flush(): Promise<void>
}

// CloudWatch exporter
export { CloudWatchExporter } from './CloudWatchExporter.js'
export type { CloudWatchConfig } from './CloudWatchExporter.js'
