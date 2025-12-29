/**
 * Search skills command implementation
 */
import * as vscode from 'vscode'
import { SkillSearchProvider } from '../providers/SkillSearchProvider.js'
import { searchSkills as searchMockSkills, type SkillData } from '../data/mockSkills.js'
import { getMcpClient } from '../mcp/McpClient.js'

/** Minimum query length for search */
const MIN_QUERY_LENGTH = 2

export function registerSearchCommand(
  context: vscode.ExtensionContext,
  searchProvider: SkillSearchProvider
): void {
  const searchCommand = vscode.commands.registerCommand('skillsmith.searchSkills', async () => {
    // Show search input with validation
    const query = await vscode.window.showInputBox({
      prompt: 'Search for Claude Code skills',
      placeHolder: 'e.g., commit, testing, docker',
      title: 'Skillsmith Search',
      validateInput: (value: string) => {
        if (!value || value.trim().length < MIN_QUERY_LENGTH) {
          return `Please enter at least ${MIN_QUERY_LENGTH} characters`
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
      async (progress: vscode.Progress<{ message?: string; increment?: number }>) => {
        progress.report({ increment: 0 })

        try {
          // Search skills using MCP client with fallback to mock data
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

/**
 * Perform skill search using MCP client with fallback to mock data
 */
async function performSearch(query: string): Promise<SkillData[]> {
  const client = getMcpClient()

  // Try MCP client first if connected
  if (client.isConnected()) {
    try {
      const response = await client.search(query)

      // Convert MCP response to SkillData format
      return response.results.map((result) => ({
        id: result.id,
        name: result.name,
        description: result.description,
        author: result.author,
        category: result.category,
        trustTier: result.trustTier,
        score: result.score,
        // Repository is not in search results, will be fetched with get_skill
      }))
    } catch (error) {
      console.warn('[Skillsmith] MCP search failed, falling back to mock data:', error)
      // Fall through to mock data
    }
  }

  // Fallback to mock data when not connected or on error
  console.log('[Skillsmith] Using mock data for search')

  // Simulate API delay for consistency
  await new Promise((resolve) => setTimeout(resolve, 100))

  return searchMockSkills(query)
}
