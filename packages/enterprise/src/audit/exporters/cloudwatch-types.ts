/**
 * SMI-959: CloudWatch Logs Exporter Types
 *
 * Type definitions and constants for AWS CloudWatch Logs integration.
 */

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for CloudWatch Logs exporter
 */
export interface CloudWatchConfig {
  /**
   * AWS region for CloudWatch Logs
   */
  region: string

  /**
   * Log group name in CloudWatch
   */
  logGroupName: string

  /**
   * Prefix for log stream names (actual stream name will be `{prefix}-{date}`)
   */
  logStreamPrefix: string

  /**
   * Retention period in days for log data (valid values: 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653, or 0 for indefinite)
   */
  retentionDays: number

  /**
   * Optional AWS credentials (uses IAM role if not provided)
   */
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
  }

  /**
   * Optional custom endpoint for testing or local development
   */
  endpoint?: string

  /**
   * Maximum number of log events per PutLogEvents call (max 10,000)
   * @default 1000
   */
  batchSize?: number

  /**
   * Maximum time to wait before flushing buffered events in milliseconds
   * @default 5000
   */
  flushInterval?: number
}

/**
 * Internal configuration with defaults applied
 */
export interface InternalConfig {
  region: string
  logGroupName: string
  logStreamPrefix: string
  retentionDays: number
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
  }
  endpoint?: string
  batchSize: number
  flushInterval: number
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Valid CloudWatch Logs retention values
 */
export const VALID_RETENTION_DAYS = [
  0, 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922,
  3288, 3653,
]

/**
 * Maximum events per PutLogEvents API call
 */
export const MAX_BATCH_SIZE = 10000

/**
 * Maximum payload size for PutLogEvents (1MB)
 */
export const MAX_BATCH_BYTES = 1048576

/**
 * Overhead per log event (26 bytes for timestamp)
 */
export const EVENT_OVERHEAD_BYTES = 26
