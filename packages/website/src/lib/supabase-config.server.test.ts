import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { getWebsiteSsrApiKey } from './supabase-config.server'

describe('getWebsiteSsrApiKey', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('falls back to the anon key, not an empty string, when the dedicated secret is unset', () => {
    // Hotfix (SMI-6190 post-merge): an empty bearer token doesn't match the
    // anon key's exact-string check, so it would fall all the way through
    // runAuthMiddleware() to the trial limiter's 10-requests-TOTAL-EVER cap
    // (confirmed already exhausted in prod) instead of the anon-key
    // community-tier bucket this credential is meant to replace. Falling
    // back to the anon key preserves pre-SMI-6190 behavior until the real
    // key is provisioned, rather than making things worse in the meantime.
    vi.stubEnv('SKILLSMITH_WEBSITE_SSR_API_KEY', undefined)
    vi.stubEnv('PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fallback-value')

    const result = getWebsiteSsrApiKey()

    expect(result).toBe('anon-key-fallback-value')
    expect(() => getWebsiteSsrApiKey()).not.toThrow()
  })

  it('falls back to the anon key when the dedicated secret is explicitly set to an empty string', () => {
    vi.stubEnv('SKILLSMITH_WEBSITE_SSR_API_KEY', '')
    vi.stubEnv('PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fallback-value')
    expect(getWebsiteSsrApiKey()).toBe('anon-key-fallback-value')
  })

  it('returns the dedicated key when configured, not the anon key', () => {
    vi.stubEnv('SKILLSMITH_WEBSITE_SSR_API_KEY', 'sk_live_test_dedicated_key')
    vi.stubEnv('PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fallback-value')
    expect(getWebsiteSsrApiKey()).toBe('sk_live_test_dedicated_key')
  })

  it('returns an empty string (never throws) when neither the dedicated key nor the anon key is configured', () => {
    // Degenerate case — no real deployment should ever reach this, since the
    // anon key is a build-time-baked public constant, but the accessor must
    // not throw regardless.
    vi.stubEnv('SKILLSMITH_WEBSITE_SSR_API_KEY', undefined)
    vi.stubEnv('PUBLIC_SUPABASE_ANON_KEY', undefined)
    expect(() => getWebsiteSsrApiKey()).not.toThrow()
    expect(getWebsiteSsrApiKey()).toBe('')
  })
})

describe('getWebsiteSsrApiKey fallback isolation (module-level re-import)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('falls back to the anon key rather than throwing when the module is freshly loaded with no dedicated key set', async () => {
    vi.stubEnv('SKILLSMITH_WEBSITE_SSR_API_KEY', undefined)
    vi.stubEnv('PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fallback-value')

    const { getWebsiteSsrApiKey: freshGetWebsiteSsrApiKey } =
      await import('./supabase-config.server')

    expect(() => freshGetWebsiteSsrApiKey()).not.toThrow()
    expect(freshGetWebsiteSsrApiKey()).toBe('anon-key-fallback-value')
  })
})
