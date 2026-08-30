/**
 * @fileoverview Helper functions for SkillInstallationService
 * @module @skillsmith/core/services/skill-installation.helpers
 * @see SMI-3483: Wave 0 — Extract SkillInstallationService into core
 *
 * Pure helper functions used by the service. Split from the main service
 * file to meet the 500-line standard.
 */

import { existsSync, readFileSync } from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'

import { extractMcpReferences } from '../analysis/McpReferenceExtractor.js'
import { mergeDependencies } from '../analysis/DependencyMerger.js'

import type { SkillDependencyRepository } from '../repositories/SkillDependencyRepository.js'
import type { SkillDependencyRow } from '../types/dependencies.js'

import { TransformationService } from '../services/TransformationService.js'
import type { Database } from '../db/database-interface.js'
import { computeQualityScore } from '../scoring/quality-score.js'
import type { RiskScoreHistoryRepository } from '../repositories/RiskScoreHistoryRepository.js'
import type { ScanReport } from '../security/index.js'
import type { DepIntelResult, OptimizationInfo } from './skill-installation.types.js'

export { fetchFromGitHub } from './skill-installation.io.js'
import { CANONICAL_CLIENT, CLIENT_DISPLAY_LABELS, type ClientId } from '../install/paths.js'

/** Result of applying optimization to a skill's content. */
export interface OptimizationResult {
  finalSkillContent: string
  subSkillFiles: Array<{ filename: string; content: string }>
  subagentContent: string | undefined
  claudeMdSnippet: string | undefined
  optimizationInfo: OptimizationInfo
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * SMI-5894 (Wave 1 Step 5): `client`/`skillsDir` default to the canonical
 * (Claude Code) client so every existing caller that doesn't pass them
 * (tests, and anywhere the service is constructed without `client`) keeps
 * seeing exactly the previous "Claude Code" / `~/.claude/skills/` wording —
 * only a caller that actually resolved a non-canonical client sees the tips
 * name that client and its real install path.
 */
export function generateTips(
  skillName: string,
  optimizationInfo: OptimizationInfo,
  client: ClientId = CANONICAL_CLIENT,
  skillsDir?: string
): string[] {
  const clientLabel = CLIENT_DISPLAY_LABELS[client]
  const dir = skillsDir ?? '~/.claude/skills'
  const tips = [
    'Skill "' + skillName + '" installed successfully!',
    'To use this skill, mention it in ' + clientLabel + ': "Use the ' + skillName + ' skill to..."',
    'View installed skills: ls ' + dir + '/',
  ]

  if (optimizationInfo.optimized) {
    tips.push('', '[Optimization] Skillsmith Optimization Applied:')
    if (optimizationInfo.tokenReductionPercent && optimizationInfo.tokenReductionPercent > 0) {
      tips.push('  - Estimated ' + optimizationInfo.tokenReductionPercent + '% token reduction')
    }
    if (optimizationInfo.subSkills && optimizationInfo.subSkills.length > 0) {
      tips.push('  - ' + optimizationInfo.subSkills.length + ' sub-skills created')
    }
    if (optimizationInfo.subagentGenerated && optimizationInfo.subagentPath) {
      tips.push('  - Companion subagent generated: ' + optimizationInfo.subagentPath)
    }
  }

  tips.push('', 'To uninstall: use the uninstall_skill tool')
  return tips
}

/**
 * Read the MCP server names registered in the consuming project's
 * `.mcp.json` (SMI-5676). Used to cross-check `extractMcpReferences`
 * candidates against what's *actually* configured, so a stale/renamed
 * reference (e.g. `claude-flow` after this project's own rename to `ruflo`)
 * gets tagged `unregistered` in `serverResolutions` instead of silently
 * asserted as a real dependency — without ever dropping a candidate that
 * simply isn't installed *yet*.
 *
 * Fails open: returns `undefined` (not `[]`) when `.mcp.json` is missing,
 * unreadable, or unparseable — `extractMcpReferences` treats `undefined` as
 * "no information available" (`serverResolutions` = `'unknown'`), whereas
 * `[]` would mean "zero servers registered", incorrectly tagging every real
 * candidate `unregistered`.
 *
 * @param projectRoot - Directory to look for `.mcp.json` in (defaults to
 *   `process.cwd()`, matching the convention used elsewhere in the codebase
 *   for locating a consuming project's config, e.g.
 *   `packages/mcp-server/src/context/project-detector.ts`).
 */
export function getRegisteredMcpServers(projectRoot: string = process.cwd()): string[] | undefined {
  const mcpJsonPath = path.join(projectRoot, '.mcp.json')
  if (!existsSync(mcpJsonPath)) return undefined

  try {
    const raw = readFileSync(mcpJsonPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return undefined

    const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers
    if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
      return undefined
    }

    return Object.keys(mcpServers as Record<string, unknown>)
  } catch {
    return undefined
  }
}

export function extractDepIntel(skillMdContent: string): DepIntelResult {
  const mcpResult = extractMcpReferences(skillMdContent, getRegisteredMcpServers())
  const warnings: string[] = []
  for (const server of mcpResult.highConfidenceServers) {
    // Don't warn about a server we positively confirmed IS configured —
    // only flag servers we couldn't confirm (unregistered/unknown).
    if (mcpResult.serverResolutions?.[server] === 'registered') continue
    warnings.push("MCP server '" + server + "' is referenced but may not be configured")
  }
  return {
    dep_inferred_servers: mcpResult.servers,
    dep_declared: undefined,
    dep_warnings: warnings,
  }
}

/**
 * Extract + persist dependency intelligence for a skill.
 *
 * @returns The number of dependency rows written (inserted or upserted) this
 *   call — i.e. `merged.length`. Because `SkillDependencyRepository.setDependencies`
 *   upserts on (skill_id, dep_type, dep_target, dep_source), calling this
 *   repeatedly with the same skillId/content is idempotent: the count
 *   reflects the size of the currently-extracted dependency set on every
 *   call, not a cumulative "newly inserted since last call" delta. Callers
 *   that need a per-run backfill count (SMI-5645) can rely on this return
 *   value directly.
 */
export function persistDependencies(
  repo: SkillDependencyRepository,
  skillId: string,
  content: string,
  declared: DepIntelResult['dep_declared']
): number {
  const mcpResult = extractMcpReferences(content, getRegisteredMcpServers())
  const merged = mergeDependencies(declared, mcpResult)
  if (merged.length === 0) return 0

  const rows: SkillDependencyRow[] = merged.map((dep) => ({
    skill_id: skillId,
    dep_type: dep.depType,
    dep_target: dep.depTarget,
    dep_version: dep.depVersion,
    dep_source: dep.depSource,
    confidence: dep.confidence,
    metadata: dep.metadata,
  }))

  const bySource = new Map<string, SkillDependencyRow[]>()
  for (const row of rows) {
    const existing = bySource.get(row.dep_source) ?? []
    existing.push(row)
    bySource.set(row.dep_source, existing)
  }

  for (const [source, sourceRows] of bySource) {
    repo.setDependencies(skillId, sourceRows, source as SkillDependencyRow['dep_source'])
  }

  return rows.length
}

/**
 * SMI-5894 (Wave 1 Step 3): compute the `~/.skillsmith/manifest.json`
 * `installedSkills` key for a given skill name + client.
 *
 * Canonical-client (`claude-code`) entries keep the legacy bare-name key —
 * every manifest reader written before multi-client installs existed
 * (`pin.ts`, `diff.ts`, MCP's `install.conflict.ts`, MCP's `uninstall_skill`
 * `listInstalledSkills()`, none of which are in this wave's scope) indexes
 * `installedSkills[name]` directly and must keep working unmodified for the
 * single-client-install case, which remains the overwhelming majority.
 * Only non-canonical clients get the composite `name::client` key, since
 * those are the ONLY entries that could previously silently collide with
 * (overwrite) a same-named install recorded under a different client —
 * exactly the bug this function exists to close. See the plan doc
 * (docs/internal/implementation/cursor-integration-readiness-cli-mcp-parity.md,
 * Wave 1 Step 3) for the full rationale and the deliberately additive,
 * backward-compatible shape of this fix.
 */
export function manifestKeyFor(name: string, client: ClientId): string {
  return client === CANONICAL_CLIENT ? name : `${name}::${client}`
}

// ADR-139 (SMI-6274 Wave 4): `performUninstall` (manifest-aware removal +
// untracked-skill adoption) now lives in `skill-installation.uninstall.ts`
// — split out to stay under the 500-line standard.
export { performUninstall } from './skill-installation.uninstall.js'

/**
 * Apply skill optimization via TransformationService.
 * Returns original content if transformation fails or produces no changes.
 *
 * @param client - SMI-6276: target client for the generated companion-agent
 *   frontmatter shape (default: canonical / `claude-code`, preserving prior
 *   behavior for every existing caller). See
 *   `SubagentGenerator.client-profiles.ts`.
 */
export async function applyOptimization(
  db: Database,
  skillId: string,
  skillName: string,
  skillMdContent: string,
  client: ClientId = CANONICAL_CLIENT
): Promise<OptimizationResult> {
  try {
    const transformService = new TransformationService(db, {
      cacheTtl: 3600,
      version: '1.0.0',
    })

    const nameMatch = skillMdContent.match(/^name:\s*(\S.*)$/m)
    const descMatch = skillMdContent.match(/^description:\s*(\S.*)$/m)
    const extractedName = nameMatch ? nameMatch[1].trim() : skillName
    const extractedDesc = descMatch ? descMatch[1].trim() : ''

    const transformResult = await transformService.transform(
      skillId,
      extractedName,
      extractedDesc,
      skillMdContent,
      client
    )

    if (transformResult.transformed) {
      return {
        finalSkillContent: transformResult.mainSkillContent,
        subSkillFiles: transformResult.subSkills,
        subagentContent: transformResult.subagent?.content,
        claudeMdSnippet: transformResult.claudeMdSnippet,
        optimizationInfo: {
          optimized: true,
          subSkills: transformResult.subSkills.map((s) => s.filename),
          subagentGenerated: !!transformResult.subagent?.content,
          tokenReductionPercent: transformResult.stats.tokenReductionPercent,
          originalLines: transformResult.stats.originalLines,
          optimizedLines: transformResult.stats.optimizedLines,
        },
      }
    }
  } catch {
    // Transformation failed — continue with original content
  }

  return {
    finalSkillContent: skillMdContent,
    subSkillFiles: [],
    subagentContent: undefined,
    claudeMdSnippet: undefined,
    optimizationInfo: { optimized: false },
  }
}

/** Sanitize install error messages to avoid leaking internal details. */
const KNOWN_ERROR_PREFIXES = [
  'already installed',
  'Could not find SKILL.md',
  'registry data quality issue',
  'Invalid SKILL.md',
  'Invalid skill ID format',
  'Security scan failed',
  'exceeds maximum length',
  'Refusing to write to symlink',
  'Refusing to write to hardlinked file',
  'Install path escapes skills directory',
  'Cannot skip security scan',
  // SMI-5982 PR-review follow-up: resolveCompanionAgentPath()'s required-baseDir guard
  // (install/paths.ts) — must surface verbatim so a directory-package-mode client (e.g.
  // a private-registry install with no per-call cwd input) fails closed with a
  // diagnosable message instead of the generic fallback below.
  'uses directory-package mode',
]

export function sanitizeInstallError(error: unknown): string {
  if (error instanceof Error) {
    if (KNOWN_ERROR_PREFIXES.some((p) => error.message.includes(p))) {
      return error.message
    }
  }
  return 'Installation failed due to an internal error'
}
// SMI-3864: Quality score + risk history helpers

/** Compute quality score (0-1) from scan report and skill metadata. */
export function computeAndAttachQualityScore(params: {
  scanReport: ScanReport | undefined
  description: string | null
  tagCount: number
  hasRepoUrl: boolean
  hasAuthor: boolean
  trustTier: string
  hasExamples: boolean
}): number {
  return computeQualityScore({
    riskScore: params.scanReport?.riskScore ?? null,
    securityFindingsCount: params.scanReport?.findings.length ?? 0,
    securityPassed: params.scanReport?.passed ?? null,
    description: params.description,
    tagCount: params.tagCount,
    hasRepoUrl: params.hasRepoUrl,
    hasAuthor: params.hasAuthor,
    trustTier: params.trustTier,
    hasExamples: params.hasExamples,
  })
}

/** Record a risk score snapshot. Best-effort: swallows errors. */
export function recordRiskHistory(params: {
  historyRepo: RiskScoreHistoryRepository | undefined
  skillId: string
  scanReport: ScanReport
  contentHash: string | null
  source: 'install' | 'indexer' | 'rescan'
}): void {
  if (!params.historyRepo) return
  try {
    params.historyRepo.record({
      skillId: params.skillId,
      riskScore: params.scanReport.riskScore,
      findingsCount: params.scanReport.findings.length,
      contentHash: params.contentHash,
      scannedAt: params.scanReport.scannedAt.toISOString(),
      source: params.source,
    })
  } catch {
    // Best-effort — do not block install on history recording failure
  }
}
