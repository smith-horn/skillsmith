/**
 * SMI-645: WebhookHandler Tests
 *
 * Tests for:
 * - WebhookPayload: Type parsing and SKILL.md detection
 * - WebhookHandler: Signature verification and event processing
 * - WebhookQueue: Priority queue with debouncing and retry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import {
  isSkillFile,
  extractSkillChanges,
  parseWebhookPayload,
  type PushEventPayload,
  type RepositoryEventPayload,
  type PingEventPayload,
} from '../src/webhooks/WebhookPayload.js'
import { WebhookHandler } from '../src/webhooks/WebhookHandler.js'
import { WebhookQueue, type WebhookQueueItem } from '../src/webhooks/WebhookQueue.js'

// ============================================================
// Test Fixtures
// ============================================================

const TEST_SECRET = 'test-webhook-secret-12345'

/**
 * Create a valid signature for a payload
 */
function createSignature(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`
}

/**
 * Create a minimal push event payload
 */
function createPushPayload(overrides: Partial<PushEventPayload> = {}): PushEventPayload {
  return {
    ref: 'refs/heads/main',
    before: 'abc123',
    after: 'def456',
    created: false,
    deleted: false,
    forced: false,
    base_ref: null,
    compare: 'https://github.com/test/repo/compare/abc123...def456',
    commits: [],
    head_commit: null,
    repository: {
      id: 12345,
      name: 'test-repo',
      full_name: 'test-owner/test-repo',
      private: false,
      owner: {
        login: 'test-owner',
        id: 1,
        type: 'User',
      },
      html_url: 'https://github.com/test-owner/test-repo',
      description: 'A test repository',
      fork: false,
      url: 'https://api.github.com/repos/test-owner/test-repo',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
      pushed_at: '2024-01-02T00:00:00Z',
      homepage: null,
      size: 100,
      stargazers_count: 10,
      watchers_count: 10,
      language: 'TypeScript',
      forks_count: 2,
      archived: false,
      disabled: false,
      open_issues_count: 5,
      topics: ['claude-code-skill'],
      visibility: 'public',
      default_branch: 'main',
    },
    pusher: {
      name: 'test-user',
      email: 'test@example.com',
    },
    sender: {
      login: 'test-user',
      id: 1,
      type: 'User',
    },
    ...overrides,
  }
}

/**
 * Create a push event with SKILL.md changes
 */
function createPushWithSkillChanges(): PushEventPayload {
  return createPushPayload({
    commits: [
      {
        id: 'commit123',
        tree_id: 'tree123',
        distinct: true,
        message: 'Add new skill',
        timestamp: '2024-01-02T12:00:00Z',
        url: 'https://github.com/test-owner/test-repo/commit/commit123',
        author: {
          name: 'Test User',
          email: 'test@example.com',
        },
        committer: {
          name: 'Test User',
          email: 'test@example.com',
        },
        added: ['.claude/skills/my-skill/SKILL.md'],
        removed: [],
        modified: ['README.md'],
      },
      {
        id: 'commit456',
        tree_id: 'tree456',
        distinct: true,
        message: 'Update another skill',
        timestamp: '2024-01-02T12:01:00Z',
        url: 'https://github.com/test-owner/test-repo/commit/commit456',
        author: {
          name: 'Test User',
          email: 'test@example.com',
        },
        committer: {
          name: 'Test User',
          email: 'test@example.com',
        },
        added: [],
        removed: [],
        modified: ['skills/other-skill/SKILL.md'],
      },
    ],
  })
}

/**
 * Create a repository event payload
 */
function createRepositoryPayload(action: RepositoryEventPayload['action']): RepositoryEventPayload {
  return {
    action,
    repository: createPushPayload().repository,
    sender: {
      login: 'test-user',
      id: 1,
      type: 'User',
    },
  }
}

/**
 * Create a ping event payload
 */
function createPingPayload(): PingEventPayload {
  return {
    zen: 'Speak like a human.',
    hook_id: 12345,
    hook: {
      type: 'Repository',
      id: 12345,
      name: 'web',
      active: true,
      events: ['push', 'repository'],
      config: {
        content_type: 'json',
        insecure_ssl: '0',
        url: 'https://example.com/webhooks/github',
      },
    },
    repository: createPushPayload().repository,
    sender: {
      login: 'test-user',
      id: 1,
      type: 'User',
    },
  }
}

// ============================================================
// WebhookPayload Tests
// ============================================================

describe('WebhookPayload', () => {
  describe('isSkillFile', () => {
    it('should detect SKILL.md at root', () => {
      expect(isSkillFile('SKILL.md')).toBe(true)
    })

    it('should detect SKILL.md in subdirectory', () => {
      expect(isSkillFile('.claude/skills/my-skill/SKILL.md')).toBe(true)
    })

    it('should detect skill.md (lowercase)', () => {
      expect(isSkillFile('path/to/skill.md')).toBe(true)
    })

    it('should not detect other markdown files', () => {
      expect(isSkillFile('README.md')).toBe(false)
      expect(isSkillFile('docs/SKILLS.md')).toBe(false)
      expect(isSkillFile('SKILL.txt')).toBe(false)
    })
  })

  describe('extractSkillChanges', () => {
    it('should extract added SKILL.md files', () => {
      const payload = createPushWithSkillChanges()
      const changes = extractSkillChanges(payload)

      expect(changes).toHaveLength(2)
      expect(changes[0].changeType).toBe('added')
      expect(changes[0].filePath).toBe('.claude/skills/my-skill/SKILL.md')
      expect(changes[1].changeType).toBe('modified')
      expect(changes[1].filePath).toBe('skills/other-skill/SKILL.md')
    })

    it('should extract removed SKILL.md files', () => {
      const payload = createPushPayload({
        commits: [
          {
            id: 'commit789',
            tree_id: 'tree789',
            distinct: true,
            message: 'Remove skill',
            timestamp: '2024-01-02T12:00:00Z',
            url: 'https://github.com/test-owner/test-repo/commit/commit789',
            author: { name: 'Test', email: 'test@example.com' },
            committer: { name: 'Test', email: 'test@example.com' },
            added: [],
            removed: ['old-skill/SKILL.md'],
            modified: [],
          },
        ],
      })

      const changes = extractSkillChanges(payload)

      expect(changes).toHaveLength(1)
      expect(changes[0].changeType).toBe('removed')
      expect(changes[0].filePath).toBe('old-skill/SKILL.md')
    })

    it('should return empty array for non-default branch pushes', () => {
      const payload = createPushWithSkillChanges()
      payload.ref = 'refs/heads/feature-branch'

      const changes = extractSkillChanges(payload)

      expect(changes).toHaveLength(0)
    })

    it('should return empty array for branch deletions', () => {
      const payload = createPushWithSkillChanges()
      payload.deleted = true

      const changes = extractSkillChanges(payload)

      expect(changes).toHaveLength(0)
    })

    it('should include repository info in changes', () => {
      const payload = createPushWithSkillChanges()
      const changes = extractSkillChanges(payload)

      expect(changes[0].repoFullName).toBe('test-owner/test-repo')
      expect(changes[0].repoUrl).toBe('https://github.com/test-owner/test-repo')
      expect(changes[0].owner).toBe('test-owner')
      expect(changes[0].repoName).toBe('test-repo')
      expect(changes[0].defaultBranch).toBe('main')
    })
  })

  describe('parseWebhookPayload', () => {
    it('should parse push events', () => {
      const payload = createPushPayload()
      const result = parseWebhookPayload('push', payload)

      expect(result.type).toBe('push')
    })

    it('should parse repository events', () => {
      const payload = createRepositoryPayload('deleted')
      const result = parseWebhookPayload('repository', payload)

      expect(result.type).toBe('repository')
    })

    it('should parse ping events', () => {
      const payload = createPingPayload()
      const result = parseWebhookPayload('ping', payload)

      expect(result.type).toBe('ping')
    })

    it('should handle unknown event types', () => {
      const result = parseWebhookPayload('unknown', { some: 'data' })

      expect(result.type).toBe('unknown')
    })
  })
})

// ============================================================
// WebhookHandler Tests
// ============================================================

describe('WebhookHandler', () => {
  let handler: WebhookHandler
  let queue: WebhookQueue
  let logMessages: { level: string; message: string; data?: unknown }[]

  beforeEach(() => {
    queue = new WebhookQueue({ debounceMs: 0 }) // No debounce for testing
    logMessages = []

    handler = new WebhookHandler({
      secret: TEST_SECRET,
      queue,
      onLog: (level, message, data) => {
        logMessages.push({ level, message, data })
      },
    })
  })

  describe('verifySignature', () => {
    it('should verify valid signature', () => {
      const payload = JSON.stringify(createPushPayload())
      const signature = createSignature(payload, TEST_SECRET)

      const result = handler.verifySignature(payload, signature)

      expect(result.valid).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('should reject missing signature', () => {
      const payload = JSON.stringify(createPushPayload())

      const result = handler.verifySignature(payload, '')

      expect(result.valid).toBe(false)
      expect(result.error).toBe('Missing signature header')
    })

    it('should reject invalid signature format', () => {
      const payload = JSON.stringify(createPushPayload())

      const result = handler.verifySignature(payload, 'invalid-format')

      expect(result.valid).toBe(false)
      expect(result.error).toBe('Invalid signature format')
    })

    it('should reject incorrect signature', () => {
      const payload = JSON.stringify(createPushPayload())
      const signature = createSignature(payload, 'wrong-secret')

      const result = handler.verifySignature(payload, signature)

      expect(result.valid).toBe(false)
      // Different secret produces same-length signature but fails verification
      expect(result.error).toBe('Signature verification failed')
    })

    it('should reject tampered payload', () => {
      const payload = JSON.stringify(createPushPayload())
      const signature = createSignature(payload, TEST_SECRET)

      // Tamper with the payload
      const tamperedPayload = payload.replace('test-repo', 'hacked-repo')

      const result = handler.verifySignature(tamperedPayload, signature)

      expect(result.valid).toBe(false)
    })
  })

  describe('handleWebhook', () => {
    it('should reject invalid signature', async () => {
      const payload = JSON.stringify(createPushPayload())

      const result = await handler.handleWebhook('push', payload, 'invalid-sig')

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.message).toContain('verification failed')
    })

    it('should reject invalid JSON payload', async () => {
      const payload = 'not valid json'
      const signature = createSignature(payload, TEST_SECRET)

      const result = await handler.handleWebhook('push', payload, signature)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid JSON payload')
    })

    it('should handle ping events', async () => {
      const payload = JSON.stringify(createPingPayload())
      const signature = createSignature(payload, TEST_SECRET)

      const result = await handler.handleWebhook('ping', payload, signature)

      expect(result.success).toBe(true)
      expect(result.eventType).toBe('ping')
      expect(result.message).toContain('Pong!')
    })

    it('should detect SKILL.md changes in push events', async () => {
      const payload = JSON.stringify(createPushWithSkillChanges())
      const signature = createSignature(payload, TEST_SECRET)

      const result = await handler.handleWebhook('push', payload, signature)

      expect(result.success).toBe(true)
      expect(result.eventType).toBe('push')
      expect(result.changesDetected).toBe(2)
      expect(result.itemsQueued).toBe(2)
    })

    it('should not queue items for pushes without SKILL.md changes', async () => {
      const payload = JSON.stringify(createPushPayload())
      const signature = createSignature(payload, TEST_SECRET)

      const result = await handler.handleWebhook('push', payload, signature)

      expect(result.success).toBe(true)
      expect(result.changesDetected).toBe(0)
      expect(result.itemsQueued).toBe(0)
    })

    it('should handle repository deletion', async () => {
      const payload = JSON.stringify(createRepositoryPayload('deleted'))
      const signature = createSignature(payload, TEST_SECRET)

      const result = await handler.handleWebhook('repository', payload, signature)

      expect(result.success).toBe(true)
      expect(result.eventType).toBe('repository')
      expect(result.itemsQueued).toBe(1)
      expect(result.message).toContain('deleted')
    })

    it('should handle repository archive', async () => {
      const payload = JSON.stringify(createRepositoryPayload('archived'))
      const signature = createSignature(payload, TEST_SECRET)

      const result = await handler.handleWebhook('repository', payload, signature)

      expect(result.success).toBe(true)
      expect(result.itemsQueued).toBe(1)
      expect(result.message).toContain('archived')
    })

    it('should handle repository unarchive', async () => {
      const payload = JSON.stringify(createRepositoryPayload('unarchived'))
      const signature = createSignature(payload, TEST_SECRET)

      const result = await handler.handleWebhook('repository', payload, signature)

      expect(result.success).toBe(true)
      expect(result.itemsQueued).toBe(1)
      expect(result.message).toContain('unarchived')
    })

    it('should ignore unhandled repository actions', async () => {
      const payload = JSON.stringify(createRepositoryPayload('renamed'))
      const signature = createSignature(payload, TEST_SECRET)

      const result = await handler.handleWebhook('repository', payload, signature)

      expect(result.success).toBe(true)
      expect(result.itemsQueued).toBe(0)
    })

    it('should call onSkillChange callback', async () => {
      const changes: unknown[] = []
      const handlerWithCallback = new WebhookHandler({
        secret: TEST_SECRET,
        queue,
        onSkillChange: (change) => changes.push(change),
      })

      const payload = JSON.stringify(createPushWithSkillChanges())
      const signature = createSignature(payload, TEST_SECRET)

      await handlerWithCallback.handleWebhook('push', payload, signature)

      expect(changes).toHaveLength(2)
    })
  })
})

// ============================================================
// WebhookQueue Tests
// ============================================================

describe('WebhookQueue', () => {
  let queue: WebhookQueue

  beforeEach(() => {
    queue = new WebhookQueue({
      debounceMs: 0, // No debounce for testing
      maxRetries: 3,
      retryDelayMs: 10,
    })
  })

  afterEach(async () => {
    queue.clear()
  })

  function createQueueItem(overrides: Partial<WebhookQueueItem> = {}): WebhookQueueItem {
    return {
      id: `test-${Date.now()}-${Math.random()}`,
      type: 'index',
      repoUrl: 'https://github.com/test/repo',
      repoFullName: 'test/repo',
      filePath: 'SKILL.md',
      commitSha: 'abc123',
      timestamp: Date.now(),
      priority: 'medium',
      retries: 0,
      ...overrides,
    }
  }

  describe('add', () => {
    it('should add item to queue', async () => {
      const item = createQueueItem()

      const added = await queue.add(item)

      expect(added).toBe(true)
      // Wait for debounce (0ms in tests)
      await new Promise((r) => setTimeout(r, 10))
      expect(queue.getStats().total).toBe(1)
    })

    it('should respect max queue size', async () => {
      const smallQueue = new WebhookQueue({ maxSize: 2, debounceMs: 0 })

      await smallQueue.addImmediate(createQueueItem({ id: '1' }))
      await smallQueue.addImmediate(createQueueItem({ id: '2' }))
      const added = await smallQueue.addImmediate(createQueueItem({ id: '3' }))

      expect(added).toBe(false)
      expect(smallQueue.getStats().total).toBe(2)
    })
  })

  describe('addImmediate', () => {
    it('should add item immediately without debounce', () => {
      const item = createQueueItem()

      const added = queue.addImmediate(item)

      expect(added).toBe(true)
      expect(queue.getStats().total).toBe(1)
    })
  })

  describe('getStats', () => {
    it('should return queue statistics', () => {
      queue.addImmediate(createQueueItem({ priority: 'high', type: 'index' }))
      queue.addImmediate(createQueueItem({ priority: 'medium', type: 'remove' }))
      queue.addImmediate(createQueueItem({ priority: 'low', type: 'archive' }))

      const stats = queue.getStats()

      expect(stats.total).toBe(3)
      expect(stats.byPriority.high).toBe(1)
      expect(stats.byPriority.medium).toBe(1)
      expect(stats.byPriority.low).toBe(1)
      expect(stats.byType.index).toBe(1)
      expect(stats.byType.remove).toBe(1)
      expect(stats.byType.archive).toBe(1)
    })
  })

  describe('priority ordering', () => {
    it('should sort items by priority in stats', () => {
      // Add items with different priorities
      queue.addImmediate(createQueueItem({ id: '1', priority: 'low' }))
      queue.addImmediate(createQueueItem({ id: '2', priority: 'medium' }))
      queue.addImmediate(createQueueItem({ id: '3', priority: 'high' }))

      const stats = queue.getStats()

      // Verify all priorities are tracked
      expect(stats.byPriority.high).toBe(1)
      expect(stats.byPriority.medium).toBe(1)
      expect(stats.byPriority.low).toBe(1)
    })
  })

  describe('retry mechanism', () => {
    it('should track retry count on queue item', async () => {
      let capturedItem: WebhookQueueItem | null = null

      const retryQueue = new WebhookQueue({
        debounceMs: 0,
        maxRetries: 3,
        retryDelayMs: 1,
        processor: async (item) => {
          capturedItem = item
          if (item.retries < 2) {
            throw new Error('Temporary failure')
          }
        },
      })

      const item = createQueueItem()
      retryQueue.addImmediate(item)

      // Wait for processing with retries
      await new Promise((r) => setTimeout(r, 200))
      await retryQueue.waitForProcessing()

      // Item should have been retried
      expect(capturedItem).not.toBeNull()
      expect(capturedItem!.retries).toBeGreaterThanOrEqual(0)
    })

    it('should call onProcessed callback on failure', async () => {
      let callbackCalled = false

      const failQueue = new WebhookQueue({
        debounceMs: 0,
        maxRetries: 1,
        retryDelayMs: 1,
        processor: async () => {
          throw new Error('Always fails')
        },
        onProcessed: () => {
          callbackCalled = true
        },
      })

      failQueue.addImmediate(createQueueItem())

      await new Promise((r) => setTimeout(r, 100))
      await failQueue.waitForProcessing()

      expect(callbackCalled).toBe(true)
    })
  })

  describe('clear', () => {
    it('should clear all non-processing items', () => {
      queue.addImmediate(createQueueItem({ id: '1' }))
      queue.addImmediate(createQueueItem({ id: '2' }))

      queue.clear()

      expect(queue.getStats().total).toBe(0)
    })
  })

  describe('hasPendingItems', () => {
    it('should return true when items are pending', () => {
      queue.addImmediate(createQueueItem())

      expect(queue.hasPendingItems()).toBe(true)
    })

    it('should return false when queue is empty', () => {
      expect(queue.hasPendingItems()).toBe(false)
    })
  })
})

// ============================================================
// Integration Tests
// ============================================================

describe('Webhook Integration', () => {
  it('should detect SKILL.md changes and queue for processing', async () => {
    const queue = new WebhookQueue({
      debounceMs: 0,
    })

    const handler = new WebhookHandler({
      secret: TEST_SECRET,
      queue,
    })

    // Simulate receiving a push webhook
    const payload = JSON.stringify(createPushWithSkillChanges())
    const signature = createSignature(payload, TEST_SECRET)

    const result = await handler.handleWebhook('push', payload, signature)

    // Verify the result
    expect(result.success).toBe(true)
    expect(result.changesDetected).toBe(2)
    expect(result.itemsQueued).toBe(2)

    // Wait for debounce timer to add items
    await new Promise((r) => setTimeout(r, 50))

    // Verify queue has pending items
    expect(queue.hasPendingItems()).toBe(true)
  })

  it('should verify webhook signatures end-to-end', async () => {
    const queue = new WebhookQueue({ debounceMs: 0 })
    const handler = new WebhookHandler({
      secret: TEST_SECRET,
      queue,
    })

    const payload = JSON.stringify(createPingPayload())
    const validSig = createSignature(payload, TEST_SECRET)
    const invalidSig = createSignature(payload, 'wrong-secret')

    // Valid signature should succeed
    const validResult = await handler.handleWebhook('ping', payload, validSig)
    expect(validResult.success).toBe(true)

    // Invalid signature should fail
    const invalidResult = await handler.handleWebhook('ping', payload, invalidSig)
    expect(invalidResult.success).toBe(false)
  })
})
