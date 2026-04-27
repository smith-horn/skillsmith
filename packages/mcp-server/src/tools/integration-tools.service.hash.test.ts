/**
 * @fileoverview Tests for hashApiKey and its env-var-backed HMAC secret.
 * Extracted from integration-tools.service.test.ts to keep that file under
 * the 500-line cap (SMI-2162). The rest of the integration-tools test
 * suite still sets the env var via its own top-level beforeAll/afterAll.
 *
 * @see SMI-4503: Rotate KEY_HMAC_SECRET to env var
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHmac } from 'node:crypto'
import { hashApiKey } from './integration-tools.service.js'

const TEST_HMAC_SECRET = 'test-hmac-secret-for-vitest-only-32chars-minimum-padding-padding-padding'
const ORIGINAL_HMAC_SECRET = process.env.SKILLSMITH_API_KEY_HMAC_SECRET

beforeAll(() => {
  process.env.SKILLSMITH_API_KEY_HMAC_SECRET = TEST_HMAC_SECRET
})

afterAll(() => {
  if (ORIGINAL_HMAC_SECRET === undefined) delete process.env.SKILLSMITH_API_KEY_HMAC_SECRET
  else process.env.SKILLSMITH_API_KEY_HMAC_SECRET = ORIGINAL_HMAC_SECRET
})

describe('hashApiKey', () => {
  it('should produce a deterministic SHA-256 HMAC hex hash', () => {
    const key = 'sk_int_testkey123'
    const hash = hashApiKey(key)

    const expected = createHmac('sha256', TEST_HMAC_SECRET).update(key).digest('hex')
    expect(hash).toBe(expected)
    expect(hash).toHaveLength(64)
  })

  it('should produce different hashes for different keys', () => {
    expect(hashApiKey('key-a')).not.toBe(hashApiKey('key-b'))
  })

  describe('boot validation', () => {
    afterAll(() => {
      process.env.SKILLSMITH_API_KEY_HMAC_SECRET = TEST_HMAC_SECRET
    })

    it('should fail fast when SKILLSMITH_API_KEY_HMAC_SECRET is missing', () => {
      delete process.env.SKILLSMITH_API_KEY_HMAC_SECRET
      expect(() => hashApiKey('any-key')).toThrow(/SKILLSMITH_API_KEY_HMAC_SECRET/)
    })

    it('should fail fast when secret is shorter than 32 characters', () => {
      process.env.SKILLSMITH_API_KEY_HMAC_SECRET = 'too-short'
      expect(() => hashApiKey('any-key')).toThrow(/32\+ character/)
    })
  })
})
