/**
 * @fileoverview Testing Module Exports
 * @module @skillsmith/core/testing
 *
 * Exports for skill testing and multi-LLM provider support.
 */

// Multi-LLM Provider (SMI-1523)
export {
  MultiLLMProvider,
  createMultiLLMProvider,
  DEFAULT_MULTI_LLM_CONFIG,
  type LLMProviderType,
  type ProviderPriority,
  type LoadBalanceStrategy,
  type FailoverCondition,
  type ProviderConfig,
  type FallbackRule,
  type FallbackStrategy,
  type CircuitBreakerConfig,
  type MultiLLMProviderConfig,
  type HealthCheckResult,
  type ProviderStatus,
  type LLMRequest,
  type LLMResponse,
  type ProviderMetrics,
  type SkillCompatibilityResult,
} from './MultiLLMProvider.js'
