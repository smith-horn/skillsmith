/**
 * @fileoverview `skill_recover_source` MCP tool (SMI-5407).
 * @module @skillsmith/mcp-server/tools/skill-recover-source
 *
 * Read-only tool: recovers the canonical GitHub source of locally-installed
 * skills. Never mutates the manifest — returns {skills, summary} for the
 * caller to inspect. The apply path (`apply_source_backfill`) is cut for v1.
 *
 * findCandidatesByName wiring:
 *   Online  — apiClient.search({ query: name, limit: 5 }), serial 100ms gap,
 *              429 -> [].
 *   Offline — local DB: SELECT id, name, repo_url, quality_score FROM skills
 *              WHERE name = ? (same shape as CLI path).
 *
 * findRegistryIdByRepoUrl wiring (SMI-5411): always the local catalog (SELECT id
 * FROM skills WHERE repo_url = ?), enriching a git/plugin-recovered manifest id
 * with the registry UUID so skill_outdated can resolve it. Best-effort/offline.
 *
 * homeDir refinement: must resolve under os.homedir() or os.tmpdir() (test
 * fixtures). Rejects arbitrary paths such as /etc.
 */

import * as os from 'node:os'
import * as path from 'node:path'

import { z } from 'zod'

import {
  SourceRecoveryService,
  defaultSkillsRoot,
  parseRepoUrl,
  skillNameVariants,
  type RecoveryCandidate,
} from '@skillsmith/core'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { hashContent } from './install.conflict-helpers.js'
import type { ToolContext } from '../context.js'
import type { SkillRecoverSourceResponse } from './skill-recover-source.types.js'

// ============================================================================
// homeDir refinement (mirrors skill-inventory-audit.ts:165)
// ============================================================================

export function isHomeDirUnderAllowedRoot(value: string): boolean {
  const resolved = path.resolve(value)
  const home = path.resolve(os.homedir())
  const tmp = path.resolve(os.tmpdir())
  return (
    resolved.startsWith(home + path.sep) ||
    resolved === home ||
    resolved.startsWith(tmp + path.sep) ||
    resolved === tmp
  )
}

// ============================================================================
// Input schema
// ============================================================================

export const skillRecoverSourceInputSchema = z
  .object({
    homeDir: z
      .string()
      .min(1)
      .refine(isHomeDirUnderAllowedRoot, {
        message:
          'homeDir must resolve under os.homedir() or os.tmpdir(); arbitrary filesystem paths are rejected',
      })
      .optional(),
    only: z.array(z.string().min(1)).optional(),
    embedding: z.boolean().optional(),
    catalogHint: z.boolean().optional(),
  })
  .strict()

export type SkillRecoverSourceValidatedInput = z.infer<typeof skillRecoverSourceInputSchema>

// ============================================================================
// MCP tool definition (ListTools)
// ============================================================================

export const skillRecoverSourceToolSchema = {
  name: 'skill_recover_source',
  description:
    '[Skillsmith — Maintain stage] Recover the canonical GitHub source of ' +
    'locally-installed skills (SMI-5407). Read-only — never mutates ' +
    '~/.skillsmith/manifest.json. Returns { skills, summary } where each ' +
    'skill entry reports confidence (exact/high/medium/low), method, and ' +
    'the recovered source URL. Feed exact/high results into ' +
    '`sklx audit sources --apply` to backfill the manifest.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      homeDir: {
        type: 'string',
        description:
          'Override the skills root parent. Must resolve under os.homedir() or os.tmpdir(); ' +
          'arbitrary paths (e.g. /etc) are rejected.',
      },
      only: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict recovery to these skill directory basenames.',
      },
      embedding: {
        type: 'boolean',
        description: 'Enable embedding tiebreak tier (off by default).',
      },
      catalogHint: {
        type: 'boolean',
        description: 'Enable catalog / author hint tier (off by default).',
      },
    },
    required: [],
  },
}

// ============================================================================
// Online candidate lookup (serial, 100ms gap, 429 -> [])
// ============================================================================

const CANDIDATE_GAP_MS = 100

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function findCandidatesOnline(
  context: ToolContext,
  name: string
): Promise<RecoveryCandidate[]> {
  try {
    const resp = await context.apiClient.search({ query: name, limit: 5 })
    if (!resp.data) return []
    const candidates: RecoveryCandidate[] = []
    for (const item of resp.data) {
      if (!item.repo_url) continue
      try {
        const parsed = parseRepoUrl(item.repo_url)
        candidates.push({
          id: item.id,
          name: item.name,
          owner: parsed.owner,
          repo: parsed.repo,
          url: `https://github.com/${parsed.owner}/${parsed.repo}`,
          qualityScore: item.quality_score ?? 0,
        })
      } catch {
        // Non-GitHub repo_url — skip.
      }
    }
    await sleep(CANDIDATE_GAP_MS)
    return candidates
  } catch {
    // Any network error (rate-limit / DNS / timeout) — degrade to no
    // candidates; the skill is reported `unknown` rather than failing the scan.
    return []
  }
}

function findCandidatesOffline(context: ToolContext, name: string): RecoveryCandidate[] {
  type SkillRow = {
    id: string
    name: string
    repo_url: string | null
    quality_score: number | null
  }
  const variants = skillNameVariants(name)
  const placeholders = variants.map(() => '?').join(', ')
  const rows = context.db
    .prepare<SkillRow>(
      `SELECT id, name, repo_url, quality_score FROM skills WHERE name IN (${placeholders})`
    )
    .all(...variants)

  const candidates: RecoveryCandidate[] = []
  for (const row of rows) {
    if (!row.repo_url) continue
    try {
      const parsed = parseRepoUrl(row.repo_url)
      candidates.push({
        id: row.id,
        name: row.name,
        owner: parsed.owner,
        repo: parsed.repo,
        url: `https://github.com/${parsed.owner}/${parsed.repo}`,
        qualityScore: row.quality_score ?? 0,
      })
    } catch {
      // Non-GitHub repo_url — skip.
    }
  }
  // Prefer an exact-name match so the affix-broadened query never downgrades a
  // clean exact hit to ambiguous; fall back to affix-variant candidates. SMI-5413.
  const exact = candidates.filter((c) => c.name.toLowerCase() === name.toLowerCase())
  return exact.length > 0 ? exact : candidates
}

/**
 * SMI-5411: offline registry-UUID enrichment for a git/plugin-recovered source.
 * The local catalog suffices (no online path) — the recovered URL is the
 * canonical `https://github.com/<owner>/<repo>` form, matched exactly against
 * the catalog's repo_url. Returns null on no match. Mirrors the CLI wiring.
 */
function findRegistryIdByRepoUrlOffline(context: ToolContext, repoUrl: string): string | null {
  const row = context.db
    .prepare<{ id: string }>('SELECT id FROM skills WHERE repo_url = ?')
    .get(repoUrl)
  return row?.id ?? null
}

// ============================================================================
// Tool implementation
// ============================================================================

async function skillRecoverSourceImpl(
  input: unknown,
  context: ToolContext
): Promise<SkillRecoverSourceResponse> {
  const parsed = skillRecoverSourceInputSchema.safeParse(input)
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join('.') : '<root>'
        return `${issuePath}: ${issue.message}`
      })
      .join('; ')
    throw new Error(`Invalid skill_recover_source input: ${message}`)
  }

  const validInput = parsed.data

  // Derive skills root from homeDir override or the system default.
  const skillsRoot = validInput.homeDir
    ? path.join(validInput.homeDir, '.claude', 'skills')
    : defaultSkillsRoot()

  const isOffline = context.apiClient.isOffline()

  const findCandidatesByName = async (name: string): Promise<RecoveryCandidate[]> => {
    if (!isOffline) {
      return findCandidatesOnline(context, name)
    }
    return findCandidatesOffline(context, name)
  }

  // SMI-5411: enrich git/plugin-recovered ids with the registry UUID from the
  // local catalog (offline, online or off — the local catalog suffices).
  const findRegistryIdByRepoUrl = async (repoUrl: string): Promise<string | null> =>
    findRegistryIdByRepoUrlOffline(context, repoUrl)

  const service = new SourceRecoveryService({
    hashContent,
    findCandidatesByName,
    findRegistryIdByRepoUrl,
  })

  return service.recoverSources({
    skillsRoot,
    only: validInput.only,
    enableEmbedding: validInput.embedding,
    enableCatalogHint: validInput.catalogHint,
  })
}

// SMI-5017 W2.S2: wrap at export boundary
export const executeSkillRecoverSource = withTelemetry(skillRecoverSourceImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'skill_recover_source',
  extractFramework: () => 'unknown',
})
