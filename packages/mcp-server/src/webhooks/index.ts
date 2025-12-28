/**
 * SMI-645: Webhook module for MCP server
 *
 * Re-exports webhook functionality from core and provides HTTP server integration.
 */

export {
  createWebhookServer,
  startWebhookServer,
  stopWebhookServer,
  type WebhookServerOptions,
  type ServerStartOptions,
  type WebhookServer,
} from './webhook-endpoint.js'

// Re-export core webhook types for convenience
export {
  WebhookHandler,
  WebhookQueue,
  isSkillFile,
  extractSkillChanges,
  parseWebhookPayload,
  type WebhookEventType,
  type SkillFileChange,
  type WebhookHandleResult,
  type WebhookQueueItem,
  type QueueStats,
} from '@skillsmith/core'
