/**
 * SMI-2201: Filter validation and dry-run preview for the
 * Batch Skill Transformation CLI.
 *
 * Extracted from batch-transform-skills.ts (SMI-4935) to keep each module
 * under the 500-line limit. See batch-transform-skills.ts for the entrypoint.
 */

import { type SupabaseClient } from '@supabase/supabase-js'
import type { CliOptions } from './batch-transform-skills.types'
import { loadBatchTransformCheckpoint } from './batch-transform-skills.checkpoint'

const VALID_TRUST_TIERS = ['verified', 'community', 'experimental', 'unknown'] as const

/**
 * Validate ISO-8601 date format (YYYY-MM-DD)
 */
function isValidIsoDate(dateStr: string): boolean {
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (!isoDateRegex.test(dateStr)) return false

  const date = new Date(dateStr)
  return !isNaN(date.getTime())
}

/**
 * Validate filter options and return errors if any
 */
export function validateFilters(options: CliOptions): string[] {
  const errors: string[] = []

  // Validate --since format
  if (options.since && !isValidIsoDate(options.since)) {
    errors.push(`Invalid date format '${options.since}'. Use ISO-8601: --since 2026-01-25`)
  }

  // Validate --trust-tier value
  if (
    options.trustTier &&
    !VALID_TRUST_TIERS.includes(options.trustTier as (typeof VALID_TRUST_TIERS)[number])
  ) {
    errors.push(
      `Invalid trust tier '${options.trustTier}'. Valid values: ${VALID_TRUST_TIERS.join(', ')}`
    )
  }

  // Warn about incompatible combinations
  if (options.retryFailed && options.retrySkipped) {
    errors.push('--retry-failed and --retry-skipped are mutually exclusive')
  }

  if ((options.retryFailed || options.retrySkipped) && options.onlyMissing) {
    errors.push('--retry-failed/--retry-skipped and --only-missing are mutually exclusive')
  }

  return errors
}

/**
 * Check if any filters are active
 */
export function hasActiveFilters(options: CliOptions): boolean {
  return (
    options.retryFailed ||
    options.retrySkipped ||
    options.onlyMissing ||
    !!options.since ||
    !!options.trustTier ||
    options.monorepoSkills
  )
}

/**
 * Get filter counts for preview (dry-run)
 */
export async function getFilterPreview(
  supabase: SupabaseClient,
  options: CliOptions
): Promise<{ total: number; breakdown: Record<string, number> }> {
  const breakdown: Record<string, number> = {}

  // Get total skills with repo_url
  const { count: totalCount } = await supabase
    .from('skills')
    .select('id', { count: 'exact', head: true })
    .not('repo_url', 'is', null)

  breakdown['Total skills (with repo_url)'] = totalCount ?? 0

  // Filter: --trust-tier
  if (options.trustTier) {
    const { count } = await supabase
      .from('skills')
      .select('id', { count: 'exact', head: true })
      .not('repo_url', 'is', null)
      .eq('trust_tier', options.trustTier)
    breakdown[`Trust tier = ${options.trustTier}`] = count ?? 0
  }

  // Filter: --since
  if (options.since) {
    const { count } = await supabase
      .from('skills')
      .select('id', { count: 'exact', head: true })
      .not('repo_url', 'is', null)
      .gte('created_at', options.since)
    breakdown[`Indexed since ${options.since}`] = count ?? 0
  }

  // Filter: --monorepo-skills (URLs containing /tree/)
  if (options.monorepoSkills) {
    const { count } = await supabase
      .from('skills')
      .select('id', { count: 'exact', head: true })
      .not('repo_url', 'is', null)
      .like('repo_url', '%/tree/%')
    breakdown['Monorepo skills (/tree/ URLs)'] = count ?? 0
  }

  // Filter: --only-missing
  if (options.onlyMissing) {
    const { count } = await supabase
      .from('skills')
      .select('id', { count: 'exact', head: true })
      .not('repo_url', 'is', null)
      .is('skill_transformations.skill_id', null)
    breakdown['Missing transformations'] = count ?? 0
  }

  // Filter: --retry-failed (from checkpoint)
  if (options.retryFailed) {
    const checkpoint = loadBatchTransformCheckpoint()
    if (checkpoint?.failedSkillIds?.length) {
      breakdown['Failed in previous run'] = checkpoint.failedSkillIds.length
    } else {
      breakdown['Failed in previous run'] = 0
    }
  }

  // Filter: --retry-skipped (from checkpoint)
  if (options.retrySkipped) {
    const checkpoint = loadBatchTransformCheckpoint()
    if (checkpoint?.skippedSkillIds?.length) {
      breakdown['Skipped in previous run'] = checkpoint.skippedSkillIds.length
    } else {
      breakdown['Skipped in previous run'] = 0
    }
  }

  // Calculate combined count (simplified - actual query does intersection)
  let combinedCount = totalCount ?? 0
  if (options.trustTier)
    combinedCount = Math.min(combinedCount, breakdown[`Trust tier = ${options.trustTier}`])
  if (options.since)
    combinedCount = Math.min(combinedCount, breakdown[`Indexed since ${options.since}`])
  if (options.monorepoSkills)
    combinedCount = Math.min(combinedCount, breakdown['Monorepo skills (/tree/ URLs)'])
  if (options.onlyMissing)
    combinedCount = Math.min(combinedCount, breakdown['Missing transformations'])
  if (options.retryFailed) combinedCount = breakdown['Failed in previous run']
  if (options.retrySkipped) combinedCount = breakdown['Skipped in previous run']

  return { total: combinedCount, breakdown }
}

/**
 * Print filter preview for dry-run mode
 */
export function printFilterPreview(breakdown: Record<string, number>, total: number): void {
  console.log('\nFilters applied:')
  console.log('-'.repeat(50))
  for (const [filter, count] of Object.entries(breakdown)) {
    console.log(`  ${filter}: ${count} skills`)
  }
  console.log('-'.repeat(50))
  console.log(`  Combined: ${total} skills to process`)
  console.log('')
}
