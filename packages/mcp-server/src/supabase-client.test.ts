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

// ============================================================================
// SMI-6622 round 7 PR-07: a Supabase URL with embedded userinfo (`https://user:pass@host`)
// constructs a client SILENTLY — the leak surfaces one query later, when PostgREST/undici's own
// "Request cannot be constructed from a URL that includes credentials: <url>" TypeError embeds the
// credentials VERBATIM in `error.message`, which every forwarding call site then copies into a
// tool result. A measurement run against real `@supabase/supabase-js` 2.114.0 + Node 22 confirmed
// this is the only real leak of its kind (every other upstream error class produced no credential
// material). This describe block exercises the REAL (unmocked) module, same as the block above —
// mocking supabase-client.js itself would prove nothing about a guard that lives inside it.
// ============================================================================

describe('supabase-client.ts — Supabase URL credential guard (SMI-6622 round 7)', () => {
  const USERNAME_MARKER = 'MARKERUSER'
  const PASSWORD_MARKER = 'MARKERPASS-9999'
  const MARKER_HOST = 'example.invalid'
  const AUTHORED_MESSAGE = /the configured supabase url contains a username or password/i

  function snapshotAllEnv(): () => void {
    const vitestVar = process.env.VITEST
    const url = process.env.SUPABASE_URL
    const anon = process.env.SUPABASE_ANON_KEY
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    return () => {
      if (vitestVar === undefined) delete process.env.VITEST
      else process.env.VITEST = vitestVar
      if (url === undefined) delete process.env.SUPABASE_URL
      else process.env.SUPABASE_URL = url
      if (anon === undefined) delete process.env.SUPABASE_ANON_KEY
      else process.env.SUPABASE_ANON_KEY = anon
      if (serviceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
      else process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey
    }
  }

  afterEach(() => {
    vi.resetModules()
  })

  // Requirement 1 (factory level): each client factory throws the authored message for BOTH a
  // full userinfo URL and a username-only one, and the message contains neither marker nor the
  // host. `SUPABASE_URL` is set explicitly (not deleted) so `assertNoProdFallbackUnderTest()`
  // never fires first and masks the guard under test — same technique the block above uses.
  describe.each([
    [
      'userinfo (username + password)',
      `https://${USERNAME_MARKER}:${PASSWORD_MARKER}@${MARKER_HOST}`,
    ],
    ['username-only', `https://${USERNAME_MARKER}@${MARKER_HOST}`],
  ])('a Supabase URL with %s', (_label, credentialedUrl) => {
    async function assertRejectsWithoutLeaking(rejecting: Promise<unknown>): Promise<void> {
      await expect(rejecting).rejects.toThrow(AUTHORED_MESSAGE)
      try {
        await rejecting
        expect.unreachable()
      } catch (err) {
        const message = (err as Error).message
        expect(message).not.toContain(USERNAME_MARKER)
        expect(message).not.toContain(PASSWORD_MARKER)
        expect(message).not.toContain(MARKER_HOST)
      }
    }

    it('getSupabaseClient() rejects it before constructing a client, without leaking it', async () => {
      const restore = snapshotAllEnv()
      try {
        process.env.VITEST = 'true'
        process.env.SUPABASE_URL = credentialedUrl
        process.env.SUPABASE_ANON_KEY = 'anon'
        vi.resetModules()
        const { getSupabaseClient } = await import('./supabase-client.js')
        await assertRejectsWithoutLeaking(getSupabaseClient())
      } finally {
        restore()
      }
    })

    it('getSupabaseUserClient() rejects it before constructing a client, without leaking it', async () => {
      const restore = snapshotAllEnv()
      try {
        process.env.VITEST = 'true'
        process.env.SUPABASE_URL = credentialedUrl
        process.env.SUPABASE_ANON_KEY = 'anon'
        vi.resetModules()
        const { getSupabaseUserClient } = await import('./supabase-client.js')
        await assertRejectsWithoutLeaking(getSupabaseUserClient('fake-token'))
      } finally {
        restore()
      }
    })

    it('getSupabaseAdminClient() rejects it before constructing a client, without leaking it', async () => {
      const restore = snapshotAllEnv()
      try {
        process.env.VITEST = 'true'
        process.env.SUPABASE_URL = credentialedUrl
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
        vi.resetModules()
        const { getSupabaseAdminClient } = await import('./supabase-client.js')
        await assertRejectsWithoutLeaking(getSupabaseAdminClient())
      } finally {
        restore()
      }
    })
  })

  // Requirement 3 (control): a normal URL with no userinfo still constructs a client — the guard
  // must not be a false-positive trap on every configured URL.
  it('a normal URL with no userinfo still constructs a client — no throw from the guard', async () => {
    const restore = snapshotAllEnv()
    try {
      process.env.VITEST = 'true'
      process.env.SUPABASE_URL = `https://${MARKER_HOST}`
      process.env.SUPABASE_ANON_KEY = 'anon'
      vi.resetModules()
      const { getSupabaseClient } = await import('./supabase-client.js')
      // createClient() itself never dials out at construction time (same reasoning as the
      // pre-existing "does NOT throw the prod-fallback guard" test above) — resolving proves the
      // credential guard did not fire for a clean URL.
      await expect(getSupabaseClient()).resolves.toBeTruthy()
    } finally {
      restore()
    }
  })

  // Requirement 2 (end to end): the credentialed URL reaches the MCP tool handlers through the
  // REAL, unmocked module chain — registry-tools.js -> registry-tools.team.js ->
  // supabase-client.js's getSupabaseClient() — no mock of supabase-client.js or of the guard
  // itself. `fetch` is mocked (permitted explicitly — "mock at the network or fetch layer if
  // needed") to throw the EXACT failure the guard exists to prevent — supabase-js's own
  // `TypeError: Request cannot be constructed from a URL that includes credentials: <url>`
  // (confirmed against real `@supabase/supabase-js` 2.114.0 + Node 22 with marker credentials) —
  // rather than a real DNS attempt against a non-routable host, which is what happens when this
  // test's fetch mock is removed: slow (~9.5s) and non-deterministic, though it does still
  // ultimately exercise the same code path.
  //
  // MEASURED FINDING, not assumed: this test passes end to end even with ONLY supabase-client.ts
  // reverted (see this file's revert-check report) — `registry-tools.team.ts`'s round-6 PR-07
  // `resolveRegistryTeamId()` already wraps EVERY exception/`rpcResult.error` from its client
  // construction and RPC call in authored-only text, attaching the raw value solely as `cause`,
  // regardless of what that text contains. Team resolution is the ONLY client-touching step either
  // tool takes before returning a result, so for these two tools specifically, round 6 alone
  // already fully absorbs this leak — round 7's OWN necessity is proven at the FACTORY level
  // (getSupabaseClient/getSupabaseUserClient/getSupabaseAdminClient, 6/6 tests above fail on
  // revert), not by this test. This test is kept as a real, valuable composed-behavior regression
  // guard (round 6 + round 7 together stay safe end to end) — not represented as round-7-specific
  // revert-check evidence.
  it('private_registry_manage and private_registry_publish results contain neither marker when SUPABASE_URL is credentialed', async () => {
    const restore = snapshotAllEnv()
    const origLicense = process.env.SKILLSMITH_LICENSE_KEY
    const origApiKey = process.env.SKILLSMITH_API_KEY
    const originalFetch = globalThis.fetch
    try {
      process.env.VITEST = 'true'
      process.env.SUPABASE_URL = `https://${USERNAME_MARKER}:${PASSWORD_MARKER}@${MARKER_HOST}`
      process.env.SUPABASE_ANON_KEY = 'anon'
      delete process.env.SKILLSMITH_LICENSE_KEY
      process.env.SKILLSMITH_API_KEY = 'sk_live_fake_for_this_test'
      globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        throw new TypeError(
          `Request cannot be constructed from a URL that includes credentials: ${String(input)}`
        )
      }) as typeof fetch
      vi.resetModules()

      const { executePrivateRegistryManage, executePrivateRegistryPublish } =
        await import('./tools/registry-tools.js')
      const context = {} as Parameters<typeof executePrivateRegistryManage>[1]

      const manageResult = await executePrivateRegistryManage({ action: 'list' }, context)
      expect(manageResult.success).toBe(false)
      expect(manageResult.error).not.toContain(USERNAME_MARKER)
      expect(manageResult.error).not.toContain(PASSWORD_MARKER)
      expect(manageResult.error).not.toContain(MARKER_HOST)

      const publishResult = await executePrivateRegistryPublish(
        {
          skillId: 'myteam/my-skill',
          version: '1.0.0',
          content: { 'SKILL.md': '# My Skill\n\nDoes a useful thing.' },
        },
        context
      )
      expect(publishResult.success).toBe(false)
      expect(publishResult.error).not.toContain(USERNAME_MARKER)
      expect(publishResult.error).not.toContain(PASSWORD_MARKER)
      expect(publishResult.error).not.toContain(MARKER_HOST)
    } finally {
      globalThis.fetch = originalFetch
      restore()
      if (origLicense === undefined) delete process.env.SKILLSMITH_LICENSE_KEY
      else process.env.SKILLSMITH_LICENSE_KEY = origLicense
      if (origApiKey === undefined) delete process.env.SKILLSMITH_API_KEY
      else process.env.SKILLSMITH_API_KEY = origApiKey
    }
  })
})
