/**
 * Skillsmith VS Code Extension
 * Provides skill discovery and installation directly in VS Code
 */
import * as vscode from 'vscode'
import { SkillTreeProvider } from './providers/SkillTreeProvider.js'
import { SkillSearchProvider } from './providers/SkillSearchProvider.js'
import { registerSearchCommand } from './commands/searchSkills.js'
import { registerInstallCommand } from './commands/installSkill.js'
import { SkillDetailPanel } from './views/SkillDetailPanel.js'

let skillTreeProvider: SkillTreeProvider
let skillSearchProvider: SkillSearchProvider

export function activate(context: vscode.ExtensionContext) {
  console.log('Skillsmith extension is now active')

  // Initialize providers
  skillTreeProvider = new SkillTreeProvider()
  skillSearchProvider = new SkillSearchProvider()

  // Register tree views
  const skillsView = vscode.window.createTreeView('skillsmith.skillsView', {
    treeDataProvider: skillTreeProvider,
    showCollapseAll: true,
  })

  const searchView = vscode.window.createTreeView('skillsmith.searchView', {
    treeDataProvider: skillSearchProvider,
    showCollapseAll: true,
  })

  context.subscriptions.push(skillsView, searchView)

  // Register commands
  registerSearchCommand(context, skillSearchProvider)
  registerInstallCommand(context, skillSearchProvider)

  // Register refresh command
  const refreshCommand = vscode.commands.registerCommand('skillsmith.refreshSkills', () => {
    skillTreeProvider.refresh()
    vscode.window.showInformationMessage('Skills refreshed')
  })

  // Register view details command
  const viewDetailsCommand = vscode.commands.registerCommand(
    'skillsmith.viewSkillDetails',
    (skillId: string) => {
      SkillDetailPanel.createOrShow(context.extensionUri, skillId)
    }
  )

  context.subscriptions.push(refreshCommand, viewDetailsCommand)

  // Show welcome message on first activation
  const hasShownWelcome = context.globalState.get('skillsmith.welcomeShown')
  if (!hasShownWelcome) {
    vscode.window
      .showInformationMessage(
        'Welcome to Skillsmith! Search for Claude Code skills using Cmd+Shift+P.',
        'Search Skills'
      )
      .then((selection) => {
        if (selection === 'Search Skills') {
          vscode.commands.executeCommand('skillsmith.searchSkills')
        }
      })
    context.globalState.update('skillsmith.welcomeShown', true)
  }
}

export function deactivate() {
  console.log('Skillsmith extension deactivated')
}

// Export providers for testing
export { skillTreeProvider, skillSearchProvider }
