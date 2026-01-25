/**
 * SMI-1299: CLI Recommend Command Helpers
 * @module @skillsmith/cli/commands/recommend.helpers
 */

import chalk from 'chalk'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TrustTier, CodebaseContext, FrameworkInfo, DependencyInfo } from '@skillsmith/core'
import type { RecommendResponse, InstalledSkill } from './recommend.types.js'
import { VALID_TRUST_TIERS } from './recommend.types.js'

// Re-export scoring helpers for backwards compatibility
export {
  inferRolesFromTags,
  normalizeSkillName,
  skillsOverlap,
  filterOverlappingSkills,
} from './recommend-scoring.js'

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate and normalize trust tier from API response (SMI-1354)
 */
export function validateTrustTier(tier: unknown): TrustTier {
  if (typeof tier === 'string' && VALID_TRUST_TIERS.includes(tier as TrustTier)) {
    return tier as TrustTier
  }
  return 'unknown'
}

/**
 * Check if error is a network-related error (SMI-1355)
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    return (
      message.includes('fetch failed') ||
      message.includes('network') ||
      message.includes('enotfound') ||
      message.includes('econnrefused') ||
      message.includes('timeout') ||
      message.includes('socket') ||
      error.name === 'AbortError'
    )
  }
  return false
}

// ============================================================================
// Display Helpers
// ============================================================================

/**
 * Get trust badge for display (SMI-1357)
 */
export function getTrustBadge(tier: TrustTier): string {
  switch (tier) {
    case 'verified':
      return chalk.green('[VERIFIED]')
    case 'community':
      return chalk.blue('[COMMUNITY]')
    case 'experimental':
      return chalk.yellow('[EXPERIMENTAL]')
    case 'unknown':
    default:
      return chalk.gray('[UNKNOWN]')
  }
}

/**
 * Format recommendations for terminal display
 */
export function formatRecommendations(
  response: RecommendResponse,
  context: CodebaseContext | null
): string {
  const lines: string[] = []

  lines.push('')
  lines.push(chalk.bold.blue('=== Skill Recommendations ==='))
  lines.push('')

  if (context) {
    if (context.frameworks.length > 0) {
      const frameworks = context.frameworks
        .slice(0, 3)
        .map((f: FrameworkInfo) => f.name)
        .join(', ')
      lines.push(chalk.dim(`Detected: ${frameworks}`))
      lines.push('')
    }
  }

  if (response.recommendations.length === 0) {
    lines.push(chalk.yellow('No recommendations found.'))
    lines.push('')
    lines.push('Suggestions:')
    lines.push('  - Ensure the project has a package.json')
    lines.push('  - Try a project with more dependencies')
    lines.push('  - Use --context to provide additional context')
    if (response.context.role_filter) {
      lines.push(`  - Try removing the --role filter (currently: ${response.context.role_filter})`)
    }
  } else {
    lines.push(`Found ${chalk.bold(response.recommendations.length)} recommendation(s):`)
    lines.push('')

    response.recommendations.forEach((rec, index) => {
      const trustBadge = getTrustBadge(rec.trust_tier)
      const qualityColor =
        rec.quality_score >= 80 ? chalk.green : rec.quality_score >= 50 ? chalk.yellow : chalk.red

      let relevanceDisplay: string
      if (rec.similarity_score < 0) {
        relevanceDisplay = chalk.gray('N/A')
      } else {
        const relevanceColor =
          rec.similarity_score >= 0.7
            ? chalk.green
            : rec.similarity_score >= 0.4
              ? chalk.yellow
              : chalk.gray
        relevanceDisplay = relevanceColor(`${Math.round(rec.similarity_score * 100)}%`)
      }

      const rolesDisplay = rec.roles?.length ? chalk.cyan(` [${rec.roles.join(', ')}]`) : ''
      lines.push(
        `${chalk.bold(`${index + 1}.`)} ${chalk.bold(rec.name)} ${trustBadge}${rolesDisplay}`
      )
      lines.push(
        `   Score: ${qualityColor(`${rec.quality_score}/100`)} | Relevance: ${relevanceDisplay}`
      )
      lines.push(`   ${chalk.dim(rec.reason)}`)
      lines.push(`   ${chalk.dim(`ID: ${rec.skill_id}`)}`)
      lines.push('')
    })
  }

  lines.push(chalk.dim('---'))
  lines.push(chalk.dim(`Candidates considered: ${response.candidates_considered}`))
  if (response.overlap_filtered > 0) {
    lines.push(chalk.dim(`Filtered for overlap: ${response.overlap_filtered}`))
  }
  if (response.role_filtered > 0) {
    lines.push(chalk.dim(`Filtered for role: ${response.role_filtered}`))
  }
  if (response.context.role_filter) {
    lines.push(chalk.dim(`Role filter: ${response.context.role_filter}`))
  }
  if (response.context.auto_detected) {
    lines.push(
      chalk.dim(
        `Installed skills: ${response.context.installed_count} (auto-detected from ~/.claude/skills/)`
      )
    )
  } else {
    lines.push(chalk.dim(`Installed skills: ${response.context.installed_count}`))
  }
  lines.push(chalk.dim(`Completed in ${response.timing.totalMs}ms`))

  return lines.join('\n')
}

/**
 * Format recommendations as JSON
 */
export function formatAsJson(response: RecommendResponse, context: CodebaseContext | null): string {
  const output = {
    recommendations: response.recommendations,
    analysis: context
      ? {
          frameworks: context.frameworks.slice(0, 10).map((f: FrameworkInfo) => ({
            name: f.name,
            confidence: Math.round(f.confidence * 100),
          })),
          dependencies: context.dependencies.slice(0, 20).map((d: DependencyInfo) => ({
            name: d.name,
            is_dev: d.isDev,
          })),
          stats: {
            total_files: context.stats.totalFiles,
            total_lines: context.stats.totalLines,
          },
        }
      : null,
    meta: {
      candidates_considered: response.candidates_considered,
      overlap_filtered: response.overlap_filtered,
      role_filtered: response.role_filtered,
      role_filter: response.context.role_filter ?? null,
      installed_count: response.context.installed_count,
      auto_detected: response.context.auto_detected,
      timing_ms: response.timing.totalMs,
    },
  }

  return JSON.stringify(output, null, 2)
}

/**
 * Format offline analysis results (SMI-1355)
 */
export function formatOfflineResults(context: CodebaseContext, json: boolean): string {
  if (json) {
    return JSON.stringify(
      {
        offline: true,
        analysis: {
          frameworks: context.frameworks.slice(0, 10).map((f: FrameworkInfo) => ({
            name: f.name,
            confidence: Math.round(f.confidence * 100),
          })),
          dependencies: context.dependencies.slice(0, 20).map((d: DependencyInfo) => ({
            name: d.name,
            is_dev: d.isDev,
          })),
          stats: {
            total_files: context.stats.totalFiles,
            total_lines: context.stats.totalLines,
          },
        },
        message: 'Unable to reach Skillsmith API. Showing analysis-only results.',
      },
      null,
      2
    )
  }

  const lines: string[] = []
  lines.push('')
  lines.push(chalk.yellow('⚠ Unable to reach Skillsmith API. Showing analysis-only results.'))
  lines.push('')
  lines.push(chalk.bold.blue('=== Codebase Analysis ==='))
  lines.push('')

  if (context.frameworks.length > 0) {
    lines.push(chalk.bold('Detected Frameworks:'))
    context.frameworks.slice(0, 5).forEach((f: FrameworkInfo) => {
      lines.push(`  - ${f.name} (${Math.round(f.confidence * 100)}% confidence)`)
    })
    lines.push('')
  }

  if (context.dependencies.length > 0) {
    const prodDeps = context.dependencies.filter((d: DependencyInfo) => !d.isDev).slice(0, 10)
    if (prodDeps.length > 0) {
      lines.push(chalk.bold('Key Dependencies:'))
      prodDeps.forEach((d: DependencyInfo) => lines.push(`  - ${d.name}`))
      lines.push('')
    }
  }

  lines.push(chalk.dim('---'))
  lines.push(chalk.dim(`Files analyzed: ${context.stats.totalFiles}`))
  lines.push(chalk.dim(`Total lines: ${context.stats.totalLines.toLocaleString()}`))
  lines.push('')
  lines.push(chalk.cyan('To get skill recommendations, ensure network connectivity and retry.'))

  return lines.join('\n')
}

// ============================================================================
// Stack Building
// ============================================================================

/**
 * Build stack from codebase analysis
 */
export function buildStackFromAnalysis(context: CodebaseContext): string[] {
  const stack: string[] = []

  for (const fw of context.frameworks.slice(0, 5)) {
    stack.push(fw.name.toLowerCase())
  }

  for (const dep of context.dependencies.slice(0, 10)) {
    if (!dep.isDev) {
      stack.push(dep.name.toLowerCase())
    }
  }

  return [...new Set(stack)].slice(0, 10)
}

// ============================================================================
// Installed Skills Detection
// ============================================================================

/**
 * Read installed skills from ~/.claude/skills/ directory (SMI-1358)
 */
export function getInstalledSkills(): InstalledSkill[] {
  const skillsDir = join(homedir(), '.claude', 'skills')

  if (!existsSync(skillsDir)) {
    return []
  }

  const installedSkills: InstalledSkill[] = []

  try {
    const entries = readdirSync(skillsDir)

    for (const entry of entries) {
      const skillPath = join(skillsDir, entry)
      const stat = statSync(skillPath)

      if (!stat.isDirectory()) continue

      const skill: InstalledSkill = {
        name: entry.toLowerCase(),
        directory: entry,
        tags: [],
        category: null,
      }

      const skillMdPath = join(skillPath, 'SKILL.md')
      if (existsSync(skillMdPath)) {
        try {
          const content = readFileSync(skillMdPath, 'utf-8')
          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
          const frontmatter = frontmatterMatch?.[1]
          if (frontmatter) {
            const tagsMatch = frontmatter.match(/tags:\s*\[(.*?)\]/)
            const tagsContent = tagsMatch?.[1]
            if (tagsContent) {
              skill.tags = tagsContent
                .split(',')
                .map((t: string) => t.trim().replace(/['"]/g, '').toLowerCase())
                .filter(Boolean)
            }
            const categoryMatch = frontmatter.match(/category:\s*["']?([^"'\n]+)["']?/)
            const categoryContent = categoryMatch?.[1]
            if (categoryContent) {
              skill.category = categoryContent.trim().toLowerCase()
            }
          }
        } catch {
          // Ignore read errors
        }
      }

      installedSkills.push(skill)
    }
  } catch {
    return []
  }

  return installedSkills
}
