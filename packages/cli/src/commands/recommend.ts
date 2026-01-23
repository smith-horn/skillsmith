/**
 * SMI-1299: CLI Recommend Command
 *
 * Analyzes a codebase and recommends relevant skills based on detected
 * frameworks, dependencies, and patterns.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import {
  CodebaseAnalyzer,
  createApiClient,
  type SkillRole,
  SKILL_ROLES,
} from '@skillsmith/core'
import { sanitizeError } from '../utils/sanitize.js'

// Re-export types for public API
export type { SkillRecommendation, RecommendResponse, InstalledSkill } from './recommend.types.js'

// Import helpers
import type { SkillRecommendation, RecommendResponse, RecommendOptions } from './recommend.types.js'
import {
  validateTrustTier,
  isNetworkError,
  formatRecommendations,
  formatAsJson,
  formatOfflineResults,
  buildStackFromAnalysis,
  getInstalledSkills,
  inferRolesFromTags,
  filterOverlappingSkills,
} from './recommend.helpers.js'

// ============================================================================
// Main Workflow
// ============================================================================

/**
 * Run recommendation workflow
 */
async function runRecommend(targetPath: string, options: RecommendOptions): Promise<void> {
  const spinner = ora()
  let codebaseContext: Awaited<ReturnType<CodebaseAnalyzer['analyze']>> | null = null

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

    // Transform API response
    let recommendations: SkillRecommendation[] = apiResponse.data.map((skill) => ({
      skill_id: skill.id,
      name: skill.name,
      reason: `Matches your stack: ${stack.slice(0, 3).join(', ')}`,
      similarity_score: -1,
      trust_tier: validateTrustTier(skill.trust_tier),
      quality_score: Math.round((skill.quality_score ?? 0.5) * 100),
      roles: inferRolesFromTags(skill.tags || []),
    }))

    // Apply overlap filtering
    let overlapFiltered = 0
    let installedSkills: Awaited<ReturnType<typeof getInstalledSkills>> = []
    const autoDetected = !options.installed || options.installed.length === 0

    if (!options.noOverlap) {
      if (options.installed && options.installed.length > 0) {
        installedSkills = options.installed.map((id) => ({
          name: id.toLowerCase().split('/').pop() ?? id.toLowerCase(),
          directory: id,
          tags: [],
          category: null,
        }))
      } else {
        installedSkills = getInstalledSkills()
      }

      if (installedSkills.length > 0) {
        const filterResult = filterOverlappingSkills(recommendations, installedSkills)
        recommendations = filterResult.filtered
        overlapFiltered = filterResult.overlapCount
      }
    }

    // Apply role-based filtering
    let roleFiltered = 0
    if (options.role) {
      const beforeRoleFilter = recommendations.length
      recommendations = recommendations.filter((rec) => rec.roles?.includes(options.role!))
      roleFiltered = beforeRoleFilter - recommendations.length

      recommendations = recommendations.map((rec) => ({
        ...rec,
        quality_score: Math.min(100, rec.quality_score + 30),
        reason: `${rec.reason} (role: ${options.role})`,
      }))
      recommendations.sort((a, b) => b.quality_score - a.quality_score)
    }

    const response: RecommendResponse = {
      recommendations,
      candidates_considered: apiResponse.data.length,
      overlap_filtered: overlapFiltered,
      role_filtered: roleFiltered,
      context: {
        installed_count: installedSkills.length,
        has_project_context: !!options.context,
        using_semantic_matching: true,
        auto_detected: autoDetected,
        ...(options.role ? { role_filter: options.role } : {}),
      },
      timing: { totalMs: codebaseContext.metadata.durationMs },
    }

    let filterMsg = ''
    if (overlapFiltered > 0 || roleFiltered > 0) {
      const parts: string[] = []
      if (overlapFiltered > 0) parts.push(`${overlapFiltered} overlap`)
      if (roleFiltered > 0) parts.push(`${roleFiltered} role`)
      filterMsg = ` (filtered: ${parts.join(', ')})`
    }

    spinner.succeed(`Found ${response.recommendations.length} recommendations${filterMsg}`)

    // Step 4: Output results
    if (options.json) {
      console.log(formatAsJson(response, codebaseContext))
    } else {
      console.log(formatRecommendations(response, codebaseContext))
    }
  } catch (error) {
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

// ============================================================================
// Command Creation
// ============================================================================

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
    .option(
      '-r, --role <role>',
      `SMI-1631: Filter by skill role (${SKILL_ROLES.join(', ')}). Skills matching the role get a +30 score boost.`
    )
    .action(
      async (targetPath: string, opts: Record<string, string | boolean | string[] | undefined>) => {
        const limit = parseInt(opts['limit'] as string, 10)
        const maxFiles = parseInt(opts['max-files'] as string, 10)
        const json = (opts['json'] as boolean) === true
        const context = opts['context'] as string | undefined
        const installed = opts['installed'] as string[] | undefined
        const noOverlap = opts['overlap'] === false

        const roleInput = opts['role'] as string | undefined
        let role: SkillRole | undefined
        if (roleInput) {
          if (SKILL_ROLES.includes(roleInput as SkillRole)) {
            role = roleInput as SkillRole
          } else {
            console.error(
              chalk.yellow(
                `Warning: Invalid role "${roleInput}". Valid roles: ${SKILL_ROLES.join(', ')}`
              )
            )
          }
        }

        await runRecommend(targetPath, {
          limit: isNaN(limit) ? 5 : Math.min(Math.max(limit, 1), 50),
          maxFiles: isNaN(maxFiles) ? 1000 : maxFiles,
          json,
          context,
          installed,
          noOverlap,
          role,
        })
      }
    )

  return cmd
}

export default createRecommendCommand
