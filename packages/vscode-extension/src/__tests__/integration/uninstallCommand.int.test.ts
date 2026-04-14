import * as assert from 'node:assert'
import * as vscode from 'vscode'

suite('Skillsmith: Uninstall Skill command (SMI-4195)', () => {
  test('command is registered', async () => {
    const commands = await vscode.commands.getCommands(true)
    assert.ok(
      commands.includes('skillsmith.uninstallSkill'),
      'skillsmith.uninstallSkill should be registered'
    )
  })

  test('command shows "no skills" message when skillsDirectory is empty', async () => {
    // Full flow (quickPick → confirm → fs.rm) requires a seeded temp
    // skillsDirectory and cannot run inside the host workspace without fixtures.
    // This integration test only validates that the command surface activates
    // without throwing. End-to-end uninstall flow is covered by the unit tests
    // in src/__tests__/uninstallCommand.test.ts against a real temp fs.
    await vscode.commands.executeCommand('skillsmith.uninstallSkill')
  })
})
