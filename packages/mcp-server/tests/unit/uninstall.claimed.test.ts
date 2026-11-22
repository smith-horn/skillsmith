/**
 * SMI-6531 (A1 step 8-i-a-1, gate Major 2): when another install claimed the
 * skill's name while `uninstall_skill` was removing it, the fan-out links
 * recorded under that name are the new install's. The tool must not tear them
 * down, and says so in the result's warning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  uninstall: vi.fn(),
  removeLinks: vi.fn(),
  scope: 'global' as 'global' | 'workspace',
}))

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
    scope: mocks.scope,
  }),
}))

import { CLAIMED_LINKS_NOTE, uninstallSkill } from '../../src/tools/uninstall.js'
import type { ToolContext } from '../../src/context.js'

const context = {} as ToolContext
const savedClient = process.env['SKILLSMITH_CLIENT']

beforeEach(() => {
  vi.clearAllMocks()
  mocks.scope = 'global'
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

  it('a claimed name on a non-canonical client: no links note (that path owns no links)', async () => {
    mocks.uninstall.mockResolvedValue({
      success: true,
      skillName: 's',
      message: 'parked',
      claimedByAnotherInstall: true,
    })
    const r = await uninstallSkill({ skillName: 's', force: true, client: 'cursor' }, context)
    expect(r.success).toBe(true)
    expect(r.message).toBe('parked')
    expect(mocks.removeLinks).not.toHaveBeenCalled()
    expect(r.warning ?? '').not.toContain(CLAIMED_LINKS_NOTE)
  })

  it('a claimed name at workspace scope on the canonical client: no links note, no teardown', async () => {
    mocks.scope = 'workspace'
    mocks.uninstall.mockResolvedValue({
      success: true,
      skillName: 's',
      message: 'parked',
      claimedByAnotherInstall: true,
    })
    const r = await uninstallSkill({ skillName: 's', force: true }, context)
    expect(r.success).toBe(true)
    expect(r.message).toBe('parked')
    expect(mocks.removeLinks).not.toHaveBeenCalled()
    expect(r.warning ?? '').not.toContain(CLAIMED_LINKS_NOTE)
  })

  it('a link teardown that throws leaves the uninstall successful and says so in the warning', async () => {
    mocks.removeLinks.mockRejectedValue(new Error('manifest unreadable'))
    mocks.uninstall.mockResolvedValue({
      success: true,
      skillName: 's',
      message: 'parked',
      warning: 'earlier note',
    })
    const r = await uninstallSkill({ skillName: 's', force: true }, context)
    expect(mocks.removeLinks).toHaveBeenCalledWith('s')
    expect(r.success).toBe(true)
    expect(r.warning).toBe(
      'earlier note; could not clean up cross-client links: manifest unreadable'
    )
  })

  it('a link teardown that throws with no earlier warning: the note alone is the warning', async () => {
    mocks.removeLinks.mockRejectedValue(new Error('manifest unreadable'))
    mocks.uninstall.mockResolvedValue({ success: true, skillName: 's', message: 'parked' })
    const r = await uninstallSkill({ skillName: 's', force: true }, context)
    expect(mocks.removeLinks).toHaveBeenCalledWith('s')
    expect(r.success).toBe(true)
    expect(r.warning).toBe('could not clean up cross-client links: manifest unreadable')
  })

  it('a link teardown that rejects with a non-Error: its string form is reported', async () => {
    mocks.removeLinks.mockRejectedValue('lock busy')
    mocks.uninstall.mockResolvedValue({ success: true, skillName: 's', message: 'parked' })
    const r = await uninstallSkill({ skillName: 's', force: true }, context)
    expect(mocks.removeLinks).toHaveBeenCalledWith('s')
    expect(r.success).toBe(true)
    expect(r.warning).toBe('could not clean up cross-client links: lock busy')
  })

  it('control: an unclaimed global uninstall still tears the links down', async () => {
    mocks.uninstall.mockResolvedValue({ success: true, skillName: 's', message: 'parked' })
    const r = await uninstallSkill({ skillName: 's', force: true }, context)
    expect(r.success).toBe(true)
    expect(mocks.removeLinks).toHaveBeenCalledWith('s')
    expect(r.warning ?? '').not.toContain(CLAIMED_LINKS_NOTE)
  })
})
