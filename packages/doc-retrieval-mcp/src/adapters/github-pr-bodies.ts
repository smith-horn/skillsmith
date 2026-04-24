import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { chunkId, estimateTokens } from '../indexer.helpers.js'
import type { AdapterContext, AdapterFile, ChunkMetadata, SourceAdapter } from '../types.js'

/**
 * `github-pr-bodies` adapter (SMI-4450 Wave 1 Step 4 §S2c). Fetches
 * merged PR bodies from GitHub via `gh api graphql`, caches them on
 * disk, and emits one chunk per PR.
 *
 * Target: pair 3 of the 6-pair regression set (SMI-4401 callback H1
 * + overlay). PR bodies are the canonical human-authored rationale
 * for a change set — more detailed than commit messages.
 *
 * Auth (SPARC §S2c / plan-review H2):
 *   Reads `process.env.GITHUB_TOKEN` directly. The token is expected
 *   to be pre-injected by the OUTER `varlock run -- ./scripts/run-
 *   indexer.sh` wrapper. The adapter MUST NOT spawn a nested
 *   `varlock run` — nested varlock breaks the secret-masking
 *   invariant. If `GITHUB_TOKEN` is unset, adapter logs a warning
 *   and returns [] (known soft-fail mode).
 *
 * Cache:
 *   `<repo>/.ruvector/pr-bodies-cache.json` — per-PR records keyed
 *   by PR number. First-run fetches the last 180 days; incremental
 *   fetches last 7 days plus any PR numbers already in the cache.
 *
 * Boundaries:
 * - Virtual key: `github://<owner>/<repo>/pr/<number>`.
 * - `kind: "pr"`, `lifetime: "long-term"`.
 * - Skip: draft PRs, bodies < 64 chars, bot-authored PRs without
 *   an SMI reference.
 */
export function createGitHubPrBodiesAdapter(): SourceAdapter {
  return {
    kind: 'github-pr-bodies',
    lifetime: 'long-term',
    listFiles,
    listDeletedPaths,
    chunk,
  }
}

const CACHE_REL_PATH = '.ruvector/pr-bodies-cache.json'
const FIRST_RUN_WINDOW_DAYS = 180
const INCREMENTAL_WINDOW_DAYS = 7
const MIN_BODY_CHARS = 64
const SMI_PATTERN = /\bSMI-(\d+)\b/
const OWNER_REPO_DEFAULT = { owner: 'smith-horn', repo: 'skillsmith' }

interface CachedPr {
  number: number
  title: string
  body: string
  mergedAt: string
  mergeCommit: string | null
  author: string
  isDraft: boolean
  url: string
}

type Cache = Record<string, CachedPr>

async function listFiles(ctx: AdapterContext): Promise<AdapterFile[]> {
  const token = process.env.GITHUB_TOKEN
  if (!token || token.length === 0) {
    console.warn(
      'github-pr-bodies: GITHUB_TOKEN unset; skipping adapter. ' +
        'Launch the indexer through `varlock run -- ./scripts/run-indexer.sh`.'
    )
    return []
  }

  const { owner, repo } = resolveOwnerRepo(ctx)
  const cachePath = join(ctx.repoRoot, CACHE_REL_PATH)
  const cache = await loadCache(cachePath)

  const days = ctx.mode === 'full' ? FIRST_RUN_WINDOW_DAYS : INCREMENTAL_WINDOW_DAYS
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const fetched = fetchMergedPrsSince(owner, repo, sinceIso, token)
  if (fetched === null) {
    // Soft-fail; emit whatever is already cached instead of dropping the
    // whole source.
    return buildFilesFromCache(cache, owner, repo)
  }

  for (const pr of fetched) cache[String(pr.number)] = pr
  await saveCache(cachePath, cache)

  return buildFilesFromCache(cache, owner, repo)
}

async function listDeletedPaths(): Promise<string[]> {
  // PRs are immutable history once merged.
  return []
}

async function chunk(file: AdapterFile, ctx: AdapterContext): Promise<ChunkMetadata[]> {
  const raw = file.rawContent
  if (raw.length < MIN_BODY_CHARS) return []

  const tokens = estimateTokens(raw)
  if (tokens < ctx.cfg.chunk.minTokens) return []

  const maxChars = ctx.cfg.chunk.targetTokens * 4
  const text = raw.length <= maxChars ? raw : raw.slice(0, maxChars)
  const effTokens = text === raw ? tokens : estimateTokens(text)

  const title = typeof file.tags?.title === 'string' ? file.tags.title : ''
  const id = chunkId(file.logicalPath, 1, 1, text)
  return [
    {
      id,
      filePath: file.logicalPath,
      lineStart: 1,
      lineEnd: Math.max(1, text.split('\n').length),
      headingChain: title ? [title] : [file.logicalPath],
      text,
      tokens: effTokens,
      kind: 'pr',
      lifetime: 'long-term',
      tags: file.tags,
    },
  ]
}

/**
 * Resolve owner/repo from `ctx.adapterCfg` (`github_owner` / `github_repo`),
 * falling back to the known Skillsmith repo. Exported for tests.
 */
export function resolveOwnerRepo(ctx: AdapterContext): { owner: string; repo: string } {
  const cfg = ctx.adapterCfg as { github_owner?: string; github_repo?: string } | undefined
  return {
    owner: typeof cfg?.github_owner === 'string' ? cfg.github_owner : OWNER_REPO_DEFAULT.owner,
    repo: typeof cfg?.github_repo === 'string' ? cfg.github_repo : OWNER_REPO_DEFAULT.repo,
  }
}

async function loadCache(path: string): Promise<Cache> {
  if (!existsSync(path)) return {}
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as Cache
  } catch {
    return {}
  }
}

async function saveCache(path: string, cache: Cache): Promise<void> {
  try {
    mkdirSync(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(cache, null, 2), 'utf8')
  } catch (err) {
    console.warn(`github-pr-bodies: failed to persist cache at ${path}: ${(err as Error).message}`)
  }
}

function buildFilesFromCache(cache: Cache, owner: string, repo: string): AdapterFile[] {
  const files: AdapterFile[] = []
  for (const pr of Object.values(cache)) {
    if (shouldSkip(pr)) continue
    const body = (pr.body ?? '').trim()
    if (body.length < MIN_BODY_CHARS) continue
    const smiMatch = `${pr.title}\n${body}`.match(SMI_PATTERN)
    files.push({
      logicalPath: `github://${owner}/${repo}/pr/${pr.number}`,
      rawContent: body,
      absolutePath: null,
      tags: {
        source: 'github-pr-bodies',
        pr: pr.number,
        title: pr.title,
        merged_at: pr.mergedAt,
        merge_commit: pr.mergeCommit,
        author: pr.author,
        ...(smiMatch ? { smi: `SMI-${smiMatch[1]}` } : {}),
      },
    })
  }
  return files.sort((a, b) => Number(b.tags?.pr ?? 0) - Number(a.tags?.pr ?? 0))
}

function shouldSkip(pr: CachedPr): boolean {
  if (pr.isDraft) return true
  const hasSmi = SMI_PATTERN.test(`${pr.title}\n${pr.body ?? ''}`)
  if (!hasSmi && pr.author.toLowerCase().includes('dependabot')) return true
  if (!hasSmi && pr.author.toLowerCase().includes('renovate')) return true
  return false
}

/**
 * Fetch merged PRs since the given ISO timestamp via `gh api graphql`.
 * Returns `null` on CLI error or auth failure so the caller can fall
 * back to cache without losing the adapter entirely. Exported for tests
 * so the fetch can be stubbed via a dependency-injection test double.
 */
export function fetchMergedPrsSince(
  owner: string,
  repo: string,
  sinceIso: string,
  token: string
): CachedPr[] | null {
  const query = `
    query($q: String!) {
      search(query: $q, type: ISSUE, first: 50) {
        nodes {
          ... on PullRequest {
            number
            title
            body
            mergedAt
            mergeCommit { oid }
            author { login }
            isDraft
            url
          }
        }
      }
    }
  `.trim()
  const q = `repo:${owner}/${repo} is:pr is:merged merged:>=${sinceIso}`

  try {
    const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`, '-F', `q=${q}`], {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
      maxBuffer: 32 * 1024 * 1024,
    })
    return parseGraphqlResponse(out)
  } catch {
    return null
  }
}

/**
 * Parse the `gh api graphql` JSON response into `CachedPr[]`. Exported
 * for tests.
 */
export function parseGraphqlResponse(raw: string): CachedPr[] | null {
  try {
    const parsed = JSON.parse(raw) as {
      data?: {
        search?: {
          nodes?: Array<{
            number?: number
            title?: string
            body?: string
            mergedAt?: string
            mergeCommit?: { oid?: string } | null
            author?: { login?: string } | null
            isDraft?: boolean
            url?: string
          }>
        }
      }
    }
    const nodes = parsed.data?.search?.nodes ?? []
    const out: CachedPr[] = []
    for (const n of nodes) {
      if (typeof n.number !== 'number') continue
      out.push({
        number: n.number,
        title: n.title ?? '',
        body: n.body ?? '',
        mergedAt: n.mergedAt ?? '',
        mergeCommit: n.mergeCommit?.oid ?? null,
        author: n.author?.login ?? '',
        isDraft: Boolean(n.isDraft),
        url: n.url ?? '',
      })
    }
    return out
  } catch {
    return null
  }
}
