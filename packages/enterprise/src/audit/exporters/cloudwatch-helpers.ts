/**
 * SMI-959: CloudWatch Logs Exporter Helpers
 *
 * Utility functions for CloudWatch configuration validation
 * and batch processing.
 */

import type { InputLogEvent } from '@aws-sdk/client-cloudwatch-logs'
import type { RetentionAuditEvent as AuditEvent } from '../retention/RetentionPolicy.js'
import {
  type CloudWatchConfig,
  type InternalConfig,
  VALID_RETENTION_DAYS,
  MAX_BATCH_SIZE,
  MAX_BATCH_BYTES,
  EVENT_OVERHEAD_BYTES,
} from './cloudwatch-types.js'

// ============================================================================
// Configuration Validation
// ============================================================================

/**
 * Validate CloudWatch configuration
 *
 * @param config - Configuration to validate
 * @throws Error if configuration is invalid
 */
export function validateCloudWatchConfig(config: CloudWatchConfig): void {
  if (!config.region) {
    throw new Error('CloudWatch region is required')
  }

  if (!config.logGroupName) {
    throw new Error('CloudWatch logGroupName is required')
  }

  if (!config.logStreamPrefix) {
    throw new Error('CloudWatch logStreamPrefix is required')
  }

  if (!VALID_RETENTION_DAYS.includes(config.retentionDays)) {
    throw new Error(
      `Invalid retentionDays: ${config.retentionDays}. Valid values are: ${VALID_RETENTION_DAYS.join(', ')}`
    )
  }

  if (
    config.batchSize !== undefined &&
    (config.batchSize < 1 || config.batchSize > MAX_BATCH_SIZE)
  ) {
    throw new Error(`batchSize must be between 1 and ${MAX_BATCH_SIZE}`)
  }

  if (config.flushInterval !== undefined && config.flushInterval < 0) {
    throw new Error('flushInterval must be non-negative')
  }
}

/**
 * Create internal configuration with defaults applied
 *
 * @param config - User-provided configuration
 * @returns Internal configuration with all required fields
 */
export function createInternalConfig(config: CloudWatchConfig): InternalConfig {
  const internalConfig: InternalConfig = {
    region: config.region,
    logGroupName: config.logGroupName,
    logStreamPrefix: config.logStreamPrefix,
    retentionDays: config.retentionDays,
    batchSize: Math.min(config.batchSize ?? 1000, MAX_BATCH_SIZE),
    flushInterval: config.flushInterval ?? 5000,
  }

  if (config.credentials) {
    internalConfig.credentials = config.credentials
  }
  if (config.endpoint) {
    internalConfig.endpoint = config.endpoint
  }

  return internalConfig
}

// ============================================================================
// Event Conversion
// ============================================================================

/**
 * Convert audit event to CloudWatch log event
 *
 * @param event - Audit event to convert
 * @returns CloudWatch log event
 */
export function toLogEvent(event: AuditEvent): InputLogEvent {
  return {
    timestamp: new Date(event.timestamp).getTime(),
    message: JSON.stringify({
      id: event.id,
      event_type: event.event_type,
      actor: event.actor,
      resource: event.resource,
      action: event.action,
      result: event.result,
      metadata: event.metadata,
      created_at: event.created_at,
    }),
  }
}

// ============================================================================
// Batch Processing
// ============================================================================

/**
 * Split events into batches that fit within CloudWatch limits
 *
 * @param events - Events to split
 * @returns Array of batches
 */
export function splitIntoBatches(events: InputLogEvent[]): InputLogEvent[][] {
  const batches: InputLogEvent[][] = []
  let currentBatch: InputLogEvent[] = []
  let currentBatchSize = 0

  for (const event of events) {
    const eventSize = (event.message?.length ?? 0) + EVENT_OVERHEAD_BYTES

    if (currentBatch.length >= MAX_BATCH_SIZE || currentBatchSize + eventSize > MAX_BATCH_BYTES) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch)
      }
      currentBatch = []
      currentBatchSize = 0
    }

    currentBatch.push(event)
    currentBatchSize += eventSize
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch)
  }

  return batches
}

/**
 * Get the current date string for log stream naming
 *
 * @returns Date string in YYYY-MM-DD format
 */
export function getCurrentDateString(): string {
  return new Date().toISOString().split('T')[0]!
}
