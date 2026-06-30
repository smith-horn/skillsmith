/**
 * SMI-5127: Search command action implementation + telemetry wrapper.
 *
 * SMI-5427: remote-default search. CLI `search` now routes to the remote
 * skills-search edge fn via ApiClient.search() so npx/WASM users never pay
 * a ~74k local sync. Local DB is a fallback (offline / network error only).
 * autoSyncIfEmpty (SMI-4917 Bug-3) is removed — reversed intentionally.
 *
 * Sibling-split from search.ts following the <command>.action.ts convention
 * established by SMI-5040.
 */

import chalk from 'chalk'
import ora from 'ora'
import { input, checkbox, number, select } from '@inquirer/prompts'
import {
  SkillRepository,
  SkillDependencyRepository,
  SkillInstallationService,
  SkillsmithApiClient,
  createApiClient,
  loadStoredAccessToken,
  type SearchOptions,
  type TrustTier,
  type RegistryLookup,
  type RegistrySkillInfo,
} from '@skillsmith/core'
// SMI-5039: lazy embedding-capability probe.
import { probeEmbeddingCapability } from '@skillsmith/core/embeddings/probe'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { openCliDatabase } from '../utils/open-database.js'
import { isLocalIndexEmpty, formatEmptyIndexHint, searchRemoteOrLocal } from './search.helpers.js'
import { sanitizeError } from '../utils/sanitize.js'
import { type InteractiveSearchState, type SearchPhase, PAGE_SIZE } from './search-types.js'
import { TRUST_TIER_COLORS, displayResults, displaySkillDetails } from './search-formatters.js'

// ---------------------------------------------------------------------------
// Private helpers (not exported — used only by searchActionImpl)
// ---------------------------------------------------------------------------

/**
 * Run interactive search loop using state machine pattern (SMI-759).
 * SMI-5427: searches remote first; falls back to local on network errors.
 */
async function runInteractiveSearch(dbPath: string): Promise<void> {
  const db = await openCliDatabase(dbPath)

  console.log(chalk.bold.blue('\n=== Skillsmith Interactive Search ===\n'))

  try {
    let phase: SearchPhase = 'collect_query'
    let state: InteractiveSearchState | null = null

    while (phase !== 'exit') {
      // Phase: Collect search query and filters
      if (phase === 'collect_query') {
        const query = await input({
          message: 'Enter search query (or press Enter to browse with filters):',
          default: '',
        })

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

        const minQualityScore = await number({
          message: 'Minimum quality score (0-100, leave empty for no filter):',
          default: 0,
          min: 0,
          max: 100,
        })

        const hasQuery = query.trim().length > 0
        const hasFilters =
          trustTiers.length > 0 || (minQualityScore !== undefined && minQualityScore > 0)

        if (!hasQuery && !hasFilters) {
          console.log(chalk.red('Please provide a search query or select at least one filter.'))
          continue
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
        const searchOptions: SearchOptions = {
          query: state.query,
          limit: PAGE_SIZE,
          offset: state.offset,
        }

        if (state.minQualityScore > 0) {
          searchOptions.minQualityScore = state.minQualityScore
        }

        // API supports one trust tier; multi-tier is filtered client-side below.
        if (state.trustTiers.length === 1 && state.trustTiers[0] !== undefined) {
          searchOptions.trustTier = state.trustTiers[0]
        }

        // SMI-5427: remote-first search.
        const outcome = await searchRemoteOrLocal(searchOptions, db)

        if (outcome.kind === 'quota') {
          console.error(chalk.red(`\n${outcome.message}`))
          phase = 'exit'
          continue
        }
        if (outcome.kind === 'auth') {
          console.error(chalk.red('\nAuthentication required. Run `skillsmith login` to sign in.'))
          phase = 'exit'
          continue
        }
        if (outcome.kind === 'empty') {
          console.log(formatEmptyIndexHint())
          phase = 'exit'
          continue
        }

        const { items: rawItems, hasMore, totalHint } = outcome

        // Multi-tier client-side filtering (when multiple tiers selected).
        const trustTiersForFilter = state.trustTiers
        const filteredItems =
          trustTiersForFilter.length > 1
            ? rawItems.filter((r) => trustTiersForFilter.includes(r.skill.trustTier))
            : rawItems

        if (filteredItems.length === 0) {
          if (isLocalIndexEmpty(db)) {
            console.log(formatEmptyIndexHint())
          } else {
            displayResults(filteredItems, totalHint, state.offset, PAGE_SIZE)
          }
          phase = 'exit'
          continue
        }

        displayResults(filteredItems, totalHint, state.offset, PAGE_SIZE)

        const choices: Array<{ name: string; value: string }> = []

        for (let i = 0; i < filteredItems.length; i++) {
          const skill = filteredItems[i]!.skill
          const colorFn = TRUST_TIER_COLORS[skill.trustTier]
          choices.push({
            name: `${i + 1}. ${colorFn(skill.name)} - View details`,
            value: `view_${i}`,
          })
        }

        choices.push({ name: chalk.dim('---'), value: 'separator' })

        if (state.offset > 0) {
          choices.push({ name: chalk.cyan('<< Previous page'), value: 'prev' })
        }

        if (hasMore) {
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
                // SMI-5427: API-backed registry lookup — falls through to API
                // when the skill is not in the local DB (remote-only result).
                const registryLookup = buildRegistryLookupWithApiFallback(skillRepo)
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
 * Build a RegistryLookup that tries local DB first, then falls back to the
 * remote API. This ensures `skillsmith install` works for skills discovered
 * via remote search even when the local DB has never been synced.
 *
 * SMI-5427: install path requires a repoUrl; remote getSkill provides it.
 */
function buildRegistryLookupWithApiFallback(skillRepo: SkillRepository): RegistryLookup {
  return {
    async lookup(sid: string): Promise<RegistrySkillInfo | null> {
      const s = skillRepo.findById(sid)
      if (s?.repoUrl) {
        return {
          repoUrl: s.repoUrl,
          name: s.name,
          trustTier: s.trustTier,
          quarantined: false,
        }
      }
      // API fallback for remote-only results.
      try {
        const jwtToken = await loadStoredAccessToken()
        const apiClient = createApiClient(jwtToken ? { jwtToken } : {})
        if (apiClient.isOffline()) return null
        const response = await apiClient.getSkill(sid)
        const r = response.data
        if (!r.repo_url) return null
        return {
          repoUrl: r.repo_url,
          name: r.name,
          trustTier: SkillsmithApiClient.toSkill(r).trustTier,
          quarantined: false,
        }
      } catch {
        return null
      }
    },
  }
}

/**
 * Run non-interactive search (SMI-5427: remote-first).
 */
async function runSearch(
  query: string,
  options: {
    db: string
    limit: number
    tier?: TrustTier
    category?: string
    minScore?: number
    safeOnly?: boolean
    maxRisk?: number
    quiet?: boolean
    noProgress?: boolean
  }
): Promise<void> {
  const db = await openCliDatabase(options.db)

  const suppress = options.quiet || options.noProgress || process.env['SKILLSMITH_QUIET'] === 'true'
  const spinner = suppress ? null : ora('Searching Skillsmith registry...').start()

  try {
    const searchOptions: SearchOptions = {
      query,
      limit: options.limit,
    }

    if (options.tier !== undefined) {
      searchOptions.trustTier = options.tier
    }
    if (options.category !== undefined) {
      searchOptions.category = options.category
    }
    if (options.minScore !== undefined) {
      searchOptions.minQualityScore = options.minScore / 100
    }
    if (options.safeOnly !== undefined) {
      searchOptions.safeOnly = options.safeOnly
    }
    if (options.maxRisk !== undefined) {
      searchOptions.maxRiskScore = options.maxRisk
    }

    const outcome = await searchRemoteOrLocal(searchOptions, db)

    if (spinner) spinner.stop()

    if (outcome.kind === 'quota') {
      console.error(chalk.red(`\n${outcome.message}`))
      return
    }
    if (outcome.kind === 'auth') {
      console.error(chalk.red('Authentication required. Run `skillsmith login` to sign in.'))
      return
    }
    if (outcome.kind === 'empty') {
      console.log(formatEmptyIndexHint())
      return
    }

    const { items, totalHint } = outcome
    // SMI-4926: distinguish empty local index from genuine no-match.
    if (items.length === 0 && isLocalIndexEmpty(db)) {
      console.log(formatEmptyIndexHint())
      return
    }
    displayResults(items, totalHint, 0, options.limit)
  } finally {
    if (spinner) spinner.stop()
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
    const quiet = !!(opts['quiet'] as boolean | undefined)
    const noProgress = opts['progress'] === false

    // SMI-5039: lazy probe — honors SKILLSMITH_QUIET + --quiet + --no-progress.
    await probeEmbeddingCapability({ quiet: quiet || noProgress })

    const interactive = opts['interactive'] as boolean | undefined
    const dbPath = opts['db'] as string
    const limit = parseInt(opts['limit'] as string, 10)
    const tier = opts['tier'] as TrustTier | undefined
    const category = opts['category'] as string | undefined
    const minScore = opts['min-score'] ? parseInt(opts['min-score'] as string, 10) : undefined
    const safeOnly = opts['safe-only'] as boolean | undefined
    const maxRisk = opts['max-risk'] ? parseInt(opts['max-risk'] as string, 10) : undefined

    if (interactive) {
      await runInteractiveSearch(dbPath)
    } else if (query) {
      const searchOpts: Parameters<typeof runSearch>[1] = { db: dbPath, limit, quiet, noProgress }
      if (tier !== undefined) searchOpts.tier = tier
      if (category !== undefined) searchOpts.category = category
      if (minScore !== undefined) searchOpts.minScore = minScore
      if (safeOnly !== undefined) searchOpts.safeOnly = safeOnly
      if (maxRisk !== undefined) searchOpts.maxRisk = maxRisk
      await runSearch(query, searchOpts)
    } else if (
      tier !== undefined ||
      category !== undefined ||
      minScore !== undefined ||
      safeOnly !== undefined ||
      maxRisk !== undefined
    ) {
      console.log(chalk.blue('Running filter-only search...'))
      const searchOpts: Parameters<typeof runSearch>[1] = { db: dbPath, limit, quiet, noProgress }
      if (tier !== undefined) searchOpts.tier = tier
      if (category !== undefined) searchOpts.category = category
      if (minScore !== undefined) searchOpts.minScore = minScore
      if (safeOnly !== undefined) searchOpts.safeOnly = safeOnly
      if (maxRisk !== undefined) searchOpts.maxRisk = maxRisk
      await runSearch('', searchOpts)
    } else {
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
