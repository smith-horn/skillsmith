/**
 * SMI-963: Event Stream Tests
 *
 * Comprehensive test suite for real-time audit event streaming
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  EventStreamManager,
  type StreamAuditEvent,
  type EventFilter,
  type EventSeverity,
} from '../../../src/audit/streaming/EventStream.js'

// Test utilities - fixed date for deterministic testing
const FIXED_TIMESTAMP = 1705312800000 // January 15, 2024 at 10:00 UTC
const FIXED_DATE = new Date(FIXED_TIMESTAMP)

function setupFakeTimers(): void {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_DATE)
}

function cleanupFakeTimers(): void {
  vi.useRealTimers()
}

/**
 * Create a mock audit event with sensible defaults
 */
function createMockEvent(overrides: Partial<StreamAuditEvent> = {}): StreamAuditEvent {
  return {
    id: `evt-${Math.random().toString(36).substring(7)}`,
    type: 'url_fetch',
    timestamp: new Date().toISOString(),
    severity: 'info',
    actor: 'system',
    resource: 'https://example.com',
    action: 'fetch',
    result: 'success',
    ...overrides,
  }
}

describe('EventStreamManager', () => {
  let manager: EventStreamManager

  beforeEach(() => {
    setupFakeTimers()
    manager = new EventStreamManager()
  })

  afterEach(() => {
    manager.clear()
    cleanupFakeTimers()
  })

  describe('subscribe', () => {
    it('should create a subscription and return an async iterable', () => {
      const stream = manager.subscribe({})

      expect(stream).toBeDefined()
      expect(typeof stream[Symbol.asyncIterator]).toBe('function')
    })

    it('should track subscription count', () => {
      expect(manager.subscriptionCount).toBe(0)

      manager.subscribe({})
      expect(manager.subscriptionCount).toBe(1)

      manager.subscribe({})
      expect(manager.subscriptionCount).toBe(2)
    })

    it('should reject subscriptions when max limit is reached', () => {
      const smallManager = new EventStreamManager({ maxSubscriptions: 2 })

      smallManager.subscribe({})
      smallManager.subscribe({})

      expect(() => smallManager.subscribe({})).toThrow(/Maximum subscription limit/)
    })

    it('should store filter in subscription info', () => {
      const filter: EventFilter = {
        eventTypes: ['security_scan'],
        severities: ['critical'],
        actors: ['scanner'],
      }

      manager.subscribe(filter)

      const subscriptions = manager.getActiveSubscriptions()
      expect(subscriptions).toHaveLength(1)
      expect(subscriptions[0].filter).toEqual(filter)
    })
  })

  describe('unsubscribe', () => {
    it('should remove subscription from active list', () => {
      const stream = manager.subscribe({}) as AsyncIterable<StreamAuditEvent> & {
        subscriptionId: string
      }
      const subId = stream.subscriptionId

      expect(manager.subscriptionCount).toBe(1)

      manager.unsubscribe(subId)

      expect(manager.subscriptionCount).toBe(0)
    })

    it('should handle unsubscribe of non-existent subscription gracefully', () => {
      expect(() => manager.unsubscribe('non-existent-id')).not.toThrow()
    })

    it('should close the async iterator when unsubscribed', async () => {
      const stream = manager.subscribe({}) as AsyncIterable<StreamAuditEvent> & {
        subscriptionId: string
      }
      const subId = stream.subscriptionId
      const iterator = stream[Symbol.asyncIterator]()

      // Start waiting for next event
      const nextPromise = iterator.next()

      // Unsubscribe
      manager.unsubscribe(subId)

      // Should resolve with done: true
      const result = await nextPromise
      expect(result.done).toBe(true)
    })
  })

  describe('getActiveSubscriptions', () => {
    it('should return empty array when no subscriptions', () => {
      expect(manager.getActiveSubscriptions()).toEqual([])
    })

    it('should return info for all active subscriptions', () => {
      manager.subscribe({ eventTypes: ['type1'] })
      manager.subscribe({ eventTypes: ['type2'] })

      const subscriptions = manager.getActiveSubscriptions()

      expect(subscriptions).toHaveLength(2)
      expect(subscriptions[0]).toHaveProperty('id')
      expect(subscriptions[0]).toHaveProperty('filter')
      expect(subscriptions[0]).toHaveProperty('createdAt')
      expect(subscriptions[0]).toHaveProperty('eventCount')
      expect(subscriptions[0]).toHaveProperty('isPaused')
    })

    it('should include event count in subscription info', async () => {
      const stream = manager.subscribe({})
      const iterator = stream[Symbol.asyncIterator]()

      // Emit and consume events
      manager.emit(createMockEvent())
      await iterator.next()

      manager.emit(createMockEvent())
      await iterator.next()

      const subscriptions = manager.getActiveSubscriptions()
      expect(subscriptions[0].eventCount).toBe(2)
    })
  })

  describe('emit', () => {
    it('should deliver events to subscribers', async () => {
      const stream = manager.subscribe({})
      const iterator = stream[Symbol.asyncIterator]()

      const event = createMockEvent({ type: 'security_scan' })
      manager.emit(event)

      const result = await iterator.next()
      expect(result.done).toBe(false)
      expect(result.value).toEqual(event)
    })

    it('should return count of delivered subscriptions', () => {
      manager.subscribe({})
      manager.subscribe({})
      manager.subscribe({ eventTypes: ['other_type'] })

      const event = createMockEvent({ type: 'url_fetch' })
      const count = manager.emit(event)

      // 2 subscriptions match (empty filter and other_type filter doesn't match)
      expect(count).toBe(2)
    })

    it('should buffer events when subscriber is not waiting', async () => {
      const stream = manager.subscribe({}) as AsyncIterable<StreamAuditEvent> & {
        subscriptionId: string
      }
      const subId = stream.subscriptionId

      // Emit events without consuming
      manager.emit(createMockEvent({ id: 'evt-1' }))
      manager.emit(createMockEvent({ id: 'evt-2' }))
      manager.emit(createMockEvent({ id: 'evt-3' }))

      expect(manager.getBufferSize(subId)).toBe(3)

      // Now consume events
      const iterator = stream[Symbol.asyncIterator]()
      const result1 = await iterator.next()
      expect(result1.value.id).toBe('evt-1')

      const result2 = await iterator.next()
      expect(result2.value.id).toBe('evt-2')
    })

    it('should add events to global buffer', () => {
      manager.emit(createMockEvent())
      manager.emit(createMockEvent())

      expect(manager.globalBufferSize).toBe(2)
    })
  })

  describe('event filtering', () => {
    it('should filter by event type', async () => {
      const stream = manager.subscribe({ eventTypes: ['security_scan'] })
      const iterator = stream[Symbol.asyncIterator]()

      manager.emit(createMockEvent({ type: 'url_fetch' }))
      manager.emit(createMockEvent({ type: 'security_scan', id: 'matched' }))

      const result = await iterator.next()
      expect(result.value.id).toBe('matched')
      expect(result.value.type).toBe('security_scan')
    })

    it('should filter by severity', async () => {
      const stream = manager.subscribe({ severities: ['critical', 'warning'] })
      const iterator = stream[Symbol.asyncIterator]()

      manager.emit(createMockEvent({ severity: 'info' }))
      manager.emit(createMockEvent({ severity: 'critical', id: 'matched' }))

      const result = await iterator.next()
      expect(result.value.id).toBe('matched')
      expect(result.value.severity).toBe('critical')
    })

    it('should filter by actor', async () => {
      const stream = manager.subscribe({ actors: ['scanner', 'admin'] })
      const iterator = stream[Symbol.asyncIterator]()

      manager.emit(createMockEvent({ actor: 'system' }))
      manager.emit(createMockEvent({ actor: 'scanner', id: 'matched' }))

      const result = await iterator.next()
      expect(result.value.id).toBe('matched')
      expect(result.value.actor).toBe('scanner')
    })

    it('should filter by resource (partial match)', async () => {
      const stream = manager.subscribe({ resources: ['example.com'] })
      const iterator = stream[Symbol.asyncIterator]()

      manager.emit(createMockEvent({ resource: 'https://other.com' }))
      manager.emit(createMockEvent({ resource: 'https://example.com/api', id: 'matched' }))

      const result = await iterator.next()
      expect(result.value.id).toBe('matched')
    })

    it('should apply multiple filter criteria (AND logic)', async () => {
      const stream = manager.subscribe({
        eventTypes: ['security_scan'],
        severities: ['critical'],
        actors: ['scanner'],
      })
      const iterator = stream[Symbol.asyncIterator]()

      // Only matches type
      manager.emit(createMockEvent({ type: 'security_scan', severity: 'info', actor: 'system' }))

      // Only matches type and severity
      manager.emit(
        createMockEvent({ type: 'security_scan', severity: 'critical', actor: 'system' })
      )

      // Matches all criteria
      manager.emit(
        createMockEvent({
          type: 'security_scan',
          severity: 'critical',
          actor: 'scanner',
          id: 'matched',
        })
      )

      const result = await iterator.next()
      expect(result.value.id).toBe('matched')
    })

    it('should match all events with empty filter', async () => {
      const stream = manager.subscribe({})
      const iterator = stream[Symbol.asyncIterator]()

      const event = createMockEvent()
      manager.emit(event)

      const result = await iterator.next()
      expect(result.value).toEqual(event)
    })
  })

  describe('backpressure handling', () => {
    it('should drop oldest events when buffer is full (default strategy)', () => {
      const smallManager = new EventStreamManager({
        maxBufferSize: 3,
        backpressureStrategy: 'drop-oldest',
      })

      const stream = smallManager.subscribe({}) as AsyncIterable<StreamAuditEvent> & {
        subscriptionId: string
      }
      const subId = stream.subscriptionId

      // Fill buffer
      smallManager.emit(createMockEvent({ id: 'evt-1' }))
      smallManager.emit(createMockEvent({ id: 'evt-2' }))
      smallManager.emit(createMockEvent({ id: 'evt-3' }))

      // Buffer should be full
      expect(smallManager.getBufferSize(subId)).toBe(3)

      // Emit another event
      smallManager.emit(createMockEvent({ id: 'evt-4' }))

      // Buffer still size 3, oldest dropped
      expect(smallManager.getBufferSize(subId)).toBe(3)

      smallManager.clear()
    })

    it('should reject new events when buffer is full (reject-new strategy)', () => {
      const smallManager = new EventStreamManager({
        maxBufferSize: 2,
        backpressureStrategy: 'reject-new',
      })

      const stream = smallManager.subscribe({}) as AsyncIterable<StreamAuditEvent> & {
        subscriptionId: string
      }
      const subId = stream.subscriptionId

      // Fill buffer
      smallManager.emit(createMockEvent({ id: 'evt-1' }))
      smallManager.emit(createMockEvent({ id: 'evt-2' }))

      expect(smallManager.getBufferSize(subId)).toBe(2)

      // Try to emit more
      const count = smallManager.emit(createMockEvent({ id: 'evt-3' }))

      // Event not delivered to this subscription
      expect(count).toBe(0)
      expect(smallManager.getBufferSize(subId)).toBe(2)

      smallManager.clear()
    })

    it('should limit global buffer size', () => {
      const smallManager = new EventStreamManager({ maxBufferSize: 5 })

      for (let i = 0; i < 10; i++) {
        smallManager.emit(createMockEvent({ id: `evt-${i}` }))
      }

      expect(smallManager.globalBufferSize).toBe(5)

      // Should have the most recent events
      const recent = smallManager.getRecentEvents()
      expect(recent[0].id).toBe('evt-5')
      expect(recent[4].id).toBe('evt-9')

      smallManager.clear()
    })
  })

  describe('pause and resume', () => {
    it('should pause event delivery when subscription is paused', async () => {
      const stream = manager.subscribe({}) as AsyncIterable<StreamAuditEvent> & {
        subscriptionId: string
      }
      const subId = stream.subscriptionId

      manager.pause(subId)

      const count = manager.emit(createMockEvent())
      expect(count).toBe(0)

      const subscriptions = manager.getActiveSubscriptions()
      expect(subscriptions[0].isPaused).toBe(true)
    })

    it('should resume event delivery after resume', async () => {
      const stream = manager.subscribe({}) as AsyncIterable<StreamAuditEvent> & {
        subscriptionId: string
      }
      const subId = stream.subscriptionId
      const iterator = stream[Symbol.asyncIterator]()

      manager.pause(subId)
      manager.emit(createMockEvent({ id: 'paused' }))

      manager.resume(subId)
      manager.emit(createMockEvent({ id: 'resumed' }))

      const result = await iterator.next()
      expect(result.value.id).toBe('resumed')
    })

    it('should return false when pausing non-existent subscription', () => {
      expect(manager.pause('non-existent')).toBe(false)
    })

    it('should return false when resuming non-existent subscription', () => {
      expect(manager.resume('non-existent')).toBe(false)
    })
  })

  describe('getRecentEvents', () => {
    it('should return empty array when no events', () => {
      expect(manager.getRecentEvents()).toEqual([])
    })

    it('should return recent events from global buffer', () => {
      manager.emit(createMockEvent({ id: 'evt-1' }))
      manager.emit(createMockEvent({ id: 'evt-2' }))
      manager.emit(createMockEvent({ id: 'evt-3' }))

      const events = manager.getRecentEvents()
      expect(events).toHaveLength(3)
      expect(events[0].id).toBe('evt-1')
      expect(events[2].id).toBe('evt-3')
    })

    it('should respect limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        manager.emit(createMockEvent({ id: `evt-${i}` }))
      }

      const events = manager.getRecentEvents(3)
      expect(events).toHaveLength(3)
      // Should return the most recent 3
      expect(events[0].id).toBe('evt-7')
      expect(events[2].id).toBe('evt-9')
    })
  })

  describe('clear', () => {
    it('should remove all subscriptions', () => {
      manager.subscribe({})
      manager.subscribe({})
      manager.subscribe({})

      expect(manager.subscriptionCount).toBe(3)

      manager.clear()

      expect(manager.subscriptionCount).toBe(0)
    })

    it('should clear global buffer', () => {
      manager.emit(createMockEvent())
      manager.emit(createMockEvent())

      expect(manager.globalBufferSize).toBe(2)

      manager.clear()

      expect(manager.globalBufferSize).toBe(0)
    })

    it('should close pending iterators', async () => {
      const stream = manager.subscribe({})
      const iterator = stream[Symbol.asyncIterator]()

      const nextPromise = iterator.next()
      manager.clear()

      const result = await nextPromise
      expect(result.done).toBe(true)
    })
  })

  describe('async iteration', () => {
    it('should support for-await-of loop', async () => {
      const stream = manager.subscribe({})
      const received: StreamAuditEvent[] = []

      // Emit events in background
      setTimeout(() => {
        manager.emit(createMockEvent({ id: 'evt-1' }))
        manager.emit(createMockEvent({ id: 'evt-2' }))
        // Close after 2 events
        setTimeout(() => manager.clear(), 10)
      }, 0)

      vi.advanceTimersByTime(5)

      for await (const event of stream) {
        received.push(event)
        if (received.length === 2) break
      }

      expect(received).toHaveLength(2)
      expect(received[0].id).toBe('evt-1')
      expect(received[1].id).toBe('evt-2')
    })

    it('should support iterator return for early termination', async () => {
      const stream = manager.subscribe({}) as AsyncIterable<StreamAuditEvent> & {
        subscriptionId: string
      }
      const iterator = stream[Symbol.asyncIterator]()

      // Emit an event
      manager.emit(createMockEvent())
      await iterator.next()

      // Early termination via return
      const result = await iterator.return!()
      expect(result.done).toBe(true)

      // Subscription should be removed
      expect(manager.subscriptionCount).toBe(0)
    })
  })

  describe('concurrent subscriptions', () => {
    it('should deliver same event to multiple matching subscribers', async () => {
      const stream1 = manager.subscribe({})
      const stream2 = manager.subscribe({})
      const iterator1 = stream1[Symbol.asyncIterator]()
      const iterator2 = stream2[Symbol.asyncIterator]()

      const event = createMockEvent()
      manager.emit(event)

      const result1 = await iterator1.next()
      const result2 = await iterator2.next()

      expect(result1.value).toEqual(event)
      expect(result2.value).toEqual(event)
    })

    it('should filter independently for each subscription', async () => {
      const stream1 = manager.subscribe({ severities: ['critical'] })
      const stream2 = manager.subscribe({ severities: ['info'] })
      const iterator1 = stream1[Symbol.asyncIterator]()
      const iterator2 = stream2[Symbol.asyncIterator]()

      manager.emit(createMockEvent({ severity: 'critical', id: 'critical-event' }))
      manager.emit(createMockEvent({ severity: 'info', id: 'info-event' }))

      const result1 = await iterator1.next()
      const result2 = await iterator2.next()

      expect(result1.value.id).toBe('critical-event')
      expect(result2.value.id).toBe('info-event')
    })
  })

  describe('edge cases', () => {
    it('should handle rapid emit and consume cycles', async () => {
      const stream = manager.subscribe({})
      const iterator = stream[Symbol.asyncIterator]()
      const events: StreamAuditEvent[] = []

      for (let i = 0; i < 100; i++) {
        manager.emit(createMockEvent({ id: `evt-${i}` }))
        const result = await iterator.next()
        events.push(result.value)
      }

      expect(events).toHaveLength(100)
      expect(events[0].id).toBe('evt-0')
      expect(events[99].id).toBe('evt-99')
    })

    it('should handle metadata in events', async () => {
      const stream = manager.subscribe({})
      const iterator = stream[Symbol.asyncIterator]()

      const event = createMockEvent({
        metadata: {
          nested: { value: 123 },
          array: [1, 2, 3],
          string: 'test',
        },
      })

      manager.emit(event)

      const result = await iterator.next()
      expect(result.value.metadata).toEqual(event.metadata)
    })

    it('should handle events without metadata', async () => {
      const stream = manager.subscribe({})
      const iterator = stream[Symbol.asyncIterator]()

      const event = createMockEvent()
      delete event.metadata

      manager.emit(event)

      const result = await iterator.next()
      expect(result.value.metadata).toBeUndefined()
    })

    it('should handle subscription with all filter types', async () => {
      const filter: EventFilter = {
        eventTypes: ['security_scan', 'url_fetch'],
        severities: ['critical', 'warning'],
        actors: ['scanner', 'admin'],
        resources: ['skill-', 'api/'],
      }

      const stream = manager.subscribe(filter)
      const iterator = stream[Symbol.asyncIterator]()

      // Event that matches all criteria
      const matchingEvent = createMockEvent({
        type: 'security_scan',
        severity: 'critical',
        actor: 'scanner',
        resource: 'skill-123',
        id: 'matched',
      })

      manager.emit(matchingEvent)

      const result = await iterator.next()
      expect(result.value.id).toBe('matched')
    })
  })
})
