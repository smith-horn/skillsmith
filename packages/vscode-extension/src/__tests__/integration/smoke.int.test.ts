import * as assert from 'node:assert'
import * as vscode from 'vscode'

suite('Skillsmith Extension Activation', () => {
  test('extension activates', async () => {
    const ext = vscode.extensions.getExtension('skillsmith.skillsmith-vscode')
    assert.ok(ext, 'extension not found')
    await ext.activate()
    assert.strictEqual(ext.isActive, true)
  })

  test('registers core commands', async () => {
    const commands = await vscode.commands.getCommands(true)
    assert.ok(commands.includes('skillsmith.searchSkills'))
    assert.ok(commands.includes('skillsmith.installSkill'))
  })
})
