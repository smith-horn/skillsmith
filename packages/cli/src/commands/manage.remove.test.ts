/**
 * SMI-6531 (A1 step 8-i-a-1): `skillsmith remove` maps core's uninstall result
 * to three outcomes and exits 0, 1 or 4 (UD32), runs the fan-out teardown only
 * on a removal, and prints the park-result path's lines on stderr.
 */
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  uninstallFn: vi.fn(),
  removeLinks: vi.fn(),
  fail: vi.fn(),
  succeed: vi.fn(),
}))

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: mocks.succeed,
    fail: mocks.fail,
    text: '',
  })),
}))
vi.mock('../utils/open-database.js', () => ({
  openCliDatabase: vi.fn(async () => ({ close: vi.fn() })),
}))
vi.mock('@skillsmith/core/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@skillsmith/core/install')>()),
  removeLinks: mocks.removeLinks,
}))
vi.mock('@skillsmith/core', () => ({
  SkillRepository: vi.fn().mockImplementation(function () {
    return {}
  }),
  SkillDependencyRepository: vi.fn().mockImplementation(function () {
    return {}
  }),
  SkillInstallationService: vi.fn().mockImplementation(function () {
    return { uninstall: mocks.uninstallFn }
  }),
}))

import { printParkResultLines, removeExitCode, removeSkill } from './manage.remove.js'

const dbPath = path.join(os.tmpdir(), `manage-remove-${process.pid}`, 'skills.db')
const scope = {
  dir: path.join(os.tmpdir(), 'skills'),
  scope: 'global',
  manifestPath: path.join(os.tmpdir(), 'manifest.json'),
} as Parameters<typeof removeSkill>[4]
const run = () => removeSkill('s', true, dbPath, 'claude-code', scope)

let errors: string[] = []
let logs: string[] = []
beforeEach(() => {
  vi.clearAllMocks()
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.join(' ')))
  logs = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')))
  mocks.removeLinks.mockResolvedValue({ removed: 0, refused: [], warnings: [] })
})
afterEach(() => vi.restoreAllMocks())

describe('the exit status (UD32)', () => {
  it('maps removed to 0, failed to 1 and not-done to 4', () => {
    expect([
      removeExitCode('removed'),
      removeExitCode('failed'),
      removeExitCode('not-done'),
    ]).toEqual([0, 1, 4])
  })
})

describe('removeSkill', () => {
  it('a park that did not finish is not-done (exit 4); no fan-out teardown', async () => {
    mocks.uninstallFn.mockResolvedValue({
      success: false,
      skillName: 's',
      message: 'Skill "s" was not uninstalled: setting aside /x ended kept (identity-changed).',
      notDone: { path: '/x', status: 'kept', reason: 'identity-changed', restoreCommand: 'r' },
    })
    const outcome = await run()
    expect(outcome).toBe('not-done')
    expect(removeExitCode(outcome)).toBe(4)
    expect(mocks.fail).toHaveBeenCalledTimes(1)
    expect(mocks.removeLinks).not.toHaveBeenCalled()
  })

  it('a name another install claimed: removed, its fan-out links left alone, a warning', async () => {
    mocks.uninstallFn.mockResolvedValue({
      success: true,
      skillName: 's',
      message: 'parked',
      claimedByAnotherInstall: true,
    })
    const outcome = await run()
    expect(outcome).toBe('removed')
    expect(mocks.removeLinks).not.toHaveBeenCalled()
    expect(logs.join('\n')).toContain('cross-client links were left in place for that install')
  })

  it('a claimed name on a non-canonical client: no links note (that path owns no links)', async () => {
    mocks.uninstallFn.mockResolvedValue({
      success: true,
      skillName: 's',
      message: 'parked',
      claimedByAnotherInstall: true,
    })
    const outcome = await removeSkill('s', true, dbPath, 'cursor', scope)
    expect(outcome).toBe('removed')
    expect(mocks.succeed).toHaveBeenCalledWith('parked')
    expect(mocks.removeLinks).not.toHaveBeenCalled()
    expect(logs.join('\n')).not.toContain('cross-client links were left in place')
  })

  it('a claimed name at workspace scope on the canonical client: no links note, no teardown', async () => {
    mocks.uninstallFn.mockResolvedValue({
      success: true,
      skillName: 's',
      message: 'parked',
      claimedByAnotherInstall: true,
    })
    const workspace = { ...scope, scope: 'workspace' } as Parameters<typeof removeSkill>[4]
    const outcome = await removeSkill('s', true, dbPath, 'claude-code', workspace)
    expect(outcome).toBe('removed')
    expect(mocks.succeed).toHaveBeenCalledWith('parked')
    expect(mocks.removeLinks).not.toHaveBeenCalled()
    expect(logs.join('\n')).not.toContain('cross-client links were left in place')
  })

  it('an existing refusal is failed (exit 1)', async () => {
    mocks.uninstallFn.mockResolvedValue({ success: false, skillName: 's', message: 'refused' })
    const outcome = await run()
    expect(outcome).toBe('failed')
    expect(removeExitCode(outcome)).toBe(1)
  })

  it('a parked uninstall is removed (exit 0), prints its line, and tears down fan-out', async () => {
    mocks.uninstallFn.mockResolvedValue({
      success: true,
      skillName: 's',
      message: 'parked, see `skillsmith doctor backups --prune --op abc`',
      usageWarning: "Skillsmith's set-aside folders on this disk hold 2 GB",
      hints: ['hint: one'],
    })
    const outcome = await run()
    expect(outcome).toBe('removed')
    expect(mocks.succeed).toHaveBeenCalledWith(
      'parked, see `skillsmith doctor backups --prune --op abc`'
    )
    expect(mocks.removeLinks).toHaveBeenCalledWith('s')
    expect(errors).toEqual(["Skillsmith's set-aside folders on this disk hold 2 GB", 'hint: one'])
  })

  it('a not-done uninstall still prints the warning once', async () => {
    mocks.uninstallFn.mockResolvedValue({
      success: false,
      skillName: 's',
      message: 'not done',
      notDone: { path: '/x', status: 'held', reason: 'changed-during-move', parkedPath: '/p' },
      usageWarning: 'set-aside folders: over',
    })
    await run()
    expect(errors.filter((e) => e === 'set-aside folders: over')).toHaveLength(1)
  })
})

describe('printParkResultLines', () => {
  it('prints nothing when there is nothing to say', () => {
    printParkResultLines({})
    expect(errors).toEqual([])
  })
})
