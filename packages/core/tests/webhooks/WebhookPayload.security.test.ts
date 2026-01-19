/**
 * SMI-680: Security tests for WebhookPayload validation
 *
 * These tests verify that parseWebhookPayload properly validates
 * incoming payloads using zod schemas instead of unsafe type assertions.
 */

import { describe, it, expect } from 'vitest'
import { parseWebhookPayload } from '../../src/webhooks/WebhookPayload.js'

describe('parseWebhookPayload Security (SMI-680)', () => {
  describe('push event validation', () => {
    it('should reject payload with missing required fields', () => {
      const malformedPayload = {
        // missing: ref, before, after, repository
        commits: [],
      }

      expect(() => {
        parseWebhookPayload('push', malformedPayload)
      }).toThrow(/Invalid push event payload/)
    })

    it('should reject payload with wrong field types', () => {
      const malformedPayload = {
        ref: 123, // should be string
        before: 'abc',
        after: 'def',
        repository: {
          full_name: 'owner/repo',
          default_branch: 'main',
        },
      }

      expect(() => {
        parseWebhookPayload('push', malformedPayload)
      }).toThrow(/Invalid push event payload/)
    })

    it('should reject payload with missing repository.full_name', () => {
      const malformedPayload = {
        ref: 'refs/heads/main',
        before: 'abc123',
        after: 'def456',
        repository: {
          // missing: full_name
          default_branch: 'main',
        },
      }

      expect(() => {
        parseWebhookPayload('push', malformedPayload)
      }).toThrow(/Invalid push event payload/)
    })

    it('should reject payload with invalid commits array', () => {
      const malformedPayload = {
        ref: 'refs/heads/main',
        before: 'abc123',
        after: 'def456',
        repository: {
          full_name: 'owner/repo',
          default_branch: 'main',
        },
        commits: 'not-an-array', // should be array
      }

      expect(() => {
        parseWebhookPayload('push', malformedPayload)
      }).toThrow(/Invalid push event payload/)
    })

    it('should accept valid push payload and preserve extra fields (passthrough)', () => {
      const validPayload = {
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
            message: 'Test commit',
            added: ['SKILL.md'],
            removed: [],
            modified: [],
          },
        ],
        repository: {
          id: 123,
          name: 'repo',
          full_name: 'owner/repo',
          default_branch: 'main',
          private: false,
          html_url: 'https://github.com/owner/repo',
          owner: { login: 'owner', id: 1, type: 'User' },
          extra_field: 'should be preserved', // extra field
        },
        pusher: { name: 'user', email: 'user@example.com' },
        sender: { login: 'user', id: 1, type: 'User' },
      }

      const result = parseWebhookPayload('push', validPayload)

      expect(result.type).toBe('push')
      expect(result.payload).toBeDefined()
      if (result.type === 'push') {
        expect(result.payload.ref).toBe('refs/heads/main')
        expect(result.payload.repository.full_name).toBe('owner/repo')
        // Extra field should be preserved (cast through unknown for index access)
        expect((result.payload.repository as unknown as Record<string, unknown>).extra_field).toBe(
          'should be preserved'
        )
      }
    })
  })

  describe('repository event validation', () => {
    it('should reject repository payload with missing action', () => {
      const malformedPayload = {
        // missing: action
        repository: {
          full_name: 'owner/repo',
        },
      }

      expect(() => {
        parseWebhookPayload('repository', malformedPayload)
      }).toThrow(/Invalid repository event payload/)
    })

    it('should reject repository payload with invalid action type', () => {
      const malformedPayload = {
        action: 123, // should be string
        repository: {
          full_name: 'owner/repo',
        },
      }

      expect(() => {
        parseWebhookPayload('repository', malformedPayload)
      }).toThrow(/Invalid repository event payload/)
    })

    it('should accept valid repository payload', () => {
      const validPayload = {
        action: 'deleted',
        repository: {
          id: 123,
          name: 'repo',
          full_name: 'owner/repo',
          private: false,
          html_url: 'https://github.com/owner/repo',
          owner: { login: 'owner', id: 1, type: 'User' },
          default_branch: 'main',
        },
        sender: { login: 'user', id: 1, type: 'User' },
      }

      const result = parseWebhookPayload('repository', validPayload)

      expect(result.type).toBe('repository')
      if (result.type === 'repository') {
        expect(result.payload.action).toBe('deleted')
      }
    })
  })

  describe('ping event validation', () => {
    it('should reject ping payload with missing zen', () => {
      const malformedPayload = {
        // missing: zen
        hook_id: 123,
      }

      expect(() => {
        parseWebhookPayload('ping', malformedPayload)
      }).toThrow(/Invalid ping event payload/)
    })

    it('should reject ping payload with missing hook_id', () => {
      const malformedPayload = {
        zen: 'Keep it simple',
        // missing: hook_id
      }

      expect(() => {
        parseWebhookPayload('ping', malformedPayload)
      }).toThrow(/Invalid ping event payload/)
    })

    it('should accept valid ping payload', () => {
      const validPayload = {
        zen: 'Keep it simple',
        hook_id: 123,
        hook: {
          type: 'Repository',
          id: 123,
          name: 'web',
          active: true,
          events: ['push'],
          config: {
            content_type: 'json',
            insecure_ssl: '0',
            url: 'https://example.com/webhook',
          },
        },
        sender: { login: 'user', id: 1, type: 'User' },
      }

      const result = parseWebhookPayload('ping', validPayload)

      expect(result.type).toBe('ping')
      if (result.type === 'ping') {
        expect(result.payload.zen).toBe('Keep it simple')
        expect(result.payload.hook_id).toBe(123)
      }
    })
  })

  describe('unknown event type', () => {
    it('should return unknown type for unrecognized event types', () => {
      const payload = { some: 'data' }

      const result = parseWebhookPayload('unknown_event', payload)

      expect(result.type).toBe('unknown')
      expect(result.payload).toEqual({ some: 'data' })
    })
  })
})
