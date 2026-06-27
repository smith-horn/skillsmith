/**
 * @fileoverview Unit tests for `sklx audit sources` CLI command.
 * @see SMI-5407: Skill Source Provenance Recovery
 *
 * Tests the action layer (`runAuditSources`) with injected mocks so the test
 * suite runs fully offline without a real DB or skills directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'

// ============================================================================
// Module mocks — must be declared before the imports that use them
// ============================================================================

const mockOpenCliDatabase = vi.fn()
vi.mock('../utils/open-database.js', () => ({
  openCliDatabase: (...args: unknown[]) => mockOpenCliDatabase(...args),
}))

const mockLoadManifest = vi.fn()
vi.mock('../utils/manifest.js', () => ({
  loadManifest: () => mockLoadManifest(),
}))

const mockRecoverSources = vi.fn()
const mockBackfillManifest = vi.fn()

vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()
  return {
    ...actual,
    // Must be a regular function (not arrow) so `new SourceRecoveryService()` works.
    SourceRecoveryService: function MockSourceRecoveryService() {
      return { recoverSources: (...args: unknown[]) => mockRecoverSources(...args) }
    },
    backfillManifest: (...args: unknown[]) => mockBackfillManifest(...args),
    defaultSkillsRoot: () => path.join(os.homedir(), '.claude', 'skills'),
  }
})

// ============================================================================
// Import after mocks
// ============================================================================

import { runAuditSources, type AuditSourcesOptions } from './audit-sources.action.js'

// ============================================================================
// Fixtures
// ============================================================================

type RecoveryStatus = 'recovered' | 'already_tracked' | 'unknown' | 'skipped_backup'
type RecoveryConfidence = 'exact' | 'high' | 'medium' | 'low' | 'user-specified' | 'unknown'

interface SimpleSkillResult {
  skillName: string
  installPath: string
  recoveredSource: { owner: string; repo: string; url: string } | null
  registryId: string | null
  method: string | null
  confidence: RecoveryConfidence
  candidates: Array<{
    id: string
    name: string
    owner: string
    repo: string
    url: string
    qualityScore: number
  }>
  status: RecoveryStatus
}

interface SimpleReport {
  skills: SimpleSkillResult[]
  summary: {
    total: number
    recovered: number
    already_tracked: number
    unknown: number
    skipped_backup: number
  }
}

function makeReport(overrides: Partial<SimpleReport> = {}): SimpleReport {
  return {
    skills: [
      {
        skillName: 'linear',
        installPath: '/home/user/.claude/skills/linear',
        recoveredSource: {
          owner: 'williamsmith',
          repo: 'linear',
          url: 'https://github.com/williamsmith/linear',
        },
        registryId: 'uuid-linear',
        method: 'git-remote',
        confidence: 'exact',
        candidates: [],
        status: 'recovered',
      },
    ],
    summary: { total: 1, recovered: 1, already_tracked: 0, unknown: 0, skipped_backup: 0 },
    ...overrides,
  }
}

function makeDb() {
  return {
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
    close: vi.fn(),
  }
}

function baseOptions(overrides: Partial<AuditSourcesOptions> = {}): AuditSourcesOptions {
  return {
    skillsRoot: '/tmp/test-skills',
    apply: false,
    yes: false,
    set: undefined,
    minConfidence: 'high',
    json: false,
    embedding: false,
    catalogHint: false,
    writeFrontmatter: false,
    forceWriteFrontmatter: false,
    db: ':memory:',
    ...overrides,
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('runAuditSources', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOpenCliDatabase.mockResolvedValue(makeDb())
    mockLoadManifest.mockResolvedValue({ version: '1.0.0', installedSkills: {} })
    mockRecoverSources.mockResolvedValue(makeReport())
    mockBackfillManifest.mockResolvedValue({ planned: [], written: [], skipped: [] })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // --------------------------------------------------------------------------
  // --json shape + exit 0
  // --------------------------------------------------------------------------

  it('--json emits valid JSON with skills and summary', async () => {
    const report = makeReport()
    mockRecoverSources.mockResolvedValue(report)

    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      if (typeof chunk === 'string') written.push(chunk)
      return true
    })

    await runAuditSources(baseOptions({ json: true }))

    const output = written.join('')
    const parsed = JSON.parse(output) as { skills: unknown[]; summary: { total: number } }
    expect(Array.isArray(parsed.skills)).toBe(true)
    expect(parsed.summary.total).toBe(1)
  })

  // --------------------------------------------------------------------------
  // Dry-run: default run does NOT write the manifest
  // --------------------------------------------------------------------------

  it('dry-run by default: does not call backfillManifest', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runAuditSources(baseOptions())
    expect(mockBackfillManifest).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  // --------------------------------------------------------------------------
  // already_tracked overlay
  // --------------------------------------------------------------------------

  it('overlays already_tracked when manifest already has a source', async () => {
    mockLoadManifest.mockResolvedValue({
      version: '1.0.0',
      installedSkills: {
        linear: {
          id: 'uuid-linear',
          name: 'linear',
          version: '1.0.0',
          source: 'https://github.com/williamsmith/linear',
          installPath: '/home/user/.claude/skills/linear',
          installedAt: '2024-01-01T00:00:00.000Z',
          lastUpdated: '2024-01-01T00:00:00.000Z',
        },
      },
    })

    const jsonChunks: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      if (typeof chunk === 'string') jsonChunks.push(chunk)
      return true
    })

    await runAuditSources(baseOptions({ json: true }))

    const parsed = JSON.parse(jsonChunks.join('')) as {
      skills: Array<{ status: string }>
      summary: { already_tracked: number }
    }

    const alreadyTracked = parsed.skills.find((s) => s.status === 'already_tracked')
    expect(alreadyTracked).toBeDefined()
    expect(parsed.summary.already_tracked).toBe(1)
  })

  // --------------------------------------------------------------------------
  // --apply --yes writes the manifest
  // --------------------------------------------------------------------------

  it('--apply --yes calls backfillManifest with apply: true', async () => {
    mockBackfillManifest.mockResolvedValue({ planned: [], written: ['linear'], skipped: [] })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await runAuditSources(baseOptions({ apply: true, yes: true }))

    expect(mockBackfillManifest).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.any(Object) }),
      expect.objectContaining({ apply: true })
    )

    logSpy.mockRestore()
  })

  // --------------------------------------------------------------------------
  // Multi-candidate row appears in JSON output
  // --------------------------------------------------------------------------

  it('--json includes candidates array when ambiguous (multi-match)', async () => {
    const ambiguousReport = makeReport({
      skills: [
        {
          skillName: 'git-helper',
          installPath: '/home/user/.claude/skills/git-helper',
          recoveredSource: null,
          registryId: null,
          method: 'registry-name',
          confidence: 'low',
          candidates: [
            {
              id: 'id-1',
              name: 'git-helper',
              owner: 'alice',
              repo: 'git-helper',
              url: 'https://github.com/alice/git-helper',
              qualityScore: 80,
            },
            {
              id: 'id-2',
              name: 'git-helper',
              owner: 'bob',
              repo: 'git-helper',
              url: 'https://github.com/bob/git-helper',
              qualityScore: 60,
            },
          ],
          status: 'unknown',
        },
      ],
      summary: { total: 1, recovered: 0, already_tracked: 0, unknown: 1, skipped_backup: 0 },
    })
    mockRecoverSources.mockResolvedValue(ambiguousReport)

    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      if (typeof chunk === 'string') written.push(chunk)
      return true
    })

    await runAuditSources(baseOptions({ json: true }))

    const parsed = JSON.parse(written.join('')) as {
      skills: Array<{ candidates: unknown[] }>
    }
    expect(parsed.skills[0]?.candidates).toHaveLength(2)
  })

  // --------------------------------------------------------------------------
  // --write-frontmatter without --force-write-frontmatter exits non-zero
  // --------------------------------------------------------------------------

  it('--write-frontmatter without --force-write-frontmatter exits with code 1', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: number | string | null) => {
        throw new Error('process.exit')
      })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      runAuditSources(baseOptions({ writeFrontmatter: true, forceWriteFrontmatter: false }))
    ).rejects.toThrow('process.exit')

    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
    errSpy.mockRestore()
  })
})
