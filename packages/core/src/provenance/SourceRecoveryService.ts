/**
 * @fileoverview Tiered source-recovery orchestrator.
 * @module @skillsmith/core/provenance/SourceRecoveryService
 * @see SMI-5407
 *
 * Resolves the canonical GitHub source of each locally-installed skill by
 * trying tiers in confidence order and short-circuiting on the first hit:
 *   git remote (exact) -> plugin manifest (high) -> registry name
 *   (medium/low, review-only) -> embedding (opt-in) -> hints (opt-in) -> unknown.
 *
 * The git and plugin tiers are local file reads: they resolve the SOURCE
 * before any injected dependency is invoked. They then make a best-effort,
 * OFFLINE call to the optional `findRegistryIdByRepoUrl` (local catalog lookup)
 * to enrich the manifest id with a registry UUID (SMI-5411) -- never network,
 * never throws. An offline run never touches the network.
 */

import * as os from 'os'
import * as path from 'path'

import { SkillParser } from '../indexer/SkillParser.js'

import { parseGitConfigRemote, normalizeGitHubRemote } from './git-config.js'
import { parsePluginManifestRepository } from './plugin-manifest.js'
import { scanLocalSkills } from './local-skill-scan.js'
import type {
  RecoveredSource,
  RecoveryCandidate,
  RecoveryDeps,
  RecoveryReport,
  RecoverySummary,
  SkillRecoveryResult,
} from './types.js'

/** Options for a full recovery run. */
export interface RecoverSourcesOptions {
  /** Root to scan. Defaults to `~/.claude/skills`. */
  skillsRoot?: string
  /** Restrict to these skill directory names. */
  only?: string[]
  /** Enable the embedding tiebreak tier (off by default). */
  enableEmbedding?: boolean
  /** Enable the catalog / author hint tier (off by default). */
  enableCatalogHint?: boolean
}

/** Per-skill resolution options (opt-in tiers). */
export interface RecoverOneOptions {
  enableEmbedding?: boolean
  enableCatalogHint?: boolean
}

const frontmatterParser = new SkillParser({ requireName: false })

/** Default install root for locally-installed skills. */
export function defaultSkillsRoot(): string {
  return path.join(os.homedir(), '.claude', 'skills')
}

function candidateSource(candidate: RecoveryCandidate): RecoveredSource {
  return { owner: candidate.owner, repo: candidate.repo, url: candidate.url }
}

function resolvedResult(
  skillName: string,
  installPath: string,
  source: RecoveredSource,
  method: SkillRecoveryResult['method'],
  confidence: SkillRecoveryResult['confidence'],
  registryId: string | null,
  candidates: RecoveryCandidate[] = []
): SkillRecoveryResult {
  return {
    skillName,
    installPath,
    recoveredSource: source,
    registryId,
    method,
    confidence,
    candidates,
    status: 'recovered',
  }
}

function unknownResult(skillName: string, installPath: string): SkillRecoveryResult {
  return {
    skillName,
    installPath,
    recoveredSource: null,
    registryId: null,
    method: null,
    confidence: 'unknown',
    candidates: [],
    status: 'unknown',
  }
}

function backupResult(skillName: string, installPath: string): SkillRecoveryResult {
  return {
    skillName,
    installPath,
    recoveredSource: null,
    registryId: null,
    method: null,
    confidence: 'unknown',
    candidates: [],
    status: 'skipped_backup',
  }
}

/** GitHub usernames: 1-39 chars, alphanumeric or hyphen, no leading/trailing hyphen. */
function isPlausibleOwner(value: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(value)
}

function computeSummary(skills: SkillRecoveryResult[]): RecoverySummary {
  const summary: RecoverySummary = {
    total: skills.length,
    recovered: 0,
    already_tracked: 0,
    unknown: 0,
    skipped_backup: 0,
  }
  for (const skill of skills) {
    summary[skill.status] += 1
  }
  return summary
}

export class SourceRecoveryService {
  constructor(private readonly deps: RecoveryDeps) {}

  /**
   * Best-effort OFFLINE registry-UUID enrichment for a git/plugin source URL.
   * Returns the catalog UUID for `url`'s repo when the optional dep is wired and
   * a match exists; null otherwise. NEVER throws -- a missing dep, a no-match, or
   * a dep failure all degrade to null so the already-resolved (exact/high) source
   * is never lost. SMI-5411.
   */
  private async enrichRegistryId(url: string): Promise<string | null> {
    if (!this.deps.findRegistryIdByRepoUrl) return null
    try {
      return await this.deps.findRegistryIdByRepoUrl(url)
    } catch {
      return null
    }
  }

  /** Scan `skillsRoot` and resolve every (non-filtered) skill's source. */
  async recoverSources(opts: RecoverSourcesOptions = {}): Promise<RecoveryReport> {
    const skillsRoot = opts.skillsRoot ?? defaultSkillsRoot()
    const entries = await scanLocalSkills(skillsRoot)
    const only = opts.only
    const filtered =
      only && only.length > 0 ? entries.filter((e) => only.includes(e.skillName)) : entries

    const skills: SkillRecoveryResult[] = []
    for (const entry of filtered) {
      if (entry.isBackup) {
        skills.push(backupResult(entry.skillName, entry.dir))
        continue
      }
      skills.push(
        await this.recoverOne(entry.dir, entry.skillName, entry.skillMd, {
          enableEmbedding: opts.enableEmbedding,
          enableCatalogHint: opts.enableCatalogHint,
        })
      )
    }

    return { skills, summary: computeSummary(skills) }
  }

  /**
   * Resolve a single skill directory. Tiers short-circuit on the first hit; the
   * git and plugin tiers resolve the source before any dependency call, then
   * best-effort enrich the manifest id with a registry UUID via the optional,
   * OFFLINE `findRegistryIdByRepoUrl`.
   */
  async recoverOne(
    dir: string,
    skillName: string,
    skillMd: string | null,
    opts: RecoverOneOptions = {}
  ): Promise<SkillRecoveryResult> {
    // Tier 1: git remote (exact) -- source is offline; the id enrichment is a
    // best-effort offline catalog lookup (SMI-5411).
    const git = parseGitConfigRemote(dir)
    if (git) {
      const registryId = await this.enrichRegistryId(git.url)
      return resolvedResult(skillName, dir, git, 'git-remote', 'exact', registryId)
    }

    // Tier 2: plugin manifest (high) -- same offline id enrichment.
    const plugin = parsePluginManifestRepository(dir)
    if (plugin) {
      const registryId = await this.enrichRegistryId(plugin.url)
      return resolvedResult(skillName, dir, plugin, 'plugin-json', 'high', registryId)
    }

    // Tier 3: registry name match (medium/low) -- REVIEW ONLY.
    const candidates = await this.deps.findCandidatesByName(skillName)
    if (candidates.length === 1) {
      const candidate = candidates[0]
      return resolvedResult(
        skillName,
        dir,
        candidateSource(candidate),
        'registry-name',
        'medium',
        candidate.id
      )
    }
    if (candidates.length > 1) {
      return this.resolveAmbiguous(dir, skillName, skillMd, candidates, opts)
    }

    // Tier 5: hints (opt-in, low).
    if (opts.enableCatalogHint) {
      const hint = await this.resolveHint(dir, skillName, skillMd)
      if (hint) return hint
    }

    // Tier 6: unknown.
    return unknownResult(skillName, dir)
  }

  /** Tier 4: embedding tiebreak over an ambiguous candidate set (opt-in). */
  private async resolveAmbiguous(
    dir: string,
    skillName: string,
    skillMd: string | null,
    candidates: RecoveryCandidate[],
    opts: RecoverOneOptions
  ): Promise<SkillRecoveryResult> {
    if (opts.enableEmbedding && this.deps.rankByEmbedding && skillMd) {
      const ranked = await this.deps.rankByEmbedding(skillName, skillMd, candidates)
      if (ranked.length > 0) {
        const top = ranked[0]
        return resolvedResult(
          skillName,
          dir,
          candidateSource(top),
          'registry-embedding',
          'low',
          top.id,
          ranked
        )
      }
    }
    // Ambiguous and unresolved: surface the candidates for review.
    return {
      skillName,
      installPath: dir,
      recoveredSource: null,
      registryId: null,
      method: 'registry-name',
      confidence: 'low',
      candidates,
      status: 'unknown',
    }
  }

  /** Tier 5 helper: catalog repo_url then a speculative frontmatter author. */
  private async resolveHint(
    dir: string,
    skillName: string,
    skillMd: string | null
  ): Promise<SkillRecoveryResult | null> {
    if (this.deps.lookupCatalogRepoUrl) {
      const url = await this.deps.lookupCatalogRepoUrl(skillName)
      if (url) {
        const source = normalizeGitHubRemote(url)
        if (source) return resolvedResult(skillName, dir, source, 'catalog-db', 'low', null)
      }
    }

    if (skillMd) {
      const fm = frontmatterParser.extractFrontmatter(skillMd)
      const author = typeof fm?.author === 'string' ? fm.author.trim() : ''
      if (author && isPlausibleOwner(author)) {
        const source: RecoveredSource = {
          owner: author,
          repo: skillName,
          url: `https://github.com/${author}/${skillName}`,
        }
        return resolvedResult(skillName, dir, source, 'author-hint', 'low', null)
      }
    }

    return null
  }
}
