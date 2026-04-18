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
const { mockInstall, mockEmitInstallEvent } = vi.hoisted(() => ({
  mockInstall: vi.fn(),
  mockEmitInstallEvent: vi.fn(),
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

import { installSkill } from './install.js'
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
    mockInstall.mockResolvedValue(HAPPY_RESULT)
    // By default no conflict preflight interception.
    mockLoadManifest.mockResolvedValue({ version: '1', installedSkills: {} })
    mockCheckForConflicts.mockResolvedValue({ shouldProceed: true })
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

    it('falls through to core install when manifest lookup throws', async () => {
      // Conflict preflight swallows errors and continues with normal install.
      mockLoadManifest.mockRejectedValueOnce(new Error('manifest missing'))

      const result = await installSkill({
        skillId: 'owner/repo/test-skill',
        force: true,
        conflictAction: 'overwrite',
      })

      expect(result).toEqual(HAPPY_RESULT)
      expect(mockInstall).toHaveBeenCalledTimes(1)
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
      expect(mockCheckForConflicts).toHaveBeenCalledWith(
        'bare-name',
        '/x',
        expect.objectContaining({ installedSkills: expect.any(Object) }),
        'overwrite',
        'bare-name'
      )
    })
  })
})
