/**
 * SMI-5127: Search command action implementation + telemetry wrapper.
 *
 * Sibling-split from search.ts following the <command>.action.ts convention
 * established by SMI-5040. The action impl is extracted here and wrapped with
 * withTelemetry so the CLI_DISPATCHER_MAP coverage test can assert coverage
 * without importing the full commander tree.
 *
 * Opts-adaptation choice: searchActionImpl accepts the same (query, opts)
 * signature that commander passes to .action() — the factory in search.ts
 * passes the wrapped action directly to .action() with no closure needed.
 * The interactive sub-functions (runInteractiveSearch, runSearch) remain
 * private to this module.
 */

import chalk from 'chalk'
import ora from 'ora'
import { input, checkbox, number, select } from '@inquirer/prompts'
import {
  SearchService,
  SkillRepository,
  SkillDependencyRepository,
  SkillInstallationService,
  type SearchOptions,
  type TrustTier,
  type RegistryLookup,
  type RegistrySkillInfo,
} from '@skillsmith/core'
// SMI-5039: lazy embedding-capability probe. CLI `search` is the only
// embedding-relevant command — it surfaces a degraded-search warning to the
// operator without blocking the FTS fallback path. The probe is hard-bounded
// at 2 s, stderr-only, and never throws; `SKILLSMITH_QUIET=true` suppresses
// the warning line for scripted use.
import { probeEmbeddingCapability } from '@skillsmith/core/embeddings/probe'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { openCliDatabase } from '../utils/open-database.js'
import { autoSyncIfEmpty, isLocalIndexEmpty, formatEmptyIndexHint } from './search.helpers.js'
import { sanitizeError } from '../utils/sanitize.js'
import { type InteractiveSearchState, type SearchPhase, PAGE_SIZE } from './search-types.js'
import { TRUST_TIER_COLORS, displayResults, displaySkillDetails } from './search-formatters.js'

// ---------------------------------------------------------------------------
// Private helpers (not exported — used only by searchActionImpl)
// ---------------------------------------------------------------------------

/**
 * Run interactive search loop using state machine pattern (SMI-759)
 * Uses iterative while loop instead of recursion for new searches.
 */
async function runInteractiveSearch(dbPath: string): Promise<void> {
  const db = await openCliDatabase(dbPath)
  // SMI-4917 Bug 3: bootstrap the local registry on a first-time search.
  await autoSyncIfEmpty(db)
  const searchService = new SearchService(db)

  console.log(chalk.bold.blue('\n=== Skillsmith Interactive Search ===\n'))

  try {
    // State machine: phase controls the loop behavior
    let phase: SearchPhase = 'collect_query'
    let state: InteractiveSearchState | null = null

    // Main state machine loop - replaces recursive calls
    while (phase !== 'exit') {
      // Phase: Collect search query and filters
      if (phase === 'collect_query') {
        // Step 1: Enter search query (optional if filters will be provided)
        const query = await input({
          message: 'Enter search query (or press Enter to browse with filters):',
          default: '',
        })

        // Step 2: Filter by trust tier
        const trustTiers = await checkbox<TrustTier>({
          message: 'Filter by trust tier (select with space, enter to continue):',
          choices: [
            { name: chalk.green('Verified'), value: 'verified' },
            { name: chalk.blue('Curated'), value: 'curated' },
            { name: chalk.yellow('Community'), value: 'community' },
            { name: chalk.red('Experimental'), value: 'experimental' },
            { name: chalk.gray('Unknown'), value: 'unknown' },
            { name: chalk.cyan('Local'), value: 'local' },
          ],
        })

        // Step 3: Minimum quality score
        const minQualityScore = await number({
          message: 'Minimum quality score (0-100, leave empty for no filter):',
          default: 0,
          min: 0,
          max: 100,
        })

        // Validate: require query OR at least one filter
        const hasQuery = query.trim().length > 0
        const hasFilters =
          trustTiers.length > 0 || (minQualityScore !== undefined && minQualityScore > 0)

        if (!hasQuery && !hasFilters) {
          console.log(chalk.red('Please provide a search query or select at least one filter.'))
          continue // Stay in collect_query phase
        }

        state = {
          query,
          trustTiers,
          minQualityScore: (minQualityScore || 0) / 100,
          offset: 0,
        }

        phase = 'searching'
        continue
      }

      // Phase: Search and display results
      if (phase === 'searching' && state !== null) {
        // Build search options - only add optional properties when they have values
        const searchOptions: SearchOptions = {
          query: state.query,
          limit: PAGE_SIZE,
          offset: state.offset,
        }

        // Add optional filters only when they have values (exactOptionalPropertyTypes)
        if (state.minQualityScore > 0) {
          searchOptions.minQualityScore = state.minQualityScore
        }

        // Filter by first selected trust tier (API only supports one)
        if (state.trustTiers.length === 1 && state.trustTiers[0] !== undefined) {
          searchOptions.trustTier = state.trustTiers[0]
        }

        // Execute search
        const results = searchService.search(searchOptions)

        // If filtering by multiple trust tiers, filter client-side
        let filteredItems = results.items
        const trustTiersForFilter = state.trustTiers
        if (trustTiersForFilter.length > 1) {
          filteredItems = results.items.filter((r) =>
            trustTiersForFilter.includes(r.skill.trustTier)
          )
        }

        if (results.items.length === 0) {
          // SMI-4926: distinguish an empty/unsynced local index from a no-match.
          if (isLocalIndexEmpty(db)) {
            console.log(formatEmptyIndexHint(db))
          } else {
            displayResults(filteredItems, results.total, state.offset, PAGE_SIZE)
          }
          phase = 'exit'
          continue
        }

        displayResults(filteredItems, results.total, state.offset, PAGE_SIZE)

        // Build action choices
        const choices: Array<{ name: string; value: string }> = []

        // Add skill selection options
        for (let i = 0; i < filteredItems.length; i++) {
          const skill = filteredItems[i]!.skill
          const colorFn = TRUST_TIER_COLORS[skill.trustTier]
          choices.push({
            name: `${i + 1}. ${colorFn(skill.name)} - View details`,
            value: `view_${i}`,
          })
        }

        // Add navigation options
        choices.push({ name: chalk.dim('---'), value: 'separator' })

        if (state.offset > 0) {
          choices.push({ name: chalk.cyan('<< Previous page'), value: 'prev' })
        }

        if (results.hasMore) {
          choices.push({ name: chalk.cyan('Next page >>'), value: 'next' })
        }

        choices.push({ name: chalk.magenta('New search'), value: 'new' })
        choices.push({ name: chalk.red('Exit'), value: 'exit' })

        const action = await select({
          message: 'Select a skill to view or navigate:',
          choices,
        })

        if (action === 'separator') {
          continue
        } else if (action === 'exit') {
          phase = 'exit'
        } else if (action === 'new') {
          // SMI-759: Reset to collect_query phase instead of recursive call
          phase = 'collect_query'
          console.log(chalk.bold.blue('\n=== New Search ===\n'))
        } else if (action === 'prev') {
          state.offset = Math.max(0, state.offset - PAGE_SIZE)
        } else if (action === 'next') {
          state.offset += PAGE_SIZE
        } else if (action.startsWith('view_')) {
          const index = parseInt(action.replace('view_', ''), 10)
          const selectedResult = filteredItems[index]
          if (selectedResult) {
            displaySkillDetails(selectedResult)

            // Ask what to do next
            const nextAction = await select({
              message: 'What would you like to do?',
              choices: [
                { name: 'Back to results', value: 'back' },
                { name: 'Install this skill', value: 'install' },
                { name: 'Exit', value: 'exit' },
              ],
            })

            if (nextAction === 'install') {
              const installSpinner = ora('Installing skill...').start()
              try {
                const skillRepo = new SkillRepository(db)
                const skillDependencyRepo = new SkillDependencyRepository(db)
                const registryLookup: RegistryLookup = {
                  async lookup(sid: string): Promise<RegistrySkillInfo | null> {
                    const s = skillRepo.findById(sid)
                    if (!s || !s.repoUrl) return null
                    return {
                      repoUrl: s.repoUrl,
                      name: s.name,
                      trustTier: s.trustTier,
                      quarantined: false,
                    }
                  },
                }
                const installService = new SkillInstallationService({
                  db,
                  skillRepo,
                  skillDependencyRepo,
                  registryLookup,
                  onProgress: (_stage: string, detail: string) => {
                    installSpinner.text = detail
                  },
                })
                const installResult = await installService.install(selectedResult.skill.id, {})
                if (installResult.success) {
                  installSpinner.succeed(
                    chalk.green(`Installed "${selectedResult.skill.name}" successfully`)
                  )
                  if (installResult.installPath) {
                    console.log(chalk.dim(`  Path: ${installResult.installPath}`))
                  }
                } else {
                  installSpinner.fail(chalk.red(`Installation failed: ${installResult.error}`))
                }
              } catch (installError) {
                installSpinner.fail(
                  chalk.red(
                    `Installation error: ${installError instanceof Error ? installError.message : String(installError)}`
                  )
                )
              }
            } else if (nextAction === 'exit') {
              phase = 'exit'
            }
          }
        }
      }
    }
  } finally {
    db.close()
  }

  console.log(chalk.dim('\nGoodbye!\n'))
}

/**
 * Run non-interactive search
 */
async function runSearch(
  query: string,
  options: {
    db: string
    limit: number
    tier?: TrustTier
    category?: string
    minScore?: number
    // SMI-825: Security filters
    safeOnly?: boolean
    maxRisk?: number
  }
): Promise<void> {
  const db = await openCliDatabase(options.db)
  // SMI-4917 Bug 3: bootstrap the local registry on a first-time search.
  await autoSyncIfEmpty(db)
  const searchService = new SearchService(db)

  try {
    // Build search options - only add optional properties when they have values
    const searchOptions: SearchOptions = {
      query,
      limit: options.limit,
    }

    // Add optional filters only when they have values (exactOptionalPropertyTypes)
    if (options.tier !== undefined) {
      searchOptions.trustTier = options.tier
    }
    if (options.category !== undefined) {
      searchOptions.category = options.category
    }
    if (options.minScore !== undefined) {
      searchOptions.minQualityScore = options.minScore / 100
    }
    // SMI-825: Security filters
    if (options.safeOnly !== undefined) {
      searchOptions.safeOnly = options.safeOnly
    }
    if (options.maxRisk !== undefined) {
      searchOptions.maxRiskScore = options.maxRisk
    }

    const results = searchService.search(searchOptions)
    // SMI-4926: an empty local index produces 0 results that look like a
    // genuine no-match — surface a sync-state-aware hint instead.
    if (results.items.length === 0 && isLocalIndexEmpty(db)) {
      console.log(formatEmptyIndexHint(db))
      return
    }
    displayResults(results.items, results.total, 0, options.limit)
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Action impl (matches commander's .action() signature)
// ---------------------------------------------------------------------------

async function searchActionImpl(
  query: string | undefined,
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  try {
    // SMI-5039: lazy probe — only fires on the search command, NOT on
    // --version / --help (those short-circuit at commander level before
    // any .action runs). Honors SKILLSMITH_QUIET=true for scripted use.
    // Probe cannot throw; safe to await unconditionally.
    await probeEmbeddingCapability()
    const interactive = opts['interactive'] as boolean | undefined
    const dbPath = opts['db'] as string
    const limit = parseInt(opts['limit'] as string, 10)
    const tier = opts['tier'] as TrustTier | undefined
    const category = opts['category'] as string | undefined
    const minScore = opts['min-score'] ? parseInt(opts['min-score'] as string, 10) : undefined
    // SMI-825: Security filters
    const safeOnly = opts['safe-only'] as boolean | undefined
    const maxRisk = opts['max-risk'] ? parseInt(opts['max-risk'] as string, 10) : undefined

    if (interactive) {
      await runInteractiveSearch(dbPath)
    } else if (query) {
      // Query provided - run search with optional filters
      const searchOpts: {
        db: string
        limit: number
        tier?: TrustTier
        category?: string
        minScore?: number
        safeOnly?: boolean
        maxRisk?: number
      } = {
        db: dbPath,
        limit,
      }
      if (tier !== undefined) {
        searchOpts.tier = tier
      }
      if (category !== undefined) {
        searchOpts.category = category
      }
      if (minScore !== undefined) {
        searchOpts.minScore = minScore
      }
      // SMI-825: Security filters
      if (safeOnly !== undefined) {
        searchOpts.safeOnly = safeOnly
      }
      if (maxRisk !== undefined) {
        searchOpts.maxRisk = maxRisk
      }
      await runSearch(query, searchOpts)
    } else if (
      tier !== undefined ||
      category !== undefined ||
      minScore !== undefined ||
      safeOnly !== undefined ||
      maxRisk !== undefined
    ) {
      // No query but filters provided - run filter-only search
      console.log(chalk.blue('Running filter-only search...'))
      const searchOpts: {
        db: string
        limit: number
        tier?: TrustTier
        category?: string
        minScore?: number
        safeOnly?: boolean
        maxRisk?: number
      } = {
        db: dbPath,
        limit,
      }
      if (tier !== undefined) {
        searchOpts.tier = tier
      }
      if (category !== undefined) {
        searchOpts.category = category
      }
      if (minScore !== undefined) {
        searchOpts.minScore = minScore
      }
      // SMI-825: Security filters
      if (safeOnly !== undefined) {
        searchOpts.safeOnly = safeOnly
      }
      if (maxRisk !== undefined) {
        searchOpts.maxRisk = maxRisk
      }
      await runSearch('', searchOpts)
    } else {
      // No query and no filters
      console.log(
        chalk.yellow(
          'Please provide a search query, filters (--tier, --category, --min-score, --safe-only, --max-risk), or use -i for interactive mode'
        )
      )
      console.log(chalk.dim('Examples:'))
      console.log(chalk.dim('  skillsmith search "authentication"'))
      console.log(chalk.dim('  skillsmith search --tier verified'))
      console.log(chalk.dim('  skillsmith search --category security'))
      console.log(chalk.dim('  skillsmith search --tier community --min-score 70'))
      console.log(chalk.dim('  skillsmith search --safe-only'))
      console.log(chalk.dim('  skillsmith search --max-risk 30'))
      console.log(chalk.dim('  skillsmith search -i'))
    }
  } catch (error) {
    console.error(chalk.red('Search error:'), sanitizeError(error))
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Telemetry-wrapped export (SMI-5127)
// ---------------------------------------------------------------------------

export const searchAction = withTelemetry(searchActionImpl, {
  source: 'cli',
  extractSkillId: () => 'search',
  extractFramework: () => 'cli',
})
