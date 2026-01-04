/**
 * SMI-959: AWS CloudWatch Logs Exporter
 *
 * Exports audit events to AWS CloudWatch Logs for centralized log management,
 * monitoring, and compliance. Supports IAM role-based authentication and
 * configurable retention policies.
 */

import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  PutLogEventsCommand,
  PutRetentionPolicyCommand,
  type InputLogEvent,
  type CloudWatchLogsClientConfig,
} from '@aws-sdk/client-cloudwatch-logs'
import type { RetentionAuditEvent as AuditEvent } from '../retention/RetentionPolicy.js'
import type { StreamingExporter, ExportResult } from './index.js'

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
 * Valid CloudWatch Logs retention values
 */
const VALID_RETENTION_DAYS = [
  0, 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922,
  3288, 3653,
]

/**
 * Maximum events per PutLogEvents API call
 */
const MAX_BATCH_SIZE = 10000

/**
 * Maximum payload size for PutLogEvents (1MB)
 */
const MAX_BATCH_BYTES = 1048576

/**
 * Overhead per log event (26 bytes for timestamp)
 */
const EVENT_OVERHEAD_BYTES = 26

/**
 * CloudWatch Logs exporter for audit events
 *
 * @example
 * ```typescript
 * const exporter = new CloudWatchExporter({
 *   region: 'us-east-1',
 *   logGroupName: '/skillsmith/enterprise/audit',
 *   logStreamPrefix: 'audit-events',
 *   retentionDays: 90,
 * })
 *
 * await exporter.initialize()
 *
 * const result = await exporter.stream([
 *   { id: '1', event_type: 'skill_install', ... }
 * ])
 *
 * await exporter.close()
 * ```
 */
/**
 * Internal configuration with defaults applied
 */
interface InternalConfig {
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

export class CloudWatchExporter implements StreamingExporter {
  readonly format = 'cloudwatch'

  private client: CloudWatchLogsClient
  private config: InternalConfig
  private currentLogStream: string | null = null
  private sequenceToken: string | undefined = undefined
  private buffer: InputLogEvent[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private initialized = false

  constructor(config: CloudWatchConfig) {
    this.validateConfig(config)

    // Build config with required properties
    const internalConfig: InternalConfig = {
      region: config.region,
      logGroupName: config.logGroupName,
      logStreamPrefix: config.logStreamPrefix,
      retentionDays: config.retentionDays,
      batchSize: Math.min(config.batchSize ?? 1000, MAX_BATCH_SIZE),
      flushInterval: config.flushInterval ?? 5000,
    }

    // Add optional properties only if defined
    if (config.credentials) {
      internalConfig.credentials = config.credentials
    }
    if (config.endpoint) {
      internalConfig.endpoint = config.endpoint
    }

    this.config = internalConfig

    const clientConfig: CloudWatchLogsClientConfig = {
      region: config.region,
    }

    if (config.credentials) {
      clientConfig.credentials = {
        accessKeyId: config.credentials.accessKeyId,
        secretAccessKey: config.credentials.secretAccessKey,
      }
    }

    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint
    }

    this.client = new CloudWatchLogsClient(clientConfig)
  }

  /**
   * Validate configuration
   */
  private validateConfig(config: CloudWatchConfig): void {
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
   * Initialize the exporter by creating log group and stream if needed
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    // Ensure log group exists
    await this.ensureLogGroup()

    // Set retention policy
    if (this.config.retentionDays > 0) {
      await this.setRetentionPolicy()
    }

    // Create initial log stream
    await this.createLogStream()

    this.initialized = true
  }

  /**
   * Ensure the log group exists
   */
  private async ensureLogGroup(): Promise<void> {
    try {
      const response = await this.client.send(
        new DescribeLogGroupsCommand({
          logGroupNamePrefix: this.config.logGroupName,
          limit: 1,
        })
      )

      const exists = response.logGroups?.some((lg) => lg.logGroupName === this.config.logGroupName)

      if (!exists) {
        await this.client.send(
          new CreateLogGroupCommand({
            logGroupName: this.config.logGroupName,
          })
        )
      }
    } catch (error) {
      const err = error as Error
      // ResourceAlreadyExistsException is acceptable
      if (!err.name?.includes('ResourceAlreadyExistsException')) {
        throw new Error(`Failed to create log group: ${err.message}`)
      }
    }
  }

  /**
   * Set retention policy on the log group
   */
  private async setRetentionPolicy(): Promise<void> {
    try {
      await this.client.send(
        new PutRetentionPolicyCommand({
          logGroupName: this.config.logGroupName,
          retentionInDays: this.config.retentionDays,
        })
      )
    } catch (error) {
      const err = error as Error
      throw new Error(`Failed to set retention policy: ${err.message}`)
    }
  }

  /**
   * Create a new log stream for the current date
   */
  private async createLogStream(): Promise<void> {
    const dateStr = new Date().toISOString().split('T')[0] // YYYY-MM-DD
    const streamName = `${this.config.logStreamPrefix}-${dateStr}`

    if (this.currentLogStream === streamName) {
      return
    }

    try {
      // Check if stream exists
      const response = await this.client.send(
        new DescribeLogStreamsCommand({
          logGroupName: this.config.logGroupName,
          logStreamNamePrefix: streamName,
          limit: 1,
        })
      )

      const existingStream = response.logStreams?.find((ls) => ls.logStreamName === streamName)

      if (existingStream) {
        this.currentLogStream = streamName
        this.sequenceToken = existingStream.uploadSequenceToken
        return
      }

      // Create new stream
      await this.client.send(
        new CreateLogStreamCommand({
          logGroupName: this.config.logGroupName,
          logStreamName: streamName,
        })
      )

      this.currentLogStream = streamName
      this.sequenceToken = undefined
    } catch (error) {
      const err = error as Error
      // ResourceAlreadyExistsException is acceptable
      if (err.name?.includes('ResourceAlreadyExistsException')) {
        this.currentLogStream = streamName
        this.sequenceToken = undefined
      } else {
        throw new Error(`Failed to create log stream: ${err.message}`)
      }
    }
  }

  /**
   * Convert audit event to CloudWatch log event
   */
  private toLogEvent(event: AuditEvent): InputLogEvent {
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

  /**
   * Export events to a buffer (batch export)
   */
  async export(events: AuditEvent[]): Promise<Buffer> {
    const logEvents = events.map((e) => this.toLogEvent(e))
    const jsonOutput = JSON.stringify(logEvents, null, 2)
    return Buffer.from(jsonOutput, 'utf-8')
  }

  /**
   * Stream events to CloudWatch Logs
   */
  async stream(events: AuditEvent[]): Promise<ExportResult> {
    const startTime = Date.now()

    if (!this.initialized) {
      await this.initialize()
    }

    // Ensure we have a current log stream (may change on day boundary)
    await this.createLogStream()

    if (!this.currentLogStream) {
      return {
        success: false,
        exportedCount: 0,
        failedCount: events.length,
        error: 'No log stream available',
        exportedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
      }
    }

    const logEvents = events.map((e) => this.toLogEvent(e))

    // Add to buffer
    this.buffer.push(...logEvents)

    // Check if we need to flush
    if (this.buffer.length >= this.config.batchSize) {
      return this.flushBuffer(startTime)
    }

    // Schedule a flush if not already scheduled
    this.scheduleFlush()

    return {
      success: true,
      exportedCount: events.length,
      failedCount: 0,
      exportedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    }
  }

  /**
   * Schedule a flush after flushInterval
   */
  private scheduleFlush(): void {
    if (this.flushTimer) {
      return
    }

    this.flushTimer = setTimeout(() => {
      this.flush().catch((err) => {
        console.error('CloudWatch flush error:', err)
      })
    }, this.config.flushInterval)
  }

  /**
   * Flush buffered events to CloudWatch
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    if (this.buffer.length === 0) {
      return
    }

    await this.flushBuffer(Date.now())
  }

  /**
   * Flush buffer and return result
   */
  private async flushBuffer(startTime: number): Promise<ExportResult> {
    const eventsToSend = this.buffer.splice(0, this.config.batchSize)

    if (eventsToSend.length === 0) {
      return {
        success: true,
        exportedCount: 0,
        failedCount: 0,
        exportedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
      }
    }

    // Sort events by timestamp (required by CloudWatch)
    eventsToSend.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))

    // Split into batches that fit within size limits
    const batches = this.splitIntoBatches(eventsToSend)

    let exportedCount = 0
    let failedCount = 0
    let lastError: string | undefined

    for (const batch of batches) {
      try {
        const response = await this.client.send(
          new PutLogEventsCommand({
            logGroupName: this.config.logGroupName,
            logStreamName: this.currentLogStream!,
            logEvents: batch,
            sequenceToken: this.sequenceToken,
          })
        )

        this.sequenceToken = response.nextSequenceToken
        exportedCount += batch.length

        // Check for rejected events
        if (response.rejectedLogEventsInfo) {
          const rejected = response.rejectedLogEventsInfo
          const rejectedCount =
            (rejected.expiredLogEventEndIndex ?? 0) -
            (rejected.tooNewLogEventStartIndex ?? 0) +
            (rejected.tooOldLogEventEndIndex ?? 0)
          failedCount += rejectedCount
          exportedCount -= rejectedCount
        }
      } catch (error) {
        const err = error as Error & { expectedSequenceToken?: string }

        // Handle sequence token mismatch
        if (err.name === 'InvalidSequenceTokenException' && err.expectedSequenceToken) {
          this.sequenceToken = err.expectedSequenceToken
          // Retry once with correct token
          try {
            const retryResponse = await this.client.send(
              new PutLogEventsCommand({
                logGroupName: this.config.logGroupName,
                logStreamName: this.currentLogStream!,
                logEvents: batch,
                sequenceToken: this.sequenceToken,
              })
            )
            this.sequenceToken = retryResponse.nextSequenceToken
            exportedCount += batch.length
          } catch (retryError) {
            failedCount += batch.length
            lastError = (retryError as Error).message
          }
        } else {
          failedCount += batch.length
          lastError = err.message
        }
      }
    }

    const result: ExportResult = {
      success: failedCount === 0,
      exportedCount,
      failedCount,
      exportedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    }

    if (lastError) {
      result.error = lastError
    }

    return result
  }

  /**
   * Split events into batches that fit within CloudWatch limits
   */
  private splitIntoBatches(events: InputLogEvent[]): InputLogEvent[][] {
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
   * Close the exporter and cleanup resources
   */
  async close(): Promise<void> {
    // Flush any remaining events
    await this.flush()

    // Clear timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    // Destroy client
    this.client.destroy()
    this.initialized = false
  }
}
