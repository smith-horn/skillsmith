import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { getWebsiteSsrApiKey } from './supabase-config.server'

describe('getWebsiteSsrApiKey', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns an empty string, not undefined, when the env var is unset', () => {
    // vi.stubEnv('KEY', undefined) simulates the var never having been set —
    // import.meta.env.SKILLSMITH_WEBSITE_SSR_API_KEY reads back as undefined,
    // exactly like local dev before the real secret is provisioned.
    vi.stubEnv('SKILLSMITH_WEBSITE_SSR_API_KEY', undefined)

    const result = getWebsiteSsrApiKey()

    expect(result).toBe('')
    expect(result).not.toBeUndefined()
    expect(() => getWebsiteSsrApiKey()).not.toThrow()
  })

  it('returns an empty string when the env var is explicitly set to an empty string', () => {
    vi.stubEnv('SKILLSMITH_WEBSITE_SSR_API_KEY', '')
    expect(getWebsiteSsrApiKey()).toBe('')
  })

  it('returns the configured value when the env var is set', () => {
    vi.stubEnv('SKILLSMITH_WEBSITE_SSR_API_KEY', 'sk_live_test_dedicated_key')
    expect(getWebsiteSsrApiKey()).toBe('sk_live_test_dedicated_key')
  })
})

describe('getWebsiteSsrApiKey fallback isolation (module-level re-import)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('degrades to an empty string rather than throwing when the module is freshly loaded with no env var set', async () => {
    vi.stubEnv('SKILLSMITH_WEBSITE_SSR_API_KEY', undefined)

    const { getWebsiteSsrApiKey: freshGetWebsiteSsrApiKey } =
      await import('./supabase-config.server')

    expect(() => freshGetWebsiteSsrApiKey()).not.toThrow()
    expect(freshGetWebsiteSsrApiKey()).toBe('')
  })
})
