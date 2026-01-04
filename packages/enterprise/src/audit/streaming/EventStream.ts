/**
 * SMI-963: Real-Time Event Streaming
 *
 * Provides AsyncIterable-based streaming for audit events with filtering,
 * backpressure handling, and subscription management.
 *
 * Core implementation without WebSocket dependency - protocol adapters
 * can be built on top of this core.
 */

import { randomUUID } from 'crypto'

/**
 * Severity levels for audit events
 */
export type EventSeverity = 'info' | 'warning' | 'critical'

/**
 * Audit event structure for streaming
 * Named StreamAuditEvent to avoid collision with AuditEvent in AuditEventTypes
 */
export interface StreamAuditEvent {
  id: string
  type: string
  timestamp: string
  severity: EventSeverity
  actor: string
  resource: string
  action: string
  result: 'success' | 'blocked' | 'error' | 'warning'
  metadata?: Record<string, unknown>
}

/**
 * Filter criteria for event subscriptions
 */
export interface EventFilter {
  eventTypes?: string[]
  severities?: EventSeverity[]
  actors?: string[]
  resources?: string[]
}

/**
 * Information about an active subscription
 */
export interface SubscriptionInfo {
  id: string
  filter: EventFilter
  createdAt: string
  eventCount: number
  isPaused: boolean
}

/**
 * Internal subscription state
 */
interface Subscription {
  id: string
  filter: EventFilter
  createdAt: string
  eventCount: number
  isPaused: boolean
  buffer: StreamAuditEvent[]
  resolve: ((value: IteratorResult<StreamAuditEvent>) => void) | null
  reject: ((error: Error) => void) | null
  closed: boolean
}

/**
 * Configuration options for EventStreamManager
 */
export interface EventStreamConfig {
  /**
   * Maximum buffer size per subscription before backpressure kicks in
   * @default 1000
   */
  maxBufferSize?: number

  /**
   * Behavior when buffer is full: 'drop-oldest' or 'reject-new'
   * @default 'drop-oldest'
   */
  backpressureStrategy?: 'drop-oldest' | 'reject-new'

  /**
   * Maximum number of concurrent subscriptions
   * @default 100
   */
  maxSubscriptions?: number
}

/**
 * Interface for audit event streaming
 */
export interface AuditEventStream {
  subscribe(filter: EventFilter): AsyncIterable<StreamAuditEvent>
  unsubscribe(subscriptionId: string): void
  getActiveSubscriptions(): SubscriptionInfo[]
}

/**
 * Event stream manager implementing real-time audit event streaming
 *
 * @example
 * ```typescript
 * const manager = new EventStreamManager()
 *
 * // Subscribe with filter
 * const stream = manager.subscribe({
 *   severities: ['critical', 'warning'],
 *   eventTypes: ['security_scan', 'url_fetch']
 * })
 *
 * // Consume events asynchronously
 * for await (const event of stream) {
 *   console.log('Received event:', event.type, event.severity)
 * }
 *
 * // From another part of the code (e.g., EnterpriseAuditLogger)
 * manager.emit({
 *   id: 'evt-123',
 *   type: 'security_scan',
 *   timestamp: new Date().toISOString(),
 *   severity: 'critical',
 *   actor: 'scanner',
 *   resource: 'skill-xyz',
 *   action: 'scan',
 *   result: 'warning',
 *   metadata: { findings: 3 }
 * })
 * ```
 */
export class EventStreamManager implements AuditEventStream {
  private subscriptions: Map<string, Subscription> = new Map()
  private eventBuffer: StreamAuditEvent[] = []
  private config: Required<EventStreamConfig>

  constructor(config: EventStreamConfig = {}) {
    this.config = {
      maxBufferSize: config.maxBufferSize ?? 1000,
      backpressureStrategy: config.backpressureStrategy ?? 'drop-oldest',
      maxSubscriptions: config.maxSubscriptions ?? 100,
    }
  }

  /**
   * Subscribe to audit events with optional filtering
   *
   * @param filter - Filter criteria for events
   * @returns AsyncIterable that yields matching events
   * @throws Error if max subscriptions limit is reached
   */
  subscribe(filter: EventFilter = {}): AsyncIterable<StreamAuditEvent> {
    if (this.subscriptions.size >= this.config.maxSubscriptions) {
      throw new Error(
        `Maximum subscription limit reached (${this.config.maxSubscriptions}). ` +
          `Unsubscribe from existing subscriptions before creating new ones.`
      )
    }

    const subscriptionId = randomUUID()
    const subscription: Subscription = {
      id: subscriptionId,
      filter: { ...filter },
      createdAt: new Date().toISOString(),
      eventCount: 0,
      isPaused: false,
      buffer: [],
      resolve: null,
      reject: null,
      closed: false,
    }

    this.subscriptions.set(subscriptionId, subscription)

    // Create the async iterable with generator - use arrow functions to maintain this context
    const nextEvent = this.nextEvent.bind(this)
    const unsubscribe = this.unsubscribe.bind(this)
    const asyncIterable: AsyncIterable<StreamAuditEvent> & { subscriptionId: string } = {
      subscriptionId,
      [Symbol.asyncIterator](): AsyncIterator<StreamAuditEvent> {
        return {
          next: async (): Promise<IteratorResult<StreamAuditEvent>> => {
            return nextEvent(subscriptionId)
          },
          return: async (): Promise<IteratorResult<StreamAuditEvent>> => {
            unsubscribe(subscriptionId)
            return { done: true, value: undefined }
          },
          throw: async (error: Error): Promise<IteratorResult<StreamAuditEvent>> => {
            unsubscribe(subscriptionId)
            throw error
          },
        }
      },
    }

    return asyncIterable
  }

  /**
   * Get the next event for a subscription (internal method)
   */
  private nextEvent(subscriptionId: string): Promise<IteratorResult<StreamAuditEvent>> {
    return new Promise((resolve, reject) => {
      const subscription = this.subscriptions.get(subscriptionId)

      if (!subscription) {
        resolve({ done: true, value: undefined })
        return
      }

      if (subscription.closed) {
        resolve({ done: true, value: undefined })
        return
      }

      // If there's a buffered event, return it immediately
      if (subscription.buffer.length > 0) {
        const event = subscription.buffer.shift()!
        subscription.eventCount++
        resolve({ done: false, value: event })
        return
      }

      // Otherwise, wait for the next event
      subscription.resolve = resolve
      subscription.reject = reject
    })
  }

  /**
   * Unsubscribe from event stream
   *
   * @param subscriptionId - ID of subscription to cancel
   */
  unsubscribe(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId)
    if (subscription) {
      subscription.closed = true
      // Resolve any pending promise to signal completion
      if (subscription.resolve) {
        subscription.resolve({ done: true, value: undefined })
        subscription.resolve = null
        subscription.reject = null
      }
      this.subscriptions.delete(subscriptionId)
    }
  }

  /**
   * Get information about all active subscriptions
   *
   * @returns Array of subscription information
   */
  getActiveSubscriptions(): SubscriptionInfo[] {
    return Array.from(this.subscriptions.values()).map((sub) => ({
      id: sub.id,
      filter: { ...sub.filter },
      createdAt: sub.createdAt,
      eventCount: sub.eventCount,
      isPaused: sub.isPaused,
    }))
  }

  /**
   * Emit an audit event to all matching subscriptions
   *
   * Called by EnterpriseAuditLogger when events are logged.
   *
   * @param event - The audit event to emit
   * @returns Number of subscriptions that received the event
   */
  emit(event: StreamAuditEvent): number {
    // Add to global event buffer
    this.eventBuffer.push(event)
    if (this.eventBuffer.length > this.config.maxBufferSize) {
      this.eventBuffer.shift()
    }

    let deliveryCount = 0

    for (const subscription of this.subscriptions.values()) {
      if (subscription.closed || subscription.isPaused) {
        continue
      }

      if (!this.matchesFilter(event, subscription.filter)) {
        continue
      }

      // Deliver to subscription
      if (subscription.resolve) {
        // Subscriber is waiting, deliver immediately
        subscription.eventCount++
        subscription.resolve({ done: false, value: event })
        subscription.resolve = null
        subscription.reject = null
        deliveryCount++
      } else {
        // Buffer the event
        if (subscription.buffer.length >= this.config.maxBufferSize) {
          if (this.config.backpressureStrategy === 'drop-oldest') {
            subscription.buffer.shift()
            subscription.buffer.push(event)
            deliveryCount++
          }
          // 'reject-new' strategy: don't add to buffer
        } else {
          subscription.buffer.push(event)
          deliveryCount++
        }
      }
    }

    return deliveryCount
  }

  /**
   * Check if an event matches a filter
   */
  private matchesFilter(event: StreamAuditEvent, filter: EventFilter): boolean {
    // If no filter criteria, match all
    if (
      !filter.eventTypes?.length &&
      !filter.severities?.length &&
      !filter.actors?.length &&
      !filter.resources?.length
    ) {
      return true
    }

    // Check event types
    if (filter.eventTypes?.length && !filter.eventTypes.includes(event.type)) {
      return false
    }

    // Check severities
    if (filter.severities?.length && !filter.severities.includes(event.severity)) {
      return false
    }

    // Check actors
    if (filter.actors?.length && !filter.actors.includes(event.actor)) {
      return false
    }

    // Check resources (partial match)
    if (filter.resources?.length) {
      const matchesAnyResource = filter.resources.some(
        (resource) => event.resource.includes(resource) || resource.includes(event.resource)
      )
      if (!matchesAnyResource) {
        return false
      }
    }

    return true
  }

  /**
   * Pause a subscription (events will be buffered)
   *
   * @param subscriptionId - ID of subscription to pause
   * @returns true if subscription was paused, false if not found
   */
  pause(subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId)
    if (subscription) {
      subscription.isPaused = true
      return true
    }
    return false
  }

  /**
   * Resume a paused subscription
   *
   * @param subscriptionId - ID of subscription to resume
   * @returns true if subscription was resumed, false if not found
   */
  resume(subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId)
    if (subscription) {
      subscription.isPaused = false
      return true
    }
    return false
  }

  /**
   * Get the current buffer size for a subscription
   *
   * @param subscriptionId - ID of subscription
   * @returns Buffer size or -1 if subscription not found
   */
  getBufferSize(subscriptionId: string): number {
    const subscription = this.subscriptions.get(subscriptionId)
    return subscription ? subscription.buffer.length : -1
  }

  /**
   * Get global event buffer (for replay/debugging)
   *
   * @param limit - Maximum number of events to return
   * @returns Recent events from global buffer
   */
  getRecentEvents(limit: number = 100): StreamAuditEvent[] {
    return this.eventBuffer.slice(-limit)
  }

  /**
   * Clear all subscriptions and buffers
   * Primarily for testing and cleanup
   */
  clear(): void {
    for (const subscription of this.subscriptions.values()) {
      subscription.closed = true
      if (subscription.resolve) {
        subscription.resolve({ done: true, value: undefined })
      }
    }
    this.subscriptions.clear()
    this.eventBuffer = []
  }

  /**
   * Get current subscription count
   */
  get subscriptionCount(): number {
    return this.subscriptions.size
  }

  /**
   * Get global buffer size
   */
  get globalBufferSize(): number {
    return this.eventBuffer.length
  }
}
