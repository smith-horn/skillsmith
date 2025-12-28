/**
 * SMI-682: Security tests for X-Forwarded-For proxy trust validation
 *
 * These tests verify that the server only trusts X-Forwarded-For headers
 * when explicitly configured and from trusted proxy sources.
 */

import { describe, it, expect, vi } from 'vitest'
import { IncomingMessage } from 'http'
import { Socket } from 'net'

// Import the getClientIp function directly from TypeScript source
import { getClientIp, type WebhookServerConfig } from '../../src/webhooks/webhook-endpoint.ts'

describe('X-Forwarded-For Proxy Trust (SMI-682)', () => {
  function createMockRequest(
    headers: Record<string, string | string[] | undefined>,
    remoteAddress: string = '10.0.0.1'
  ): IncomingMessage {
    const socket = {
      remoteAddress,
    } as Socket

    const req = {
      headers,
      socket,
    } as IncomingMessage

    return req
  }

  describe('when trustProxy is false (default)', () => {
    it('should ignore X-Forwarded-For header and use socket address', () => {
      const config: WebhookServerConfig = {
        secret: 'test-secret',
        trustProxy: false,
      }

      const req = createMockRequest({ 'x-forwarded-for': '203.0.113.50' }, '10.0.0.1')

      const ip = getClientIp(req, config)

      expect(ip).toBe('10.0.0.1')
    })

    it('should use socket address when no X-Forwarded-For present', () => {
      const config: WebhookServerConfig = {
        secret: 'test-secret',
        trustProxy: false,
      }

      const req = createMockRequest({}, '192.168.1.100')

      const ip = getClientIp(req, config)

      expect(ip).toBe('192.168.1.100')
    })
  })

  describe('when trustProxy is true', () => {
    it('should use X-Forwarded-For header value', () => {
      const config: WebhookServerConfig = {
        secret: 'test-secret',
        trustProxy: true,
      }

      const req = createMockRequest({ 'x-forwarded-for': '203.0.113.50' }, '10.0.0.1')

      const ip = getClientIp(req, config)

      expect(ip).toBe('203.0.113.50')
    })

    it('should use first IP from comma-separated X-Forwarded-For', () => {
      const config: WebhookServerConfig = {
        secret: 'test-secret',
        trustProxy: true,
      }

      const req = createMockRequest(
        { 'x-forwarded-for': '203.0.113.50, 10.0.0.1, 192.168.1.1' },
        '127.0.0.1'
      )

      const ip = getClientIp(req, config)

      expect(ip).toBe('203.0.113.50')
    })

    it('should fallback to socket address when no X-Forwarded-For', () => {
      const config: WebhookServerConfig = {
        secret: 'test-secret',
        trustProxy: true,
      }

      const req = createMockRequest({}, '10.0.0.1')

      const ip = getClientIp(req, config)

      expect(ip).toBe('10.0.0.1')
    })
  })

  describe('when trustedProxies is configured', () => {
    it('should trust X-Forwarded-For only from trusted proxy IPs', () => {
      const config: WebhookServerConfig = {
        secret: 'test-secret',
        trustProxy: true,
        trustedProxies: ['10.0.0.1', '10.0.0.2'],
      }

      // Request comes from trusted proxy
      const req = createMockRequest({ 'x-forwarded-for': '203.0.113.50' }, '10.0.0.1')

      const ip = getClientIp(req, config)

      expect(ip).toBe('203.0.113.50')
    })

    it('should NOT trust X-Forwarded-For from untrusted proxy IPs', () => {
      const config: WebhookServerConfig = {
        secret: 'test-secret',
        trustProxy: true,
        trustedProxies: ['10.0.0.1', '10.0.0.2'],
      }

      // Request comes from untrusted IP (potential attacker)
      const req = createMockRequest(
        { 'x-forwarded-for': '203.0.113.50' },
        '192.168.1.100' // Not in trusted list
      )

      const ip = getClientIp(req, config)

      // Should use socket address, not spoofed header
      expect(ip).toBe('192.168.1.100')
    })

    it('should prevent IP spoofing attacks from untrusted sources', () => {
      const config: WebhookServerConfig = {
        secret: 'test-secret',
        trustProxy: true,
        trustedProxies: ['10.0.0.1'],
      }

      // Attacker tries to spoof IP by setting X-Forwarded-For
      const req = createMockRequest(
        { 'x-forwarded-for': '1.2.3.4' }, // Spoofed IP
        '192.168.1.100' // Attacker's real IP (not trusted)
      )

      const ip = getClientIp(req, config)

      // Attack should fail - use real socket address
      expect(ip).toBe('192.168.1.100')
      expect(ip).not.toBe('1.2.3.4')
    })
  })

  describe('edge cases', () => {
    it('should return "unknown" when socket has no remoteAddress', () => {
      const config: WebhookServerConfig = {
        secret: 'test-secret',
        trustProxy: false,
      }

      const socket = {} as Socket // No remoteAddress
      const req = {
        headers: {},
        socket,
      } as IncomingMessage

      const ip = getClientIp(req, config)

      expect(ip).toBe('unknown')
    })

    it('should handle array X-Forwarded-For header', () => {
      const config: WebhookServerConfig = {
        secret: 'test-secret',
        trustProxy: true,
      }

      const req = createMockRequest(
        { 'x-forwarded-for': ['203.0.113.50', '10.0.0.1'] as unknown as string },
        '127.0.0.1'
      )

      const ip = getClientIp(req, config)

      expect(ip).toBe('203.0.113.50')
    })

    it('should trim whitespace from X-Forwarded-For values', () => {
      const config: WebhookServerConfig = {
        secret: 'test-secret',
        trustProxy: true,
      }

      const req = createMockRequest(
        { 'x-forwarded-for': '  203.0.113.50  , 10.0.0.1  ' },
        '127.0.0.1'
      )

      const ip = getClientIp(req, config)

      expect(ip).toBe('203.0.113.50')
    })
  })
})
