/**
 * @fileoverview Unit tests for install_skill MCP tool Zod boundary guard
 * @see SMI-4288: Zod validation guard at MCP tool boundary
 * @see https://github.com/smith-horn/skillsmith/issues/599
 *
 * These tests cover the behaviour introduced by the signature change from
 * `installSkill(input: InstallInput, ...)` to `installSkill(input: unknown, ...)`.
 * The guard protects against malformed MCP payloads (e.g. `{}`,
 * `{ skillId: 123 }`, invalid enum) reaching the core installation service.
 *
 * The happy path mocks `@skillsmith/core` so no real filesystem or network
 * work happens — this file is a unit test for the tool-boundary validation
 * shim, not an integration test for the install flow itself (that lives
 * in `tests/integration/install.integration.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// SMI-4288: Mock the core service so the happy-path test exercises only the
// Zod gate + delegation. `vi.hoisted` is required because `vi.mock` is
// hoisted above regular `const` declarations and would otherwise reference
// the stubs before they are initialised.
// SMI-6585 cross-model review: `checkInstallTarget` was reached through the
// `...actual` passthrough, so no test could make the TARGET GUARD itself
// throw — only the manifest load. That left three of the pre-flight's four
// throw sources uncovered, and a regression that reported manifest failures
// while silently losing guard failures would have passed. It is stubbed here,
// defaulting to the same `{ ok: true }` the real guard returns for these
// fixtures, so existing tests are unaffected and the throw path is reachable.
const { mockInstall, mockEmitInstallEvent, mockCheckInstallTarget } = vi.hoisted(() => ({
  mockInstall: vi.fn(),
  mockEmitInstallEvent: vi.fn(),
  mockCheckInstallTarget: vi.fn(),
}))

vi.mock('@skillsmith/core', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  class MockSkillInstallationService {
    install = mockInstall
  }
  return {
    ...actual,
    SkillInstallationService: MockSkillInstallationService,
    emitInstallEvent: mockEmitInstallEvent,
    checkInstallTarget: mockCheckInstallTarget,
  }
})

// Prevent getToolContext() from throwing when no context is passed — the
// installSkill helper calls it before delegating. A minimal stub is enough
// because the mocked SkillInstallationService ignores the params.
vi.mock('../context.js', () => ({
  getToolContext: vi.fn().mockReturnValue({
    db: {},
    skillRepository: {},
    skillDependencyRepository: {},
    coInstallRepository: undefined,
    sessionInstalledSkillIds: [],
  }),
}))

// SMI-4288: Mock install.helpers so the conflict-preflight path exercises
// deterministic behaviour. Each test configures loadManifest explicitly.
const { mockLoadManifest, mockLookupSkillFromRegistry } = vi.hoisted(() => ({
  mockLoadManifest: vi.fn(),
  mockLookupSkillFromRegistry: vi.fn(),
}))

vi.mock('./install.helpers.js', () => ({
  loadManifest: mockLoadManifest,
  lookupSkillFromRegistry: mockLookupSkillFromRegistry,
}))

// Conflict check helper — return a shouldProceed:true stub so the flow
// falls through to the core service unless a test overrides.
const { mockCheckForConflicts } = vi.hoisted(() => ({
  mockCheckForConflicts: vi.fn(),
}))

vi.mock('./install.conflict.js', () => ({
  checkForConflicts: mockCheckForConflicts,
}))

// SMI-4588 Wave 2 PR #3 added a pre-flight namespace gate (`runNamespaceGate`)
// to the install hot path. Without mocking it, the gate scans the test
// runner's real `~/.claude` and may surface false-positive collisions that
// block the install in `preventative` mode (the `community`-tier default).
// Mock it to a deterministic `proceed` decision so this test stays focused
// on the Zod boundary guard. PR #4 adds this mock to repair the
// post-merge-verify regression introduced by PR #3 (install.test.ts left
// without a gate stub when install.ts gained the runNamespaceGate call).
const { mockRunNamespaceGate } = vi.hoisted(() => ({
  mockRunNamespaceGate: vi.fn(),
}))

// SMI-6529 N5 (round 4): `buildPreflightCandidate`/`resolveCallerTier`/
// `readAuditModeOverride`/`extractSkillName` moved into this module (to
// keep install.ts under the 500-line gate) — install.ts now imports ALL of
// them from here, so this mock must pass those four through via
// `importActual` (pure, deterministic, no side effects) and only override
// `runNamespaceGate` itself.
vi.mock('./install.namespace-gate.js', async (importActual) => {
  const actual = await importActual<typeof import('./install.namespace-gate.js')>()
  return {
    ...actual,
    runNamespaceGate: mockRunNamespaceGate,
  }
})

// ADR-139 (SMI-6274 Wave 4) / GPT-5.6-Sol PR review: installSkillImpl now
// resolves global-vs-workspace scope via resolveScopedSkillsDir() (real
// filesystem ancestor walk when unmocked). Left unmocked, this test's
// resolved scope would depend on whatever real `.claude/skills` marker or
// `.git` boundary happens to exist above the test runner's actual
// invocation cwd — the exact cwd-dependent fragility class a prior PR
// review round on this same PR caught in a sibling CLI test file
// (manage.skills-directory.test.ts / manage.test.ts). Every test in this
// file assumes the pre-ADR-139 "always global" behavior (the conflict
// pre-flight tests below specifically require scope === 'global' to run at
// all — see install.ts's own gate), so this is mocked deterministically to
// 'global' regardless of the real filesystem/invocation directory.
const { mockResolveScopedSkillsDir } = vi.hoisted(() => ({
  mockResolveScopedSkillsDir: vi.fn(),
}))

vi.mock('@skillsmith/core/install', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    resolveScopedSkillsDir: mockResolveScopedSkillsDir,
  }
})

import { installSkill, extractSkillName } from './install.js'
import type { InstallResult } from './install.types.js'

const HAPPY_RESULT: InstallResult = {
  success: true,
  skillId: 'owner/repo/test-skill',
  installPath: '/tmp/mock/test-skill',
}

describe('installSkill() Zod boundary guard (SMI-4288 / #599)', () => {
  beforeEach(() => {
    mockInstall.mockReset()
    mockEmitInstallEvent.mockReset()
    mockLoadManifest.mockReset()
    mockLookupSkillFromRegistry.mockReset()
    mockCheckForConflicts.mockReset()
    mockRunNamespaceGate.mockReset()
    mockResolveScopedSkillsDir.mockReset()
    // SMI-6585: the target guard is stubbed so its throw path is reachable.
    // It MUST carry a default — a bare `vi.fn()` returns `undefined`, and the
    // caller's `if (!targetCheck.ok)` would then throw into the very catch
    // these tests exercise, quietly adding a tip to every other test in the
    // file.
    //
    // SMI-6588: `preExisted` is part of the contract's ok-branch
    // (`{ ok: true; preExisted: boolean }`). `install.ts` does not read it
    // today, which is exactly why omitting it was safe AND wrong: the suite
    // would stay green on the day someone does, handing them `undefined`.
    // A mock must not be a looser shape than the thing it stands in for.
    mockCheckInstallTarget.mockReset()
    mockCheckInstallTarget.mockResolvedValue({ ok: true, preExisted: false })
    // ADR-139: deterministic global scope — see the mock's own comment above.
    mockResolveScopedSkillsDir.mockReturnValue({
      scope: 'global',
      dir: '/mock/skills-dir',
      manifestPath: '/mock/manifest.json',
      created: false,
    })
    mockInstall.mockResolvedValue(HAPPY_RESULT)
    // By default no conflict preflight interception.
    mockLoadManifest.mockResolvedValue({ version: '1', installedSkills: {} })
    mockCheckForConflicts.mockResolvedValue({ shouldProceed: true })
    // SMI-4588 Wave 2 PR #3: default the namespace gate to `proceed` with
    // no warnings/pending so the Zod boundary tests remain focused on
    // validation behavior. Tests that need the blocking path can override.
    // SMI-6588: `problems: []` is the "the gate ran and had nothing to say"
    // shape. It is non-optional on the real type for the same reason it is
    // spelled out here — an absent field would be indistinguishable from a
    // gate that never ran.
    mockRunNamespaceGate.mockResolvedValue({
      decision: 'proceed',
      candidate: { identifier: 'test', projectedSourcePath: '/tmp/test' },
      preflight: { warnings: [], pendingCollision: null, auditId: 'mock-audit-id' },
      resultPatch: { installComplete: true },
      problems: [],
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('happy path', () => {
    it('delegates a valid InstallInput to SkillInstallationService.install', async () => {
      const result = await installSkill({
        skillId: 'owner/repo/test-skill',
        force: false,
        skipScan: true,
        skipOptimize: true,
        confirmed: true,
      })

      expect(result).toEqual(HAPPY_RESULT)
      expect(mockInstall).toHaveBeenCalledTimes(1)
      expect(mockInstall).toHaveBeenCalledWith('owner/repo/test-skill', {
        force: false,
        skipScan: true,
        skipOptimize: true,
        conflictAction: undefined,
        confirmed: true,
      })
    })
  })

  describe('validation failures return structured InstallResult', () => {
    it('rejects undefined input with success: false and surfaces the Zod issue', async () => {
      const result = await installSkill(undefined)

      expect(result.success).toBe(false)
      expect(result.skillId).toBe('')
      expect(result.installPath).toBe('')
      expect(result.error).toBeDefined()
      expect(result.error).toContain('Invalid install input')
      // Core service must never be invoked when validation fails.
      expect(mockInstall).not.toHaveBeenCalled()
    })

    it('rejects input missing skillId', async () => {
      const result = await installSkill({})

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid install input')
      expect(result.error).toContain('skillId')
      expect(mockInstall).not.toHaveBeenCalled()
    })

    it('rejects input with non-string skillId', async () => {
      const result = await installSkill({ skillId: 123 })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid install input')
      expect(result.error).toContain('skillId')
      expect(mockInstall).not.toHaveBeenCalled()
    })

    it('rejects input with invalid conflictAction enum value', async () => {
      const result = await installSkill({
        skillId: 'owner/repo/test-skill',
        conflictAction: 'stomp',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid install input')
      expect(result.error).toContain('conflictAction')
      expect(mockInstall).not.toHaveBeenCalled()
    })

    it('rejects empty-string skillId (min(1) constraint)', async () => {
      const result = await installSkill({ skillId: '' })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid install input')
      expect(mockInstall).not.toHaveBeenCalled()
    })
  })

  describe('pre-existing failure paths still work after guard', () => {
    it('surfaces a service-level failure result untouched', async () => {
      const serviceFailure: InstallResult = {
        success: false,
        skillId: 'owner/repo/test-skill',
        installPath: '',
        error: 'Skill indexed for discovery only',
      }
      mockInstall.mockResolvedValueOnce(serviceFailure)

      const result = await installSkill({
        skillId: 'owner/repo/test-skill',
        skipScan: true,
      })

      expect(result).toEqual(serviceFailure)
      expect(result.error).toBe('Skill indexed for discovery only')
    })
  })

  describe('conflict preflight path (force + conflictAction)', () => {
    it('returns the early-exit conflict result when checkForConflicts signals stop', async () => {
      const conflictResult: InstallResult = {
        success: false,
        skillId: 'owner/repo/test-skill',
        installPath: '/existing/path',
        error: 'User cancelled due to local modifications',
      }
      mockLoadManifest.mockResolvedValueOnce({
        version: '1',
        installedSkills: {
          'test-skill': {
            id: 'owner/repo/test-skill',
            name: 'test-skill',
            version: '1.0.0',
            source: 'registry',
            installPath: '/existing/path',
            installedAt: '2026-01-01T00:00:00Z',
            lastUpdated: '2026-01-01T00:00:00Z',
          },
        },
      })
      mockCheckForConflicts.mockResolvedValueOnce({
        shouldProceed: false,
        earlyReturn: conflictResult,
      })

      const result = await installSkill({
        skillId: 'owner/repo/test-skill',
        force: true,
        conflictAction: 'cancel',
      })

      expect(result).toEqual(conflictResult)
      expect(mockCheckForConflicts).toHaveBeenCalledTimes(1)
      expect(mockInstall).not.toHaveBeenCalled()
    })

    it('falls through to core install when manifest lookup throws, and reports that it did', async () => {
      // SMI-6585: a throw in the pre-flight no longer changes the OUTCOME —
      // the install still proceeds, and core's own target guard still runs
      // unconditionally before any write — but it is no longer invisible.
      //
      // This assertion deliberately checks the reported problem rather than
      // a bare call count. A count cannot distinguish "the pre-flight never
      // ran" from "it threw and was swallowed"; both read as zero. That
      // ambiguity is what made the original defect survive 13 cross-model
      // review rounds.
      mockLoadManifest.mockRejectedValueOnce(new Error('manifest missing'))

      const result = await installSkill({
        skillId: 'owner/repo/test-skill',
        force: true,
        conflictAction: 'overwrite',
      })

      expect(result.success).toBe(HAPPY_RESULT.success)
      expect(mockInstall).toHaveBeenCalledTimes(1)
      expect(result.tips).toEqual(
        expect.arrayContaining([expect.stringContaining('could not be evaluated')])
      )
      expect(result.tips?.join(' ')).toContain('manifest missing')
    })

    it('reports the underlying cause and the unapplied conflictAction, not a generic string', async () => {
      // SMI-6585: the two things a caller loses when the pre-flight throws
      // are (1) the conflict backup/GC side effects and (2) their requested
      // conflictAction. A report that says only "something failed" is worth
      // little more than the silence it replaced, so both the real errno and
      // the unapplied action must survive into the message.
      mockLoadManifest.mockRejectedValueOnce(new Error('EACCES: permission denied'))

      const result = await installSkill({
        skillId: 'owner/repo/test-skill',
        force: true,
        conflictAction: 'cancel',
      })

      // The install proceeded: core's guard, not this pre-flight, is what
      // refuses an unsafe target.
      expect(mockInstall).toHaveBeenCalledTimes(1)

      const reported = result.tips?.join(' ') ?? ''
      expect(reported).toContain('EACCES: permission denied')
      // Deliberately "may not have been fully applied": `checkForConflicts`
      // can throw AFTER writing a backup, so claiming it was not applied at
      // all would assert more than this code can know (cross-model review).
      expect(reported).toContain('may not have been fully applied')
    })

    // SMI-6585 cross-model review: the try block has four throw sources and
    // the tests above only exercise the manifest load. A regression that kept
    // reporting manifest failures while silently losing a TARGET GUARD or
    // CONFLICT CHECK failure would have passed. Each source gets its own case.
    it('reports a failure thrown by the target guard itself', async () => {
      mockLoadManifest.mockResolvedValueOnce({
        version: '1',
        installedSkills: {
          'test-skill': {
            id: 'owner/repo/test-skill',
            name: 'test-skill',
            version: '1.0.0',
            source: 'registry',
            installPath: '/existing/path',
            installedAt: '2026-01-01T00:00:00Z',
            lastUpdated: '2026-01-01T00:00:00Z',
          },
        },
      })
      mockCheckInstallTarget.mockRejectedValueOnce(new Error('EACCES: lstat failed'))

      const result = await installSkill({
        skillId: 'owner/repo/test-skill',
        force: true,
        conflictAction: 'overwrite',
      })

      expect(mockInstall).toHaveBeenCalledTimes(1)
      expect(result.tips?.join(' ') ?? '').toContain('EACCES: lstat failed')
    })

    it('reports a failure thrown by the conflict check', async () => {
      mockLoadManifest.mockResolvedValueOnce({
        version: '1',
        installedSkills: {
          'test-skill': {
            id: 'owner/repo/test-skill',
            name: 'test-skill',
            version: '1.0.0',
            source: 'registry',
            installPath: '/existing/path',
            installedAt: '2026-01-01T00:00:00Z',
            lastUpdated: '2026-01-01T00:00:00Z',
          },
        },
      })
      mockCheckForConflicts.mockRejectedValueOnce(new Error('backup store unreadable'))

      const result = await installSkill({
        skillId: 'owner/repo/test-skill',
        force: true,
        conflictAction: 'overwrite',
      })

      expect(mockInstall).toHaveBeenCalledTimes(1)
      expect(result.tips?.join(' ') ?? '').toContain('backup store unreadable')
    })

    it('survives a thrown value whose string conversion itself throws', async () => {
      // SMI-6585 cross-model review: a rejection can carry ANY value. An
      // object with a throwing `toString` would make the reporting code throw
      // from inside the handler written to keep the install's outcome
      // unchanged — converting a swallowed failure into an escaped exception.
      const hostile = {
        toString() {
          throw new Error('nice try')
        },
      }
      mockLoadManifest.mockRejectedValueOnce(hostile)

      const result = await installSkill({
        skillId: 'owner/repo/test-skill',
        force: true,
        conflictAction: 'overwrite',
      })

      // The install still completed rather than the handler throwing.
      expect(mockInstall).toHaveBeenCalledTimes(1)
      expect(result.tips?.join(' ') ?? '').toContain('could not be described')
    })

    // SMI-6588: the namespace gate degrades to `proceed` when it cannot run.
    // These two cases are the point of the change — they must NOT produce the
    // same result. The negative case is as load-bearing as the positive one:
    // without it, a regression that tipped on every install would pass.
    it('reports it when the namespace pre-flight degraded instead of running', async () => {
      mockRunNamespaceGate.mockResolvedValue({
        decision: 'proceed',
        candidate: { identifier: 'test', projectedSourcePath: '/tmp/test' },
        preflight: { warnings: [], pendingCollision: null, auditId: 'mock-audit-id' },
        resultPatch: { installComplete: true },
        problems: [
          'the namespace pre-flight did not run (the rename ledger could not be read: ' +
            'EACCES: permission denied); the install proceeded, but this skill was NOT ' +
            'checked for a name collision with your already-installed skills.',
        ],
      })

      const result = await installSkill({ skillId: 'owner/repo/test-skill' })

      // The install still succeeds — the gate is advisory and must never
      // block on its own failure.
      expect(result.success).toBe(true)
      expect(mockInstall).toHaveBeenCalledTimes(1)
      const reported = result.tips?.join(' ') ?? ''
      expect(reported).toContain('namespace pre-flight did not run')
      expect(reported).toContain('EACCES: permission denied')
    })

    it('adds no tip when the namespace pre-flight ran and found no collision', async () => {
      // The beforeEach default is a clean `problems: []` gate.
      const result = await installSkill({ skillId: 'owner/repo/test-skill' })

      expect(result.success).toBe(true)
      expect(result.tips?.join(' ') ?? '').not.toContain('namespace pre-flight')
    })

    it('resolves bare skillId (no slash) via extractSkillName', async () => {
      mockLoadManifest.mockResolvedValueOnce({
        version: '1',
        installedSkills: {
          'bare-name': {
            id: 'bare-name',
            name: 'bare-name',
            version: '1.0.0',
            source: 'registry',
            installPath: '/x',
            installedAt: '2026-01-01T00:00:00Z',
            lastUpdated: '2026-01-01T00:00:00Z',
          },
        },
      })

      const result = await installSkill({
        skillId: 'bare-name',
        force: true,
        conflictAction: 'overwrite',
      })

      expect(result).toEqual(HAPPY_RESULT)
      // SMI-6529 N5 (round 4): the pre-flight now computes `installPath`
      // the SAME way core's install() does — `path.join(effectiveSkillsDir,
      // skillName)` — never the manifest entry's own recorded
      // `installPath` (here `/x`), which can legitimately differ (a
      // different scope/client's directory entirely). `/mock/skills-dir` is
      // this test file's mocked `effectiveSkillsDir`.
      expect(mockCheckForConflicts).toHaveBeenCalledWith(
        'bare-name',
        '/mock/skills-dir/bare-name',
        expect.objectContaining({ installedSkills: expect.any(Object) }),
        'overwrite',
        'bare-name'
      )
    })
  })

  // SMI-4737: bound `packDomain` and `token` upstream
  describe('SMI-4737 — skillId / token boundary caps', () => {
    it('rejects skillId > 512 chars at the Zod boundary', async () => {
      const result = await installSkill({ skillId: 'a'.repeat(513) })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid install input')
      expect(result.error).toContain('skillId exceeds maximum length of 512 chars')
      expect(mockInstall).not.toHaveBeenCalled()
    })

    it('accepts skillId at exactly 512 chars when extracted token <= 128 (boundary)', async () => {
      // 'a'.repeat(383) + '/' + 'b'.repeat(128) = 512 chars total; token = 128 (boundary).
      const skillId = 'a'.repeat(383) + '/' + 'b'.repeat(128)
      expect(skillId.length).toBe(512)

      const result = await installSkill({
        skillId,
        skipScan: true,
        skipOptimize: true,
        confirmed: true,
      })

      expect(result.success).toBe(true)
      expect(mockInstall).toHaveBeenCalledTimes(1)
    })

    it('extractSkillName throws on extracted segment > 128 chars', () => {
      // 511 chars total — passes Zod 512-cap; extracted segment = 129 — over token cap.
      const overCap = 'valid/' + 'a'.repeat(129)
      expect(() => extractSkillName(overCap)).toThrow(/exceeds 128 chars/)
    })

    it('extractSkillName accepts 128-char extracted segment at boundary', () => {
      const atCap = 'valid/' + 'a'.repeat(128)
      expect(extractSkillName(atCap)).toBe('a'.repeat(128))
    })

    it('installSkill returns structured invalid_skill_id envelope when extractSkillName throws', async () => {
      // 'a'.repeat(382) + '/' + 'b'.repeat(129) = 512 chars total; passes Zod;
      // extracted token = 129 → extractSkillName throws → caller wraps.
      const skillId = 'a'.repeat(382) + '/' + 'b'.repeat(129)
      expect(skillId.length).toBe(512)

      const result = await installSkill({ skillId })

      expect(result.success).toBe(false)
      expect(result.skillId).toBe(skillId)
      expect(result.installPath).toBe('')
      expect(result.error).toContain('invalid_skill_id')
      expect(result.error).toContain('128 chars')
      // Core service must not be invoked when the skillId is rejected upstream.
      expect(mockInstall).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // SMI-4795: install telemetry must thread errorCode + trustTier
  //
  // Prior to SMI-4795, the MCP emit site only forwarded {skillId, source,
  // success, durationMs}. This left every failed install in the funnel as
  // `error_code: NULL`, blocking root-cause classification. These tests
  // assert the four metadata fields are now propagated to emitInstallEvent.
  // ==========================================================================

  describe('SMI-4795: emitInstallEvent receives errorCode + trustTier', () => {
    it('forwards trustTier and errorCode on a failed install', async () => {
      mockInstall.mockResolvedValueOnce({
        success: false,
        skillId: 'owner/repo/scan-rejected',
        installPath: '',
        errorCode: 'SCAN_REJECTED',
        trustTier: 'community',
        error: 'Security scan failed',
      })

      await installSkill({ skillId: 'owner/repo/scan-rejected' })

      expect(mockEmitInstallEvent).toHaveBeenCalledTimes(1)
      const payload = mockEmitInstallEvent.mock.calls[0]?.[0]
      expect(payload).toMatchObject({
        skillId: 'owner/repo/scan-rejected',
        source: 'mcp',
        success: false,
        errorCode: 'SCAN_REJECTED',
        trustTier: 'community',
      })
      expect(typeof payload.durationMs).toBe('number')
    })

    it('forwards trustTier on a successful install but omits errorCode', async () => {
      mockInstall.mockResolvedValueOnce({
        success: true,
        skillId: 'owner/repo/ok-skill',
        installPath: '/tmp/mock/ok-skill',
        trustTier: 'verified',
      })

      await installSkill({ skillId: 'owner/repo/ok-skill' })

      expect(mockEmitInstallEvent).toHaveBeenCalledTimes(1)
      const payload = mockEmitInstallEvent.mock.calls[0]?.[0]
      expect(payload).toMatchObject({
        skillId: 'owner/repo/ok-skill',
        source: 'mcp',
        success: true,
        trustTier: 'verified',
      })
      expect(payload.errorCode).toBeUndefined()
    })

    it('omits both errorCode and trustTier when neither is set', async () => {
      // Service returned a failure result that pre-dates SMI-4795 (no fields).
      // Emit-site must not invent values — payload omits both keys cleanly.
      mockInstall.mockResolvedValueOnce({
        success: false,
        skillId: 'owner/repo/legacy-failure',
        installPath: '',
        error: 'something went wrong',
      })

      await installSkill({ skillId: 'owner/repo/legacy-failure' })

      expect(mockEmitInstallEvent).toHaveBeenCalledTimes(1)
      const payload = mockEmitInstallEvent.mock.calls[0]?.[0]
      expect(payload.errorCode).toBeUndefined()
      expect(payload.trustTier).toBeUndefined()
      expect(payload.success).toBe(false)
    })
  })
})
