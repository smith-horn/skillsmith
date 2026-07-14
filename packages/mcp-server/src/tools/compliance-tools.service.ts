/**
 * @fileoverview Real compliance service — queries audit_logs + skills SQLite tables
 * @module @skillsmith/mcp-server/tools/compliance-tools.service
 * @see SMI-3916: Wave 2 — Compliance real queries
 * @see SMI-5675: skill inventory now sourced from the installed-skill manifest,
 *   not the entire locally-indexed `skills` table (see gatherData below).
 *
 * Replaces stub compliance data with actual SQL queries against local
 * audit_logs and skills tables. Returns data conforming to ComplianceData.
 */

import * as os from 'os'
import * as path from 'path'
import { ManifestManager } from '@skillsmith/core'
import type { Database } from '@skillsmith/core'
import type { ComplianceService, ComplianceData, SkillInventoryItem } from './compliance-tools.js'

// ============================================================================
// Internal row types for type-safe query results
// ============================================================================

interface EventTypeRow {
  event_type: string
  count: number
}

/** Supplementary metadata joined from the `skills` table by installed skill ID (SMI-5675). */
interface SkillMetaRow {
  id: string
  trust_tier: string | null
  quality_score: number | null
}

interface ActorRow {
  actor: string
  actions: number
  last_active: string
}

interface TopToolRow {
  resource: string
  count: number
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MANIFEST_PATH = path.join(os.homedir(), '.skillsmith', 'manifest.json')

/** Chunk size for `skills WHERE id IN (...)` lookups — stays well under SQLite's
 * default bound-parameter ceiling even for an unusually large installed set. */
const SKILL_META_CHUNK_SIZE = 500

// ============================================================================
// Helpers
// ============================================================================

/**
 * Fetch supplementary `skills` table metadata (trust_tier, quality_score) for
 * a set of installed skill IDs, batched to stay under SQLite's bound-parameter
 * limit. Returns an empty map (not a throw) for IDs with no matching row —
 * callers fall back to 'unknown'/null, since a skill can be installed without
 * (yet) being present in the locally-indexed `skills` table.
 */
function fetchSkillMetadata(db: Database, ids: string[]): Map<string, SkillMetaRow> {
  const result = new Map<string, SkillMetaRow>()
  for (let i = 0; i < ids.length; i += SKILL_META_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + SKILL_META_CHUNK_SIZE)
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db
      .prepare<SkillMetaRow>(
        `SELECT id, trust_tier, quality_score FROM skills WHERE id IN (${placeholders})`
      )
      .all(...chunk)
    for (const row of rows) result.set(row.id, row)
  }
  return result
}

// ============================================================================
// Service factory
// ============================================================================

/**
 * Create a compliance service backed by real SQLite queries.
 *
 * SMI-5675 fix: the installed-skill SET now comes from
 * `~/.skillsmith/manifest.json` (via `ManifestManager`), not the entire
 * `skills` table — that table holds the full locally-indexed registry corpus
 * (thousands of registry-synced + filesystem-scanned rows), the overwhelming
 * majority of which the user never installed. The `skills` table is still
 * queried, but only for supplementary metadata (trust_tier, quality_score)
 * joined by skill ID against the installed set. `version` now comes from the
 * manifest entry's real `version` field (previously hardcoded `'0.0.0'` —
 * the "version lives in skill_versions table, not skills" comment that
 * justified that hardcode was already obsolete: the manifest has always
 * carried the real installed version).
 *
 * Affects all 3 report formats (soc2, cyclonedx, json) — they all consume
 * `ComplianceData.skills` from this same `gatherData()` call.
 *
 * Tables/files queried:
 * - audit_logs: event_type, timestamp, actor, resource, result
 * - ~/.skillsmith/manifest.json: installedSkills (id, version, installPath, installedAt, lastUpdated)
 * - skills: id, trust_tier, quality_score (supplementary metadata only)
 */
export function createRealComplianceService(
  db: Database,
  options: { manifestManager?: ManifestManager } = {}
): ComplianceService {
  const manifestManager = options.manifestManager ?? new ManifestManager(DEFAULT_MANIFEST_PATH)

  return {
    async gatherData(periodDays: number, includeUserActivity: boolean): Promise<ComplianceData> {
      const now = new Date()
      const periodStart = new Date(now.getTime() - periodDays * 86_400_000)
      const since = periodStart.toISOString()

      // ----------------------------------------------------------------
      // Audit summary from audit_logs
      // ----------------------------------------------------------------
      const totalEventsRow = db
        .prepare<{ c: number }>('SELECT COUNT(*) as c FROM audit_logs WHERE timestamp >= ?')
        .get(since)
      const totalEvents = totalEventsRow?.c ?? 0

      const byEventType = db
        .prepare<EventTypeRow>(
          'SELECT event_type, COUNT(*) as count FROM audit_logs ' +
            'WHERE timestamp >= ? GROUP BY event_type ORDER BY count DESC'
        )
        .all(since)

      // Derive install/uninstall/search counts from event_type
      const eventCounts = new Map(byEventType.map((r) => [r.event_type, r.count]))
      const installCount = eventCounts.get('skill.install') ?? 0
      const uninstallCount = eventCounts.get('skill.uninstall') ?? 0
      const searchCount = eventCounts.get('skill.search') ?? 0

      // ----------------------------------------------------------------
      // Skill inventory: installed-skill manifest is the source of truth
      // (SMI-5675) — `skills` table joined only for supplementary metadata.
      // ----------------------------------------------------------------
      const manifest = await manifestManager.load()
      // Defensive fallback: ManifestManager.load() only guards against
      // invalid JSON syntax (falls back to {installedSkills:{}} on a parse
      // failure) — a manifest file that parses as valid JSON but has an
      // unexpected shape (an old-format file, or installedSkills
      // missing/null) is NOT caught there and would otherwise throw on
      // Object.values() below. Degrade to "zero installed skills" rather
      // than failing the whole compliance report.
      const installedSkillsRecord =
        manifest.installedSkills && typeof manifest.installedSkills === 'object'
          ? manifest.installedSkills
          : {}
      const installedEntries = Object.values(installedSkillsRecord)

      const skills: SkillInventoryItem[] = []
      if (installedEntries.length > 0) {
        const metaById = fetchSkillMetadata(
          db,
          installedEntries.map((e) => e.id)
        )

        for (const entry of installedEntries) {
          const meta = metaById.get(entry.id)
          skills.push({
            skillId: entry.id,
            version: entry.version || '0.0.0',
            trustTier: (meta?.trust_tier ?? 'unknown') as SkillInventoryItem['trustTier'],
            installedAt: entry.installedAt,
            lastUpdated: entry.lastUpdated,
            installPath: entry.installPath,
          })
        }

        skills.sort((a, b) => a.skillId.localeCompare(b.skillId))
      }

      // ----------------------------------------------------------------
      // User activity (optional)
      // ----------------------------------------------------------------
      let userActivity = null
      if (includeUserActivity) {
        const actors = db
          .prepare<ActorRow>(
            'SELECT actor, COUNT(*) as actions, MAX(timestamp) as last_active ' +
              'FROM audit_logs WHERE timestamp >= ? AND actor IS NOT NULL ' +
              'GROUP BY actor ORDER BY actions DESC'
          )
          .all(since)

        const topTools = db
          .prepare<TopToolRow>(
            'SELECT resource, COUNT(*) as count FROM audit_logs ' +
              'WHERE timestamp >= ? AND resource IS NOT NULL ' +
              'GROUP BY resource ORDER BY count DESC LIMIT 10'
          )
          .all(since)
          .map((r) => ({ tool: r.resource, count: r.count }))

        // Count distinct days with activity
        const activeDaysRow = db
          .prepare<{
            days: number
          }>(
            'SELECT COUNT(DISTINCT DATE(timestamp)) as days FROM audit_logs ' +
              'WHERE timestamp >= ?'
          )
          .get(since)

        userActivity = {
          uniqueUsers: actors.length,
          topTools,
          activeDays: activeDaysRow?.days ?? 0,
        }
      }

      // ----------------------------------------------------------------
      // Config state (static for now — SSO/RBAC tables don't exist locally)
      // ----------------------------------------------------------------
      const configState = {
        ssoEnabled: false,
        rbacEnabled: false,
        auditLoggingEnabled: true,
        webhooksConfigured: 0,
      }

      return {
        skills,
        auditSummary: {
          totalEvents,
          installCount,
          uninstallCount,
          searchCount,
          periodStart: periodStart.toISOString(),
          periodEnd: now.toISOString(),
        },
        userActivity,
        configState,
      }
    },
  }
}
