/**
 * Search skills command implementation
 * Uses SkillService for centralized MCP-first + mock fallback.
 */
import * as vscode from 'vscode'
import { SkillSearchProvider } from '../providers/SkillSearchProvider.js'
import type { SkillService } from '../services/SkillService.js'

export function registerSearchCommand(
  context: vscode.ExtensionContext,
  searchProvider: SkillSearchProvider,
  skillService: SkillService
): void {
  const searchCommand = vscode.commands.registerCommand('skillsmith.searchSkills', async () => {
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

          if (results.length === 0) {
            const noResultsMsg = trimmedQuery
              ? `No skills found for "${trimmedQuery}"`
              : 'No skills found'
            vscode.window.showInformationMessage(noResultsMsg)
            searchProvider.clearResults()
            return
          }

          const label = trimmedQuery || 'all skills'
          const displayLabel = isOffline ? `${label} (Offline)` : label
          searchProvider.setResults(results, displayLabel)

          // Focus on search results view
          await vscode.commands.executeCommand('skillsmith.searchView.focus')

          const foundMsg = trimmedQuery
            ? `Found ${results.length} skill${results.length === 1 ? '' : 's'} for "${trimmedQuery}"`
            : `Showing ${results.length} skill${results.length === 1 ? '' : 's'}`
          vscode.window.showInformationMessage(foundMsg)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          vscode.window.showErrorMessage(`Search failed: ${message}`)
        } finally {
          clearTimeout(timer5s)
          clearTimeout(timer15s)
        }
      }
    )
  })

  context.subscriptions.push(searchCommand)
}
