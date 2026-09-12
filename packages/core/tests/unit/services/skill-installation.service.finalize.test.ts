/**
 * @fileoverview Direct unit tests for finalizeSuccessfulInstall()'s
 * best-effort boundary around co-install-session recording.
 * @see SMI-6529 N4 (round 4)
 *
 * probe-finalize.mjs (reviewer): `recordSessionCoInstalls` used to run AFTER
 * the manifest write, OUTSIDE any try/catch — a throw from it (e.g. a SQLite
 * busy/lock error) propagated out of `finalizeSuccessfulInstall()` even
 * though the manifest update had ALREADY committed successfully. The caller
 * (`service.ts`) treats any exception from this function as "undo the
 * write," so an unrelated co-install-recording hiccup rolled back files and
 * a manifest entry that were both already correct.
 */
import { describe, it, expect, vi } from 'vitest'
import { finalizeSuccessfulInstall } from '../../../src/services/skill-installation.service.finalize.js'
import type { FinalizeInstallParams } from '../../../src/services/skill-installation.service.finalize.js'
import type { ManifestManager } from '../../../src/services/skill-manifest.js'
import type { SkillDependencyRepository } from '../../../src/repositories/SkillDependencyRepository.js'
import type { CoInstallRecorder } from '../../../src/services/skill-installation.types.js'

function buildParams(overrides: Partial<FinalizeInstallParams> = {}): FinalizeInstallParams {
  const updateSafely = vi.fn(
    async (updateFn: (m: { installedSkills: Record<string, unknown> }) => unknown) => {
      updateFn({ installedSkills: {} })
    }
  )
  const manifest = { updateSafely } as unknown as ManifestManager
  const skillDependencyRepo = {
    setDependencies: vi.fn(),
  } as unknown as SkillDependencyRepository

  return {
    manifest,
    coInstallRecorder: undefined,
    sessionInstalledSkillIds: [],
    skillDependencyRepo,
    quarantineLookup: undefined,
    riskHistoryRepo: undefined,
    aiDefenceFeedback: undefined,
    onProgress: () => {},
    client: 'claude-code',
    skillsDir: '/tmp/skills',
    skillId: 'author/my-skill',
    owner: 'author',
    repo: 'my-skill',
    skillName: 'my-skill',
    installPath: '/tmp/skills/my-skill',
    manifestKey: 'my-skill',
    contentHash: 'abc123',
    skillMdContent: '# my-skill\n',
    optimizationInfo: { optimized: false },
    securityReport: undefined,
    configWarnings: [],
    skipScanRequested: undefined,
    contentHashMismatch: false,
    trustTier: 'community',
    ...overrides,
  } as FinalizeInstallParams
}

describe('finalizeSuccessfulInstall (SMI-6529 N4)', () => {
  // SMI-6529 round 28 (pre-merge gate, PR-07): these three catches stayed
  // best-effort — the install succeeded and must not be undone — but they were
  // SILENT, so an operator had no sign that bookkeeping was incomplete. They
  // now ride the result's own tips channel.
  it('reports best-effort bookkeeping it could not complete, instead of swallowing it', async () => {
    const throwingRecorder: CoInstallRecorder = {
      recordSessionCoInstalls: vi.fn(() => {
        throw new Error('simulated SQLite busy/lock error')
      }),
    }
    const params = buildParams({
      coInstallRecorder: throwingRecorder,
      // The lookup is only consulted for servers the content actually
      // references, so the fixture has to name one (mcp__<server>__<tool>).
      skillMdContent: '# my-skill\n\nUse mcp__linear__save_issue to file it.\n',
      quarantineLookup: () => {
        throw new Error('quarantine store unavailable')
      },
    })

    const result = await finalizeSuccessfulInstall(params)

    // Still a successful install: the fix makes it audible, not fatal.
    expect(result.success).toBe(true)
    const tips = (result.tips ?? []).join('\n')
    expect(tips).toContain('co-install session tracking was not recorded')
    // The one that matters most: a failed quarantine check is not a clean one.
    expect(tips).toContain('could not be checked against the quarantine list')
  })

  // Round 29 (gate confirmation): the previous test covered two of the three
  // best-effort catches. Dependency persistence had none, so reverting that
  // catch alone would not have failed anything.
  it('reports dependency intelligence it could not persist', async () => {
    const throwingRepo = {
      setDependencies: vi.fn(() => {
        throw new Error('dependency table is locked')
      }),
    } as unknown as SkillDependencyRepository
    const params = buildParams({
      skillDependencyRepo: throwingRepo,
      // persistDependencies returns early when nothing merges, so the content
      // has to reference a server for the repo to be touched at all.
      skillMdContent: '# my-skill\n\nUse mcp__linear__save_issue to file it.\n',
    })

    const result = await finalizeSuccessfulInstall(params)

    expect(result.success).toBe(true)
    expect((result.tips ?? []).join('\n')).toContain('dependency intelligence was not persisted')
  })

  it('N4: a throwing coInstallRecorder does NOT fail the install — manifest write already committed', async () => {
    const throwingRecorder: CoInstallRecorder = {
      recordSessionCoInstalls: vi.fn(() => {
        throw new Error('simulated SQLite busy/lock error')
      }),
    }
    const params = buildParams({ coInstallRecorder: throwingRecorder })

    const result = await finalizeSuccessfulInstall(params)

    expect(result.success).toBe(true)
    expect(result.skillId).toBe('author/my-skill')
    // The manifest write ran (and committed) before the recorder was ever
    // invoked — proven via the updateSafely spy having been called exactly
    // once, with no exception surfacing from this call at all.
    expect(
      (params.manifest as unknown as { updateSafely: ReturnType<typeof vi.fn> }).updateSafely
    ).toHaveBeenCalledTimes(1)
    expect(throwingRecorder.recordSessionCoInstalls).toHaveBeenCalledTimes(1)
  })

  it('N4: a throwing coInstallRecorder does not push the failed skillId onto sessionInstalledSkillIds', async () => {
    const throwingRecorder: CoInstallRecorder = {
      recordSessionCoInstalls: vi.fn(() => {
        throw new Error('simulated SQLite busy/lock error')
      }),
    }
    const sessionInstalledSkillIds: string[] = ['already-installed-this-session']
    const params = buildParams({ coInstallRecorder: throwingRecorder, sessionInstalledSkillIds })

    await finalizeSuccessfulInstall(params)

    // The push only happens AFTER recordSessionCoInstalls succeeds — a throw
    // must leave the session list exactly as it was, not silently claim this
    // skill was recorded.
    expect(sessionInstalledSkillIds).toEqual(['already-installed-this-session'])
  })

  it('a NON-throwing coInstallRecorder still records normally (no regression)', async () => {
    const recordSessionCoInstalls = vi.fn()
    const recorder: CoInstallRecorder = { recordSessionCoInstalls }
    const sessionInstalledSkillIds: string[] = []
    const params = buildParams({ coInstallRecorder: recorder, sessionInstalledSkillIds })

    const result = await finalizeSuccessfulInstall(params)

    expect(result.success).toBe(true)
    expect(recordSessionCoInstalls).toHaveBeenCalledWith(['author/my-skill'])
    expect(sessionInstalledSkillIds).toEqual(['author/my-skill'])
  })

  it('a throwing manifest.updateSafely still propagates (only the manifest write may fail the install)', async () => {
    const params = buildParams()
    ;(params.manifest as unknown as { updateSafely: () => Promise<void> }).updateSafely = vi
      .fn()
      .mockRejectedValue(new Error('simulated manifest write failure'))

    await expect(finalizeSuccessfulInstall(params)).rejects.toThrow(
      'simulated manifest write failure'
    )
  })
})
