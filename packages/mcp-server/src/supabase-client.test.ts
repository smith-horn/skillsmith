/**
 * @fileoverview supabase-client.ts's test-time production-fallback guard (SMI-6622 round 2)
 * @see SMI-6622: an adversarial-review probe recorded real `resolve_team_from_license` POSTs
 *      reaching the hardcoded prod URL from an unmocked test run — `getSupabaseClient()`/
 *      `getSupabaseUserClient()`'s anon-key fallback (SMI-6109) had no guard against a test
 *      silently dialing production. This file exercises the REAL (unmocked) module directly —
 *      every other supabase-client.js consumer's tests mock it wholesale, so none of them would
 *      have caught a regression here.
 *
 * `process.env.VITEST` is `'true'` for this whole file/process (Vitest sets it) — "outside the
 * test runner" is simulated per-test by deleting it, then restored in `afterEach` so later tests
 * (and other files sharing a worker under `--no-isolate`, if ever enabled) see the real value.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'

function snapshotEnv(): () => void {
  const vitestVar = process.env.VITEST
  const url = process.env.SUPABASE_URL
  const anon = process.env.SUPABASE_ANON_KEY
  return () => {
    if (vitestVar === undefined) delete process.env.VITEST
    else process.env.VITEST = vitestVar
    if (url === undefined) delete process.env.SUPABASE_URL
    else process.env.SUPABASE_URL = url
    if (anon === undefined) delete process.env.SUPABASE_ANON_KEY
    else process.env.SUPABASE_ANON_KEY = anon
  }
}

describe('supabase-client.ts — test-time production-fallback guard (SMI-6622)', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('getSupabaseClient() throws under VITEST with no SUPABASE_URL, instead of dialing prod', async () => {
    const restore = snapshotEnv()
    try {
      process.env.VITEST = 'true'
      delete process.env.SUPABASE_URL
      delete process.env.SUPABASE_ANON_KEY
      vi.resetModules()
      const { getSupabaseClient } = await import('./supabase-client.js')
      await expect(getSupabaseClient()).rejects.toThrow(
        /test attempted to reach production Supabase/i
      )
    } finally {
      restore()
    }
  })

  it('getSupabaseUserClient() throws under VITEST with no SUPABASE_URL, instead of dialing prod', async () => {
    const restore = snapshotEnv()
    try {
      process.env.VITEST = 'true'
      delete process.env.SUPABASE_URL
      delete process.env.SUPABASE_ANON_KEY
      vi.resetModules()
      const { getSupabaseUserClient } = await import('./supabase-client.js')
      await expect(getSupabaseUserClient('fake-token')).rejects.toThrow(
        /test attempted to reach production Supabase/i
      )
    } finally {
      restore()
    }
  })

  it('getSupabaseClient() does NOT throw the prod-fallback guard when SUPABASE_URL is explicitly set (even under VITEST)', async () => {
    const restore = snapshotEnv()
    try {
      process.env.VITEST = 'true'
      process.env.SUPABASE_URL = 'http://127.0.0.1:1'
      process.env.SUPABASE_ANON_KEY = 'local-anon'
      vi.resetModules()
      const { getSupabaseClient } = await import('./supabase-client.js')
      // createClient() itself never dials out at construction time — only a later .rpc()/.from()
      // call would, and this test makes none. Resolving (not throwing) proves the guard did not
      // fire for an explicit override, which is the property under test.
      await expect(getSupabaseClient()).resolves.toBeTruthy()
    } finally {
      restore()
    }
  })

  it('getSupabaseAdminClient() is unaffected — it already had no fallback to guard (SMI-6109)', async () => {
    const restore = snapshotEnv()
    try {
      process.env.VITEST = 'true'
      delete process.env.SUPABASE_URL
      vi.resetModules()
      const { getSupabaseAdminClient } = await import('./supabase-client.js')
      await expect(getSupabaseAdminClient()).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY required/i)
    } finally {
      restore()
    }
  })

  it('outside the test runner (VITEST unset), the fallback is NOT guarded — real behavior unchanged', async () => {
    const restore = snapshotEnv()
    try {
      delete process.env.VITEST
      delete process.env.SUPABASE_URL
      delete process.env.SUPABASE_ANON_KEY
      vi.resetModules()
      const { getSupabaseClient } = await import('./supabase-client.js')
      await expect(getSupabaseClient()).resolves.toBeTruthy()
    } finally {
      restore()
    }
  })
})
