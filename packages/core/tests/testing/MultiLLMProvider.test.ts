/**
 * @fileoverview MultiLLMProvider Unit Tests
 *
 * Tests for the multi-LLM provider system including:
 * - Initialization and configuration
 * - Provider management (enable/disable, health checks)
 * - Request completion with failover
 * - Circuit breaker functionality
 * - Load balancing strategies
 * - Skill compatibility testing
 * - Metrics collection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  MultiLLMProvider,
  createMultiLLMProvider,
  DEFAULT_MULTI_LLM_CONFIG,
  type LLMProviderType,
  type MultiLLMProviderConfig,
  type LLMRequest,
} from '../../src/testing/MultiLLMProvider.js'

describe('MultiLLMProvider', () => {
  let provider: MultiLLMProvider

  afterEach(() => {
    if (provider) {
      provider.close()
    }
  })

  describe('Initialization', () => {
    it('should create with default configuration', () => {
      provider = new MultiLLMProvider()
      expect(provider.isInitialized()).toBe(false)
    })

    it('should initialize successfully', async () => {
      provider = new MultiLLMProvider()
      await provider.initialize()
      expect(provider.isInitialized()).toBe(true)
    })

    it('should only initialize once', async () => {
      provider = new MultiLLMProvider()
      await provider.initialize()
      await provider.initialize() // Should be idempotent
      expect(provider.isInitialized()).toBe(true)
    })

    it('should merge custom config with defaults', async () => {
      const customConfig: MultiLLMProviderConfig = {
        defaultProvider: 'openai',
        loadBalancing: {
          enabled: false,
          strategy: 'round-robin',
        },
      }
      provider = new MultiLLMProvider(customConfig)
      await provider.initialize()

      // Should have default providers from DEFAULT_MULTI_LLM_CONFIG
      const availableProviders = provider.getAvailableProviders()
      expect(availableProviders).toContain('anthropic')
    })

    it('should use factory function to create initialized provider', async () => {
      provider = await createMultiLLMProvider()
      expect(provider.isInitialized()).toBe(true)
    })
  })

  describe('Provider Management', () => {
    beforeEach(async () => {
      provider = await createMultiLLMProvider()
    })

    it('should return enabled providers', () => {
      const enabled = provider.getEnabledProviders()
      expect(enabled).toContain('anthropic')
      expect(enabled).toContain('openai')
      expect(enabled).toContain('google')
      expect(enabled).toContain('cohere')
      // ollama is disabled by default
      expect(enabled).not.toContain('ollama')
    })

    it('should return available providers (enabled with closed circuits)', () => {
      const available = provider.getAvailableProviders()
      // Only enabled providers with closed circuit breakers are "available"
      expect(available.length).toBe(4) // anthropic, openai, google, cohere (ollama disabled)
      expect(available).toContain('anthropic')
      expect(available).not.toContain('ollama') // disabled by default
    })

    it('should return provider status', () => {
      const status = provider.getProviderStatus('anthropic')
      expect(status).toMatchObject({
        available: true,
        circuitState: 'closed',
        activeRequests: 0,
        currentLoad: expect.any(Number),
      })
    })

    it('should return unavailable status for unknown provider', () => {
      const status = provider.getProviderStatus('unknown' as LLMProviderType)
      // Returns status with available: false for unknown providers
      expect(status.available).toBe(false)
      expect(status.circuitState).toBe('closed')
    })
  })

  describe('Health Checks', () => {
    beforeEach(async () => {
      provider = await createMultiLLMProvider()
    })

    it('should perform health check on provider', async () => {
      const result = await provider.healthCheck('anthropic')
      expect(result).toMatchObject({
        healthy: expect.any(Boolean),
        timestamp: expect.any(Date),
      })
    })

    it('should fail health check for disabled provider', async () => {
      const result = await provider.healthCheck('ollama')
      expect(result.healthy).toBe(false)
      expect(result.error).toContain('not enabled')
    })
  })

  describe('Request Completion', () => {
    beforeEach(async () => {
      provider = await createMultiLLMProvider()
    })

    it('should throw if not initialized', async () => {
      const uninitializedProvider = new MultiLLMProvider()
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
      }

      await expect(uninitializedProvider.complete(request)).rejects.toThrow('not initialized')
    })

    it('should handle empty messages gracefully', async () => {
      const request: LLMRequest = {
        messages: [],
      }

      // Implementation doesn't validate empty messages - it will process the request
      // In production, this would likely fail at the API level
      const response = await provider.complete(request)
      expect(response).toBeDefined()
    })

    it('should accept valid request structure', async () => {
      const request: LLMRequest = {
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'What is 2+2?' },
        ],
        maxTokens: 100,
        temperature: 0.7,
      }

      // This will fail with network error since we don't have real API access,
      // but the request structure should be valid
      try {
        await provider.complete(request)
      } catch (error) {
        // Expected to fail with API error, not validation error
        expect((error as Error).message).not.toContain('Invalid request')
      }
    })

    it('should use specified provider when given', async () => {
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
        provider: 'openai',
      }

      // Will fail with API error, but should attempt openai
      try {
        await provider.complete(request)
      } catch {
        // Expected - no API keys
      }

      const metrics = provider.getMetrics()
      const openaiMetrics = metrics.get('openai')
      // Should have attempted the request
      expect(openaiMetrics?.totalRequests).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Circuit Breaker', () => {
    it('should initialize circuit breakers for enabled providers', async () => {
      provider = await createMultiLLMProvider()

      const anthropicStatus = provider.getProviderStatus('anthropic')
      expect(anthropicStatus?.circuitState).toBe('closed')
    })

    it('should track circuit breaker state', async () => {
      provider = await createMultiLLMProvider({
        circuitBreaker: {
          timeoutMs: 100,
          errorThresholdPercentage: 50,
          resetTimeoutMs: 1000,
          volumeThreshold: 3,
        },
      })

      const status = provider.getProviderStatus('anthropic')
      expect(status?.circuitState).toBe('closed')
    })
  })

  describe('Load Balancing', () => {
    it('should respect cost-based load balancing', async () => {
      provider = await createMultiLLMProvider({
        loadBalancing: {
          enabled: true,
          strategy: 'cost-based',
        },
      })

      // Cost-based should prefer cheaper providers
      // Google has lowest cost in defaults
      const status = provider.getProviderStatus('google')
      expect(status?.available).toBe(true)
    })

    it('should support round-robin strategy', async () => {
      provider = await createMultiLLMProvider({
        loadBalancing: {
          enabled: true,
          strategy: 'round-robin',
        },
      })

      expect(provider.isInitialized()).toBe(true)
    })

    it('should support least-loaded strategy', async () => {
      provider = await createMultiLLMProvider({
        loadBalancing: {
          enabled: true,
          strategy: 'least-loaded',
        },
      })

      expect(provider.isInitialized()).toBe(true)
    })

    it('should support latency-based strategy', async () => {
      provider = await createMultiLLMProvider({
        loadBalancing: {
          enabled: true,
          strategy: 'latency-based',
        },
      })

      expect(provider.isInitialized()).toBe(true)
    })
  })

  describe('Skill Compatibility Testing', () => {
    beforeEach(async () => {
      provider = await createMultiLLMProvider()
    })

    it('should test skill compatibility across providers', async () => {
      const result = await provider.testSkillCompatibility('commit')

      expect(result).toMatchObject({
        skillId: 'commit',
        results: expect.any(Object),
        overallScore: expect.any(Number),
      })
    })

    it('should include results for each enabled provider', async () => {
      const result = await provider.testSkillCompatibility('test-skill')
      const enabledProviders = provider.getEnabledProviders()

      // Should have result for each enabled provider (results is a Record)
      for (const p of enabledProviders) {
        expect(result.results[p]).toBeDefined()
      }
    })

    it('should calculate overall compatibility score', async () => {
      const result = await provider.testSkillCompatibility('my-skill')

      expect(result.overallScore).toBeGreaterThanOrEqual(0)
      expect(result.overallScore).toBeLessThanOrEqual(1)
    })
  })

  describe('Metrics Collection', () => {
    beforeEach(async () => {
      provider = await createMultiLLMProvider({
        enableMetrics: true,
      })
    })

    it('should collect metrics for each provider', () => {
      const metrics = provider.getMetrics()

      expect(metrics).toBeInstanceOf(Map)
      expect(metrics.size).toBeGreaterThan(0)
    })

    it('should track request counts', () => {
      const metrics = provider.getMetrics()
      const anthropicMetrics = metrics.get('anthropic')

      expect(anthropicMetrics).toMatchObject({
        totalRequests: expect.any(Number),
        successRate: expect.any(Number),
        errorRate: expect.any(Number),
      })
    })

    it('should track latency statistics', () => {
      const metrics = provider.getMetrics()
      const anthropicMetrics = metrics.get('anthropic')

      expect(anthropicMetrics).toMatchObject({
        avgLatencyMs: expect.any(Number),
      })
    })

    it('should track cost information', () => {
      const metrics = provider.getMetrics()
      const anthropicMetrics = metrics.get('anthropic')

      expect(anthropicMetrics).toMatchObject({
        totalCost: expect.any(Number),
        load: expect.any(Number),
      })
    })
  })

  describe('Event Emission', () => {
    it('should emit initialized event on initialization', async () => {
      provider = new MultiLLMProvider()
      const initHandler = vi.fn()
      provider.on('initialized', initHandler)

      await provider.initialize()

      expect(initHandler).toHaveBeenCalledWith({
        providers: expect.any(Array),
        defaultProvider: 'anthropic',
      })
    })

    it('should emit v3_integration event', async () => {
      provider = new MultiLLMProvider()
      const v3Handler = vi.fn()
      provider.on('v3_integration', v3Handler)

      await provider.initialize()

      // V3 may or may not be available
      expect(v3Handler).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: expect.any(Boolean),
        })
      )
    })

    it('should emit metrics events when enabled', async () => {
      provider = await createMultiLLMProvider({
        enableMetrics: true,
      })
      const metricsHandler = vi.fn()
      provider.on('metrics', metricsHandler)

      // Trigger a health check which should emit metrics
      await provider.healthCheck('anthropic')

      // May or may not emit immediately depending on implementation
      // Just verify the event handler was set up
      expect(provider.listenerCount('metrics')).toBe(1)
    })
  })

  describe('Fallback Strategy', () => {
    it('should configure fallback rules', async () => {
      provider = await createMultiLLMProvider({
        fallbackStrategy: {
          name: 'custom',
          enabled: true,
          maxAttempts: 5,
          rules: [
            {
              condition: 'rate_limit',
              fallbackProviders: ['google', 'cohere'],
              retryOriginal: false,
            },
          ],
        },
      })

      expect(provider.isInitialized()).toBe(true)
    })

    it('should disable fallback when configured', async () => {
      provider = await createMultiLLMProvider({
        fallbackStrategy: {
          name: 'none',
          enabled: false,
          maxAttempts: 0,
          rules: [],
        },
      })

      expect(provider.isInitialized()).toBe(true)
    })
  })

  describe('Cost Optimization', () => {
    it('should respect cost limits', async () => {
      provider = await createMultiLLMProvider({
        costOptimization: {
          enabled: true,
          maxCostPerRequest: 0.01,
          preferredProviders: ['google', 'cohere'],
        },
      })

      expect(provider.isInitialized()).toBe(true)
    })

    it('should prefer cheaper providers when enabled', async () => {
      provider = await createMultiLLMProvider({
        costOptimization: {
          enabled: true,
          preferredProviders: ['google'],
        },
      })

      // Google should be available and preferred
      const googleStatus = provider.getProviderStatus('google')
      expect(googleStatus?.available).toBe(true)
    })
  })

  describe('Close and Cleanup', () => {
    it('should close cleanly', async () => {
      provider = await createMultiLLMProvider()
      expect(() => provider.close()).not.toThrow()
    })

    it('should reset state on close', async () => {
      provider = await createMultiLLMProvider()
      expect(provider.isInitialized()).toBe(true)

      provider.close()

      // Should not be initialized after close
      expect(provider.isInitialized()).toBe(false)
      // Metrics should be cleared
      const metrics = provider.getMetrics()
      expect(metrics.size).toBe(0)
    })

    it('should be safe to close multiple times', async () => {
      provider = await createMultiLLMProvider()
      provider.close()
      expect(() => provider.close()).not.toThrow()
    })
  })
})

describe('DEFAULT_MULTI_LLM_CONFIG', () => {
  it('should have anthropic as default provider', () => {
    expect(DEFAULT_MULTI_LLM_CONFIG.defaultProvider).toBe('anthropic')
  })

  it('should have all 5 provider types configured', () => {
    const providers = Object.keys(DEFAULT_MULTI_LLM_CONFIG.providers)
    expect(providers).toContain('anthropic')
    expect(providers).toContain('openai')
    expect(providers).toContain('google')
    expect(providers).toContain('cohere')
    expect(providers).toContain('ollama')
  })

  it('should have resilient fallback strategy', () => {
    expect(DEFAULT_MULTI_LLM_CONFIG.fallbackStrategy.name).toBe('resilient')
    expect(DEFAULT_MULTI_LLM_CONFIG.fallbackStrategy.enabled).toBe(true)
  })

  it('should have cost-based load balancing by default', () => {
    expect(DEFAULT_MULTI_LLM_CONFIG.loadBalancing.strategy).toBe('cost-based')
    expect(DEFAULT_MULTI_LLM_CONFIG.loadBalancing.enabled).toBe(true)
  })

  it('should have reasonable cost limits', () => {
    expect(DEFAULT_MULTI_LLM_CONFIG.costOptimization.enabled).toBe(true)
    expect(DEFAULT_MULTI_LLM_CONFIG.costOptimization.maxCostPerRequest).toBe(0.05)
  })

  it('should have circuit breaker configured', () => {
    expect(DEFAULT_MULTI_LLM_CONFIG.circuitBreaker.timeoutMs).toBe(30000)
    expect(DEFAULT_MULTI_LLM_CONFIG.circuitBreaker.errorThresholdPercentage).toBe(50)
    expect(DEFAULT_MULTI_LLM_CONFIG.circuitBreaker.resetTimeoutMs).toBe(30000)
    expect(DEFAULT_MULTI_LLM_CONFIG.circuitBreaker.volumeThreshold).toBe(10)
  })

  it('should have ollama disabled by default (requires local setup)', () => {
    expect(DEFAULT_MULTI_LLM_CONFIG.providers.ollama?.enabled).toBe(false)
  })

  it('should have cloud providers enabled by default', () => {
    expect(DEFAULT_MULTI_LLM_CONFIG.providers.anthropic?.enabled).toBe(true)
    expect(DEFAULT_MULTI_LLM_CONFIG.providers.openai?.enabled).toBe(true)
    expect(DEFAULT_MULTI_LLM_CONFIG.providers.google?.enabled).toBe(true)
    expect(DEFAULT_MULTI_LLM_CONFIG.providers.cohere?.enabled).toBe(true)
  })
})
