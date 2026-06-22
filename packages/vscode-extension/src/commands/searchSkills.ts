/**
 * Search skills command implementation
 * Uses SkillService for centralized MCP-first + mock fallback.
 *
 * SMI-5298 (#1431): search routes into the unified `SkillTreeDataProvider`
 * (the single `skillsmith.skillsView` tree), not the retired `searchView`.
 * Results land in the provider's "Available Skills" group, which is then
 * revealed via the retained `TreeView` handle.
 *
 * Wave 2a (#1433 SMI-5304 / #1432 SMI-5305 / #1434-P2 SMI-5306): a shared
 * `performSearch` helper threads active filters into the search, sets the
 * persistent `TreeView.message` context banner, maintains the
 * `skillsmith.hasActiveFilters` context key, and renders filter-aware
 * empty/offline copy. Filters are collected via `searchFilters.ts`.
 */
import * as vscode from 'vscode'
import type { SkillTreeDataProvider } from '../sidebar/SkillTreeDataProvider.js'
import type { SkillTreeItem } from '../sidebar/SkillTreeItem.js'
import type { SkillService } from '../services/SkillService.js'
import type { SidebarMessageState } from '../sidebar/message-state.js'
import { withTelemetry } from '../services/telemetry-wrap.js'
import { collectSearchFilters, type SearchFilters } from './searchFilters.js'

interface SearchSkillsDeps {
  treeDataProvider: SkillTreeDataProvider
  skillsView: vscode.TreeView<SkillTreeItem>
  skillService: SkillService
  // SMI-5345 (#1438): the single owner of `skillsView.message`. `performSearch`
  // routes its context banner / no-results / offline copy through this state
  // machine instead of writing `skillsView.message` directly, which resolves
  // the multi-writer race with the first-run hint and the MCP-offline observer.
  messageState: SidebarMessageState
}

/** SMI-5288: whether explicit demo mode is enabled. */
function isDemoModeEnabled(): boolean {
  return vscode.workspace.getConfiguration('skillsmith').get<boolean>('demoMode', false)
}

/**
 * Composes the persistent context banner (#1432) from the provider's single
 * `describeActiveContext()` formatter, so the banner and the group label can
 * never drift. The banner owns the query + filter parts; the group label owns
 * the count header.
 */
function formatContextBanner(deps: SearchSkillsDeps): string {
  const { rawQuery, demo, filterParts } = deps.treeDataProvider.describeActiveContext()
  const head = rawQuery ? `Showing results for "${rawQuery}"` : 'Showing all skills'
  const parts = [head, ...filterParts]
  if (demo) {
    parts.push('Demo')
  }
  return parts.join(' · ')
}

/** Reflects the provider's filter state into the `hasActiveFilters` context key. */
async function syncActiveFiltersContext(deps: SearchSkillsDeps): Promise<void> {
  await vscode.commands.executeCommand(
    'setContext',
    'skillsmith.hasActiveFilters',
    deps.treeDataProvider.hasActiveFilters()
  )
}

/**
 * Surfaces the Available group after a successful search.
 *
 * SMI-5298 (#1431): focus the container/view FIRST, then reveal. `reveal({
 * focus })` does not reliably open a collapsed/hidden activity-bar container or
 * pull focus from the editor, so a palette-invoked search with the sidebar
 * closed would otherwise give zero feedback (compounded by #1434-P1 removing
 * the success toast). Focus-then-reveal covers all sidebar states. The reveal
 * no-ops when there is no Available group to show.
 */
async function revealAvailableGroup(deps: SearchSkillsDeps): Promise<void> {
  const { treeDataProvider, skillsView } = deps
  await vscode.commands.executeCommand('skillsmith.skillsView.focus')
  const availableGroup = treeDataProvider.getAvailableGroupItem()
  if (availableGroup) {
    await skillsView.reveal(availableGroup, { focus: true, expand: true })
  }
}

/**
 * Shared search core (#1433): runs the query with the supplied filters, routes
 * results into the provider, maintains the context banner + `hasActiveFilters`
 * key, and reveals the Available group. Used by the search command and both the
 * filter/clear-filter commands so they share one code path.
 *
 * The reveal + banner + setContext calls MUST stay inside this function (never
 * module scope) so telemetry-coverage.test.ts can import the wrapped actions as
 * values without invoking vscode APIs at load.
 */
async function performSearch(
  deps: SearchSkillsDeps,
  query: string,
  filters: SearchFilters
): Promise<void> {
  const { treeDataProvider, skillService } = deps
  const trimmedQuery = query.trim()
  const hasFilters =
    filters.trustTier !== undefined ||
    filters.category !== undefined ||
    filters.minScore !== undefined

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Searching skills...',
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ increment: 0 })

      const timer5s = setTimeout(() => {
        if (!token.isCancellationRequested) {
          progress.report({ message: 'Still searching...' })
        }
      }, 5000)

      const timer15s = setTimeout(() => {
        if (!token.isCancellationRequested) {
          progress.report({ message: 'Server is slow -- try again later?' })
        }
      }, 15000)

      try {
        if (token.isCancellationRequested) {
          return
        }

        const { results, isOffline } = await skillService.search(trimmedQuery, filters)

        if (token.isCancellationRequested) {
          return
        }

        progress.report({ increment: 100 })

        const demoMode = isDemoModeEnabled()

        if (results.length === 0) {
          // SMI-5288: offline + empty + not demo means the server is
          // unavailable — be honest instead of showing a fake catalog. Render
          // a persistent in-tree banner (#1438-P2) in addition to the warning.
          if (isOffline && !demoMode) {
            vscode.window.showWarningMessage(
              'Skillsmith server unavailable — start the Skillsmith MCP server and try again.'
            )
            treeDataProvider.clearSearchResults()
            deps.messageState.setSearchBanner(
              'Skillsmith server unavailable — start the MCP server and try again.'
            )
            await syncActiveFiltersContext(deps)
            return
          }
          // #1434-P2: filter-aware no-results copy.
          const noResultsMsg = buildNoResultsMessage(trimmedQuery, hasFilters)
          vscode.window.showInformationMessage(noResultsMsg)
          treeDataProvider.clearSearchResults()
          deps.messageState.setSearchBanner(noResultsMsg)
          await syncActiveFiltersContext(deps)
          return
        }

        // SMI-5288: non-empty offline results only happen in demo mode now.
        const isDemoResults = isOffline && demoMode
        treeDataProvider.setSearchResults(results, trimmedQuery, { demo: isDemoResults })

        // #1432: persistent context banner derived from the single formatter.
        deps.messageState.setSearchBanner(formatContextBanner(deps))
        await syncActiveFiltersContext(deps)

        // SMI-5298 (#1431): surface the Available group in the unified view.
        // #1434-P1: the "Found N skills" success toast is intentionally removed —
        // the revealed tree group is the feedback now.
        await revealAvailableGroup(deps)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        vscode.window.showErrorMessage(`Search failed: ${message}`)
      } finally {
        clearTimeout(timer5s)
        clearTimeout(timer15s)
      }
    }
  )
}

/** Builds the no-results copy, filter-aware (#1434-P2). */
function buildNoResultsMessage(trimmedQuery: string, hasFilters: boolean): string {
  if (hasFilters) {
    return trimmedQuery
      ? `No skills match "${trimmedQuery}" with the current filters — try Clear Filters.`
      : 'No skills match the current filters — try Clear Filters.'
  }
  return trimmedQuery ? `No skills found for "${trimmedQuery}"` : 'No skills found'
}

// SMI-5130: extracted from the inline registerCommand closure so withTelemetry
// can wrap it at the export boundary (telemetry coverage gate). Deps that the
// closure captured are threaded in explicitly.
async function searchSkillsImpl(deps: SearchSkillsDeps): Promise<void> {
  // Show search input (query is optional - empty searches return all skills)
  const query = await vscode.window.showInputBox({
    prompt: 'Search for agent skills',
    placeHolder: 'Search for skills (or press Enter to browse all)',
    title: 'Skillsmith Search',
  })

  // User cancelled (pressed Escape)
  if (query === undefined) {
    return
  }

  await performSearch(deps, query, deps.treeDataProvider.getFilters())
}

/**
 * #1433: collect filters via the 3-step QuickPick, store them on the provider
 * (single source of truth), then re-run the LAST query with them. A filter-
 * first flow (no query yet) runs browse-all (`''`). Escape aborts and leaves
 * the existing filters untouched.
 */
async function applyFiltersImpl(deps: SearchSkillsDeps): Promise<void> {
  const filters = await collectSearchFilters()
  if (filters === undefined) {
    return
  }
  deps.treeDataProvider.setFilters(filters)
  await performSearch(deps, deps.treeDataProvider.getLastSearchQuery(), filters)
}

/** #1433: clear all filters and re-run the last query unfiltered. */
async function clearFiltersImpl(deps: SearchSkillsDeps): Promise<void> {
  deps.treeDataProvider.clearFilters()
  await performSearch(deps, deps.treeDataProvider.getLastSearchQuery(), {})
}

export const searchSkillsAction = withTelemetry(searchSkillsImpl, {
  source: 'vscode-extension',
  // SMI-5143: CLI-aligned action name so the same action shares one skill_id
  // across CLI + VS Code, split only by `source` (cli vs vscode-extension).
  extractSkillId: () => 'search',
})

export const filterSkillsAction = withTelemetry(applyFiltersImpl, {
  source: 'vscode-extension',
  // Plan-review #5: distinct id so filter adoption is measurable (not 'search').
  extractSkillId: () => 'filter',
})

export const clearFiltersAction = withTelemetry(clearFiltersImpl, {
  source: 'vscode-extension',
  // Plan-review #5: distinct id so clear-filter usage is measurable.
  extractSkillId: () => 'clear_filter',
})

export function registerSearchCommand(
  context: vscode.ExtensionContext,
  treeDataProvider: SkillTreeDataProvider,
  skillsView: vscode.TreeView<SkillTreeItem>,
  skillService: SkillService,
  messageState: SidebarMessageState
): void {
  const deps: SearchSkillsDeps = { treeDataProvider, skillsView, skillService, messageState }
  context.subscriptions.push(
    vscode.commands.registerCommand('skillsmith.searchSkills', () => searchSkillsAction(deps)),
    vscode.commands.registerCommand('skillsmith.filterSkills', () => filterSkillsAction(deps)),
    vscode.commands.registerCommand('skillsmith.clearSkillFilters', () => clearFiltersAction(deps))
  )
}
