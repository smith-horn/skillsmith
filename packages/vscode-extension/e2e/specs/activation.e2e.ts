/**
 * Activation smoke (SMI-5331, Phase 2a). The cheapest, most stable spec — also a
 * harness-liveness canary. Coverage of activation + command registration overlaps
 * the in-process `@vscode/test-electron` integration suite
 * (src/__tests__/integration/smoke.int.test.ts); the net-new value of the wdio
 * suite is the webview/modal layer the in-process tests cannot reach.
 */
import { browser, expect } from '@wdio/globals'

const EXTENSION_ID = 'skillsmith.skillsmith-vscode'

// The 13 commands contributed in package.json `contributes.commands`.
const EXPECTED_COMMANDS = [
  'skillsmith.searchSkills',
  'skillsmith.installSkill',
  'skillsmith.refreshSkills',
  'skillsmith.filterSkills',
  'skillsmith.clearSkillFilters',
  'skillsmith.viewSkillDetails',
  'skillsmith.mcpReconnect',
  'skillsmith.createSkill',
  'skillsmith.uninstallSkill',
  'skillsmith.recommendSkills',
  'skillsmith.compareSkills',
  'skillsmith.diffSkill',
  'skillsmith.auditInventory',
]

describe('Skillsmith extension activation', () => {
  it('activates on startup', async () => {
    await browser.waitUntil(
      async () =>
        browser.executeWorkbench(
          (vscode, id) => vscode.extensions.getExtension(id)?.isActive === true,
          EXTENSION_ID
        ),
      { timeout: 30_000, timeoutMsg: 'extension did not activate within 30s' }
    )
    const isActive = await browser.executeWorkbench(
      (vscode, id) => vscode.extensions.getExtension(id)?.isActive === true,
      EXTENSION_ID
    )
    expect(isActive).toBe(true)
  })

  it('registers all 13 contributed commands', async () => {
    const registered: string[] = await browser.executeWorkbench((vscode) =>
      vscode.commands.getCommands(true)
    )
    for (const cmd of EXPECTED_COMMANDS) {
      expect(registered).toContain(cmd)
    }
  })

  it('contributes the Skillsmith activity-bar view container', async () => {
    const workbench = await browser.getWorkbench()
    const control = await workbench.getActivityBar().getViewControl('Skillsmith')
    expect(control).toBeDefined()
  })
})
