/**
 * SMI-1261: Unit tests for PostHog telemetry module
 *
 * Tests cover:
 * - Initialization (success, disabled mode, invalid key)
 * - Client state management (getPostHog, isPostHogEnabled)
 * - Event tracking (trackEvent, trackSkillSearch, trackSkillView, trackSkillInstall, trackApiError)
 * - User identification with restricted traits
 * - Feature flag evaluation
 * - Lifecycle management (flushPostHog, shutdownPostHog)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Use vi.hoisted to ensure mocks are available during vi.mock hoisting
const mocks = vi.hoisted(() => {
  const capture = vi.fn()
  const identify = vi.fn()
  const isFeatureEnabled = vi.fn().mockResolvedValue(true)
  const flush = vi.fn().mockResolvedValue(undefined)
  const shutdown = vi.fn().mockResolvedValue(undefined)
  const debug = vi.fn()
  const constructorCalls: Array<{
    apiKey: string
    options?: { host?: string; flushInterval?: number }
  }> = []

  return {
    capture,
    identify,
    isFeatureEnabled,
    flush,
    shutdown,
    debug,
    constructorCalls,
  }
})

vi.mock('posthog-node', () => {
  return {
    PostHog: class MockPostHog {
      constructor(apiKey: string, options?: { host?: string; flushInterval?: number }) {
        mocks.constructorCalls.push({ apiKey, options })
      }

      capture(...args: unknown[]) {
        return mocks.capture(...args)
      }

      identify(...args: unknown[]) {
        return mocks.identify(...args)
      }

      isFeatureEnabled(...args: unknown[]) {
        return mocks.isFeatureEnabled(...args)
      }

      flush(...args: unknown[]) {
        return mocks.flush(...args)
      }

      shutdown(...args: unknown[]) {
        return mocks.shutdown(...args)
      }

      debug(...args: unknown[]) {
        return mocks.debug(...args)
      }
    },
  }
})

import {
  initializePostHog,
  shutdownPostHog,
  getPostHog,
  isPostHogEnabled,
  trackEvent,
  trackSkillSearch,
  trackSkillView,
  trackSkillInstall,
  trackApiError,
  identifyUser,
  isFeatureFlagEnabled,
  flushPostHog,
  ALLOWED_TRAITS,
  type PostHogConfig,
  type AllowedUserTraits,
} from '../../src/telemetry/posthog.js'

describe('PostHog telemetry', () => {
  beforeEach(() => {
    // Reset all mocks before each test (including mockImplementationOnce queues)
    mocks.capture.mockReset()
    mocks.identify.mockReset()
    mocks.isFeatureEnabled.mockReset().mockResolvedValue(true)
    mocks.flush.mockReset().mockResolvedValue(undefined)
    mocks.shutdown.mockReset().mockResolvedValue(undefined)
    mocks.debug.mockReset()
    // Clear constructor call tracking
    mocks.constructorCalls.length = 0
  })

  afterEach(async () => {
    // Clean up PostHog state after each test
    // First shutdown any existing instance
    await shutdownPostHog()
    // Force reset state by initializing with valid key and shutting down
    // This handles the case where a test used disabled: true which doesn't create an instance
    // but sets isDisabled = true, which shutdown alone won't reset
    initializePostHog({ apiKey: 'phc_cleanup_key' })
    await shutdownPostHog()
  })

  describe('initializePostHog', () => {
    it('should initialize with valid API key', () => {
      const config: PostHogConfig = {
        apiKey: 'phc_test_key_123',
        host: 'https://custom.posthog.com',
        flushInterval: 5000,
      }

      initializePostHog(config)

      expect(mocks.constructorCalls).toHaveLength(1)
      expect(mocks.constructorCalls[0]).toEqual({
        apiKey: 'phc_test_key_123',
        options: {
          host: 'https://custom.posthog.com',
          flushInterval: 5000,
        },
      })
      expect(isPostHogEnabled()).toBe(true)
      expect(getPostHog()).not.toBeNull()
    })

    it('should use default host and flushInterval when not provided', () => {
      const config: PostHogConfig = {
        apiKey: 'phc_test_key_456',
      }

      initializePostHog(config)

      expect(mocks.constructorCalls).toHaveLength(1)
      expect(mocks.constructorCalls[0]).toEqual({
        apiKey: 'phc_test_key_456',
        options: {
          host: 'https://app.posthog.com',
          flushInterval: 10000,
        },
      })
    })

    it('should enable debug mode when configured', () => {
      const config: PostHogConfig = {
        apiKey: 'phc_test_key_debug',
        debug: true,
      }

      initializePostHog(config)

      expect(mocks.debug).toHaveBeenCalled()
    })

    it('should disable telemetry when disabled flag is set', () => {
      const config: PostHogConfig = {
        apiKey: 'phc_test_key_disabled',
        disabled: true,
      }

      initializePostHog(config)

      expect(mocks.constructorCalls).toHaveLength(0)
      expect(isPostHogEnabled()).toBe(false)
      expect(getPostHog()).toBeNull()
    })

    it('should disable telemetry when API key is empty', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const config: PostHogConfig = {
        apiKey: '',
      }

      initializePostHog(config)

      expect(mocks.constructorCalls).toHaveLength(0)
      expect(isPostHogEnabled()).toBe(false)
      expect(warnSpy).toHaveBeenCalledWith('[PostHog] No API key provided, telemetry disabled')

      warnSpy.mockRestore()
    })

    it('should disable telemetry when API key is missing (falsy)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Using type assertion to test edge case
      const config = { apiKey: undefined } as unknown as PostHogConfig

      initializePostHog(config)

      expect(isPostHogEnabled()).toBe(false)

      warnSpy.mockRestore()
    })
  })

  describe('getPostHog', () => {
    it('should return null when not initialized', () => {
      expect(getPostHog()).toBeNull()
    })

    it('should return PostHog instance when initialized', () => {
      initializePostHog({ apiKey: 'phc_test_get' })

      const instance = getPostHog()
      expect(instance).not.toBeNull()
      expect(instance).toHaveProperty('capture')
    })
  })

  describe('isPostHogEnabled', () => {
    it('should return false when not initialized', () => {
      expect(isPostHogEnabled()).toBe(false)
    })

    it('should return true when initialized with valid key', () => {
      initializePostHog({ apiKey: 'phc_test_enabled' })
      expect(isPostHogEnabled()).toBe(true)
    })

    it('should return false when disabled', () => {
      initializePostHog({ apiKey: 'phc_test_disabled', disabled: true })
      expect(isPostHogEnabled()).toBe(false)
    })
  })

  describe('trackEvent', () => {
    it('should track event with properties when enabled', () => {
      initializePostHog({ apiKey: 'phc_test_track' })

      trackEvent('user_123', 'skill_search', {
        query: 'testing',
        result_count: 5,
        duration_ms: 150,
      })

      expect(mocks.capture).toHaveBeenCalledWith({
        distinctId: 'user_123',
        event: 'skill_search',
        properties: {
          query: 'testing',
          result_count: 5,
          duration_ms: 150,
          $lib: 'skillsmith',
          $lib_version: expect.any(String),
        },
      })
    })

    it('should track event without properties', () => {
      initializePostHog({ apiKey: 'phc_test_track_simple' })

      trackEvent('user_456', 'skill_view')

      expect(mocks.capture).toHaveBeenCalledWith({
        distinctId: 'user_456',
        event: 'skill_view',
        properties: {
          $lib: 'skillsmith',
          $lib_version: expect.any(String),
        },
      })
    })

    it('should silently no-op when disabled', () => {
      initializePostHog({ apiKey: 'phc_test_noop', disabled: true })

      trackEvent('user_789', 'skill_install', { skill_id: 'test/skill' })

      expect(mocks.capture).not.toHaveBeenCalled()
    })

    it('should silently no-op when not initialized', () => {
      trackEvent('user_000', 'skill_uninstall')

      expect(mocks.capture).not.toHaveBeenCalled()
    })

    it('should handle capture errors gracefully', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      mocks.capture.mockImplementationOnce(() => {
        throw new Error('Network error')
      })

      initializePostHog({ apiKey: 'phc_test_error' })

      // Should not throw
      expect(() => {
        trackEvent('user_error', 'skill_search', { query: 'test' })
      }).not.toThrow()

      expect(debugSpy).toHaveBeenCalledWith('[PostHog] Failed to track event:', expect.any(Error))

      debugSpy.mockRestore()
    })

    it('should track custom event types', () => {
      initializePostHog({ apiKey: 'phc_test_custom' })

      trackEvent('user_custom', 'custom_event_type', {
        custom_property: 'value',
      })

      expect(mocks.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'custom_event_type',
        })
      )
    })
  })

  describe('trackSkillSearch', () => {
    it('should track skill search with all parameters', () => {
      initializePostHog({ apiKey: 'phc_test_search' })

      trackSkillSearch('user_search', 'react hooks', 10, 250, {
        trustTier: 'verified',
        category: 'development',
      })

      expect(mocks.capture).toHaveBeenCalledWith({
        distinctId: 'user_search',
        event: 'skill_search',
        properties: {
          query: 'react hooks',
          result_count: 10,
          duration_ms: 250,
          trust_tier: 'verified',
          category: 'development',
          $lib: 'skillsmith',
          $lib_version: expect.any(String),
        },
      })
    })

    it('should track skill search without filters', () => {
      initializePostHog({ apiKey: 'phc_test_search_no_filter' })

      trackSkillSearch('user_search_2', 'testing', 5, 100)

      expect(mocks.capture).toHaveBeenCalledWith({
        distinctId: 'user_search_2',
        event: 'skill_search',
        properties: {
          query: 'testing',
          result_count: 5,
          duration_ms: 100,
          trust_tier: undefined,
          category: undefined,
          $lib: 'skillsmith',
          $lib_version: expect.any(String),
        },
      })
    })
  })

  describe('trackSkillView', () => {
    it('should track skill view from CLI', () => {
      initializePostHog({ apiKey: 'phc_test_view' })

      trackSkillView('user_view', 'community/jest-helper', 'cli')

      expect(mocks.capture).toHaveBeenCalledWith({
        distinctId: 'user_view',
        event: 'skill_view',
        properties: {
          skill_id: 'community/jest-helper',
          source: 'cli',
          $lib: 'skillsmith',
          $lib_version: expect.any(String),
        },
      })
    })

    it('should track skill view from MCP', () => {
      initializePostHog({ apiKey: 'phc_test_view_mcp' })

      trackSkillView('user_view_2', 'verified/commit', 'mcp')

      expect(mocks.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({
            source: 'mcp',
          }),
        })
      )
    })

    it('should track skill view from API', () => {
      initializePostHog({ apiKey: 'phc_test_view_api' })

      trackSkillView('user_view_3', 'experimental/ai-helper', 'api')

      expect(mocks.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({
            source: 'api',
          }),
        })
      )
    })
  })

  describe('trackSkillInstall', () => {
    it('should track skill installation', () => {
      initializePostHog({ apiKey: 'phc_test_install' })

      trackSkillInstall('user_install', 'community/vitest-helper', 'cli')

      expect(mocks.capture).toHaveBeenCalledWith({
        distinctId: 'user_install',
        event: 'skill_install',
        properties: {
          skill_id: 'community/vitest-helper',
          source: 'cli',
          $lib: 'skillsmith',
          $lib_version: expect.any(String),
        },
      })
    })
  })

  describe('trackApiError', () => {
    it('should track API error with duration', () => {
      initializePostHog({ apiKey: 'phc_test_api_error' })

      trackApiError('user_error', 'RATE_LIMITED', '/api/skills/search', 500)

      expect(mocks.capture).toHaveBeenCalledWith({
        distinctId: 'user_error',
        event: 'api_error',
        properties: {
          error_code: 'RATE_LIMITED',
          endpoint: '/api/skills/search',
          duration_ms: 500,
          $lib: 'skillsmith',
          $lib_version: expect.any(String),
        },
      })
    })

    it('should track API error without duration', () => {
      initializePostHog({ apiKey: 'phc_test_api_error_no_dur' })

      trackApiError('user_error_2', 'NOT_FOUND', '/api/skills/unknown')

      expect(mocks.capture).toHaveBeenCalledWith({
        distinctId: 'user_error_2',
        event: 'api_error',
        properties: {
          error_code: 'NOT_FOUND',
          endpoint: '/api/skills/unknown',
          duration_ms: undefined,
          $lib: 'skillsmith',
          $lib_version: expect.any(String),
        },
      })
    })
  })

  describe('identifyUser', () => {
    it('should identify user with allowed traits', () => {
      initializePostHog({ apiKey: 'phc_test_identify' })

      const traits: AllowedUserTraits = {
        tier: 'pro',
        version: '1.2.3',
        platform: 'darwin',
        sdk_version: '0.5.0',
      }

      identifyUser('anon_user_hash', traits)

      expect(mocks.identify).toHaveBeenCalledWith({
        distinctId: 'anon_user_hash',
        properties: {
          tier: 'pro',
          version: '1.2.3',
          platform: 'darwin',
          sdk_version: '0.5.0',
        },
      })
    })

    it('should filter out non-allowed traits (defense in depth)', () => {
      initializePostHog({ apiKey: 'phc_test_identify_filter' })

      // Simulate passing extra properties (e.g., via type bypass)
      const traitsWithExtra = {
        tier: 'free',
        email: 'should@be.filtered', // PII - should be filtered
        name: 'John Doe', // PII - should be filtered
        ip_address: '127.0.0.1', // PII - should be filtered
      } as unknown as AllowedUserTraits

      identifyUser('anon_user_hash_2', traitsWithExtra)

      expect(mocks.identify).toHaveBeenCalledWith({
        distinctId: 'anon_user_hash_2',
        properties: {
          tier: 'free',
          // email, name, ip_address should NOT be present
        },
      })
    })

    it('should handle partial traits', () => {
      initializePostHog({ apiKey: 'phc_test_identify_partial' })

      identifyUser('anon_user_partial', { platform: 'linux' })

      expect(mocks.identify).toHaveBeenCalledWith({
        distinctId: 'anon_user_partial',
        properties: {
          platform: 'linux',
        },
      })
    })

    it('should handle empty traits', () => {
      initializePostHog({ apiKey: 'phc_test_identify_empty' })

      identifyUser('anon_user_empty', {})

      expect(mocks.identify).toHaveBeenCalledWith({
        distinctId: 'anon_user_empty',
        properties: {},
      })
    })

    it('should silently no-op when disabled', () => {
      initializePostHog({ apiKey: 'phc_test_identify_disabled', disabled: true })

      identifyUser('user_disabled', { tier: 'pro' })

      expect(mocks.identify).not.toHaveBeenCalled()
    })

    it('should handle identify errors gracefully', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      mocks.identify.mockImplementationOnce(() => {
        throw new Error('Identify failed')
      })

      initializePostHog({ apiKey: 'phc_test_identify_error' })

      expect(() => {
        identifyUser('user_error', { tier: 'free' })
      }).not.toThrow()

      expect(debugSpy).toHaveBeenCalledWith('[PostHog] Failed to identify user:', expect.any(Error))

      debugSpy.mockRestore()
    })
  })

  describe('ALLOWED_TRAITS', () => {
    it('should contain only safe, non-PII properties', () => {
      expect(ALLOWED_TRAITS).toEqual(['tier', 'version', 'platform', 'sdk_version'])
    })

    it('should not contain any PII fields', () => {
      const piiFields = [
        'email',
        'name',
        'first_name',
        'last_name',
        'phone',
        'address',
        'ip',
        'ip_address',
        'user_id',
        'username',
      ]

      for (const pii of piiFields) {
        expect(ALLOWED_TRAITS).not.toContain(pii)
      }
    })
  })

  describe('isFeatureFlagEnabled', () => {
    it('should return true when flag is enabled', async () => {
      initializePostHog({ apiKey: 'phc_test_ff_enabled' })
      mocks.isFeatureEnabled.mockResolvedValueOnce(true)

      const result = await isFeatureFlagEnabled('user_ff', 'new_search_ui')

      expect(result).toBe(true)
      expect(mocks.isFeatureEnabled).toHaveBeenCalledWith('new_search_ui', 'user_ff')
    })

    it('should return false when flag is disabled', async () => {
      initializePostHog({ apiKey: 'phc_test_ff_disabled' })
      mocks.isFeatureEnabled.mockResolvedValueOnce(false)

      const result = await isFeatureFlagEnabled('user_ff_2', 'beta_feature')

      expect(result).toBe(false)
    })

    it('should track feature flag evaluation event', async () => {
      initializePostHog({ apiKey: 'phc_test_ff_track' })
      mocks.isFeatureEnabled.mockResolvedValueOnce(true)

      await isFeatureFlagEnabled('user_ff_track', 'tracked_flag')

      expect(mocks.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: 'user_ff_track',
          event: 'feature_flag_evaluated',
          properties: expect.objectContaining({
            flag_key: 'tracked_flag',
            flag_value: true,
          }),
        })
      )
    })

    it('should return false when PostHog is disabled', async () => {
      initializePostHog({ apiKey: 'phc_test_ff_noop', disabled: true })

      const result = await isFeatureFlagEnabled('user_disabled', 'any_flag')

      expect(result).toBe(false)
      expect(mocks.isFeatureEnabled).not.toHaveBeenCalled()
    })

    it('should return false when not initialized', async () => {
      const result = await isFeatureFlagEnabled('user_uninit', 'any_flag')

      expect(result).toBe(false)
    })

    it('should handle null/undefined from PostHog', async () => {
      initializePostHog({ apiKey: 'phc_test_ff_null' })
      mocks.isFeatureEnabled.mockResolvedValueOnce(null)

      const result = await isFeatureFlagEnabled('user_null', 'null_flag')

      expect(result).toBe(false)
    })

    it('should return false on error', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      initializePostHog({ apiKey: 'phc_test_ff_error' })
      mocks.isFeatureEnabled.mockRejectedValueOnce(new Error('Network error'))

      const result = await isFeatureFlagEnabled('user_error', 'error_flag')

      expect(result).toBe(false)
      expect(debugSpy).toHaveBeenCalledWith(
        '[PostHog] Failed to check feature flag:',
        expect.any(Error)
      )

      debugSpy.mockRestore()
    })
  })

  describe('flushPostHog', () => {
    it('should flush pending events', async () => {
      initializePostHog({ apiKey: 'phc_test_flush' })

      await flushPostHog()

      expect(mocks.flush).toHaveBeenCalled()
    })

    it('should no-op when not initialized', async () => {
      await flushPostHog()

      expect(mocks.flush).not.toHaveBeenCalled()
    })

    it('should handle flush errors gracefully', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      mocks.flush.mockRejectedValueOnce(new Error('Flush failed'))

      initializePostHog({ apiKey: 'phc_test_flush_error' })

      await expect(flushPostHog()).resolves.toBeUndefined()

      expect(debugSpy).toHaveBeenCalledWith('[PostHog] Failed to flush events:', expect.any(Error))

      debugSpy.mockRestore()
    })
  })

  describe('shutdownPostHog', () => {
    it('should shutdown and reset state', async () => {
      initializePostHog({ apiKey: 'phc_test_shutdown' })
      expect(isPostHogEnabled()).toBe(true)

      await shutdownPostHog()

      expect(mocks.shutdown).toHaveBeenCalled()
      expect(getPostHog()).toBeNull()
      expect(isPostHogEnabled()).toBe(false)
    })

    it('should no-op when not initialized', async () => {
      await shutdownPostHog()

      expect(mocks.shutdown).not.toHaveBeenCalled()
    })

    it('should handle shutdown errors gracefully', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      mocks.shutdown.mockRejectedValueOnce(new Error('Shutdown failed'))

      initializePostHog({ apiKey: 'phc_test_shutdown_error' })

      await expect(shutdownPostHog()).resolves.toBeUndefined()

      expect(debugSpy).toHaveBeenCalledWith('[PostHog] Failed to shutdown:', expect.any(Error))

      debugSpy.mockRestore()
    })

    it('should allow re-initialization after shutdown', async () => {
      initializePostHog({ apiKey: 'phc_test_reinit_1' })
      expect(isPostHogEnabled()).toBe(true)

      await shutdownPostHog()
      expect(isPostHogEnabled()).toBe(false)

      initializePostHog({ apiKey: 'phc_test_reinit_2' })
      expect(isPostHogEnabled()).toBe(true)
    })
  })

  describe('integration scenarios', () => {
    it('should handle full lifecycle correctly', async () => {
      // Initialize
      initializePostHog({ apiKey: 'phc_test_lifecycle' })
      expect(isPostHogEnabled()).toBe(true)

      // Track events
      trackEvent('user_1', 'skill_search', { query: 'test' })
      trackSkillView('user_1', 'test/skill', 'cli')
      trackSkillInstall('user_1', 'test/skill', 'cli')

      // Identify user
      identifyUser('user_1', { tier: 'pro', platform: 'darwin' })

      // Check feature flag
      mocks.isFeatureEnabled.mockResolvedValueOnce(true)
      const flagEnabled = await isFeatureFlagEnabled('user_1', 'beta')
      expect(flagEnabled).toBe(true)

      // Flush and shutdown
      await flushPostHog()
      await shutdownPostHog()

      expect(mocks.capture).toHaveBeenCalledTimes(4) // 3 events + 1 flag evaluation
      expect(mocks.identify).toHaveBeenCalledTimes(1)
      expect(mocks.flush).toHaveBeenCalledTimes(1)
      expect(mocks.shutdown).toHaveBeenCalledTimes(1)
    })

    it('should gracefully handle all operations when disabled', async () => {
      initializePostHog({ apiKey: 'phc_disabled', disabled: true })

      // All operations should silently no-op
      trackEvent('user', 'event')
      trackSkillSearch('user', 'query', 0, 0)
      trackSkillView('user', 'skill', 'cli')
      trackSkillInstall('user', 'skill', 'cli')
      trackApiError('user', 'ERR', '/api')
      identifyUser('user', { tier: 'free' })
      const flag = await isFeatureFlagEnabled('user', 'flag')

      expect(flag).toBe(false)
      expect(mocks.capture).not.toHaveBeenCalled()
      expect(mocks.identify).not.toHaveBeenCalled()
      expect(mocks.isFeatureEnabled).not.toHaveBeenCalled()
    })
  })
})
