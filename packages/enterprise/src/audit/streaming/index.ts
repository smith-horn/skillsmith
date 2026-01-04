/**
 * SMI-963: Real-time audit event streaming
 *
 * Provides streaming capabilities for audit events:
 * - AsyncIterable-based streaming (no WebSocket dependency for core)
 * - Event filtering by type/severity
 * - Backpressure handling
 * - Subscription management
 */

export {
  EventStreamManager,
  type AuditEventStream,
  type StreamAuditEvent,
  type EventFilter,
  type EventSeverity,
  type SubscriptionInfo,
  type EventStreamConfig,
} from './EventStream.js'
