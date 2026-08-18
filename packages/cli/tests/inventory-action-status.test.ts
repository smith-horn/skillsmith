/**
 * SMI-6060 (GPT-5.6-Sol review follow-up): `inventory status`'s "Local skills:"
 * line hand-typed the literal `./.claude/skills`, the exact same drift bug
 * this wave's `manage`/`list` footer fix (manage.test.ts) closed off — found
 * as a sibling-implementation gap during review and fixed at this call site
 * too. Regression guard asserts the actual printed line, not an internal
 * call spy.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@skillsmith/core', () => ({
  getDeviceId: vi.fn(() => undefined),
  getLastInventoryPushAt: vi.fn(() => undefined),
  isInventorySyncDisabledLocally: vi.fn(() => false),
  pushInventory: vi.fn(),
  purgeInventory: vi.fn(),
  forgetDevice: vi.fn(),
  InventoryAuthError: class InventoryAuthError extends Error {},
  InventoryConflictError: class InventoryConflictError extends Error {},
  InventoryValidationError: class InventoryValidationError extends Error {},
  InventoryUploadError: class InventoryUploadError extends Error {},
}))

vi.mock('@skillsmith/core/install', () => ({
  enumerateHarnessPresence: vi.fn(() => []),
}))

vi.mock('../src/utils/skills-directory.js', () => ({
  getInstalledSkillsPerHarness: vi.fn(async () => [
    { harness: 'local', skillId: 'local/test-skill' },
  ]),
}))

describe("inventory status — 'Local skills:' line (SMI-6060)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints the relative display path, not a hardcoded literal or absolute path', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    const { runStatus } = await import('../src/commands/inventory.action.js')
    await runStatus()

    const allOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(allOutput).toContain('1 skill in ./.claude/skills (repo-local')
    expect(allOutput).not.toContain(process.cwd() + '/.claude/skills')
  })
})
