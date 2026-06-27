/**
 * @fileoverview Terminal/CLI formatting helpers for get_skill responses.
 * @module @skillsmith/mcp-server/tools/get-skill.format
 *
 * SMI-5360: split out of get-skill.ts to keep that file under the 500-line
 * limit. These are pure presentation helpers — no I/O, no ToolContext.
 */

import {
  type GetSkillResponse,
  type MCPTrustTier as TrustTier,
  TrustTierDescriptions,
} from '@skillsmith/core'

/**
 * Format skill details for terminal/CLI display.
 *
 * Produces a comprehensive human-readable string including:
 * - Basic info (ID, author, version, category)
 * - Full description
 * - Trust tier with explanation
 * - Visual score breakdown bars
 * - Repository and tags
 * - Installation command
 *
 * @param response - Get skill response from executeGetSkill
 * @returns Formatted string suitable for terminal output
 *
 * @example
 * const response = await executeGetSkill({ id: 'getsentry/commit' });
 * console.log(formatSkillDetails(response));
 * // Output:
 * // === commit ===
 * // ID: getsentry/commit
 * // Author: getsentry
 * // Version: 1.2.0
 * // ...
 */
export function formatSkillDetails(response: GetSkillResponse): string {
  const skill = response.skill
  const lines: string[] = []

  lines.push('\n=== ' + skill.name + ' ===\n')

  // Basic info
  lines.push('ID: ' + skill.id)
  lines.push('Author: ' + skill.author)
  lines.push('Version: ' + (skill.version || 'N/A'))
  lines.push('Category: ' + skill.category)
  // SMI-4954: surface installability so callers don't try to install a
  // discovery-only entry that install_skill cannot resolve.
  // SMI-5360: installable only flips false for quarantine, so a skill that
  // carries a repository but is still not installable is quarantine-blocked,
  // NOT discovery-only — say so rather than printing the misleading
  // "discovery-only entry" reason.
  if (skill.installable === false) {
    if (skill.repository) {
      lines.push('Installable: NO — blocked (quarantined; install_skill will refuse this)')
    } else {
      lines.push('Installable: NO — discovery-only entry (install_skill will not resolve this)')
    }
  } else if (skill.installable === true) {
    lines.push('Installable: yes')
  }
  lines.push('')

  // Description
  lines.push('Description:')
  lines.push('  ' + skill.description)
  lines.push('')

  // Trust tier with explanation
  lines.push('Trust Tier: ' + formatTrustTier(skill.trustTier))
  lines.push('  ' + TrustTierDescriptions[skill.trustTier])
  lines.push('')

  // Score breakdown
  lines.push('Overall Score: ' + skill.score + '/100')
  if (skill.scoreBreakdown) {
    lines.push('Score Breakdown:')
    lines.push('  Quality:       ' + formatScoreBar(skill.scoreBreakdown.quality))
    lines.push('  Popularity:    ' + formatScoreBar(skill.scoreBreakdown.popularity))
    lines.push('  Maintenance:   ' + formatScoreBar(skill.scoreBreakdown.maintenance))
    lines.push('  Security:      ' + formatScoreBar(skill.scoreBreakdown.security))
    lines.push('  Documentation: ' + formatScoreBar(skill.scoreBreakdown.documentation))
  }
  lines.push('')

  // Repository
  if (skill.repository) {
    lines.push('Repository: ' + skill.repository)
  }

  // SMI-5327: License — null / whitespace-only means "unknown / not detected", NOT "no license".
  lines.push('License: ' + (skill.license?.trim() || 'Unknown'))

  // Tags
  if (skill.tags && skill.tags.length > 0) {
    lines.push('Tags: ' + skill.tags.join(', '))
  }
  lines.push('')

  // SMI-825: Security information
  lines.push('--- Security ---')
  if (skill.security) {
    if (skill.security.passed === null) {
      lines.push('  Status: Not scanned')
    } else if (skill.security.passed) {
      lines.push('  Status: PASSED')
      lines.push('  Risk Score: ' + (skill.security.riskScore ?? 0) + '/100')
      lines.push('  Findings: ' + (skill.security.findingsCount ?? 0))
    } else {
      lines.push('  Status: FAILED')
      lines.push('  Risk Score: ' + (skill.security.riskScore ?? 0) + '/100 (HIGH)')
      lines.push('  Findings: ' + (skill.security.findingsCount ?? 0))
      lines.push('  WARNING: This skill has security issues. Review carefully before use.')
    }
    if (skill.security.scannedAt) {
      lines.push('  Scanned: ' + skill.security.scannedAt)
    }
  } else {
    lines.push('  Status: Not scanned')
  }
  lines.push('')

  // SMI-3137: Dependency intelligence
  if (response.dependencies && response.dependencies.length > 0) {
    lines.push('--- Dependencies ---')
    for (const dep of response.dependencies) {
      const version = dep.dep_version ? '@' + dep.dep_version : ''
      const source = dep.dep_source === 'declared' ? '' : ' (inferred)'
      lines.push('  [' + dep.dep_type + '] ' + dep.dep_target + version + source)
    }
    lines.push('')
  }

  // SMI-2761: Co-install recommendations
  if (response.also_installed && response.also_installed.length > 0) {
    lines.push('--- Users Also Installed ---')
    for (const co of response.also_installed) {
      lines.push('  ' + co.skillId + (co.description ? ' — ' + co.description : ''))
    }
    lines.push('')
  }

  // SMI-3672: Skill content (SKILL.md)
  if (response.content) {
    lines.push('--- Skill Content ---')
    lines.push(response.content)
    lines.push('')
  }

  // Installation
  lines.push('--- Installation ---')
  lines.push('  ' + response.installCommand)
  lines.push('')

  // Timing
  lines.push('---')
  lines.push('Retrieved in ' + response.timing.totalMs + 'ms')

  return lines.join('\n')
}

/**
 * Format trust tier with visual indicator
 * SMI-1809: Added 'local' tier
 * SMI-2381 / SMI-4520: Added 'curated' tier
 * SMI-5205: Added 'official' and 'unverified' tiers
 */
function formatTrustTier(tier: TrustTier): string {
  switch (tier) {
    case 'official':
      return '[!] OFFICIAL' // SMI-5205: Platform/partner with full security review
    case 'verified':
      return '[*] VERIFIED'
    case 'community':
      return '[+] COMMUNITY'
    case 'curated':
      return '[#] CURATED' // SMI-2381: Third-party publisher
    case 'local':
      return '[@] LOCAL' // SMI-1809: Local skills from ~/.claude/skills/
    case 'experimental':
      return '[~] EXPERIMENTAL'
    case 'unknown':
      return '[?] UNKNOWN'
    case 'unverified':
      return '[?] UNVERIFIED' // SMI-5205: Public alias for unknown
  }
}

/**
 * Format score as a visual bar
 */
function formatScoreBar(score: number): string {
  const filled = Math.round(score / 10)
  const empty = 10 - filled
  const bar = '='.repeat(filled) + '-'.repeat(empty)
  return '[' + bar + '] ' + score + '/100'
}
