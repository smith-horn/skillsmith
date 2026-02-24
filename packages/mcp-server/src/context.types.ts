/**
 * @fileoverview Tool Context Type Definitions
 * @module @skillsmith/mcp-server/context.types
 * @see SMI-2741: Split from context.ts to meet 500-line standard
 *
 * Shared type definitions used by both sync (context.ts) and
 * async (context.async.ts) context creation modules.
 */

import type {
  SearchService,
  SkillRepository,
  SkillsmithApiClient,
  BackgroundSyncService,
  DatabaseType,
  ApiClientConfig,
} from '@skillsmith/core'
import type { LLMFailoverChain, LLMFailoverConfig } from './llm/failover.js'

/**
 * Shared context for MCP tool handlers
 * SMI-1183: Added apiClient for live API access with local fallback
 * SMI-1184: Added distinctId for telemetry tracking
 * SMI-1524: Added llmFailover for multi-LLM support with circuit breaker
 */
export interface ToolContext {
  /** SQLite database connection */
  db: DatabaseType
  /** Search service with FTS5/BM25 (fallback) */
  searchService: SearchService
  /** Skill repository for CRUD operations (fallback) */
  skillRepository: SkillRepository
  /** API client for live Supabase API (primary) */
  apiClient: SkillsmithApiClient
  /** Anonymous user ID for telemetry (undefined if telemetry disabled) */
  distinctId?: string
  /** Background sync service (if enabled) */
  backgroundSync?: BackgroundSyncService
  /** LLM failover chain for multi-provider support (SMI-1524) */
  llmFailover?: LLMFailoverChain
  /** Internal: Signal handlers for cleanup (prevents memory leaks) */
  _signalHandlers?: Array<{ signal: NodeJS.Signals; handler: () => void }>
}

/**
 * Telemetry configuration for PostHog (SMI-1184)
 * Privacy-first: disabled by default (opt-in)
 */
export interface TelemetryConfig {
  /**
   * Enable telemetry collection (default: false for privacy)
   * Can also be set via SKILLSMITH_TELEMETRY_ENABLED env var
   */
  enabled?: boolean
  /**
   * PostHog API key (starts with phc_)
   * Can also be set via POSTHOG_API_KEY env var
   */
  postHogApiKey?: string
  /**
   * PostHog host URL (default: https://app.posthog.com)
   */
  postHogHost?: string
}

/**
 * Background sync configuration
 */
export interface BackgroundSyncConfig {
  /**
   * Enable background sync during MCP server sessions
   * Can also be set via SKILLSMITH_BACKGROUND_SYNC env var
   * Default: true (syncs if config.enabled is true)
   */
  enabled?: boolean
  /**
   * Enable debug logging for sync operations
   */
  debug?: boolean
}

/**
 * Options for creating tool context
 */
export interface ToolContextOptions {
  /** Custom database path (defaults to ~/.skillsmith/skills.db) */
  dbPath?: string
  /** Search cache TTL in seconds (default: 300) */
  searchCacheTtl?: number
  /** API client configuration (SMI-1183) */
  apiClientConfig?: ApiClientConfig
  /**
   * API key for authenticated requests
   * Can also be set via SKILLSMITH_API_KEY env var
   * SMI-XXXX: API Key Authentication
   */
  apiKey?: string
  /**
   * Telemetry configuration (SMI-1184)
   * Privacy-first: telemetry is OPT-IN and disabled by default
   */
  telemetryConfig?: TelemetryConfig
  /**
   * Background sync configuration
   * Enables automatic registry sync during MCP server sessions
   */
  backgroundSyncConfig?: BackgroundSyncConfig
  /**
   * LLM failover chain configuration (SMI-1524)
   * Enables multi-provider LLM support with automatic failover
   * Disabled by default - set enabled: true to activate
   */
  llmFailoverConfig?: LLMFailoverConfig
}
