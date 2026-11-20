/**
 * SMI-6531 (A1 step 8-i-a-1, gate Major 2): when another install claimed the
 * skill's name while `uninstall_skill` was removing it, the fan-out links
 * recorded under that name are the new install's. The tool must not tear them
 * down, and says so in the result's warning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ uninstall: vi.fn(), removeLinks: vi.fn() }))

vi.mock('@skillsmith/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@skillsmith/core')>()),
  SkillInstallationService: vi.fn().mockImplementation(function () {
    return { uninstall: mocks.uninstall }
  }),
}))
vi.mock('@skillsmith/core/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@skillsmith/core/install')>()),
  removeLinks: mocks.removeLinks,
  resolveScopedSkillsDir: () => ({
    dir: '/nonexistent/skills',
    manifestPath: '/nonexistent/manifest.json',
    scope: 'global',
  }),
}))

import { CLAIMED_LINKS_NOTE, uninstallSkill } from '../../src/tools/uninstall.js'
import type { ToolContext } from '../../src/context.js'

const context = {} as ToolContext
const savedClient = process.env['SKILLSMITH_CLIENT']

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env['SKILLSMITH_CLIENT']
  mocks.removeLinks.mockResolvedValue({ removed: 1, refused: [], warnings: [] })
})
afterEach(() => {
  if (savedClient === undefined) delete process.env['SKILLSMITH_CLIENT']
  else process.env['SKILLSMITH_CLIENT'] = savedClient
})

describe('uninstall_skill and a name another install claimed', () => {
  it('leaves the fan-out links alone and says why', async () => {
    mocks.uninstall.mockResolvedValue({
      success: true,
      skillName: 's',
      message: 'parked',
      claimedByAnotherInstall: true,
    })
    const r = await uninstallSkill({ skillName: 's', force: true }, context)
    expect(r.success).toBe(true)
    expect(mocks.removeLinks).not.toHaveBeenCalled()
    expect(r.warning).toContain(CLAIMED_LINKS_NOTE)
  })

  it('control: an unclaimed global uninstall still tears the links down', async () => {
    mocks.uninstall.mockResolvedValue({ success: true, skillName: 's', message: 'parked' })
    const r = await uninstallSkill({ skillName: 's', force: true }, context)
    expect(r.success).toBe(true)
    expect(mocks.removeLinks).toHaveBeenCalledWith('s')
    expect(r.warning ?? '').not.toContain(CLAIMED_LINKS_NOTE)
  })
})
