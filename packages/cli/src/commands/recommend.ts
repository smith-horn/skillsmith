/**
 * SMI-1299: CLI Recommend Command
 *
 * Analyzes a codebase and recommends relevant skills based on detected
 * frameworks, dependencies, and patterns.
 *
 * References:
 * - SMI-1283 (analyze command pattern)
 * - packages/mcp-server/src/tools/recommend.ts (recommendation logic)
 */

import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CodebaseAnalyzer,
  createApiClient,
  type CodebaseContext,
  type TrustTier,
} from '@skillsmith/core'
import { sanitizeError } from '../utils/sanitize.js'

/**
 * Valid trust tier values
 */
const VALID_TRUST_TIERS: readonly TrustTier[] = [
  'verified',
  'community',
  'experimental',
  'unknown',
] as const

/**
 * Validate and normalize trust tier from API response (SMI-1354)
 * Returns 'unknown' for invalid values
 */
function validateTrustTier(tier: unknown): TrustTier {
  if (typeof tier === 'string' && VALID_TRUST_TIERS.includes(tier as TrustTier)) {
    return tier as TrustTier
  }
  return 'unknown'
}

/**
 * Skill recommendation from API
 */
interface SkillRecommendation {
  skill_id: string
  name: string
  reason: string
  similarity_score: number
  trust_tier: TrustTier
  quality_score: number
}

/**
 * Recommendation response
 */
interface RecommendResponse {
  recommendations: SkillRecommendation[]
  candidates_considered: number
  overlap_filtered: number
  context: {
    installed_count: number
    has_project_context: boolean
    using_semantic_matching: boolean
    auto_detected: boolean
  }
  timing: {
    totalMs: number
  }
}

/**
 * Get trust badge for display (SMI-1357: Use TrustTier type)
 */
function getTrustBadge(tier: TrustTier): string {
  switch (tier) {
    case 'verified':
      return chalk.green('[VERIFIED]')
    case 'community':
      return chalk.blue('[COMMUNITY]')
    case 'experimental':
      return chalk.yellow('[EXPERIMENTAL]')
    case 'unknown':
      return chalk.gray('[UNKNOWN]')
  }
}

/**
 * Format recommendations for terminal display
 */
function formatRecommendations(
  response: RecommendResponse,
  context: CodebaseContext | null
): string {
  const lines: string[] = []

  lines.push('')
  lines.push(chalk.bold.blue('=== Skill Recommendations ==='))
  lines.push('')

  if (context) {
    // Show detected frameworks
    if (context.frameworks.length > 0) {
      const frameworks = context.frameworks
        .slice(0, 3)
        .map((f) => f.name)
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
  } else {
    lines.push(`Found ${chalk.bold(response.recommendations.length)} recommendation(s):`)
    lines.push('')

    response.recommendations.forEach((rec, index) => {
      const trustBadge = getTrustBadge(rec.trust_tier)
      const qualityColor =
        rec.quality_score >= 80 ? chalk.green : rec.quality_score >= 50 ? chalk.yellow : chalk.red
      // Format relevance - show N/A if not available from API (-1)
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

      lines.push(`${chalk.bold(`${index + 1}.`)} ${chalk.bold(rec.name)} ${trustBadge}`)
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
function formatAsJson(response: RecommendResponse, context: CodebaseContext | null): string {
  const output = {
    recommendations: response.recommendations,
    analysis: context
      ? {
          frameworks: context.frameworks.slice(0, 10).map((f) => ({
            name: f.name,
            confidence: Math.round(f.confidence * 100),
          })),
          dependencies: context.dependencies.slice(0, 20).map((d) => ({
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
      installed_count: response.context.installed_count,
      auto_detected: response.context.auto_detected,
      timing_ms: response.timing.totalMs,
    },
  }

  return JSON.stringify(output, null, 2)
}

/**
 * Build stack from codebase analysis
 */
function buildStackFromAnalysis(context: CodebaseContext): string[] {
  const stack: string[] = []

  // Add detected frameworks
  for (const fw of context.frameworks.slice(0, 5)) {
    stack.push(fw.name.toLowerCase())
  }

  // Add key dependencies
  for (const dep of context.dependencies.slice(0, 10)) {
    if (!dep.isDev) {
      stack.push(dep.name.toLowerCase())
    }
  }

  return [...new Set(stack)].slice(0, 10)
}

/**
 * Check if error is a network-related error (SMI-1355)
 */
function isNetworkError(error: unknown): boolean {
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

/**
 * Format offline analysis results (SMI-1355)
 */
function formatOfflineResults(context: CodebaseContext, json: boolean): string {
  if (json) {
    return JSON.stringify(
      {
        offline: true,
        analysis: {
          frameworks: context.frameworks.slice(0, 10).map((f) => ({
            name: f.name,
            confidence: Math.round(f.confidence * 100),
          })),
          dependencies: context.dependencies.slice(0, 20).map((d) => ({
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
    context.frameworks.slice(0, 5).forEach((f) => {
      const confidence = Math.round(f.confidence * 100)
      lines.push(`  - ${f.name} (${confidence}% confidence)`)
    })
    lines.push('')
  }

  if (context.dependencies.length > 0) {
    const prodDeps = context.dependencies.filter((d) => !d.isDev).slice(0, 10)
    if (prodDeps.length > 0) {
      lines.push(chalk.bold('Key Dependencies:'))
      prodDeps.forEach((d) => lines.push(`  - ${d.name}`))
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

/**
 * Installed skill metadata (SMI-1358)
 */
interface InstalledSkill {
  name: string
  directory: string
  tags: string[]
  category: string | null
}

/**
 * Read installed skills from ~/.claude/skills/ directory (SMI-1358)
 * Returns array of installed skill metadata
 */
function getInstalledSkills(): InstalledSkill[] {
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

      if (!stat.isDirectory()) {
        continue
      }

      // Try to read SKILL.md or skill.yaml for metadata
      const skill: InstalledSkill = {
        name: entry.toLowerCase(),
        directory: entry,
        tags: [],
        category: null,
      }

      // Try to extract tags from SKILL.md frontmatter
      const skillMdPath = join(skillPath, 'SKILL.md')
      if (existsSync(skillMdPath)) {
        try {
          const content = readFileSync(skillMdPath, 'utf-8')
          // Extract tags from YAML frontmatter
          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
          const frontmatter = frontmatterMatch?.[1]
          if (frontmatter) {
            // Extract tags
            const tagsMatch = frontmatter.match(/tags:\s*\[(.*?)\]/)
            const tagsContent = tagsMatch?.[1]
            if (tagsContent) {
              skill.tags = tagsContent
                .split(',')
                .map((t) => t.trim().replace(/['"]/g, '').toLowerCase())
                .filter(Boolean)
            }
            // Extract category
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
    // Return empty array if directory cannot be read
    return []
  }

  return installedSkills
}

/**
 * Normalize a skill name for comparison (SMI-1358)
 * Removes common prefixes/suffixes and normalizes case
 */
function normalizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_]/g, '')
    .replace(/^skill/, '')
    .replace(/skill$/, '')
    .replace(/^helper/, '')
    .replace(/helper$/, '')
    .trim()
}

/**
 * Check if two skills overlap in functionality (SMI-1358)
 * Uses name similarity, tag matching, and category comparison
 */
function skillsOverlap(installed: InstalledSkill, recommended: SkillRecommendation): boolean {
  const installedName = normalizeSkillName(installed.name)
  const recommendedName = normalizeSkillName(recommended.name)
  const recommendedId = recommended.skill_id.toLowerCase()

  // Direct name match (exact or normalized)
  if (installedName === recommendedName) {
    return true
  }

  // Check if installed name is contained in recommended ID
  // e.g., installed "jest" overlaps with "community/jest-helper"
  if (recommendedId.includes(installed.name)) {
    return true
  }

  // Check if normalized names contain each other
  if (installedName.includes(recommendedName) || recommendedName.includes(installedName)) {
    // Only match if substantial overlap (at least 4 chars)
    if (installedName.length >= 4 && recommendedName.length >= 4) {
      return true
    }
  }

  // Tag-based overlap detection
  if (installed.tags.length > 0) {
    const recommendedNameParts = recommended.name.toLowerCase().split(/[-_\s]+/)
    const hasTagOverlap = installed.tags.some(
      (tag) => recommendedNameParts.includes(tag) || recommendedName.includes(tag)
    )
    if (hasTagOverlap) {
      return true
    }
  }

  return false
}

/**
 * Filter recommendations to remove overlaps with installed skills (SMI-1358)
 */
function filterOverlappingSkills(
  recommendations: SkillRecommendation[],
  installedSkills: InstalledSkill[]
): { filtered: SkillRecommendation[]; overlapCount: number } {
  if (installedSkills.length === 0) {
    return { filtered: recommendations, overlapCount: 0 }
  }

  const filtered: SkillRecommendation[] = []
  let overlapCount = 0

  for (const rec of recommendations) {
    const hasOverlap = installedSkills.some((installed) => skillsOverlap(installed, rec))
    if (hasOverlap) {
      overlapCount++
    } else {
      filtered.push(rec)
    }
  }

  return { filtered, overlapCount }
}

/**
 * Run recommendation workflow
 */
async function runRecommend(
  targetPath: string,
  options: {
    limit: number
    json: boolean
    context: string | undefined
    installed: string[] | undefined
    noOverlap: boolean
    maxFiles: number
  }
): Promise<void> {
  const spinner = ora()
  let codebaseContext: CodebaseContext | null = null

  try {
    // Step 1: Analyze codebase
    spinner.start('Analyzing codebase...')
    const analyzer = new CodebaseAnalyzer()

    codebaseContext = await analyzer.analyze(targetPath, {
      maxFiles: options.maxFiles,
      includeDevDeps: true,
    })

    spinner.succeed(
      `Analyzed ${codebaseContext.stats.totalFiles} files (${codebaseContext.frameworks.length} frameworks detected)`
    )

    // Step 2: Build recommendation request
    spinner.start('Finding skill recommendations...')

    const stack = buildStackFromAnalysis(codebaseContext)

    // Add user-provided context
    if (options.context) {
      const contextWords = options.context
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 5)
      stack.push(...contextWords)
    }

    // Step 3: Call recommendation API
    const apiClient = createApiClient()

    const apiResponse = await apiClient.getRecommendations({
      stack: stack.slice(0, 10),
      limit: options.limit,
    })

    // Transform API response to expected format
    let recommendations: SkillRecommendation[] = apiResponse.data.map((skill) => ({
      skill_id: skill.id,
      name: skill.name,
      reason: `Matches your stack: ${stack.slice(0, 3).join(', ')}`,
      similarity_score: -1, // API doesn't return this; -1 indicates not available
      trust_tier: validateTrustTier(skill.trust_tier),
      quality_score: Math.round((skill.quality_score ?? 0.5) * 100),
    }))

    // SMI-1358: Apply overlap filtering if enabled (default behavior)
    // noOverlap = true means user passed --no-overlap, so we should NOT filter
    let overlapFiltered = 0
    let installedSkills: InstalledSkill[] = []
    const autoDetected = !options.installed || options.installed.length === 0

    if (!options.noOverlap) {
      // Get installed skills (auto-detect from ~/.claude/skills/ if not provided)
      if (options.installed && options.installed.length > 0) {
        // Convert provided skill IDs to InstalledSkill format
        installedSkills = options.installed.map((id) => ({
          name: id.toLowerCase().split('/').pop() ?? id.toLowerCase(),
          directory: id,
          tags: [],
          category: null,
        }))
      } else {
        // Auto-detect installed skills
        installedSkills = getInstalledSkills()
      }

      if (installedSkills.length > 0) {
        const filterResult = filterOverlappingSkills(recommendations, installedSkills)
        recommendations = filterResult.filtered
        overlapFiltered = filterResult.overlapCount
      }
    }

    const response: RecommendResponse = {
      recommendations,
      candidates_considered: apiResponse.data.length,
      overlap_filtered: overlapFiltered,
      context: {
        installed_count: installedSkills.length,
        has_project_context: !!options.context,
        using_semantic_matching: true,
        auto_detected: autoDetected,
      },
      timing: {
        totalMs: codebaseContext.metadata.durationMs,
      },
    }

    spinner.succeed(`Found ${response.recommendations.length} recommendations${overlapFiltered > 0 ? ` (${overlapFiltered} filtered for overlap)` : ''}`)

    // Step 4: Output results
    if (options.json) {
      console.log(formatAsJson(response, codebaseContext))
    } else {
      console.log(formatRecommendations(response, codebaseContext))
    }
  } catch (error) {
    // SMI-1355: Check if this is a network error and we have codebase context
    if (isNetworkError(error) && codebaseContext) {
      spinner.warn('Unable to reach API, showing analysis-only results')
      console.log(formatOfflineResults(codebaseContext, options.json))
      return
    }

    spinner.fail('Recommendation failed')

    if (options.json) {
      console.error(JSON.stringify({ error: sanitizeError(error) }))
    } else {
      console.error(chalk.red('Error:'), sanitizeError(error))
    }
    process.exit(1)
  }
}

/**
 * Create recommend command
 */
export function createRecommendCommand(): Command {
  const cmd = new Command('recommend')
    .description('Analyze a codebase and recommend relevant skills based on detected patterns')
    .argument('[path]', 'Path to the codebase to analyze', '.')
    .option('-l, --limit <number>', 'Maximum recommendations to return', '5')
    .option('-j, --json', 'Output results as JSON')
    .option('-c, --context <text>', 'Additional context for recommendations')
    .option('-i, --installed <skills...>', 'Currently installed skill IDs')
    .option('--no-overlap', 'Disable overlap detection')
    .option('-m, --max-files <number>', 'Maximum files to analyze', '1000')
    .action(
      async (targetPath: string, opts: Record<string, string | boolean | string[] | undefined>) => {
        const limit = parseInt(opts['limit'] as string, 10)
        const maxFiles = parseInt(opts['max-files'] as string, 10)
        const json = (opts['json'] as boolean) === true
        const context = opts['context'] as string | undefined
        const installed = opts['installed'] as string[] | undefined
        const noOverlap = opts['overlap'] === false

        await runRecommend(targetPath, {
          limit: isNaN(limit) ? 5 : Math.min(Math.max(limit, 1), 50),
          maxFiles: isNaN(maxFiles) ? 1000 : maxFiles,
          json,
          context,
          installed,
          noOverlap,
        })
      }
    )

  return cmd
}

export default createRecommendCommand
