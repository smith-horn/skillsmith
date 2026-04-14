import * as assert from 'node:assert'
import * as vscode from 'vscode'

suite('Skillsmith: Create Skill command (SMI-4196)', () => {
  test('command is registered', async () => {
    const commands = await vscode.commands.getCommands(true)
    assert.ok(
      commands.includes('skillsmith.createSkill'),
      'skillsmith.createSkill should be registered'
    )
  })

  // Full wizard flow (InputBox × 3 + QuickPick + CLI spawn) requires mocking
  // stdin and is exercised by the unit test suite in
  // src/__tests__/createSkillCommand.test.ts against a real cross-spawn mock.
  // The Extension Host integration layer only asserts command registration.
})
