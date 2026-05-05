/**
 * E2E: Multi-key license key generation (SMI-4740)
 *
 * Verifies that Individual/Team/Enterprise subscribers can generate multiple
 * license keys up to their tier limit, and that Community subscribers are
 * still capped at 1 key by the DB-level partial unique index.
 *
 * Root cause tested: migration 030 idx_license_keys_user_tier_active enforced
 * at most 1 active key per (user_id, tier), contradicting MAX_KEYS_BY_TIER.
 * Migration SMI-4740 drops it and adds idx_license_keys_community_active.
 *
 * Run via: varlock run -- npx vitest run --config vitest.e2e.config.ts tests/e2e/api/license-key-generation.e2e.test.ts
 *
 * Required env (varlock-loaded):
 *   STAGING_SUPABASE_URL              — must match staging ref ovhcifugwqnzoebwfuku
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY
 *   STAGING_SUPABASE_ANON_KEY
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  provisionTestUser,
  cleanupTestUser,
  type ProvisionedUser,
} from '../fixtures/usage-counter-fixture.js'

const STAGING_URL = process.env.STAGING_SUPABASE_URL
const STAGING_SERVICE_KEY = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY
const STAGING_ANON_KEY = process.env.STAGING_SUPABASE_ANON_KEY

const skipReason =
  !STAGING_URL || !STAGING_SERVICE_KEY || !STAGING_ANON_KEY
    ? 'STAGING_SUPABASE_* env vars missing — run via: varlock run -- npx vitest run tests/e2e/license-key-generation.e2e.test.ts'
    : ''

const describeIfStaged = skipReason ? describe.skip : describe

const GENERATE_URL = `${STAGING_URL ?? ''}/functions/v1/generate-license`

async function generateKey(jwt: string, name: string): Promise<Response> {
  return fetch(GENERATE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  })
}

describeIfStaged('generate-license multi-key enforcement (SMI-4740)', () => {
  let individualUser: ProvisionedUser
  let communityUser: ProvisionedUser

  beforeAll(async () => {
    // provisionTestUser creates 1 license key by default — that's the baseline state
    ;[individualUser, communityUser] = await Promise.all([
      provisionTestUser({ tier: 'individual' }),
      provisionTestUser({ tier: 'community' }),
    ])
  })

  afterAll(async () => {
    await Promise.all([
      cleanupTestUser(individualUser.userId),
      cleanupTestUser(communityUser.userId),
    ])
  })

  describe('Individual tier (limit: 3)', () => {
    it('generates 2nd key when 1 already exists', async () => {
      const res = await generateKey(individualUser.jwt, 'Key 2')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.key).toMatch(/^sk_live_/)
      expect(data.key_prefix).toMatch(/^sk_live_/)
    })

    it('generates 3rd key', async () => {
      const res = await generateKey(individualUser.jwt, 'Key 3')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.key).toMatch(/^sk_live_/)
    })

    it('blocks 4th key with 400 tier-limit error (not 409)', async () => {
      const res = await generateKey(individualUser.jwt, 'Key 4')
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toMatch(/Maximum 3 active key/)
      expect(data.error).toContain('individual')
    })
  })

  describe('Community tier (limit: 1)', () => {
    it('blocks 2nd key with 400 tier-limit error (not 409)', async () => {
      // provisionTestUser already created 1 key for communityUser
      const res = await generateKey(communityUser.jwt, 'Key 2')
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toMatch(/Maximum 1 active key/)
      expect(data.error).toContain('community')
    })

    it('tier-limit error is 400 not 409 (409 = key_hash collision only)', async () => {
      const res = await generateKey(communityUser.jwt, 'Key 3')
      expect(res.status).toBe(400)
      expect(res.status).not.toBe(409)
    })
  })
})
