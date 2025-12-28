/**
 * Search skills command implementation
 */
import * as vscode from 'vscode'
import { SkillSearchProvider, SearchResultItem } from '../providers/SkillSearchProvider.js'

// Mock data for MVP - will be replaced with actual API calls
const MOCK_SKILLS: SearchResultItem[] = [
  {
    id: 'governance',
    name: 'Governance',
    description:
      'Enforces engineering standards from standards.md. Ensures code quality and best practices.',
    author: 'skillsmith',
    category: 'development',
    trustTier: 'verified',
    score: 95,
    repository: 'https://github.com/skillsmith/governance-skill',
  },
  {
    id: 'linear-integration',
    name: 'Linear Integration',
    description:
      'Manages Linear issues, projects, and workflows. Sync tasks directly from VS Code.',
    author: 'skillsmith',
    category: 'productivity',
    trustTier: 'verified',
    score: 92,
    repository: 'https://github.com/skillsmith/linear-skill',
  },
  {
    id: 'docker-manager',
    name: 'Docker Manager',
    description: 'Container-based development for isolated, reproducible environments.',
    author: 'community',
    category: 'devops',
    trustTier: 'community',
    score: 88,
    repository: 'https://github.com/community/docker-skill',
  },
  {
    id: 'test-generator',
    name: 'Test Generator',
    description: 'Automatically generates unit tests for your code using AI.',
    author: 'skillsmith',
    category: 'testing',
    trustTier: 'standard',
    score: 85,
    repository: 'https://github.com/skillsmith/test-generator-skill',
  },
  {
    id: 'api-docs',
    name: 'API Documentation',
    description: 'Generates comprehensive API documentation from code comments and types.',
    author: 'community',
    category: 'documentation',
    trustTier: 'community',
    score: 82,
    repository: 'https://github.com/community/api-docs-skill',
  },
]

export function registerSearchCommand(
  context: vscode.ExtensionContext,
  searchProvider: SkillSearchProvider
): void {
  const searchCommand = vscode.commands.registerCommand('skillsmith.searchSkills', async () => {
    // Show search input
    const query = await vscode.window.showInputBox({
      prompt: 'Search for Claude Code skills',
      placeHolder: 'e.g., docker, testing, documentation',
      title: 'Skillsmith Search',
    })

    if (!query) {
      return
    }

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
          const results = await searchSkills(query)

          progress.report({ increment: 100 })

          if (results.length === 0) {
            vscode.window.showInformationMessage(`No skills found for "${query}"`)
            searchProvider.clearResults()
            return
          }

          // Update search results view
          searchProvider.setResults(results, query)

          // Focus on search results view
          await vscode.commands.executeCommand('skillsmith.searchView.focus')

          vscode.window.showInformationMessage(
            `Found ${results.length} skill${results.length === 1 ? '' : 's'} for "${query}"`
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

async function searchSkills(query: string): Promise<SearchResultItem[]> {
  // Simulate API delay
  await new Promise((resolve) => setTimeout(resolve, 500))

  const normalizedQuery = query.toLowerCase()

  // Filter mock skills based on query
  return MOCK_SKILLS.filter((skill) => {
    return (
      skill.name.toLowerCase().includes(normalizedQuery) ||
      skill.description.toLowerCase().includes(normalizedQuery) ||
      skill.category.toLowerCase().includes(normalizedQuery) ||
      skill.author.toLowerCase().includes(normalizedQuery)
    )
  })
}

// TODO: Replace with actual API call when backend is ready
// async function searchSkillsFromAPI(query: string): Promise<SearchResultItem[]> {
//   const config = vscode.workspace.getConfiguration('skillsmith');
//   const endpoint = config.get<string>('apiEndpoint') || 'https://api.skillsmith.dev';
//
//   const response = await fetch(`${endpoint}/search?q=${encodeURIComponent(query)}`);
//   if (!response.ok) {
//     throw new Error(`API error: ${response.statusText}`);
//   }
//
//   const data = await response.json();
//   return data.results;
// }
