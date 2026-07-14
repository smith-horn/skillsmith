/**
 * @fileoverview Tests for real compliance service (SQLite-backed)
 * @see SMI-3916: Wave 2 — Compliance real queries
 * @see SMI-5675: skill inventory now sourced from the installed-skill
 *   manifest, not the entire locally-indexed `skills` table.
 */

import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseAsync, initializeSchema, ManifestManager } from '@skillsmith/core'
import type { Database, SkillManifestEntry } from '@skillsmith/core'
import { createRealComplianceService } from './compliance-tools.service.js'
import type { ComplianceService } from './compliance-tools.js'

// ============================================================================
// Test helpers
// ============================================================================

function seedAuditLogs(
  db: Database,
  rows: Array<{
    event_type?: string
    timestamp?: string
    actor?: string | null
    resource?: string | null
    result?: string
  }>
): void {
  const stmt = db.prepare(
    'INSERT INTO audit_logs (id, event_type, timestamp, actor, resource, action, result) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  for (const row of rows) {
    stmt.run(
      crypto.randomUUID(),
      row.event_type ?? 'tool.call',
      row.timestamp ?? new Date().toISOString(),
      row.actor ?? null,
      row.resource ?? null,
      'execute',
      row.result ?? 'success'
    )
  }
}

function seedSkills(
  db: Database,
  skills: Array<{
    id: string
    name: string
    author?: string
    trust_tier?: string
  }>
): void {
  const stmt = db.prepare('INSERT INTO skills (id, name, author, trust_tier) VALUES (?, ?, ?, ?)')
  for (const s of skills) {
    stmt.run(s.id, s.name, s.author ?? null, s.trust_tier ?? 'unknown')
  }
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

/** Build a well-formed manifest entry, overriding only what a test cares about. */
function manifestEntry(overrides: Partial<SkillManifestEntry> = {}): SkillManifestEntry {
  const now = new Date().toISOString()
  return {
    id: overrides.id ?? 'author/skill',
    name: overrides.name ?? 'skill',
    version: overrides.version ?? '1.2.3',
    source: overrides.source ?? 'github:author/skill',
    installPath: overrides.installPath ?? '/home/tester/.claude/skills/skill',
    installedAt: overrides.installedAt ?? now,
    lastUpdated: overrides.lastUpdated ?? now,
    ...overrides,
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('createRealComplianceService', () => {
  let db: Database
  let svc: ComplianceService
  let manifestManager: ManifestManager
  let manifestPath: string

  beforeEach(async () => {
    db = await createDatabaseAsync(':memory:')
    initializeSchema(db)

    // SMI-5675: gatherData() reads the installed-skill manifest — use a
    // per-test temp file so tests never touch the real
    // ~/.skillsmith/manifest.json on the machine running the suite, and
    // never leak installed-skill state between tests.
    manifestPath = path.join(
      os.tmpdir(),
      `skillsmith-compliance-test-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    )
    manifestManager = new ManifestManager(manifestPath)
    await manifestManager.save({ version: '1.0.0', installedSkills: {} })

    svc = createRealComplianceService(db, { manifestManager })
  })

  afterEach(async () => {
    if (db) db.close()
    await fs.rm(manifestPath, { force: true })
  })

  describe('gatherData', () => {
    it('returns empty data for an empty database and empty manifest', async () => {
      const data = await svc.gatherData(90, false)

      expect(data.skills).toEqual([])
      expect(data.auditSummary.totalEvents).toBe(0)
      expect(data.auditSummary.installCount).toBe(0)
      expect(data.auditSummary.uninstallCount).toBe(0)
      expect(data.auditSummary.searchCount).toBe(0)
      expect(data.userActivity).toBeNull()
      expect(data.configState.auditLoggingEnabled).toBe(true)
    })

    it('counts audit events by type', async () => {
      seedAuditLogs(db, [
        { event_type: 'skill.install', timestamp: daysAgo(5) },
        { event_type: 'skill.install', timestamp: daysAgo(10) },
        { event_type: 'skill.uninstall', timestamp: daysAgo(3) },
        { event_type: 'skill.search', timestamp: daysAgo(1) },
        { event_type: 'skill.search', timestamp: daysAgo(2) },
        { event_type: 'skill.search', timestamp: daysAgo(3) },
        { event_type: 'skill.install', timestamp: daysAgo(100) }, // outside 90d
      ])

      const data = await svc.gatherData(90, false)
      expect(data.auditSummary.totalEvents).toBe(6) // 6 within 90d
      expect(data.auditSummary.installCount).toBe(2) // 2 installs within 90d
      expect(data.auditSummary.uninstallCount).toBe(1)
      expect(data.auditSummary.searchCount).toBe(3)
    })

    // ------------------------------------------------------------------
    // SMI-5675: installed-scope acceptance tests
    // ------------------------------------------------------------------

    it('SMI-5675 acceptance: reports exactly the installed subset, not the whole skills table', async () => {
      // N discovered-but-uninstalled rows in the skills table (registry-synced
      // or filesystem-scanned — never installed by this user).
      seedSkills(db, [
        { id: 'other/never-installed-1', name: 'never-installed-1', trust_tier: 'community' },
        { id: 'other/never-installed-2', name: 'never-installed-2', trust_tier: 'community' },
        { id: 'other/never-installed-3', name: 'never-installed-3', trust_tier: 'unverified' },
        // Plus the 2 that ARE installed, so the join path is also exercised.
        { id: 'skillsmith/commit', name: 'commit', trust_tier: 'verified' },
        { id: 'community/test', name: 'test', trust_tier: 'community' },
      ])

      await manifestManager.save({
        version: '1.0.0',
        installedSkills: {
          commit: manifestEntry({ id: 'skillsmith/commit', name: 'commit', version: '1.2.0' }),
          test: manifestEntry({ id: 'community/test', name: 'test', version: '0.8.3' }),
        },
      })

      const data = await svc.gatherData(90, false)

      // Exactly M (2) reported, not N+M (5).
      expect(data.skills).toHaveLength(2)
      const byId = new Map(data.skills.map((s) => [s.skillId, s]))
      expect(byId.has('other/never-installed-1')).toBe(false)
      expect(byId.has('other/never-installed-2')).toBe(false)
      expect(byId.has('other/never-installed-3')).toBe(false)

      // Real versions from the manifest, not the hardcoded '0.0.0'.
      expect(byId.get('skillsmith/commit')?.version).toBe('1.2.0')
      expect(byId.get('community/test')?.version).toBe('0.8.3')

      // trust_tier still joined in from the skills table.
      expect(byId.get('skillsmith/commit')?.trustTier).toBe('verified')
      expect(byId.get('community/test')?.trustTier).toBe('community')
    })

    it('uses the manifest entry version directly, even with zero skills-table rows', async () => {
      // No rows in `skills` at all — a skill can be installed without (yet)
      // being present in the locally-indexed table.
      await manifestManager.save({
        version: '1.0.0',
        installedSkills: {
          orphan: manifestEntry({ id: 'local/orphan', name: 'orphan', version: '2.0.0' }),
        },
      })

      const data = await svc.gatherData(90, false)
      expect(data.skills).toHaveLength(1)
      expect(data.skills[0].skillId).toBe('local/orphan')
      expect(data.skills[0].version).toBe('2.0.0')
      expect(data.skills[0].trustTier).toBe('unknown') // no skills-table row to join
    })

    it('carries the manifest installPath through for downstream consumers', async () => {
      await manifestManager.save({
        version: '1.0.0',
        installedSkills: {
          commit: manifestEntry({
            id: 'skillsmith/commit',
            installPath: '/home/tester/.claude/skills/commit',
          }),
        },
      })

      const data = await svc.gatherData(90, false)
      expect(data.skills[0].installPath).toBe('/home/tester/.claude/skills/commit')
    })

    it('degrades to zero installed skills for a malformed-but-valid-JSON manifest, instead of throwing', async () => {
      // ManifestManager.load() only guards against invalid JSON syntax (a
      // parse failure falls back to {installedSkills:{}}) — a file that
      // parses fine but has an unexpected shape (old-format manifest, or
      // installedSkills missing/null) is NOT caught there. Write raw JSON
      // directly (bypassing manifestManager.save(), which only ever writes
      // well-formed objects) to simulate that case.
      await fs.writeFile(manifestPath, JSON.stringify({ version: '1.0.0' }), 'utf-8')

      await expect(svc.gatherData(90, false)).resolves.toMatchObject({ skills: [] })
    })

    it('degrades to zero installed skills when installedSkills is explicitly null', async () => {
      await fs.writeFile(
        manifestPath,
        JSON.stringify({ version: '1.0.0', installedSkills: null }),
        'utf-8'
      )

      const data = await svc.gatherData(90, false)
      expect(data.skills).toEqual([])
    })

    it('returns null userActivity when includeUserActivity=false', async () => {
      seedAuditLogs(db, [{ actor: 'alice', resource: 'search', timestamp: daysAgo(1) }])

      const data = await svc.gatherData(90, false)
      expect(data.userActivity).toBeNull()
    })

    it('returns user activity when includeUserActivity=true', async () => {
      seedAuditLogs(db, [
        { actor: 'alice', resource: 'search', timestamp: daysAgo(1) },
        { actor: 'alice', resource: 'search', timestamp: daysAgo(2) },
        { actor: 'bob', resource: 'install', timestamp: daysAgo(3) },
        { actor: null, resource: 'search', timestamp: daysAgo(1) },
      ])

      const data = await svc.gatherData(90, true)
      expect(data.userActivity).not.toBeNull()
      expect(data.userActivity!.uniqueUsers).toBe(2) // alice and bob
      expect(data.userActivity!.topTools.length).toBeGreaterThanOrEqual(1)
      expect(data.userActivity!.activeDays).toBeGreaterThanOrEqual(1)
    })

    it('counts active days correctly', async () => {
      // Events on 3 distinct days
      seedAuditLogs(db, [
        { actor: 'alice', timestamp: daysAgo(1) },
        { actor: 'alice', timestamp: daysAgo(1) }, // same day
        { actor: 'bob', timestamp: daysAgo(3) },
        { actor: 'carol', timestamp: daysAgo(5) },
      ])

      const data = await svc.gatherData(30, true)
      expect(data.userActivity!.activeDays).toBe(3)
    })

    it('includes period boundaries in audit summary', async () => {
      const data = await svc.gatherData(30, false)

      expect(data.auditSummary.periodStart).toBeDefined()
      expect(data.auditSummary.periodEnd).toBeDefined()
      const start = new Date(data.auditSummary.periodStart)
      const end = new Date(data.auditSummary.periodEnd)
      const diffDays = (end.getTime() - start.getTime()) / 86_400_000
      // Should be approximately 30 days
      expect(diffDays).toBeGreaterThanOrEqual(29)
      expect(diffDays).toBeLessThanOrEqual(31)
    })

    it('configState has expected defaults', async () => {
      const data = await svc.gatherData(90, false)
      expect(data.configState).toEqual({
        ssoEnabled: false,
        rbacEnabled: false,
        auditLoggingEnabled: true,
        webhooksConfigured: 0,
      })
    })
  })
})
