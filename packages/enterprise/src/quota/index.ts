// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2025 Smith Horn Group Ltd

/**
 * Quota Management Module
 *
 * Exports quota enforcement services and utilities for
 * managing API call limits per license tier.
 */

export {
  QuotaEnforcementService,
  createQuotaEnforcementService,
  type QuotaCheckResult,
  type UsageSummary,
} from './QuotaEnforcementService.js'
