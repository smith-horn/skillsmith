/**
 * @fileoverview CycloneDX AI/ML-BOM formatter for compliance_report
 * @module @skillsmith/mcp-server/tools/compliance-tools.cyclonedx
 * @see SMI-3140 Wave 1 Step 4: docs/internal/implementation/smi-3140-cyclonedx-ai-bom-export.md
 * @see SMI-3906: original flat-components cyclonedx format this extends
 *
 * Extends `compliance_report`'s `cyclonedx` format from a flat `components`
 * array into a full CycloneDX 1.5 AI/ML-BOM: installed skills as components,
 * a dependency graph built from `skill_dependencies`, MCP-server and model
 * "components" the library has no dedicated model for, and sparse-data
 * handling. Split out of compliance-tools.ts to stay under the 500-line
 * audit:standards gate (SMI-3140 Wave 1 Step 4 checklist item).
 *
 * Library facts verified directly against `@cyclonedx/cyclonedx-library@10.1.0`
 * source (no `modelCard` class exists — model requirements are represented as
 * `ComponentType.MachineLearningModel` components instead, per the plan doc's
 * Step 3 field-mapping design):
 * - `Models.Component.dependencies` is a `BomRefRepository` (Set<BomRef>) —
 *   the dependency graph is edges FROM a component's own `.dependencies` TO
 *   other components' `.bomRef`, normalized into the top-level `dependencies`
 *   array at serialize time (`DependencyGraphNormalizer`) — never stored
 *   directly on `Bom`.
 * - `Models.Component`/`Models.Metadata` both carry their own `.properties`
 *   (`PropertyRepository`, a `Set<Property>`) — component-level annotations
 *   and BOM-level (`metadata.properties`) annotations are separate repositories.
 *
 * Three decisions below are CONFIRMED (2026-07-14 plan-review) and must not
 * be re-litigated in this file without a fresh plan-review pass:
 * 1. Sparse-data default: read-only `pending-rescan` placeholder + warning,
 *    evaluated PER SKILL (a skill with pre-existing rows never masks another
 *    skill that still has zero — see `resolveDependencies`' doc comment).
 *    Inline backfill is opt-in (`backfillDependencies: true`), attempted only
 *    for the skills actually sparse, and hard-gated to
 *    `getBestDriver() === 'better-sqlite3'` (sql.js/WASM has no
 *    cross-process write coordination — refused with a warning, not a
 *    silent no-op).
 * 2. `inferred_static` dependency rows are advisory-only: a `properties`
 *    annotation on the owning component, NEVER a `dependencies` graph edge.
 *    Only `declared` (author frontmatter) rows become real graph edges.
 * 3. No redaction: local/proprietary components (`skills.source = 'local'`,
 *    surfaced here via `SkillInventoryItem.trustTier === 'local'`) are
 *    included with their real names, same as any other component.
 */

import * as path from 'path'
import { promises as fs } from 'fs'
import { Enums, Models, Serialize, Spec } from '@cyclonedx/cyclonedx-library'
import { AuditLogger, getBestDriver } from '@skillsmith/core'
import type { Database, SkillDependencyRepository, SkillDependencyRow } from '@skillsmith/core'
import {
  extractDepIntel,
  persistDependencies,
} from '@skillsmith/core/services/skill-installation-helpers'
import type { ComplianceData, SkillInventoryItem } from './compliance-tools.js'

// ============================================================================
// Types
// ============================================================================

export interface CycloneDxBuildOptions {
  /** Present when the tool has a live DB connection (undefined in stub mode). */
  db?: Database
  /** Present when the tool has a live DB connection (undefined in stub mode). */
  skillDependencyRepository?: SkillDependencyRepository
  /** Opt-in inline dependency backfill — see decision #1 above. Default false. */
  backfillDependencies?: boolean
}

// 'partial' is a BOM-level-only summary value (some installed skills have
// data, some don't) — a single component's own signal is always binary,
// never 'partial' (see applyDependencyGraph below).
type DependencyDataSource = 'extracted' | 'partial' | 'pending-rescan'

// ============================================================================
// Constants
// ============================================================================

const TOOL_VERSION = '1.0.0'
const BOM_APPLICATION_NAME = 'skillsmith-local-inventory'

// dep_type values that represent a real artifact worth its own CycloneDX
// component + graph edge (when declared). Everything else (env_tool, env_os,
// env_node, cli_version, conflict) is a constraint/condition, not an
// artifact — advisory property only, never a component or edge.
const SKILL_DEP_TYPES = new Set(['skill_hard', 'skill_soft', 'skill_peer'])
const MODEL_DEP_TYPES = new Set(['model_minimum', 'model_capability'])

// ============================================================================
// Component construction
// ============================================================================

function buildSkillComponent(skill: SkillInventoryItem): Models.Component {
  const component = new Models.Component(Enums.ComponentType.Library, skill.skillId, {
    bomRef: skill.skillId,
    version: skill.version || '0.0.0',
  })
  component.properties.add(new Models.Property('skillsmith:trustTier', skill.trustTier))
  component.properties.add(new Models.Property('skillsmith:installedAt', skill.installedAt))
  component.properties.add(new Models.Property('skillsmith:lastUpdated', skill.lastUpdated))
  return component
}

/** Get-or-create a deduped sub-component (MCP server or model) by name. */
function getOrCreateComponent(
  registry: Map<string, Models.Component>,
  name: string,
  bomRefPrefix: string,
  type: Enums.ComponentType
): Models.Component {
  const existing = registry.get(name)
  if (existing) return existing
  const created = new Models.Component(type, name, { bomRef: `${bomRefPrefix}:${name}` })
  registry.set(name, created)
  return created
}

// ============================================================================
// Sparse-data detection + opt-in inline backfill (decision #1)
// ============================================================================

interface DependencyResolution {
  depsBySkillId: Map<string, SkillDependencyRow[]>
  /** BOM-level summary — see the `DependencyDataSource` doc comment above. */
  dependencyDataSource: DependencyDataSource
  /**
   * Per-skill signal (skillId → 'extracted' | 'pending-rescan'), reflecting
   * that specific skill's own rows after any backfill attempt — never
   * collapsed into one global flag. Mirrored onto each component's own
   * `skillsmith:dependencyDataSource` property in applyDependencyGraph.
   */
  perSkillDataSource: Map<string, 'extracted' | 'pending-rescan'>
  warnings: string[]
}

/**
 * Sparse-data detection is evaluated PER SKILL, not as one global aggregate
 * (fixed after review — the original version summed rows across ALL
 * installed skills into a single `totalDeps` counter, so a single skill with
 * pre-existing rows from an earlier manual `skill_rescan` would mark the
 * ENTIRE export 'extracted' and skip backfill entirely, even though every
 * other installed skill still had zero rows and got neither backfill nor
 * any sparse-data signal). Each skill's own emptiness is tracked in
 * `sparseSkillIds`; backfill is attempted only for the skills that are
 * actually sparse, and a skill that already has data is never re-backfilled.
 */
async function resolveDependencies(
  data: ComplianceData,
  repo: SkillDependencyRepository | undefined,
  backfillDependencies: boolean
): Promise<DependencyResolution> {
  const warnings: string[] = []
  const depsBySkillId = new Map<string, SkillDependencyRow[]>()

  if (!repo || data.skills.length === 0) {
    if (!repo) {
      warnings.push('No database connection available — BOM emitted without dependency graph data.')
    }
    const perSkillDataSource = new Map<string, 'extracted' | 'pending-rescan'>(
      data.skills.map((s) => [s.skillId, 'pending-rescan' as const])
    )
    return {
      depsBySkillId,
      dependencyDataSource: 'pending-rescan',
      perSkillDataSource,
      warnings,
    }
  }

  const loadSkill = (skillId: string): SkillDependencyRow[] => {
    const rows = repo.getDependencies(skillId)
    depsBySkillId.set(skillId, rows)
    return rows
  }

  for (const skill of data.skills) loadSkill(skill.skillId)

  const sparseSkillIds = new Set(
    data.skills
      .filter((s) => (depsBySkillId.get(s.skillId) ?? []).length === 0)
      .map((s) => s.skillId)
  )

  if (sparseSkillIds.size > 0 && backfillDependencies) {
    // getBestDriver() reports the process-wide driver detection. This is
    // guaranteed to match what `repo`'s underlying `db` was actually created
    // with: createDatabaseAsync() (the only path that produces a live
    // context.db) uses the exact same detection order and the exact same
    // SKILLSMITH_FORCE_WASM env override as getBestDriver() — there is no
    // code path in this repo that creates a sql.js-backed connection while
    // better-sqlite3 remains available for the same process. Traced and
    // confirmed safe during plan review; not re-litigating per-call.
    const driver = getBestDriver()
    if (driver !== 'better-sqlite3') {
      // CONFIRMED decision #1: refuse loudly, never a silent no-op.
      warnings.push(
        `backfillDependencies was requested but refused: the active database driver is ` +
          `'${driver ?? 'none'}', not 'better-sqlite3'. sql.js/WASM has no cross-process write ` +
          'coordination for skill_dependencies writes. Run the skill_rescan MCP tool directly, ' +
          'or re-run this export from an environment where the native driver is available.'
      )
    } else {
      // Reuse the EXACT SMI-5645 extraction+persistence pipeline (never a
      // parallel implementation) — same functions skill_rescan's
      // backfillSkillDependencies calls, writing only through
      // SkillDependencyRepository.setDependencies()'s upsert. Only the
      // skills that are ACTUALLY sparse are attempted — a skill that
      // already has rows (from an earlier rescan, say) is left untouched.
      for (const skill of data.skills) {
        if (!sparseSkillIds.has(skill.skillId)) continue
        if (!skill.installPath) continue
        try {
          const content = await fs.readFile(path.join(skill.installPath, 'SKILL.md'), 'utf-8')
          const depIntel = extractDepIntel(content)
          persistDependencies(repo, skill.skillId, content, depIntel.dep_declared)
        } catch {
          // Best-effort — mirrors skill-rescan.helpers.ts's containment.
          // One skill's unreadable SKILL.md must never fail the whole export.
        }
        // Re-check THIS skill only — a successful backfill removes it from
        // the sparse set; a skill with genuinely zero deps, or whose
        // installPath was missing/unreadable, stays sparse.
        if (loadSkill(skill.skillId).length > 0) sparseSkillIds.delete(skill.skillId)
      }
    }
  }

  const perSkillDataSource = new Map<string, 'extracted' | 'pending-rescan'>(
    data.skills.map((s) => [
      s.skillId,
      sparseSkillIds.has(s.skillId) ? 'pending-rescan' : 'extracted',
    ])
  )

  const sparseCount = sparseSkillIds.size
  const totalCount = data.skills.length
  const dependencyDataSource: DependencyDataSource =
    sparseCount === 0 ? 'extracted' : sparseCount === totalCount ? 'pending-rescan' : 'partial'

  if (dependencyDataSource !== 'extracted') {
    warnings.push(
      backfillDependencies
        ? `${sparseCount} of ${totalCount} installed skill(s) still have no dependency data after ` +
            'inline backfill (SKILL.md missing, unreadable, or genuinely has zero declared/inferred ' +
            'dependencies) — run skill_rescan directly for full diagnostics on those skills.'
        : `${sparseCount} of ${totalCount} installed skill(s) have no skill_dependencies rows. This ` +
            'is the expected default first-run outcome if skill_rescan has not been run yet. Run the ' +
            'skill_rescan MCP tool to populate dependency data, or re-export with backfillDependencies: true.'
    )
  }

  return { depsBySkillId, dependencyDataSource, perSkillDataSource, warnings }
}

// ============================================================================
// Dependency-graph edges (declared only — decision #2)
// ============================================================================

function applyDependencyGraph(
  bom: Models.Bom,
  data: ComplianceData,
  componentBySkillId: Map<string, Models.Component>,
  depsBySkillId: Map<string, SkillDependencyRow[]>,
  perSkillDataSource: Map<string, 'extracted' | 'pending-rescan'>
): void {
  const mcpComponents = new Map<string, Models.Component>()
  const modelComponents = new Map<string, Models.Component>()

  for (const skill of data.skills) {
    const component = componentBySkillId.get(skill.skillId)
    if (!component) continue
    const rows = depsBySkillId.get(skill.skillId) ?? []

    // Per-component mirror of the BOM-level dependencyDataSource (fixed
    // alongside the per-skill sparse-data detection above) — a skill that's
    // still sparse (zero rows, whether backfill was never attempted, ran
    // but found genuinely zero deps, or couldn't run for lack of an
    // installPath) gets an explicit signal on ITS OWN component, not just a
    // silently-empty properties list with no explanation.
    component.properties.add(
      new Models.Property(
        'skillsmith:dependencyDataSource',
        perSkillDataSource.get(skill.skillId) ?? 'pending-rescan'
      )
    )

    for (const dep of rows) {
      // CONFIRMED decision #2: every dependency row is surfaced as an
      // advisory property regardless of source, but only `declared` rows
      // ever become a first-class `dependencies` graph edge below.
      const value = dep.dep_version ? `${dep.dep_target}@${dep.dep_version}` : dep.dep_target
      component.properties.add(new Models.Property(`skillsmith:dep:${dep.dep_type}`, value))
      component.properties.add(
        new Models.Property(`skillsmith:dep:${dep.dep_type}:source`, dep.dep_source)
      )

      if (dep.dep_source !== 'declared') continue

      if (SKILL_DEP_TYPES.has(dep.dep_type)) {
        const target = componentBySkillId.get(dep.dep_target)
        if (target) component.dependencies.add(target.bomRef)
      } else if (dep.dep_type === 'mcp_server') {
        const mcpComponent = getOrCreateComponent(
          mcpComponents,
          dep.dep_target,
          'mcp-server',
          Enums.ComponentType.Library
        )
        component.dependencies.add(mcpComponent.bomRef)
      } else if (MODEL_DEP_TYPES.has(dep.dep_type)) {
        const modelComponent = getOrCreateComponent(
          modelComponents,
          dep.dep_target,
          'model',
          Enums.ComponentType.MachineLearningModel
        )
        component.dependencies.add(modelComponent.bomRef)
      }
      // else: env_tool/env_os/env_node/cli_version/conflict — constraint,
      // not an artifact. Advisory property only (added above); no component,
      // no graph edge, declared or not.
    }
  }

  for (const c of mcpComponents.values()) bom.components.add(c)
  for (const c of modelComponents.values()) bom.components.add(c)
}

// ============================================================================
// Audit logging (BOM-export calls → audit_logs, per other Enterprise
// compliance tools)
// ============================================================================

function logExport(
  db: Database | undefined,
  componentCount: number,
  dependencyDataSource: DependencyDataSource,
  backfillDependencies: boolean
): void {
  if (!db) return
  try {
    const auditLogger = new AuditLogger(db)
    auditLogger.log({
      event_type: 'compliance_export',
      actor: 'user',
      resource: 'compliance_report:cyclonedx',
      action: 'export',
      result: 'success',
      metadata: { componentCount, dependencyDataSource, backfillDependencies },
    })
  } catch {
    // Audit logging is best-effort — a logging failure must never fail the
    // export itself (the export's own data is unaffected either way).
  }
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Build a CycloneDX 1.5 AI/ML-BOM JSON document from compliance data.
 *
 * Schema-valid by construction (library-backed serialization) — validated in
 * tests via `Validation.JsonStrictValidator`, not just eyeballed. See the
 * module doc above for the three CONFIRMED design decisions this
 * implementation honors.
 */
export async function formatCycloneDx(
  data: ComplianceData,
  options: CycloneDxBuildOptions = {}
): Promise<Record<string, unknown>> {
  const backfillDependencies = options.backfillDependencies ?? false

  const bom = new Models.Bom()
  bom.metadata.timestamp = new Date()
  bom.metadata.tools.tools.add(
    new Models.Tool({ vendor: 'Skillsmith', name: 'compliance-report', version: TOOL_VERSION })
  )
  bom.metadata.component = new Models.Component(
    Enums.ComponentType.Application,
    BOM_APPLICATION_NAME,
    { version: TOOL_VERSION }
  )

  // Components — one per installed skill. No redaction (decision #3): every
  // skill in `data.skills` (already installed-scope only, per the SMI-5675
  // fix in compliance-tools.service.ts) is included, including local/
  // proprietary ones (trustTier === 'local'), with real names.
  const componentBySkillId = new Map<string, Models.Component>()
  for (const skill of data.skills) {
    const component = buildSkillComponent(skill)
    componentBySkillId.set(skill.skillId, component)
    bom.components.add(component)
  }

  const { depsBySkillId, dependencyDataSource, perSkillDataSource, warnings } =
    await resolveDependencies(data, options.skillDependencyRepository, backfillDependencies)

  applyDependencyGraph(bom, data, componentBySkillId, depsBySkillId, perSkillDataSource)

  // BOM-level sparse-data signal lives in metadata.properties (not just a
  // sibling warning string in the tool-response envelope) so it survives
  // when the BOM is extracted/forwarded to a regulator or auditor.
  bom.metadata.properties.add(
    new Models.Property('skillsmith:dependencyDataSource', dependencyDataSource)
  )
  // SMI-3140 Wave 3: this AI/ML-BOM export is newly launched and not yet
  // validated at scale (real Enterprise customers get it live before either
  // UAT track runs — see the plan doc's Wave 3 intro). Remove this notice
  // once both UAT tracks have reported back.
  bom.metadata.properties.add(
    new Models.Property(
      'skillsmith:notice',
      'This CycloneDX AI/ML-BOM export is newly launched and not yet validated at scale. ' +
        'Please report any issues encountered.'
    )
  )
  warnings.forEach((warning, i) => {
    bom.metadata.properties.add(new Models.Property(`skillsmith:warning:${i}`, warning))
  })

  logExport(options.db, data.skills.length, dependencyDataSource, backfillDependencies)

  const factory = new Serialize.JSON.Normalize.Factory(Spec.Spec1dot5)
  const serializer = new Serialize.JsonSerializer(factory)
  const json = serializer.serialize(bom, { sortLists: true })
  return JSON.parse(json) as Record<string, unknown>
}
