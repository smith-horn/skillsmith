/**
 * SMI-645: Webhooks module - GitHub webhook handling for real-time index updates
 *
 * Provides:
 * - WebhookPayload: Type definitions and parsing for GitHub webhook events
 * - WebhookHandler: Process and verify incoming webhook events
 * - WebhookQueue: Priority queue with debouncing and retry support
 */

// WebhookPayload - Types and utilities
export {
  type WebhookEventType,
  type RepositoryAction,
  type GitUser,
  type PushCommit,
  type RepositoryOwner,
  type WebhookRepository,
  type WebhookSender,
  type PushEventPayload,
  type RepositoryEventPayload,
  type PingEventPayload,
  type WebhookPayload,
  type ParsedWebhookEvent,
  type SignatureVerificationResult,
  type SkillFileChange,
  isSkillFile,
  extractSkillChanges,
  parseWebhookPayload,
} from './WebhookPayload.js'

// WebhookHandler - Event processing
export {
  WebhookHandler,
  type WebhookHandlerOptions,
  type WebhookHandleResult,
  type DeliveryStats,
} from './WebhookHandler.js'

// WebhookQueue - Event queue
export {
  WebhookQueue,
  type QueueItemType,
  type QueuePriority,
  type WebhookQueueItem,
  type QueueProcessResult,
  type QueueStats,
  type WebhookQueueOptions,
} from './WebhookQueue.js'
