/**
 * @fileoverview Tests for the CycloneDX AI/ML-BOM formatter
 * @see SMI-3140 Wave 1 Step 4: docs/internal/implementation/smi-3140-cyclonedx-ai-bom-export.md
 */

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Validation, Spec } from '@cyclonedx/cyclonedx-library'
import {
  createDatabaseAsync,
  initializeSchema,
  SkillDependencyRepository,
  getBestDriver,
} from '@skillsmith/core'
import type { Database, SkillDependencyRow } from '@skillsmith/core'
import { formatCycloneDx } from './compliance-tools.cyclonedx.js'
import type { ComplianceData, SkillInventoryItem } from './compliance-tools.js'

// getBestDriver() reports the process-wide driver detection, not this test
// file's own in-memory db instance — vitest's worker-thread context fails to
// load the better-sqlite3 native binding in this repo's Docker setup even
// though it loads fine on the container's main thread (confirmed via a
// throwaway diagnostic test), so getBestDriver() always resolves 'sql.js'
// here regardless of env vars. Mock it so the "better-sqlite3" and "sql.js"
// gating branches are each independently, deterministically testable — this
// mirrors the production gate (compliance-tools.cyclonedx.ts calls the same
// getBestDriver() export), not a fake of the code under test.
vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()
  return { ...actual, getBestDriver: vi.fn(actual.getBestDriver) }
})

// ============================================================================
// Test helpers
// ============================================================================

function baseSkill(overrides: Partial<SkillInventoryItem> = {}): SkillInventoryItem {
  const now = new Date().toISOString()
  return {
    skillId: 'author/skill',
    version: '1.0.0',
    trustTier: 'verified',
    installedAt: now,
    lastUpdated: now,
    ...overrides,
  }
}

function baseData(skills: SkillInventoryItem[]): ComplianceData {
  const now = new Date().toISOString()
  return {
    skills,
    auditSummary: {
      totalEvents: 0,
      installCount: 0,
      uninstallCount: 0,
      searchCount: 0,
      periodStart: now,
      periodEnd: now,
    },
    userActivity: null,
    configState: {
      ssoEnabled: false,
      rbacEnabled: false,
      auditLoggingEnabled: true,
      webhooksConfigured: 0,
    },
  }
}

interface NormalizedProperty {
  name: string
  value: string
}

interface NormalizedComponent {
  name: string
  type: string
  'bom-ref'?: string
  properties?: NormalizedProperty[]
}

interface NormalizedDependency {
  ref: string
  dependsOn?: string[]
}

function properties(report: Record<string, unknown>): NormalizedProperty[] {
  const metadata = report.metadata as Record<string, unknown>
  return (metadata.properties as NormalizedProperty[]) ?? []
}

function dependencyDataSource(report: Record<string, unknown>): string | undefined {
  return properties(report).find((p) => p.name === 'skillsmith:dependencyDataSource')?.value
}

function notice(report: Record<string, unknown>): string | undefined {
  return properties(report).find((p) => p.name === 'skillsmith:notice')?.value
}

function components(report: Record<string, unknown>): NormalizedComponent[] {
  return (report.components as NormalizedComponent[]) ?? []
}

function dependencyEdges(report: Record<string, unknown>): NormalizedDependency[] {
  return (report.dependencies as NormalizedDependency[]) ?? []
}

// ============================================================================
// Tests
// ============================================================================

describe('formatCycloneDx', () => {
  let db: Database
  let repo: SkillDependencyRepository

  beforeEach(async () => {
    db = await createDatabaseAsync(':memory:')
    initializeSchema(db)
    repo = new SkillDependencyRepository(db)
  })

  afterEach(() => {
    if (db) db.close()
  })

  it('produces a schema-valid CycloneDX 1.5 document', async () => {
    const data = baseData([baseSkill(), baseSkill({ skillId: 'author/second' })])
    const report = await formatCycloneDx(data, { db, skillDependencyRepository: repo })

    const validator = new Validation.JsonStrictValidator(Spec.Version.v1dot5)
    const result = await validator.validate(JSON.stringify(report))
    expect(result).toBeNull()
  })

  it('always includes the Wave 3 "newly launched, not yet validated at scale" notice (SMI-3140)', async () => {
    const data = baseData([baseSkill()])
    const report = await formatCycloneDx(data, { db, skillDependencyRepository: repo })

    expect(notice(report)).toContain('newly launched and not yet validated at scale')
  })

  it('gracefully degrades when no db/repository is available (stub mode) — never crashes', async () => {
    const data = baseData([baseSkill()])
    const report = await formatCycloneDx(data, {})

    expect(report.bomFormat).toBe('CycloneDX')
    expect(report.specVersion).toBe('1.5')
    expect(dependencyDataSource(report)).toBe('pending-rescan')
  })

  // ------------------------------------------------------------------
  // CONFIRMED decision #1: sparse-data default + opt-in backfill
  // ------------------------------------------------------------------

  it('sparse-data default (no backfill): emits the pending-rescan placeholder + a warning', async () => {
    const data = baseData([baseSkill()])
    const report = await formatCycloneDx(data, {
      db,
      skillDependencyRepository: repo,
      backfillDependencies: false,
    })

    expect(dependencyDataSource(report)).toBe('pending-rescan')
    const warning = properties(report).find((p) => p.name.startsWith('skillsmith:warning:'))
    expect(warning).toBeDefined()
    expect(warning?.value).toContain('skill_rescan')
  })

  it('opt-in backfill on better-sqlite3 populates dependency data (extracted)', async () => {
    vi.mocked(getBestDriver).mockReturnValueOnce('better-sqlite3')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdx-backfill-'))
    try {
      await fs.writeFile(
        path.join(dir, 'SKILL.md'),
        [
          '---',
          'name: has-mcp-ref',
          'description: a skill that references an mcp tool',
          '---',
          '',
          'Call mcp__linear__list_issues to look things up.',
        ].join('\n')
      )

      const data = baseData([baseSkill({ skillId: 'author/has-mcp-ref', installPath: dir })])
      const report = await formatCycloneDx(data, {
        db,
        skillDependencyRepository: repo,
        backfillDependencies: true,
      })

      expect(dependencyDataSource(report)).toBe('extracted')
      expect(repo.getDependencies('author/has-mcp-ref').length).toBeGreaterThan(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('per-skill sparse-data semantics: existing rows, successful backfill, and still-sparse never collapse into one global flag', async () => {
    vi.mocked(getBestDriver).mockReturnValueOnce('better-sqlite3')

    // Skill A: already has a row from a prior rescan — must be left alone
    // (not re-backfilled) and must not mask the other two skills' sparseness.
    repo.setDependencies(
      'author/has-rows',
      [
        {
          skill_id: 'author/has-rows',
          dep_type: 'mcp_server',
          dep_target: 'linear',
          dep_version: null,
          dep_source: 'inferred_static',
          confidence: 0.9,
          metadata: null,
        },
      ],
      'inferred_static'
    )

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdx-per-skill-'))
    try {
      // Skill B: zero rows, but has a real SKILL.md with an MCP reference —
      // backfill should populate it.
      await fs.writeFile(
        path.join(dir, 'SKILL.md'),
        [
          '---',
          'name: backfillable',
          'description: a skill that references an mcp tool',
          '---',
          '',
          'Call mcp__linear__list_issues to look things up.',
        ].join('\n')
      )

      // Skill C: zero rows, no installPath — backfill is impossible for it.
      const data = baseData([
        baseSkill({ skillId: 'author/has-rows' }),
        baseSkill({ skillId: 'author/backfillable', installPath: dir }),
        baseSkill({ skillId: 'author/still-sparse' }),
      ])

      const report = await formatCycloneDx(data, {
        db,
        skillDependencyRepository: repo,
        backfillDependencies: true,
      })

      // BOM-level summary is honest about the mix: 2 of 3 extracted, 1 still
      // sparse -> 'partial', never a blanket 'extracted' just because ONE
      // skill (has-rows) already had data.
      expect(dependencyDataSource(report)).toBe('partial')

      const comps = components(report)
      const hasRows = comps.find((c) => c.name === 'author/has-rows')
      const backfillable = comps.find((c) => c.name === 'author/backfillable')
      const stillSparse = comps.find((c) => c.name === 'author/still-sparse')

      const compSource = (c?: NormalizedComponent): string | undefined =>
        c?.properties?.find((p) => p.name === 'skillsmith:dependencyDataSource')?.value

      expect(compSource(hasRows)).toBe('extracted')
      expect(compSource(backfillable)).toBe('extracted')
      expect(compSource(stillSparse)).toBe('pending-rescan')

      // has-rows was NOT re-backfilled — still exactly its original row.
      expect(repo.getDependencies('author/has-rows')).toHaveLength(1)
      // backfillable now has data from the inline backfill.
      expect(repo.getDependencies('author/backfillable').length).toBeGreaterThan(0)
      // still-sparse genuinely has zero rows (no installPath to backfill from).
      expect(repo.getDependencies('author/still-sparse')).toHaveLength(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses inline backfill on sql.js/WASM with a warning — never a silent no-op', async () => {
    vi.mocked(getBestDriver).mockReturnValueOnce('sql.js')
    const data = baseData([baseSkill({ installPath: '/nonexistent/path' })])
    const report = await formatCycloneDx(data, {
      db,
      skillDependencyRepository: repo,
      backfillDependencies: true,
    })

    // Refused, not silently ignored: still pending-rescan, plus an explicit
    // warning naming the refusal reason.
    expect(dependencyDataSource(report)).toBe('pending-rescan')
    const refusal = properties(report).find(
      (p) => p.name.startsWith('skillsmith:warning:') && p.value.includes('refused')
    )
    expect(refusal).toBeDefined()
    expect(refusal?.value).toContain('better-sqlite3')
  })

  // ------------------------------------------------------------------
  // CONFIRMED decision #2: inferred_static is advisory-only
  // ------------------------------------------------------------------

  it('inferred_static rows appear only as component properties, never as a dependencies graph edge', async () => {
    const row: SkillDependencyRow = {
      skill_id: 'author/skill',
      dep_type: 'mcp_server',
      dep_target: 'linear',
      dep_version: null,
      dep_source: 'inferred_static',
      confidence: 0.8,
      metadata: null,
    }
    repo.setDependencies('author/skill', [row], 'inferred_static')

    const data = baseData([baseSkill()])
    const report = await formatCycloneDx(data, { db, skillDependencyRepository: repo })

    // No separate mcp-server component created for an inferred-only dep.
    expect(components(report).some((c) => c.name === 'linear')).toBe(false)

    // No graph edge from the skill to anything named 'linear'.
    const edge = dependencyEdges(report).find((d) => d.ref === 'author/skill')
    expect(edge?.dependsOn ?? []).toHaveLength(0)

    // But it IS surfaced as an advisory property on the skill's own component.
    const skillComponent = components(report).find((c) => c.name === 'author/skill')
    expect(
      skillComponent?.properties?.some(
        (p) => p.name === 'skillsmith:dep:mcp_server' && p.value === 'linear'
      )
    ).toBe(true)
  })

  it('declared skill-to-skill dependency becomes a real graph edge', async () => {
    const row: SkillDependencyRow = {
      skill_id: 'author/skill-a',
      dep_type: 'skill_hard',
      dep_target: 'author/skill-b',
      dep_version: null,
      dep_source: 'declared',
      confidence: 1,
      metadata: null,
    }
    repo.setDependencies('author/skill-a', [row], 'declared')

    const data = baseData([
      baseSkill({ skillId: 'author/skill-a' }),
      baseSkill({ skillId: 'author/skill-b' }),
    ])
    const report = await formatCycloneDx(data, { db, skillDependencyRepository: repo })

    const edge = dependencyEdges(report).find((d) => d.ref === 'author/skill-a')
    expect(edge?.dependsOn).toContain('author/skill-b')
  })

  it('declared mcp_server dependency creates a distinct component and a graph edge to it', async () => {
    const row: SkillDependencyRow = {
      skill_id: 'author/skill',
      dep_type: 'mcp_server',
      dep_target: 'linear',
      dep_version: null,
      dep_source: 'declared',
      confidence: 1,
      metadata: null,
    }
    repo.setDependencies('author/skill', [row], 'declared')

    const data = baseData([baseSkill()])
    const report = await formatCycloneDx(data, { db, skillDependencyRepository: repo })

    const mcpComponent = components(report).find((c) => c.name === 'linear')
    expect(mcpComponent).toBeDefined()

    const edge = dependencyEdges(report).find((d) => d.ref === 'author/skill')
    expect(edge?.dependsOn).toContain(mcpComponent?.['bom-ref'])
  })

  // ------------------------------------------------------------------
  // CONFIRMED decision #3: no redaction
  // ------------------------------------------------------------------

  it('local/proprietary components are included unredacted, with their real names', async () => {
    const data = baseData([baseSkill({ skillId: 'local/my-private-skill', trustTier: 'local' })])
    const report = await formatCycloneDx(data, { db, skillDependencyRepository: repo })

    expect(components(report).some((c) => c.name === 'local/my-private-skill')).toBe(true)
  })

  // ------------------------------------------------------------------
  // Performance ceiling (SMI-3140 Wave 2 acceptance criterion)
  // ------------------------------------------------------------------

  it('exports 500+ installed skills, with a mixed dependency graph, well within a reasonable time bound', async () => {
    const SKILL_COUNT = 500
    const skills: SkillInventoryItem[] = Array.from({ length: SKILL_COUNT }, (_, i) =>
      baseSkill({ skillId: `author${i}/skill${i}` })
    )
    const data = baseData(skills)

    // Give roughly a third of the skills a declared skill-to-skill edge, a
    // third an mcp_server dependency, and leave a third dependency-free — a
    // more realistic mixed shape than N identical rows, and it exercises the
    // getOrCreateComponent dedup path (many skills sharing the same MCP
    // server) at scale, not just the per-skill component construction.
    for (let i = 0; i < SKILL_COUNT; i++) {
      const skillId = `author${i}/skill${i}`
      if (i % 3 === 0 && i + 1 < SKILL_COUNT) {
        repo.setDependencies(
          skillId,
          [
            {
              skill_id: skillId,
              dep_type: 'skill_soft',
              dep_target: `author${i + 1}/skill${i + 1}`,
              dep_version: null,
              dep_source: 'declared',
              confidence: 1.0,
              metadata: null,
            },
          ],
          'declared'
        )
      } else if (i % 3 === 1) {
        repo.setDependencies(
          skillId,
          [
            {
              skill_id: skillId,
              dep_type: 'mcp_server',
              dep_target: 'linear',
              dep_version: null,
              dep_source: 'declared',
              confidence: 1.0,
              metadata: null,
            },
          ],
          'declared'
        )
      }
    }

    const start = Date.now()
    const report = await formatCycloneDx(data, { db, skillDependencyRepository: repo })
    const elapsedMs = Date.now() - start

    // One component per installed skill, plus exactly one deduped 'linear'
    // MCP-server component shared across every i % 3 === 1 skill.
    expect(components(report)).toHaveLength(SKILL_COUNT + 1)
    expect(dependencyDataSource(report)).toBe('partial') // 1/3 of skills have no rows at all
    expect(elapsedMs).toBeLessThan(5000)

    const validator = new Validation.JsonStrictValidator(Spec.Version.v1dot5)
    expect(await validator.validate(JSON.stringify(report))).toBeNull()
  })
})
