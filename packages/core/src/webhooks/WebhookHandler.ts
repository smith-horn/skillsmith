/**
 * SMI-645: WebhookHandler - Process incoming GitHub webhook events
 *
 * Provides:
 * - Secure HMAC-SHA256 signature verification
 * - Event type routing
 * - SKILL.md change detection
 * - Integration with WebhookQueue for processing
 */

import { createHmac, timingSafeEqual } from 'crypto'
import type {
  ParsedWebhookEvent,
  PushEventPayload,
  RepositoryEventPayload,
  SignatureVerificationResult,
  SkillFileChange,
} from './WebhookPayload.js'
import { extractSkillChanges, parseWebhookPayload } from './WebhookPayload.js'
import type { WebhookQueue, WebhookQueueItem } from './WebhookQueue.js'

/**
 * Webhook handler options
 */
export interface WebhookHandlerOptions {
  /**
   * GitHub webhook secret for signature verification
   */
  secret: string

  /**
   * Queue for processing webhook events
   */
  queue: WebhookQueue

  /**
   * Optional callback when a skill change is detected
   */
  onSkillChange?: (change: SkillFileChange) => void

  /**
   * Optional callback for logging
   */
  onLog?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void
}

/**
 * Result of handling a webhook event
 */
export interface WebhookHandleResult {
  /**
   * Whether the webhook was handled successfully
   */
  success: boolean

  /**
   * Event type that was processed
   */
  eventType: string

  /**
   * Number of skill changes detected (for push events)
   */
  changesDetected: number

  /**
   * Number of items queued for processing
   */
  itemsQueued: number

  /**
   * Error message if processing failed
   */
  error?: string

  /**
   * Message describing what happened
   */
  message: string
}

/**
 * Delivery statistics for monitoring
 */
export interface DeliveryStats {
  trackedDeliveries: number
}

/**
 * Maximum number of delivery IDs to track (for memory management)
 */
const MAX_TRACKED_DELIVERIES = 10000

/**
 * Number of old deliveries to purge when limit is reached
 */
const DELIVERY_PURGE_COUNT = 5000

/**
 * Webhook handler for GitHub events
 */
export class WebhookHandler {
  private secret: string
  private queue: WebhookQueue
  private onSkillChange?: (change: SkillFileChange) => void
  private log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void

  /**
   * Track processed delivery IDs for idempotency
   * Using a Set for O(1) lookups
   */
  private processedDeliveries = new Set<string>()

  constructor(options: WebhookHandlerOptions) {
    this.secret = options.secret
    this.queue = options.queue
    this.onSkillChange = options.onSkillChange
    this.log = options.onLog ?? (() => {})
  }

  /**
   * Get delivery tracking statistics
   */
  getDeliveryStats(): DeliveryStats {
    return {
      trackedDeliveries: this.processedDeliveries.size,
    }
  }

  /**
   * Verify webhook signature using HMAC-SHA256
   * Uses timing-safe comparison to prevent timing attacks
   */
  verifySignature(payload: string, signature: string): SignatureVerificationResult {
    if (!signature) {
      return { valid: false, error: 'Missing signature header' }
    }

    // GitHub sends signature as "sha256=<hex digest>"
    if (!signature.startsWith('sha256=')) {
      return { valid: false, error: 'Invalid signature format' }
    }

    try {
      const expected = `sha256=${createHmac('sha256', this.secret).update(payload).digest('hex')}`

      // Use timing-safe comparison to prevent timing attacks
      const signatureBuffer = Buffer.from(signature)
      const expectedBuffer = Buffer.from(expected)

      // Buffers must be the same length for timingSafeEqual
      if (signatureBuffer.length !== expectedBuffer.length) {
        return { valid: false, error: 'Signature length mismatch' }
      }

      const valid = timingSafeEqual(signatureBuffer, expectedBuffer)

      if (!valid) {
        return { valid: false, error: 'Signature verification failed' }
      }

      return { valid: true }
    } catch (error) {
      return {
        valid: false,
        error: `Signature verification error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }
    }
  }

  /**
   * Handle an incoming webhook event
   * @param eventType - GitHub event type (push, repository, ping, etc.)
   * @param payload - Raw JSON payload string
   * @param signature - X-Hub-Signature-256 header value
   * @param deliveryId - X-GitHub-Delivery header value (optional, for idempotency)
   */
  async handleWebhook(
    eventType: string,
    payload: string,
    signature: string,
    deliveryId?: string
  ): Promise<WebhookHandleResult> {
    // Idempotency check using delivery ID
    if (deliveryId && deliveryId.length > 0) {
      if (this.processedDeliveries.has(deliveryId)) {
        this.log('info', 'Duplicate delivery detected, skipping', { deliveryId })
        return {
          success: true,
          eventType,
          changesDetected: 0,
          itemsQueued: 0,
          message: 'Duplicate delivery, already processed',
        }
      }

      // Track this delivery ID
      this.processedDeliveries.add(deliveryId)

      // Cleanup old deliveries to prevent memory growth
      if (this.processedDeliveries.size > MAX_TRACKED_DELIVERIES) {
        const toDelete = [...this.processedDeliveries].slice(0, DELIVERY_PURGE_COUNT)
        toDelete.forEach((id) => this.processedDeliveries.delete(id))
        this.log('info', 'Purged old delivery IDs', {
          purged: DELIVERY_PURGE_COUNT,
          remaining: this.processedDeliveries.size,
        })
      }
    }

    // Verify signature first
    const verification = this.verifySignature(payload, signature)
    if (!verification.valid) {
      this.log('warn', 'Webhook signature verification failed', {
        error: verification.error,
      })
      return {
        success: false,
        eventType,
        changesDetected: 0,
        itemsQueued: 0,
        error: verification.error,
        message: 'Signature verification failed',
      }
    }

    // Parse the payload
    let parsedPayload: unknown
    try {
      parsedPayload = JSON.parse(payload)
    } catch (error) {
      this.log('error', 'Failed to parse webhook payload', { error })
      return {
        success: false,
        eventType,
        changesDetected: 0,
        itemsQueued: 0,
        error: 'Invalid JSON payload',
        message: 'Failed to parse webhook payload',
      }
    }

    // Route to appropriate handler
    const event = parseWebhookPayload(eventType, parsedPayload)
    return this.processEvent(event)
  }

  /**
   * Process a parsed webhook event
   */
  private async processEvent(event: ParsedWebhookEvent): Promise<WebhookHandleResult> {
    switch (event.type) {
      case 'push':
        return this.handlePushEvent(event.payload)

      case 'repository':
        return this.handleRepositoryEvent(event.payload)

      case 'ping':
        this.log('info', 'Received ping event', {
          zen: event.payload.zen,
          hookId: event.payload.hook_id,
        })
        return {
          success: true,
          eventType: 'ping',
          changesDetected: 0,
          itemsQueued: 0,
          message: `Pong! ${event.payload.zen}`,
        }

      case 'unknown':
        this.log('info', 'Received unknown event type, ignoring')
        return {
          success: true,
          eventType: 'unknown',
          changesDetected: 0,
          itemsQueued: 0,
          message: 'Event type not handled',
        }
    }
  }

  /**
   * Handle push events - detect SKILL.md changes
   */
  private async handlePushEvent(payload: PushEventPayload): Promise<WebhookHandleResult> {
    const repoFullName = payload.repository.full_name
    const branch = payload.ref.replace('refs/heads/', '')

    this.log('info', 'Processing push event', {
      repo: repoFullName,
      branch,
      commits: payload.commits.length,
    })

    // Extract SKILL.md changes
    const changes = extractSkillChanges(payload)

    if (changes.length === 0) {
      this.log('info', 'No SKILL.md changes detected in push', {
        repo: repoFullName,
      })
      return {
        success: true,
        eventType: 'push',
        changesDetected: 0,
        itemsQueued: 0,
        message: 'No SKILL.md changes detected',
      }
    }

    this.log('info', 'SKILL.md changes detected', {
      repo: repoFullName,
      changes: changes.length,
    })

    // Queue each change for processing
    let itemsQueued = 0
    for (const change of changes) {
      // Notify callback if provided
      if (this.onSkillChange) {
        this.onSkillChange(change)
      }

      // Create queue item based on change type
      const queueItem: WebhookQueueItem = {
        id: `${change.repoFullName}:${change.filePath}:${change.commitSha}`,
        type: change.changeType === 'removed' ? 'remove' : 'index',
        repoUrl: change.repoUrl,
        repoFullName: change.repoFullName,
        filePath: change.filePath,
        commitSha: change.commitSha,
        timestamp: new Date(change.timestamp).getTime(),
        priority: this.calculatePriority(payload),
        retries: 0,
      }

      const added = await this.queue.add(queueItem)
      if (added) {
        itemsQueued++
      }
    }

    return {
      success: true,
      eventType: 'push',
      changesDetected: changes.length,
      itemsQueued,
      message: `Detected ${changes.length} SKILL.md changes, queued ${itemsQueued} for processing`,
    }
  }

  /**
   * Handle repository events - handle deletion/archival
   */
  private async handleRepositoryEvent(
    payload: RepositoryEventPayload
  ): Promise<WebhookHandleResult> {
    const repoFullName = payload.repository.full_name
    const action = payload.action

    this.log('info', 'Processing repository event', {
      repo: repoFullName,
      action,
    })

    switch (action) {
      case 'deleted': {
        // Queue removal of all skills from this repository
        const queueItem: WebhookQueueItem = {
          id: `${repoFullName}:DELETE_ALL:${Date.now()}`,
          type: 'remove_all',
          repoUrl: payload.repository.html_url,
          repoFullName,
          filePath: '*',
          commitSha: '',
          timestamp: Date.now(),
          priority: 'medium',
          retries: 0,
        }

        await this.queue.add(queueItem)

        return {
          success: true,
          eventType: 'repository',
          changesDetected: 1,
          itemsQueued: 1,
          message: `Repository deleted, queued removal of all skills`,
        }
      }

      case 'archived': {
        // Queue marking skills as inactive
        const queueItem: WebhookQueueItem = {
          id: `${repoFullName}:ARCHIVE:${Date.now()}`,
          type: 'archive',
          repoUrl: payload.repository.html_url,
          repoFullName,
          filePath: '*',
          commitSha: '',
          timestamp: Date.now(),
          priority: 'low',
          retries: 0,
        }

        await this.queue.add(queueItem)

        return {
          success: true,
          eventType: 'repository',
          changesDetected: 1,
          itemsQueued: 1,
          message: `Repository archived, queued skills for deactivation`,
        }
      }

      case 'unarchived': {
        // Queue re-indexing skills
        const queueItem: WebhookQueueItem = {
          id: `${repoFullName}:UNARCHIVE:${Date.now()}`,
          type: 'reactivate',
          repoUrl: payload.repository.html_url,
          repoFullName,
          filePath: '*',
          commitSha: '',
          timestamp: Date.now(),
          priority: 'low',
          retries: 0,
        }

        await this.queue.add(queueItem)

        return {
          success: true,
          eventType: 'repository',
          changesDetected: 1,
          itemsQueued: 1,
          message: `Repository unarchived, queued skills for reactivation`,
        }
      }

      default:
        this.log('info', `Repository action "${action}" not handled`, {
          repo: repoFullName,
        })
        return {
          success: true,
          eventType: 'repository',
          changesDetected: 0,
          itemsQueued: 0,
          message: `Repository action "${action}" not handled`,
        }
    }
  }

  /**
   * Calculate priority based on repository metrics
   */
  private calculatePriority(payload: PushEventPayload): 'high' | 'medium' | 'low' {
    const repo = payload.repository

    // High priority for popular/verified repositories
    if (repo.stargazers_count >= 100 || repo.topics.includes('claude-code-official')) {
      return 'high'
    }

    // Medium priority for repositories with some engagement
    if (repo.stargazers_count >= 10 || repo.forks_count >= 5) {
      return 'medium'
    }

    // Low priority for others
    return 'low'
  }
}

export default WebhookHandler
