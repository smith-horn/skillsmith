/**
 * @fileoverview LLMFailoverChain Unit Tests
 * @see SMI-1524: Implement LLM failover with circuit breaker
 *
 * Tests for the MCP server LLM failover chain including:
 * - Initialization and configuration
 * - Health check endpoints
 * - Failover timeout compliance (3 seconds)
 * - Circuit breaker thresholds (5 failures, 60s reset)
 * - Provider management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  LLMFailoverChain,
  createLLMFailoverChain,
  DEFAULT_LLM_FAILOVER_CONFIG,
  type LLMFailoverConfig,
} from '../../llm/failover.js'

describe('LLMFailoverChain', () => {
  let chain: LLMFailoverChain

  afterEach(() => {
    if (chain) {
      chain.close()
    }
  })

  describe('Initialization', () => {
    it('should create with default configuration', () => {
      chain = new LLMFailoverChain()
      expect(chain.isInitialized()).toBe(false)
      expect(chain.isEnabled()).toBe(true)
    })

    it('should initialize successfully', async () => {
      chain = new LLMFailoverChain()
      await chain.initialize()
      expect(chain.isInitialized()).toBe(true)
    })

    it('should only initialize once', async () => {
      chain = new LLMFailoverChain()
      await chain.initialize()
      await chain.initialize() // Should be idempotent
      expect(chain.isInitialized()).toBe(true)
    })

    it('should use factory function', async () => {
      chain = await createLLMFailoverChain()
      expect(chain.isInitialized()).toBe(true)
      expect(chain.isEnabled()).toBe(true)
    })

    it('should disable via config', async () => {
      chain = new LLMFailoverChain({ enabled: false })
      await chain.initialize()
      expect(chain.isInitialized()).toBe(true)
      expect(chain.isEnabled()).toBe(false)
    })

    it('should disable via environment variable', async () => {
      const originalEnv = process.env.SKILLSMITH_LLM_FAILOVER_ENABLED
      process.env.SKILLSMITH_LLM_FAILOVER_ENABLED = 'false'

      chain = new LLMFailoverChain()
      expect(chain.isEnabled()).toBe(false)

      process.env.SKILLSMITH_LLM_FAILOVER_ENABLED = originalEnv
    })
  })

  describe('Configuration', () => {
    it('should have correct default failover timeout (3 seconds)', () => {
      expect(DEFAULT_LLM_FAILOVER_CONFIG.failoverTimeoutMs).toBe(3000)
    })

    it('should have correct default circuit open threshold (5 failures)', () => {
      expect(DEFAULT_LLM_FAILOVER_CONFIG.circuitOpenThreshold).toBe(5)
    })

    it('should have correct default circuit reset timeout (60 seconds)', () => {
      expect(DEFAULT_LLM_FAILOVER_CONFIG.circuitResetTimeoutMs).toBe(60000)
    })

    it('should apply custom configuration', async () => {
      const customConfig: LLMFailoverConfig = {
        failoverTimeoutMs: 5000,
        circuitOpenThreshold: 10,
        circuitResetTimeoutMs: 120000,
        debug: true,
      }

      chain = new LLMFailoverChain(customConfig)
      await chain.initialize()
      expect(chain.isInitialized()).toBe(true)
    })
  })

  describe('Health Check Endpoint (SMI-1524 Acceptance Criteria)', () => {
    beforeEach(async () => {
      chain = await createLLMFailoverChain()
    })

    it('should provide health status endpoint', async () => {
      const health = await chain.getHealthStatus()

      expect(health).toMatchObject({
        healthy: expect.any(Boolean),
        timestamp: expect.any(Date),
        availableProviders: expect.any(Number),
        enabledProviders: expect.any(Number),
        errorRate: expect.any(Number),
        avgLatencyMs: expect.any(Number),
      })
    })

    it('should include per-provider health', async () => {
      const health = await chain.getHealthStatus()
      const enabledProviders = chain.getEnabledProviders()

      // Should have health info for each enabled provider
      for (const provider of enabledProviders) {
        expect(health.providers[provider]).toBeDefined()
        expect(health.circuitStates[provider]).toBeDefined()
      }
    })

    it('should report circuit breaker states', async () => {
      const health = await chain.getHealthStatus()
      const enabledProviders = chain.getEnabledProviders()

      for (const provider of enabledProviders) {
        expect(['closed', 'open', 'half-open']).toContain(health.circuitStates[provider])
      }
    })

    it('should check specific provider health', async () => {
      const result = await chain.healthCheck('anthropic')

      expect(result).toMatchObject({
        healthy: expect.any(Boolean),
        timestamp: expect.any(Date),
      })
    })
  })

  describe('Provider Management', () => {
    beforeEach(async () => {
      chain = await createLLMFailoverChain()
    })

    it('should return enabled providers', () => {
      const enabled = chain.getEnabledProviders()
      expect(enabled).toContain('anthropic')
      expect(enabled).toContain('openai')
      expect(enabled).toContain('google')
    })

    it('should return available providers', () => {
      const available = chain.getAvailableProviders()
      expect(available.length).toBeGreaterThan(0)
    })

    it('should return provider status', () => {
      const status = chain.getProviderStatus('anthropic')
      expect(status).not.toBeNull()
      expect(status).toMatchObject({
        available: expect.any(Boolean),
        circuitState: expect.any(String),
      })
    })

    it('should return null status when disabled', async () => {
      const disabledChain = await createLLMFailoverChain({ enabled: false })
      const status = disabledChain.getProviderStatus('anthropic')
      expect(status).toBeNull()
      disabledChain.close()
    })
  })

  describe('Request Completion', () => {
    beforeEach(async () => {
      chain = await createLLMFailoverChain()
    })

    it('should throw if not initialized', async () => {
      const uninitializedChain = new LLMFailoverChain()

      await expect(
        uninitializedChain.complete({
          messages: [{ role: 'user', content: 'Hello' }],
        })
      ).rejects.toThrow('not initialized')
    })

    it('should throw if disabled', async () => {
      const disabledChain = await createLLMFailoverChain({ enabled: false })

      await expect(
        disabledChain.complete({
          messages: [{ role: 'user', content: 'Hello' }],
        })
      ).rejects.toThrow('disabled')

      disabledChain.close()
    })

    it('should complete request when enabled', async () => {
      const response = await chain.complete({
        messages: [{ role: 'user', content: 'Test message' }],
      })

      expect(response).toMatchObject({
        content: expect.any(String),
        provider: expect.any(String),
        model: expect.any(String),
        latencyMs: expect.any(Number),
        cost: expect.any(Number),
      })
    })
  })

  describe('Skill Compatibility Testing', () => {
    beforeEach(async () => {
      chain = await createLLMFailoverChain()
    })

    it('should test skill compatibility', async () => {
      const result = await chain.testSkillCompatibility('commit')

      expect(result).toMatchObject({
        skillId: 'commit',
        results: expect.any(Object),
        overallScore: expect.any(Number),
        recommendedProviders: expect.any(Array),
        testedAt: expect.any(Date),
      })
    })

    it('should throw if disabled', async () => {
      const disabledChain = await createLLMFailoverChain({ enabled: false })

      await expect(disabledChain.testSkillCompatibility('commit')).rejects.toThrow('disabled')

      disabledChain.close()
    })
  })

  describe('Metrics Collection', () => {
    beforeEach(async () => {
      chain = await createLLMFailoverChain()
    })

    it('should provide metrics for providers', () => {
      const metrics = chain.getMetrics()
      expect(metrics).toBeInstanceOf(Map)
    })

    it('should return empty map when disabled', async () => {
      const disabledChain = await createLLMFailoverChain({ enabled: false })
      const metrics = disabledChain.getMetrics()
      expect(metrics.size).toBe(0)
      disabledChain.close()
    })
  })

  describe('Close and Cleanup', () => {
    it('should close cleanly', async () => {
      chain = await createLLMFailoverChain()
      expect(() => chain.close()).not.toThrow()
    })

    it('should reset initialized state on close', async () => {
      chain = await createLLMFailoverChain()
      expect(chain.isInitialized()).toBe(true)

      chain.close()

      expect(chain.isInitialized()).toBe(false)
    })

    it('should be safe to close multiple times', async () => {
      chain = await createLLMFailoverChain()
      chain.close()
      expect(() => chain.close()).not.toThrow()
    })
  })
})

describe('DEFAULT_LLM_FAILOVER_CONFIG', () => {
  it('should have SMI-1524 compliant failover timeout', () => {
    // Acceptance criteria: Failover triggers within 3 seconds
    expect(DEFAULT_LLM_FAILOVER_CONFIG.failoverTimeoutMs).toBe(3000)
  })

  it('should have SMI-1524 compliant circuit breaker threshold', () => {
    // Acceptance criteria: Circuit breaker opens after 5 failures
    expect(DEFAULT_LLM_FAILOVER_CONFIG.circuitOpenThreshold).toBe(5)
  })

  it('should have SMI-1524 compliant circuit reset timeout', () => {
    // Acceptance criteria: Circuit resets after 60 seconds
    expect(DEFAULT_LLM_FAILOVER_CONFIG.circuitResetTimeoutMs).toBe(60000)
  })

  it('should be enabled by default', () => {
    expect(DEFAULT_LLM_FAILOVER_CONFIG.enabled).toBe(true)
  })

  it('should have debug disabled by default', () => {
    expect(DEFAULT_LLM_FAILOVER_CONFIG.debug).toBe(false)
  })
})
