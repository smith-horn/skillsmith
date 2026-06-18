/**
 * Search skills command implementation
 * Uses SkillService for centralized MCP-first + mock fallback.
 *
 * SMI-5298 (#1431): search routes into the unified `SkillTreeDataProvider`
 * (the single `skillsmith.skillsView` tree), not the retired `searchView`.
 * Results land in the provider's "Available Skills" group, which is then
 * revealed via the retained `TreeView` handle.
 */
import * as vscode from 'vscode'
import type { SkillTreeDataProvider } from '../sidebar/SkillTreeDataProvider.js'
import type { SkillTreeItem } from '../sidebar/SkillTreeItem.js'
import type { SkillService } from '../services/SkillService.js'
import { withTelemetry } from '../services/telemetry-wrap.js'

interface SearchSkillsDeps {
  treeDataProvider: SkillTreeDataProvider
  skillsView: vscode.TreeView<SkillTreeItem>
  skillService: SkillService
}

/** SMI-5288: whether explicit demo mode is enabled. */
function isDemoModeEnabled(): boolean {
  return vscode.workspace.getConfiguration('skillsmith').get<boolean>('demoMode', false)
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

// SMI-5130: extracted from the inline registerCommand closure so withTelemetry
// can wrap it at the export boundary (telemetry coverage gate). Deps that the
// closure captured are threaded in explicitly. The reveal call MUST stay inside
// this function (never module scope) so telemetry-coverage.test.ts can import
// `searchSkillsAction` as a value without invoking vscode APIs at load.
async function searchSkillsImpl(deps: SearchSkillsDeps): Promise<void> {
  const { treeDataProvider, skillService } = deps
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

  const trimmedQuery = query.trim()

  // Show cancellable progress with timed messages
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

        const { results, isOffline } = await skillService.search(trimmedQuery)

        if (token.isCancellationRequested) {
          return
        }

        progress.report({ increment: 100 })

        const demoMode = isDemoModeEnabled()

        if (results.length === 0) {
          // SMI-5288: offline + empty + not demo means the server is
          // unavailable — be honest instead of showing a fake catalog.
          if (isOffline && !demoMode) {
            vscode.window.showWarningMessage(
              'Skillsmith server unavailable — start the Skillsmith MCP server and try again.'
            )
            treeDataProvider.clearSearchResults()
            return
          }
          const noResultsMsg = trimmedQuery
            ? `No skills found for "${trimmedQuery}"`
            : 'No skills found'
          vscode.window.showInformationMessage(noResultsMsg)
          treeDataProvider.clearSearchResults()
          return
        }

        const label = trimmedQuery || 'all skills'
        // SMI-5288: non-empty offline results only happen in demo mode now.
        const displayLabel = isOffline && demoMode ? `${label} (Demo)` : label
        treeDataProvider.setSearchResults(results, displayLabel)

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

export const searchSkillsAction = withTelemetry(searchSkillsImpl, {
  source: 'vscode-extension',
  // SMI-5143: CLI-aligned action name so the same action shares one skill_id
  // across CLI + VS Code, split only by `source` (cli vs vscode-extension).
  extractSkillId: () => 'search',
})

export function registerSearchCommand(
  context: vscode.ExtensionContext,
  treeDataProvider: SkillTreeDataProvider,
  skillsView: vscode.TreeView<SkillTreeItem>,
  skillService: SkillService
): void {
  const searchCommand = vscode.commands.registerCommand('skillsmith.searchSkills', () =>
    searchSkillsAction({ treeDataProvider, skillsView, skillService })
  )
  context.subscriptions.push(searchCommand)
}
