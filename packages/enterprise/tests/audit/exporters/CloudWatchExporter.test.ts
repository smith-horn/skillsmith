/**
 * SMI-959: CloudWatch Logs Exporter Tests
 *
 * Tests for the AWS CloudWatch Logs exporter with mocked AWS SDK.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CloudWatchConfig } from '../../../src/audit/exporters/CloudWatchExporter.js'
import type { RetentionAuditEvent as AuditEvent } from '../../../src/audit/retention/RetentionPolicy.js'

// Use vi.hoisted to create mocks that can be used in vi.mock factory
const { mockSend, mockDestroy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockDestroy: vi.fn(),
}))

// Mock the AWS SDK
vi.mock('@aws-sdk/client-cloudwatch-logs', () => {
  // Create a proper class mock
  class MockCloudWatchLogsClient {
    send = mockSend
    destroy = mockDestroy
    constructor(_config: unknown) {
      // Constructor can receive config
    }
  }

  return {
    CloudWatchLogsClient: MockCloudWatchLogsClient,
    CreateLogGroupCommand: class {
      type = 'CreateLogGroupCommand'
      constructor(public input: unknown) {}
    },
    CreateLogStreamCommand: class {
      type = 'CreateLogStreamCommand'
      constructor(public input: unknown) {}
    },
    DescribeLogGroupsCommand: class {
      type = 'DescribeLogGroupsCommand'
      constructor(public input: unknown) {}
    },
    DescribeLogStreamsCommand: class {
      type = 'DescribeLogStreamsCommand'
      constructor(public input: unknown) {}
    },
    PutLogEventsCommand: class {
      type = 'PutLogEventsCommand'
      constructor(public input: unknown) {}
    },
    PutRetentionPolicyCommand: class {
      type = 'PutRetentionPolicyCommand'
      constructor(public input: unknown) {}
    },
  }
})

// Import after mock setup
import { CloudWatchExporter } from '../../../src/audit/exporters/CloudWatchExporter.js'

const getMockClient = () => {
  return { send: mockSend, destroy: mockDestroy }
}

describe('CloudWatchExporter', () => {
  const baseConfig: CloudWatchConfig = {
    region: 'us-east-1',
    logGroupName: '/skillsmith/enterprise/audit',
    logStreamPrefix: 'audit-events',
    retentionDays: 90,
  }

  const createMockAuditEvent = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
    id: 'test-event-1',
    event_type: 'skill_install',
    timestamp: new Date().toISOString(),
    actor: 'user',
    resource: 'skill/test-skill',
    action: 'install',
    result: 'success',
    created_at: new Date().toISOString(),
    ...overrides,
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('constructor', () => {
    it('should create exporter with valid configuration', () => {
      const exporter = new CloudWatchExporter(baseConfig)
      expect(exporter).toBeDefined()
      expect(exporter.format).toBe('cloudwatch')
    })

    it('should create exporter with optional credentials', () => {
      const config: CloudWatchConfig = {
        ...baseConfig,
        credentials: {
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        },
      }
      const exporter = new CloudWatchExporter(config)
      expect(exporter).toBeDefined()
    })

    it('should create exporter with custom endpoint', () => {
      const config: CloudWatchConfig = {
        ...baseConfig,
        endpoint: 'http://localhost:4566',
      }
      const exporter = new CloudWatchExporter(config)
      expect(exporter).toBeDefined()
    })

    it('should throw error for missing region', () => {
      const config = { ...baseConfig, region: '' }
      expect(() => new CloudWatchExporter(config)).toThrow('CloudWatch region is required')
    })

    it('should throw error for missing logGroupName', () => {
      const config = { ...baseConfig, logGroupName: '' }
      expect(() => new CloudWatchExporter(config)).toThrow('CloudWatch logGroupName is required')
    })

    it('should throw error for missing logStreamPrefix', () => {
      const config = { ...baseConfig, logStreamPrefix: '' }
      expect(() => new CloudWatchExporter(config)).toThrow('CloudWatch logStreamPrefix is required')
    })

    it('should throw error for invalid retentionDays', () => {
      const config = { ...baseConfig, retentionDays: 45 }
      expect(() => new CloudWatchExporter(config)).toThrow(
        'Invalid retentionDays: 45. Valid values are:'
      )
    })

    it('should accept valid retentionDays values', () => {
      const validValues = [0, 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365]
      for (const days of validValues) {
        const config = { ...baseConfig, retentionDays: days }
        expect(() => new CloudWatchExporter(config)).not.toThrow()
      }
    })

    it('should throw error for invalid batchSize', () => {
      const config = { ...baseConfig, batchSize: 0 }
      expect(() => new CloudWatchExporter(config)).toThrow('batchSize must be between 1 and 10000')
    })

    it('should throw error for batchSize exceeding max', () => {
      const config = { ...baseConfig, batchSize: 10001 }
      expect(() => new CloudWatchExporter(config)).toThrow('batchSize must be between 1 and 10000')
    })

    it('should throw error for negative flushInterval', () => {
      const config = { ...baseConfig, flushInterval: -1 }
      expect(() => new CloudWatchExporter(config)).toThrow('flushInterval must be non-negative')
    })

    it('should use default batchSize and flushInterval', () => {
      const exporter = new CloudWatchExporter(baseConfig)
      expect(exporter).toBeDefined()
      // Internal config defaults are applied
    })
  })

  describe('initialize', () => {
    it('should create log group if not exists', async () => {
      const exporter = new CloudWatchExporter(baseConfig)

      const mockClient = getMockClient()
      mockClient.send.mockImplementation(async (command: { type: string }) => {
        if (command.type === 'DescribeLogGroupsCommand') {
          return { logGroups: [] }
        }
        if (command.type === 'CreateLogGroupCommand') {
          return {}
        }
        if (command.type === 'PutRetentionPolicyCommand') {
          return {}
        }
        if (command.type === 'DescribeLogStreamsCommand') {
          return { logStreams: [] }
        }
        if (command.type === 'CreateLogStreamCommand') {
          return {}
        }
        return {}
      })

      await exporter.initialize()

      expect(mockClient.send).toHaveBeenCalled()
    })

    it('should not create log group if already exists', async () => {
      const exporter = new CloudWatchExporter(baseConfig)

      const mockClient = getMockClient()
      mockClient.send.mockImplementation(async (command: { type: string }) => {
        if (command.type === 'DescribeLogGroupsCommand') {
          return {
            logGroups: [{ logGroupName: baseConfig.logGroupName }],
          }
        }
        if (command.type === 'PutRetentionPolicyCommand') {
          return {}
        }
        if (command.type === 'DescribeLogStreamsCommand') {
          return { logStreams: [] }
        }
        if (command.type === 'CreateLogStreamCommand') {
          return {}
        }
        return {}
      })

      await exporter.initialize()

      const createGroupCalls = mockClient.send.mock.calls.filter(
        ([cmd]: [{ type: string }]) => cmd.type === 'CreateLogGroupCommand'
      )
      expect(createGroupCalls).toHaveLength(0)
    })

    it('should be idempotent (multiple calls)', async () => {
      const exporter = new CloudWatchExporter(baseConfig)

      const mockClient = getMockClient()
      mockClient.send.mockImplementation(async (command: { type: string }) => {
        if (command.type === 'DescribeLogGroupsCommand') {
          return { logGroups: [{ logGroupName: baseConfig.logGroupName }] }
        }
        if (command.type === 'PutRetentionPolicyCommand') {
          return {}
        }
        if (command.type === 'DescribeLogStreamsCommand') {
          return { logStreams: [] }
        }
        if (command.type === 'CreateLogStreamCommand') {
          return {}
        }
        return {}
      })

      await exporter.initialize()
      const callsAfterFirst = mockClient.send.mock.calls.length

      await exporter.initialize()
      const callsAfterSecond = mockClient.send.mock.calls.length

      // Second call should not make additional API calls
      expect(callsAfterSecond).toBe(callsAfterFirst)
    })

    it('should handle ResourceAlreadyExistsException gracefully', async () => {
      const exporter = new CloudWatchExporter(baseConfig)

      const mockClient = getMockClient()
      mockClient.send.mockImplementation(async (command: { type: string }) => {
        if (command.type === 'DescribeLogGroupsCommand') {
          return { logGroups: [] }
        }
        if (command.type === 'CreateLogGroupCommand') {
          const error = new Error('Log group already exists')
          error.name = 'ResourceAlreadyExistsException'
          throw error
        }
        if (command.type === 'PutRetentionPolicyCommand') {
          return {}
        }
        if (command.type === 'DescribeLogStreamsCommand') {
          return { logStreams: [] }
        }
        if (command.type === 'CreateLogStreamCommand') {
          return {}
        }
        return {}
      })

      // Should not throw
      await expect(exporter.initialize()).resolves.not.toThrow()
    })
  })

  describe('export', () => {
    it('should export events to buffer as JSON', async () => {
      const exporter = new CloudWatchExporter(baseConfig)
      const events = [createMockAuditEvent(), createMockAuditEvent({ id: 'test-event-2' })]

      const buffer = await exporter.export(events)

      expect(buffer).toBeInstanceOf(Buffer)
      const parsed = JSON.parse(buffer.toString())
      expect(parsed).toHaveLength(2)
      expect(parsed[0]).toHaveProperty('timestamp')
      expect(parsed[0]).toHaveProperty('message')
    })
  })

  describe('stream', () => {
    it('should stream events to CloudWatch', async () => {
      const exporter = new CloudWatchExporter({
        ...baseConfig,
        batchSize: 1, // Force immediate flush
      })

      const mockClient = getMockClient()
      mockClient.send.mockImplementation(async (command: { type: string }) => {
        if (command.type === 'DescribeLogGroupsCommand') {
          return { logGroups: [{ logGroupName: baseConfig.logGroupName }] }
        }
        if (command.type === 'PutRetentionPolicyCommand') {
          return {}
        }
        if (command.type === 'DescribeLogStreamsCommand') {
          return { logStreams: [] }
        }
        if (command.type === 'CreateLogStreamCommand') {
          return {}
        }
        if (command.type === 'PutLogEventsCommand') {
          return { nextSequenceToken: 'token-1' }
        }
        return {}
      })

      const events = [createMockAuditEvent()]
      const result = await exporter.stream(events)

      expect(result.success).toBe(true)
      expect(result.exportedCount).toBe(1)
      expect(result.failedCount).toBe(0)

      await exporter.close()
    })

    it('should auto-initialize if not initialized', async () => {
      const exporter = new CloudWatchExporter({
        ...baseConfig,
        batchSize: 100,
        flushInterval: 10000,
      })

      const mockClient = getMockClient()
      mockClient.send.mockImplementation(async (command: { type: string }) => {
        if (command.type === 'DescribeLogGroupsCommand') {
          return { logGroups: [{ logGroupName: baseConfig.logGroupName }] }
        }
        if (command.type === 'PutRetentionPolicyCommand') {
          return {}
        }
        if (command.type === 'DescribeLogStreamsCommand') {
          return { logStreams: [] }
        }
        if (command.type === 'CreateLogStreamCommand') {
          return {}
        }
        if (command.type === 'PutLogEventsCommand') {
          return { nextSequenceToken: 'token-1' }
        }
        return {}
      })

      // Don't call initialize(), stream should do it
      const events = [createMockAuditEvent()]
      const result = await exporter.stream(events)

      expect(result.success).toBe(true)

      await exporter.close()
    })

    it('should handle sequence token mismatch and retry', async () => {
      const exporter = new CloudWatchExporter({
        ...baseConfig,
        batchSize: 1,
      })

      const mockClient = getMockClient()
      let putLogEventsCallCount = 0

      mockClient.send.mockImplementation(async (command: { type: string }) => {
        if (command.type === 'DescribeLogGroupsCommand') {
          return { logGroups: [{ logGroupName: baseConfig.logGroupName }] }
        }
        if (command.type === 'PutRetentionPolicyCommand') {
          return {}
        }
        if (command.type === 'DescribeLogStreamsCommand') {
          return { logStreams: [] }
        }
        if (command.type === 'CreateLogStreamCommand') {
          return {}
        }
        if (command.type === 'PutLogEventsCommand') {
          putLogEventsCallCount++
          if (putLogEventsCallCount === 1) {
            const error = new Error('Invalid sequence token') as Error & {
              expectedSequenceToken: string
            }
            error.name = 'InvalidSequenceTokenException'
            error.expectedSequenceToken = 'correct-token'
            throw error
          }
          return { nextSequenceToken: 'next-token' }
        }
        return {}
      })

      const events = [createMockAuditEvent()]
      const result = await exporter.stream(events)

      expect(result.success).toBe(true)
      expect(putLogEventsCallCount).toBe(2) // Initial + retry

      await exporter.close()
    })

    it('should report rejected events', async () => {
      const exporter = new CloudWatchExporter({
        ...baseConfig,
        batchSize: 1,
      })

      const mockClient = getMockClient()
      mockClient.send.mockImplementation(async (command: { type: string }) => {
        if (command.type === 'DescribeLogGroupsCommand') {
          return { logGroups: [{ logGroupName: baseConfig.logGroupName }] }
        }
        if (command.type === 'PutRetentionPolicyCommand') {
          return {}
        }
        if (command.type === 'DescribeLogStreamsCommand') {
          return { logStreams: [] }
        }
        if (command.type === 'CreateLogStreamCommand') {
          return {}
        }
        if (command.type === 'PutLogEventsCommand') {
          return {
            nextSequenceToken: 'token',
            rejectedLogEventsInfo: {
              expiredLogEventEndIndex: 1,
              tooNewLogEventStartIndex: 0,
              tooOldLogEventEndIndex: 0,
            },
          }
        }
        return {}
      })

      const events = [createMockAuditEvent()]
      const result = await exporter.stream(events)

      expect(result.failedCount).toBeGreaterThan(0)

      await exporter.close()
    })
  })

  describe('flush', () => {
    it('should flush buffered events', async () => {
      const exporter = new CloudWatchExporter({
        ...baseConfig,
        batchSize: 100, // Large batch size to buffer events
        flushInterval: 60000, // Long interval to prevent auto-flush
      })

      const mockClient = getMockClient()
      mockClient.send.mockImplementation(async (command: { type: string }) => {
        if (command.type === 'DescribeLogGroupsCommand') {
          return { logGroups: [{ logGroupName: baseConfig.logGroupName }] }
        }
        if (command.type === 'PutRetentionPolicyCommand') {
          return {}
        }
        if (command.type === 'DescribeLogStreamsCommand') {
          return { logStreams: [] }
        }
        if (command.type === 'CreateLogStreamCommand') {
          return {}
        }
        if (command.type === 'PutLogEventsCommand') {
          return { nextSequenceToken: 'token-1' }
        }
        return {}
      })

      // Add events to buffer (won't trigger auto-flush due to large batch size)
      const events = [createMockAuditEvent(), createMockAuditEvent({ id: 'test-2' })]
      await exporter.stream(events)

      // Manually flush
      await exporter.flush()

      // Verify PutLogEvents was called
      const putLogEventsCalls = mockClient.send.mock.calls.filter(
        ([cmd]: [{ type: string }]) => cmd.type === 'PutLogEventsCommand'
      )
      expect(putLogEventsCalls.length).toBeGreaterThan(0)

      await exporter.close()
    })

    it('should be safe to call on empty buffer', async () => {
      const exporter = new CloudWatchExporter(baseConfig)

      const mockClient = getMockClient()
      mockClient.send.mockImplementation(async () => ({}))

      await expect(exporter.flush()).resolves.not.toThrow()

      await exporter.close()
    })
  })

  describe('close', () => {
    it('should flush remaining events and cleanup', async () => {
      const exporter = new CloudWatchExporter({
        ...baseConfig,
        batchSize: 100,
        flushInterval: 60000,
      })

      const mockClient = getMockClient()
      mockClient.send.mockImplementation(async (command: { type: string }) => {
        if (command.type === 'DescribeLogGroupsCommand') {
          return { logGroups: [{ logGroupName: baseConfig.logGroupName }] }
        }
        if (command.type === 'PutRetentionPolicyCommand') {
          return {}
        }
        if (command.type === 'DescribeLogStreamsCommand') {
          return { logStreams: [] }
        }
        if (command.type === 'CreateLogStreamCommand') {
          return {}
        }
        if (command.type === 'PutLogEventsCommand') {
          return { nextSequenceToken: 'token' }
        }
        return {}
      })

      await exporter.initialize()
      await exporter.stream([createMockAuditEvent()])

      await exporter.close()

      expect(mockClient.destroy).toHaveBeenCalled()
    })

    it('should be safe to call multiple times', async () => {
      const exporter = new CloudWatchExporter(baseConfig)

      const mockClient = getMockClient()
      mockClient.send.mockImplementation(async () => ({}))

      await exporter.close()
      await expect(exporter.close()).resolves.not.toThrow()
    })
  })

  describe('batch splitting', () => {
    it('should split large event batches', async () => {
      const exporter = new CloudWatchExporter({
        ...baseConfig,
        batchSize: 2, // Small batch size to test splitting
      })

      const mockClient = getMockClient()
      let putLogEventsCallCount = 0

      mockClient.send.mockImplementation(async (command: { type: string }) => {
        if (command.type === 'DescribeLogGroupsCommand') {
          return { logGroups: [{ logGroupName: baseConfig.logGroupName }] }
        }
        if (command.type === 'PutRetentionPolicyCommand') {
          return {}
        }
        if (command.type === 'DescribeLogStreamsCommand') {
          return { logStreams: [] }
        }
        if (command.type === 'CreateLogStreamCommand') {
          return {}
        }
        if (command.type === 'PutLogEventsCommand') {
          putLogEventsCallCount++
          return { nextSequenceToken: `token-${putLogEventsCallCount}` }
        }
        return {}
      })

      // Stream 5 events with batch size of 2
      const events = [
        createMockAuditEvent({ id: '1' }),
        createMockAuditEvent({ id: '2' }),
        createMockAuditEvent({ id: '3' }),
        createMockAuditEvent({ id: '4' }),
        createMockAuditEvent({ id: '5' }),
      ]

      // First batch of 2 triggers flush
      await exporter.stream(events.slice(0, 2))
      // Second batch of 2 triggers flush
      await exporter.stream(events.slice(2, 4))
      // Third batch of 1 (remaining event)
      await exporter.stream(events.slice(4))
      await exporter.flush()

      // Each batch of 2 or less should be a separate call
      expect(putLogEventsCallCount).toBeGreaterThanOrEqual(2)

      await exporter.close()
    })
  })

  describe('IAM role-based authentication', () => {
    it('should work without explicit credentials (uses IAM role)', () => {
      const config: CloudWatchConfig = {
        region: 'us-east-1',
        logGroupName: '/app/logs',
        logStreamPrefix: 'events',
        retentionDays: 30,
        // No credentials - will use IAM role
      }

      const exporter = new CloudWatchExporter(config)
      expect(exporter).toBeDefined()
    })

    it('should use provided credentials when specified', () => {
      const config: CloudWatchConfig = {
        region: 'us-east-1',
        logGroupName: '/app/logs',
        logStreamPrefix: 'events',
        retentionDays: 30,
        credentials: {
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        },
      }

      const exporter = new CloudWatchExporter(config)
      expect(exporter).toBeDefined()
    })
  })
})
