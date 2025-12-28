/**
 * Search skills command implementation
 */
import * as vscode from 'vscode'
import { SkillSearchProvider } from '../providers/SkillSearchProvider.js'
import { searchSkills as searchMockSkills, type SkillData } from '../data/mockSkills.js'

/** Minimum query length for search */
const MIN_QUERY_LENGTH = 1

export function registerSearchCommand(
  context: vscode.ExtensionContext,
  searchProvider: SkillSearchProvider
): void {
  const searchCommand = vscode.commands.registerCommand('skillsmith.searchSkills', async () => {
    // Show search input with validation
    const query = await vscode.window.showInputBox({
      prompt: 'Search for Claude Code skills',
      placeHolder: 'e.g., docker, testing, documentation',
      title: 'Skillsmith Search',
      validateInput: (value) => {
        if (!value || value.trim().length < MIN_QUERY_LENGTH) {
          return 'Please enter a search term'
        }
        return null
      },
    })

    // User cancelled or empty input
    if (!query || query.trim().length === 0) {
      return
    }

    const trimmedQuery = query.trim()

    // Show progress
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Searching skills...',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ increment: 0 })

        try {
          // Search skills (using mock data for MVP)
          const results = await performSearch(trimmedQuery)

          progress.report({ increment: 100 })

          if (results.length === 0) {
            vscode.window.showInformationMessage(`No skills found for "${trimmedQuery}"`)
            searchProvider.clearResults()
            return
          }

          // Update search results view
          searchProvider.setResults(results, trimmedQuery)

          // Focus on search results view
          await vscode.commands.executeCommand('skillsmith.searchView.focus')

          vscode.window.showInformationMessage(
            `Found ${results.length} skill${results.length === 1 ? '' : 's'} for "${trimmedQuery}"`
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          vscode.window.showErrorMessage(`Search failed: ${message}`)
        }
      }
    )
  })

  context.subscriptions.push(searchCommand)
}

async function performSearch(query: string): Promise<SkillData[]> {
  // Simulate API delay
  await new Promise((resolve) => setTimeout(resolve, 300))

  // Use shared mock data search
  return searchMockSkills(query)
}
