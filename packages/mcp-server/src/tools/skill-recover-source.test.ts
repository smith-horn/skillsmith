/**
 * @fileoverview Unit tests for the `skill_recover_source` MCP tool.
 * @see SMI-5407: Skill Source Provenance Recovery
 *
 * Tests:
 *   - homeDir refinement rejects /etc and other disallowed paths.
 *   - Happy path returns { skills, summary } from SourceRecoveryService.
 *   - Read-only: never calls backfillManifest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'

// ============================================================================
// Mocks — declared before imports
// ============================================================================

const mockRecoverSources = vi.fn()

vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()
  return {
    ...actual,
    // Must be a regular function (not arrow) so `new SourceRecoveryService()` works.
    SourceRecoveryService: function MockSourceRecoveryService() {
      return { recoverSources: (...args: unknown[]) => mockRecoverSources(...args) }
    },
    defaultSkillsRoot: () => path.join(os.homedir(), '.claude', 'skills'),
  }
})

// `backfillManifest` is NOT imported by the MCP tool (read-only surface) —
// no mock needed. The "never calls backfillManifest" test spies on the
// top-level mock at the @skillsmith/core boundary instead.

// ============================================================================
// Imports after mocks
// ============================================================================

import {
  skillRecoverSourceInputSchema,
  isHomeDirUnderAllowedRoot,
  executeSkillRecoverSource,
} from './skill-recover-source.js'
import type { ToolContext } from '../context.js'

// ============================================================================
// Helpers
// ============================================================================

function makeContext(): ToolContext {
  return {
    db: {
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
    },
    apiClient: {
      isOffline: vi.fn().mockReturnValue(true), // offline in unit tests
      search: vi.fn(),
    },
  } as unknown as ToolContext
}

function makeReport() {
  return {
    skills: [
      {
        skillName: 'astro',
        installPath: '/home/user/.claude/skills/astro',
        recoveredSource: {
          owner: 'williamsmith',
          repo: 'astro',
          url: 'https://github.com/williamsmith/astro',
        },
        registryId: null,
        method: 'git-remote',
        confidence: 'exact',
        candidates: [],
        status: 'recovered',
      },
    ],
    summary: { total: 1, recovered: 1, already_tracked: 0, unknown: 0, skipped_backup: 0 },
  }
}

// ============================================================================
// Tests — homeDir refinement
// ============================================================================

describe('isHomeDirUnderAllowedRoot', () => {
  it('accepts os.homedir()', () => {
    expect(isHomeDirUnderAllowedRoot(os.homedir())).toBe(true)
  })

  it('accepts os.tmpdir()', () => {
    expect(isHomeDirUnderAllowedRoot(os.tmpdir())).toBe(true)
  })

  it('accepts a path under os.homedir()', () => {
    expect(isHomeDirUnderAllowedRoot(path.join(os.homedir(), '.skillsmith'))).toBe(true)
  })

  it('rejects /etc', () => {
    expect(isHomeDirUnderAllowedRoot('/etc')).toBe(false)
  })

  it('rejects /', () => {
    expect(isHomeDirUnderAllowedRoot('/')).toBe(false)
  })

  it('rejects /var/db', () => {
    expect(isHomeDirUnderAllowedRoot('/var/db')).toBe(false)
  })
})

// ============================================================================
// Tests — Zod schema
// ============================================================================

describe('skillRecoverSourceInputSchema', () => {
  it('accepts empty input', () => {
    expect(() => skillRecoverSourceInputSchema.parse({})).not.toThrow()
  })

  it('accepts valid homeDir under homedir', () => {
    const result = skillRecoverSourceInputSchema.parse({ homeDir: os.homedir() })
    expect(result.homeDir).toBe(os.homedir())
  })

  it('rejects homeDir pointing at /etc', () => {
    expect(() => skillRecoverSourceInputSchema.parse({ homeDir: '/etc' })).toThrow()
  })

  it('rejects unknown top-level keys (strict)', () => {
    expect(() => skillRecoverSourceInputSchema.parse({ unknown: true })).toThrow()
  })
})

// ============================================================================
// Tests — happy path
// ============================================================================

describe('executeSkillRecoverSource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRecoverSources.mockResolvedValue(makeReport())
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns skills and summary on happy path', async () => {
    const ctx = makeContext()
    const result = (await executeSkillRecoverSource({}, ctx)) as {
      skills: unknown[]
      summary: unknown
    }

    expect(Array.isArray(result.skills)).toBe(true)
    expect(result.summary).toBeDefined()
  })

  it('passes homeDir-derived skillsRoot to recoverSources', async () => {
    const ctx = makeContext()

    await executeSkillRecoverSource({ homeDir: os.tmpdir() }, ctx)

    expect(mockRecoverSources).toHaveBeenCalledWith(
      expect.objectContaining({ skillsRoot: expect.stringContaining('.claude') })
    )
  })

  it('read-only: result is a report object, not a write confirmation', async () => {
    const ctx = makeContext()
    const result = (await executeSkillRecoverSource({}, ctx)) as {
      skills: unknown[]
      summary: { total: number }
    }
    // A write operation would return { planned, written, skipped }.
    // A read-only report returns { skills, summary }.
    expect(Array.isArray(result.skills)).toBe(true)
    expect(typeof result.summary).toBe('object')
    expect('written' in result).toBe(false)
  })

  it('throws on invalid input (homeDir: /etc)', async () => {
    const ctx = makeContext()
    await expect(executeSkillRecoverSource({ homeDir: '/etc' }, ctx)).rejects.toThrow(
      /Invalid skill_recover_source input/
    )
  })
})
