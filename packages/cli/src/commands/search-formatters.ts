/**
 * SMI-744: Search Command Formatters
 *
 * Display and formatting helpers for search results.
 *
 * @module @skillsmith/cli/commands/search-formatters
 */

import chalk from 'chalk'
import Table from 'cli-table3'
import type { SearchResult, TrustTier } from '@skillsmith/core'
import type { TrustTierColors } from './search-types.js'

/**
 * Trust tier color mapping
 */
export const TRUST_TIER_COLORS: TrustTierColors = {
  verified: chalk.green,
  community: chalk.yellow,
  experimental: chalk.red,
  unknown: chalk.gray,
}

/**
 * SMI-825: Format security status for display
 */
export function formatSecurityStatus(skill: SearchResult['skill']): string {
  if (skill.securityPassed === null) {
    return chalk.gray('--')
  }
  if (skill.securityPassed) {
    const riskText = skill.riskScore !== null ? ` (${skill.riskScore})` : ''
    return chalk.green('PASS' + riskText)
  }
  const riskText = skill.riskScore !== null ? ` (${skill.riskScore})` : ''
  return chalk.red('FAIL' + riskText)
}

/**
 * Format a skill result for display with color coding
 */
export function formatSkillRow(result: SearchResult): string[] {
  const { skill } = result
  const colorFn = TRUST_TIER_COLORS[skill.trustTier]
  const score = skill.qualityScore !== null ? (skill.qualityScore * 100).toFixed(0) + '%' : 'N/A'

  return [
    colorFn(skill.name),
    skill.description?.slice(0, 40) || 'No description',
    skill.author || 'Unknown',
    colorFn(skill.trustTier),
    score,
    formatSecurityStatus(skill), // SMI-825: Security status
  ]
}

/**
 * Display search results in a table format
 */
export function displayResults(
  results: SearchResult[],
  total: number,
  offset: number,
  pageSize: number
): void {
  if (results.length === 0) {
    console.log(chalk.yellow('\nNo skills found matching your criteria.\n'))
    return
  }

  const table = new Table({
    head: [
      chalk.bold('Name'),
      chalk.bold('Description'),
      chalk.bold('Author'),
      chalk.bold('Trust Tier'),
      chalk.bold('Quality'),
      chalk.bold('Security'), // SMI-825: Security column
    ],
    colWidths: [20, 42, 18, 13, 10, 12],
    wordWrap: true,
  })

  for (const result of results) {
    table.push(formatSkillRow(result))
  }

  console.log(table.toString())

  const currentPage = Math.floor(offset / pageSize) + 1
  const totalPages = Math.ceil(total / pageSize)
  console.log(
    chalk.dim(
      `\nShowing ${offset + 1}-${offset + results.length} of ${total} results (Page ${currentPage}/${totalPages})`
    )
  )
  console.log(
    chalk.dim('Legend: ') +
      chalk.green('verified') +
      ' | ' +
      chalk.yellow('community') +
      ' | ' +
      chalk.red('experimental')
  )
}

/**
 * Display detailed skill information
 */
export function displaySkillDetails(result: SearchResult): void {
  const { skill } = result

  console.log('\n' + chalk.bold.underline(skill.name) + '\n')

  const colorFn = TRUST_TIER_COLORS[skill.trustTier]

  console.log(chalk.bold('Description: ') + (skill.description || 'No description'))
  console.log(chalk.bold('Author: ') + (skill.author || 'Unknown'))
  console.log(chalk.bold('Trust Tier: ') + colorFn(skill.trustTier))
  console.log(
    chalk.bold('Quality Score: ') +
      (skill.qualityScore !== null ? (skill.qualityScore * 100).toFixed(0) + '%' : 'N/A')
  )
  console.log(chalk.bold('Tags: ') + (skill.tags.length > 0 ? skill.tags.join(', ') : 'None'))
  console.log(chalk.bold('Repository: ') + (skill.repoUrl || 'N/A'))

  // SMI-825: Security information
  console.log(chalk.bold('\nSecurity Status:'))
  if (skill.securityPassed === null) {
    console.log('  Status: ' + chalk.gray('Not scanned'))
  } else if (skill.securityPassed) {
    console.log('  Status: ' + chalk.green('PASSED'))
    console.log('  Risk Score: ' + chalk.green((skill.riskScore ?? 0) + '/100'))
    console.log('  Findings: ' + (skill.securityFindingsCount ?? 0))
  } else {
    console.log('  Status: ' + chalk.red('FAILED'))
    console.log('  Risk Score: ' + chalk.red((skill.riskScore ?? 0) + '/100'))
    console.log('  Findings: ' + chalk.red(skill.securityFindingsCount ?? 0))
  }
  if (skill.securityScannedAt) {
    console.log('  Scanned: ' + skill.securityScannedAt)
  }

  console.log(chalk.bold('\nDates:'))
  console.log('  Created: ' + skill.createdAt)
  console.log('  Updated: ' + skill.updatedAt)
  console.log()
}

/**
 * Get color function for a trust tier
 */
export function getTrustTierColor(tier: TrustTier): (text: string) => string {
  return TRUST_TIER_COLORS[tier]
}
