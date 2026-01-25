// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2025 Smith Horn Group Ltd

/**
 * SMI-1091: Quota Types - Type definitions for quota enforcement
 *
 * Extracted from quota.ts to reduce file size.
 *
 * @see quota.ts for main middleware implementation
 */

import type { LicenseInfo } from './license.js'
import type { MCPErrorResponse } from './errorFormatter.js'

/**
 * Warning threshold type for quota levels
 */
export type WarningLevel = 0 | 80 | 90 | 100

/**
 * Quota check result returned after validating usage
 */
export interface QuotaCheckResult {
  /** Whether the tool call is allowed */
  allowed: boolean
  /** Remaining API calls in the current period */
  remaining: number
  /** Total limit for the current tier (-1 for unlimited) */
  limit: number
  /** Percentage of quota used (0-100+) */
  percentUsed: number
  /** Current warning level (0, 80, 90, or 100) */
  warningLevel: WarningLevel
  /** When the quota resets (start of next billing period) */
  resetAt: Date
  /** Warning or error message if applicable */
  message?: string
  /** Upgrade URL if quota is exceeded or near limit */
  upgradeUrl?: string
}

/**
 * Quota information to include in response metadata
 */
export interface QuotaMetadata {
  /** Remaining API calls */
  remaining: number
  /** Total limit (-1 for unlimited) */
  limit: number
  /** When the quota resets */
  resetAt: string
  /** Warning message if approaching limit */
  warning?: string
}

/**
 * Interface for quota storage adapters
 */
export interface QuotaStorage {
  /** Get current usage for a customer in the current period */
  getUsage(customerId: string): Promise<{ used: number; periodStart: Date; periodEnd: Date }>
  /** Increment usage count */
  incrementUsage(customerId: string, cost: number): Promise<void>
  /** Initialize quota for a new billing period */
  initializePeriod(customerId: string, limit: number): Promise<void>
}

/**
 * Quota middleware configuration options
 */
export interface QuotaMiddlewareOptions {
  /**
   * Cost of each API call (default: 1)
   * Can be customized per tool if some tools are more expensive
   */
  defaultCost?: number

  /**
   * Whether to track usage even for unlimited tiers (enterprise)
   * Useful for analytics purposes
   */
  trackUnlimited?: boolean

  /**
   * Custom storage adapter for quota tracking
   * If not provided, uses in-memory storage (resets on restart)
   */
  storage?: QuotaStorage
}

/**
 * Quota middleware instance
 */
export interface QuotaMiddleware {
  /**
   * Check if a tool call is allowed and track usage
   * Call this BEFORE executing the tool
   */
  checkAndTrack(
    toolName: string,
    licenseInfo: LicenseInfo | null,
    customerId?: string
  ): Promise<QuotaCheckResult>

  /**
   * Get current quota status without incrementing
   */
  getStatus(licenseInfo: LicenseInfo | null, customerId?: string): Promise<QuotaCheckResult>

  /**
   * Build quota metadata for response _meta field
   */
  buildMetadata(result: QuotaCheckResult): QuotaMetadata

  /**
   * Build error response for quota exceeded
   */
  buildExceededResponse(result: QuotaCheckResult): MCPErrorResponse
}
