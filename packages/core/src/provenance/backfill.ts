/**
 * @fileoverview Backfill recovered sources into the skill manifest.
 * @module @skillsmith/core/provenance/backfill
 * @see SMI-5407
 *
 * Plans manifest entries from a {@link RecoveryReport} and (when `apply`)
 * writes them via a single `ManifestManager.updateSafely` merge that ADDs or
 * fills-missing `source`/`id` but NEVER clobbers a healthy existing entry --
 * even when the recovered value differs. Idempotent: a second run is a no-op.
 *
 * Backfill keys (load-bearing, per plan-review):
 *   - `id`     = registry UUID when a registry tier resolved it, else `owner/skill-name`.
 *   - `source` = `https://github.com/<owner>/<repo>` (the form buildRawUrl accepts).
 */

import { existsSync } from 'fs'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { ManifestManager } from '../services/skill-manifest.js'
import { hashContent as defaultHashContent } from '../services/skill-installation.helpers.js'
import type { SkillManifestEntry } from '../services/skill-installation.types.js'

import type { RecoveryConfidence, RecoveryReport, SkillRecoveryResult } from './types.js'

/** Options controlling a backfill run. */
export interface BackfillOptions {
  /** Manifest path. Defaults to `~/.skillsmith/manifest.json`. */
  manifestPath?: string
  /** Minimum confidence to auto-qualify (default `high`). */
  minConfidence?: RecoveryConfidence
  /** Write changes. When false (default), the run is a dry-run plan only. */
  apply?: boolean
  /** Opt-in: write `repository:` into non-git skills' SKILL.md frontmatter. */
  writeFrontmatter?: boolean
  /** Explicit `<dirName> -> 'owner/repo'` overrides (resolved user-specified). */
  setOverrides?: Record<string, string>
  /** Injected `lastUpdated` ISO timestamp for deterministic tests. */
  now?: string
  /** Injected content hasher (defaults to the shared `hashContent`). */
  hashContent?: (content: string) => string
}

/** Outcome of a backfill run. */
export interface BackfillOutcome {
  /** Entries planned for write (all that qualify), regardless of `apply`. */
  planned: SkillManifestEntry[]
  /** Skill names actually written (apply only). */
  written: string[]
  /** Skill names skipped (unqualified, bad override, or healthy/clobber-protected). */
  skipped: string[]
}

const CONFIDENCE_RANK: Record<RecoveryConfidence, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  exact: 4,
  'user-specified': 5,
}

function defaultManifestPath(): string {
  return path.join(os.homedir(), '.skillsmith', 'manifest.json')
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** A manifest entry is "healthy" once it carries both a non-empty source and id. */
function isHealthy(entry: SkillManifestEntry): boolean {
  return nonEmpty(entry.source) && nonEmpty(entry.id)
}

/**
 * Does a result qualify for backfill? The `minConfidence` floor IS the gate
 * (default `high` -> only exact/high auto-write). Lowering it to `medium`
 * admits a single registry-name match (which carries the registry UUID, so
 * `skill_outdated` can resolve it); ambiguous multi-candidate results never
 * qualify because their `recoveredSource` is null (planResult drops them).
 * `unknown` never qualifies. SMI-5407.
 */
function qualifies(confidence: RecoveryConfidence, minConfidence: RecoveryConfidence): boolean {
  if (confidence === 'unknown') return false
  return CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK[minConfidence]
}

/** Parse an `owner/repo` override spec. */
function parseOwnerRepo(spec: string): { owner: string; repo: string } | null {
  const parts = spec.split('/').filter(Boolean)
  if (parts.length !== 2) return null
  return { owner: parts[0], repo: parts[1] }
}

interface BuildEntryParams {
  installPath: string
  skillName: string
  owner: string
  sourceUrl: string
  registryId: string | null
  now: string
  hash: (content: string) => string
}

/** Build a complete manifest entry, deriving installedAt/hash from SKILL.md. */
async function buildEntry(params: BuildEntryParams): Promise<SkillManifestEntry> {
  const { installPath, skillName, owner, sourceUrl, registryId, now, hash } = params
  const skillMdPath = path.join(installPath, 'SKILL.md')

  let installedAt = now
  let originalContentHash: string | undefined
  try {
    const stat = await fs.stat(skillMdPath)
    installedAt = stat.mtime.toISOString()
    const content = await fs.readFile(skillMdPath, 'utf-8')
    originalContentHash = hash(content)
  } catch {
    // SKILL.md unreadable -- fall back to `now` and leave hash undefined.
  }

  const id = nonEmpty(registryId ?? undefined) ? (registryId as string) : `${owner}/${skillName}`

  return {
    id,
    name: skillName,
    version: '1.0.0',
    source: sourceUrl,
    installPath,
    installedAt,
    lastUpdated: now,
    originalContentHash,
  }
}

/** Plan one entry from a result; returns null when it does not qualify. */
async function planResult(
  result: SkillRecoveryResult,
  overrides: Record<string, string>,
  minConfidence: RecoveryConfidence,
  now: string,
  hash: (content: string) => string
): Promise<SkillManifestEntry | null> {
  const override = overrides[result.skillName]
  if (override) {
    const ownerRepo = parseOwnerRepo(override)
    if (!ownerRepo) return null
    return buildEntry({
      installPath: result.installPath,
      skillName: result.skillName,
      owner: ownerRepo.owner,
      sourceUrl: `https://github.com/${ownerRepo.owner}/${ownerRepo.repo}`,
      registryId: null,
      now,
      hash,
    })
  }

  if (!qualifies(result.confidence, minConfidence) || !result.recoveredSource) return null

  return buildEntry({
    installPath: result.installPath,
    skillName: result.skillName,
    owner: result.recoveredSource.owner,
    sourceUrl: result.recoveredSource.url,
    registryId: result.registryId,
    now,
    hash,
  })
}

/** Fill missing fields from `planned` onto an unhealthy `existing` entry. */
function mergeEntry(existing: SkillManifestEntry, planned: SkillManifestEntry): SkillManifestEntry {
  return {
    ...existing,
    id: nonEmpty(existing.id) ? existing.id : planned.id,
    name: nonEmpty(existing.name) ? existing.name : planned.name,
    version: nonEmpty(existing.version) ? existing.version : planned.version,
    source: planned.source, // existing is unhealthy (no source) -- fill it
    installPath: nonEmpty(existing.installPath) ? existing.installPath : planned.installPath,
    installedAt: nonEmpty(existing.installedAt) ? existing.installedAt : planned.installedAt,
    lastUpdated: planned.lastUpdated,
    originalContentHash: existing.originalContentHash ?? planned.originalContentHash,
  }
}

/**
 * Write `repository: <url>` into a non-git skill's SKILL.md frontmatter.
 * Skips git checkouts and skills that already declare a `repository:`.
 */
async function maybeWriteFrontmatter(dir: string, sourceUrl: string): Promise<boolean> {
  if (existsSync(path.join(dir, '.git', 'config'))) return false

  const skillMdPath = path.join(dir, 'SKILL.md')
  let content: string
  try {
    content = await fs.readFile(skillMdPath, 'utf-8')
  } catch {
    return false
  }

  if (!content.startsWith('---')) return false
  const endIndex = content.indexOf('\n---', 3)
  if (endIndex === -1) return false

  const block = content.slice(0, endIndex)
  if (/^repository\s*:/m.test(block)) return false

  const updated = block + `\nrepository: ${sourceUrl}` + content.slice(endIndex)
  await fs.writeFile(skillMdPath, updated, 'utf-8')
  return true
}

/**
 * Plan and (optionally) apply manifest backfill for recovered sources.
 */
export async function backfillManifest(
  report: RecoveryReport,
  opts: BackfillOptions = {}
): Promise<BackfillOutcome> {
  const manifestPath = opts.manifestPath ?? defaultManifestPath()
  const minConfidence = opts.minConfidence ?? 'high'
  const apply = opts.apply ?? false
  const now = opts.now ?? new Date().toISOString()
  const hash = opts.hashContent ?? defaultHashContent
  const overrides = opts.setOverrides ?? {}

  const planned: SkillManifestEntry[] = []
  const plannedByName = new Map<string, SkillManifestEntry>()
  const skipped: string[] = []

  for (const result of report.skills) {
    const entry = await planResult(result, overrides, minConfidence, now, hash)
    if (!entry) {
      skipped.push(result.skillName)
      continue
    }
    planned.push(entry)
    plannedByName.set(result.skillName, entry)
  }

  // Dry-run, or nothing qualified: never touch the manifest.
  if (!apply || plannedByName.size === 0) {
    return { planned, written: [], skipped }
  }

  const written: string[] = []
  const manager = new ManifestManager(manifestPath)
  await manager.updateSafely((manifest) => {
    const installed = { ...manifest.installedSkills }
    for (const [name, entry] of plannedByName) {
      const existing = installed[name]
      if (existing && isHealthy(existing)) {
        skipped.push(name) // never clobber a healthy entry
        continue
      }
      installed[name] = existing ? mergeEntry(existing, entry) : entry
      written.push(name)
    }
    return { ...manifest, installedSkills: installed }
  })

  if (opts.writeFrontmatter) {
    for (const name of written) {
      const entry = plannedByName.get(name)
      if (entry) await maybeWriteFrontmatter(entry.installPath, entry.source)
    }
  }

  return { planned, written, skipped }
}
