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

// Re-export types from extracted module
export {
  type CloudWatchConfig,
  type InternalConfig,
  VALID_RETENTION_DAYS,
  MAX_BATCH_SIZE,
  MAX_BATCH_BYTES,
  EVENT_OVERHEAD_BYTES,
} from './cloudwatch-types.js'

// Import for internal use
import { type CloudWatchConfig, type InternalConfig } from './cloudwatch-types.js'
import {
  validateCloudWatchConfig,
  createInternalConfig,
  toLogEvent,
  splitIntoBatches,
  getCurrentDateString,
} from './cloudwatch-helpers.js'

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
    validateCloudWatchConfig(config)
    this.config = createInternalConfig(config)

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
   * Initialize the exporter by creating log group and stream if needed
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    await this.ensureLogGroup()

    if (this.config.retentionDays > 0) {
      await this.setRetentionPolicy()
    }

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
    const dateStr = getCurrentDateString()
    const streamName = `${this.config.logStreamPrefix}-${dateStr}`

    if (this.currentLogStream === streamName) {
      return
    }

    try {
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
      if (err.name?.includes('ResourceAlreadyExistsException')) {
        this.currentLogStream = streamName
        this.sequenceToken = undefined
      } else {
        throw new Error(`Failed to create log stream: ${err.message}`)
      }
    }
  }

  /**
   * Export events to a buffer (batch export)
   */
  async export(events: AuditEvent[]): Promise<Buffer> {
    const logEvents = events.map((e) => toLogEvent(e))
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

    const logEvents = events.map((e) => toLogEvent(e))
    this.buffer.push(...logEvents)

    if (this.buffer.length >= this.config.batchSize) {
      return this.flushBuffer(startTime)
    }

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

    eventsToSend.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))

    const batches = splitIntoBatches(eventsToSend)

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

        if (err.name === 'InvalidSequenceTokenException' && err.expectedSequenceToken) {
          this.sequenceToken = err.expectedSequenceToken
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
   * Close the exporter and cleanup resources
   */
  async close(): Promise<void> {
    await this.flush()

    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    this.client.destroy()
    this.initialized = false
  }
}
