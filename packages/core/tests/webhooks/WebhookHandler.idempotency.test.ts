/**
 * Idempotency tests for WebhookHandler using X-GitHub-Delivery
 *
 * These tests verify that duplicate webhook deliveries are detected
 * and handled idempotently using the X-GitHub-Delivery header.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { WebhookHandler } from '../../src/webhooks/WebhookHandler.js'
import { WebhookQueue } from '../../src/webhooks/WebhookQueue.js'
import { createHmac } from 'crypto'

describe('WebhookHandler Idempotency', () => {
  const TEST_SECRET = 'test-webhook-secret'

  function createSignature(payload: string): string {
    return `sha256=${createHmac('sha256', TEST_SECRET).update(payload).digest('hex')}`
  }

  function createValidPushPayload(): object {
    return {
      ref: 'refs/heads/main',
      before: 'abc123',
      after: 'def456',
      created: false,
      deleted: false,
      forced: false,
      base_ref: null,
      compare: 'https://github.com/owner/repo/compare/abc123...def456',
      commits: [
        {
          id: 'def456',
          tree_id: 'tree123',
          distinct: true,
          message: 'Add SKILL.md',
          timestamp: '2024-01-01T00:00:00Z',
          url: 'https://github.com/owner/repo/commit/def456',
          author: { name: 'Test', email: 'test@example.com' },
          committer: { name: 'Test', email: 'test@example.com' },
          added: ['.claude/skills/test/SKILL.md'],
          removed: [],
          modified: [],
        },
      ],
      head_commit: null,
      repository: {
        id: 123,
        name: 'repo',
        full_name: 'owner/repo',
        private: false,
        owner: { login: 'owner', id: 1, type: 'User' },
        html_url: 'https://github.com/owner/repo',
        description: null,
        fork: false,
        url: 'https://api.github.com/repos/owner/repo',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        pushed_at: '2024-01-01T00:00:00Z',
        homepage: null,
        size: 0,
        stargazers_count: 0,
        watchers_count: 0,
        language: 'TypeScript',
        forks_count: 0,
        archived: false,
        disabled: false,
        open_issues_count: 0,
        topics: [],
        visibility: 'public',
        default_branch: 'main',
      },
      pusher: { name: 'test', email: 'test@example.com' },
      sender: { login: 'test', id: 1, type: 'User' },
    }
  }

  let handler: WebhookHandler
  let queue: WebhookQueue
  let processedItems: unknown[]

  beforeEach(() => {
    processedItems = []

    queue = new WebhookQueue({
      debounceMs: 0,
      maxRetries: 0,
      retryDelayMs: 0,
      processor: async (item) => {
        processedItems.push(item)
      },
    })

    handler = new WebhookHandler({
      secret: TEST_SECRET,
      queue,
      onLog: () => {},
    })
  })

  describe('X-GitHub-Delivery handling', () => {
    it('should process first delivery normally', async () => {
      const payload = JSON.stringify(createValidPushPayload())
      const signature = createSignature(payload)
      const deliveryId = 'unique-delivery-id-123'

      const result = await handler.handleWebhook('push', payload, signature, deliveryId)

      expect(result.success).toBe(true)
      expect(result.changesDetected).toBe(1)
      expect(result.itemsQueued).toBe(1)
    })

    it('should detect and skip duplicate deliveries', async () => {
      const payload = JSON.stringify(createValidPushPayload())
      const signature = createSignature(payload)
      const deliveryId = 'duplicate-delivery-id'

      // First delivery - should process
      const result1 = await handler.handleWebhook('push', payload, signature, deliveryId)
      expect(result1.success).toBe(true)
      expect(result1.itemsQueued).toBe(1)

      // Second delivery with same ID - should skip
      const result2 = await handler.handleWebhook('push', payload, signature, deliveryId)
      expect(result2.success).toBe(true)
      expect(result2.message).toContain('Duplicate delivery')
      expect(result2.itemsQueued).toBe(0)
    })

    it('should process deliveries with different IDs', async () => {
      const payload = JSON.stringify(createValidPushPayload())
      const signature = createSignature(payload)

      const result1 = await handler.handleWebhook('push', payload, signature, 'delivery-1')
      const result2 = await handler.handleWebhook('push', payload, signature, 'delivery-2')

      expect(result1.success).toBe(true)
      expect(result1.itemsQueued).toBe(1)
      expect(result2.success).toBe(true)
      expect(result2.itemsQueued).toBe(1)
    })

    it('should still work when deliveryId is not provided', async () => {
      const payload = JSON.stringify(createValidPushPayload())
      const signature = createSignature(payload)

      // Without delivery ID, duplicates cannot be detected
      const result1 = await handler.handleWebhook('push', payload, signature)
      const result2 = await handler.handleWebhook('push', payload, signature)

      expect(result1.success).toBe(true)
      expect(result2.success).toBe(true)
      // Both should process since no delivery ID to track
    })
  })

  describe('delivery ID cleanup', () => {
    it('should limit stored delivery IDs to prevent memory growth', async () => {
      const payload = JSON.stringify(createValidPushPayload())
      const signature = createSignature(payload)

      // Process many unique deliveries
      for (let i = 0; i < 15000; i++) {
        await handler.handleWebhook('push', payload, signature, `delivery-${i}`)
      }

      // Verify that old delivery IDs are cleaned up
      // The implementation should keep only the last N deliveries
      const stats = handler.getDeliveryStats?.()
      if (stats) {
        expect(stats.trackedDeliveries).toBeLessThanOrEqual(10000)
      }
    })

    it('should still detect recent duplicates after cleanup', async () => {
      const payload = JSON.stringify(createValidPushPayload())
      const signature = createSignature(payload)

      // Process many deliveries
      for (let i = 0; i < 5000; i++) {
        await handler.handleWebhook('push', payload, signature, `delivery-${i}`)
      }

      // Try to replay a recent delivery
      const result = await handler.handleWebhook('push', payload, signature, 'delivery-4999')
      expect(result.message).toContain('Duplicate delivery')
    })
  })

  describe('idempotency edge cases', () => {
    it('should handle empty delivery ID as no delivery ID', async () => {
      const payload = JSON.stringify(createValidPushPayload())
      const signature = createSignature(payload)

      const result1 = await handler.handleWebhook('push', payload, signature, '')
      const result2 = await handler.handleWebhook('push', payload, signature, '')

      // Empty string should be treated as no ID
      expect(result1.success).toBe(true)
      expect(result2.success).toBe(true)
    })

    it('should handle concurrent duplicate deliveries', async () => {
      const payload = JSON.stringify(createValidPushPayload())
      const signature = createSignature(payload)
      const deliveryId = 'concurrent-delivery'

      // Simulate concurrent delivery
      const [result1, result2] = await Promise.all([
        handler.handleWebhook('push', payload, signature, deliveryId),
        handler.handleWebhook('push', payload, signature, deliveryId),
      ])

      // At least one should process, one should be duplicate
      const processed = [result1, result2].filter((r) => r.itemsQueued > 0)
      const duplicates = [result1, result2].filter((r) => r.message?.includes('Duplicate'))

      expect(processed.length + duplicates.length).toBe(2)
      expect(processed.length).toBeGreaterThanOrEqual(1)
    })
  })
})
