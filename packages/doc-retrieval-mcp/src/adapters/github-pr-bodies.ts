import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
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
// Hard cap: 40 pages × 50 per page = 2,000 PRs per run. 180-day
// Skillsmith window needs ~28 pages with ~40% headroom. A
// misconfigured query can't run unbounded.
const MAX_PAGES = 40
const PAGE_SIZE = 50

export interface CachedPr {
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
  const lineEnd = Math.max(1, text.split('\n').length)
  const id = chunkId(file.logicalPath, 1, lineEnd, text)
  return [
    {
      id,
      filePath: file.logicalPath,
      lineStart: 1,
      lineEnd,
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
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8')
    // Atomic swap — rename is POSIX-atomic within a single
    // filesystem. Prevents a crash mid-JSON.stringify from
    // leaving a truncated cache that loadCache would silently
    // treat as empty on the next run (compounding C1).
    await rename(tmp, path)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    try {
      await unlink(tmp)
    } catch {
      // best effort — tmp may not exist
    }
    if (e.code === 'EXDEV') {
      console.warn(
        'github-pr-bodies: cache path crosses filesystem boundary; ' +
          'atomic write unavailable. Consider relocating the cache to local disk.'
      )
    } else {
      console.warn(`github-pr-bodies: failed to persist cache at ${path}: ${e.message}`)
    }
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
 * Fetch merged PRs since the given ISO timestamp via `gh api graphql`,
 * iterating through pages until `hasNextPage` is false or `MAX_PAGES` is
 * reached. Skillsmith merges ~1,442 PRs per 180-day window (~28 pages);
 * without pagination, `first: 50` silently drops ~95% of the corpus on
 * first-run — blocking for the Step 8 regression gate (SMI-4450 C1).
 *
 * Returns:
 * - `null` when the very first page fails (nothing usable — let the
 *   caller fall back to cache).
 * - `CachedPr[]` otherwise, including partial accumulation when a
 *   later page fails mid-loop. Incremental runs backfill the tail.
 *
 * Exported for tests so the fetch can be exercised via a DI seam.
 */
export function fetchMergedPrsSince(
  owner: string,
  repo: string,
  sinceIso: string,
  token: string,
  // Injectable for tests — exercises the pagination loop without
  // requiring the `gh` CLI binary. Default calls through to the real
  // `gh api graphql` invocation.
  runPage: (
    owner: string,
    repo: string,
    sinceIso: string,
    after: string | null,
    token: string
  ) => GraphqlPage | null = runGraphql
): CachedPr[] | null {
  const accumulated: CachedPr[] = []
  let cursor: string | null = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = runPage(owner, repo, sinceIso, cursor, token)
    if (resp === null) {
      if (page === 0) return null
      console.warn(
        `github-pr-bodies: partial fetch — returned ${accumulated.length} PRs after ` +
          `${page} page(s); next incremental run will backfill the tail.`
      )
      return accumulated
    }
    accumulated.push(...resp.nodes)
    if (!resp.hasNextPage || resp.endCursor === null) return accumulated
    cursor = resp.endCursor
  }

  // Cap reached without hasNextPage: false — corpus may be incomplete.
  console.warn(
    `github-pr-bodies: MAX_PAGES (${MAX_PAGES}) reached with ${accumulated.length} PRs; ` +
      `corpus may be incomplete — tune MAX_PAGES or narrow the since window.`
  )
  return accumulated
}

export interface GraphqlPage {
  nodes: CachedPr[]
  hasNextPage: boolean
  endCursor: string | null
}

function runGraphql(
  owner: string,
  repo: string,
  sinceIso: string,
  after: string | null,
  token: string
): GraphqlPage | null {
  const query = `
    query($q: String!, $after: String) {
      search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on PullRequest {
            number title body mergedAt
            mergeCommit { oid }
            author { login }
            isDraft url
          }
        }
      }
    }
  `.trim()
  const q = `repo:${owner}/${repo} is:pr is:merged merged:>=${sinceIso}`

  // R1: always `-f` (literal string) for both `q` and `after`. `gh`'s
  // `-F` flag applies type inference (numbers, booleans, null), which
  // would mangle the opaque base64 cursor or any search query with
  // numeric / date tokens. `after=null` on first page is represented
  // by OMITTING the `-f after=...` arg entirely — GraphQL treats
  // absent variables as null.
  const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `q=${q}`]
  if (after !== null) args.push('-f', `after=${after}`)

  try {
    const out = execFileSync('gh', args, {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
      maxBuffer: 32 * 1024 * 1024,
    })
    return parseGraphqlResponse(out)
  } catch (err) {
    classifyAndWarn(err)
    return null
  }
}

/**
 * Classify a `gh` invocation error into an actionable warning.
 * User gets a distinguishing signal for rate-limit vs. missing
 * CLI vs. auth failure — all three still return `null` upstream
 * and fall back to cache (SMI-4450 M2).
 */
export function classifyAndWarn(err: unknown): void {
  const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; status?: number }
  const stderrRaw = e.stderr
  const stderr = (
    typeof stderrRaw === 'string' ? stderrRaw : (stderrRaw?.toString('utf8') ?? '')
  ).slice(0, 500)
  const stderrLower = stderr.toLowerCase()

  if (e.code === 'ENOENT') {
    console.warn('github-pr-bodies: gh CLI not installed; skipping adapter')
    return
  }
  // R4: lowercase substring match — resilient to phrasing drift across
  // gh CLI versions. GitHub's canonical error is "API rate limit
  // exceeded"; secondary-rate-limit messages vary.
  if (stderrLower.includes('rate limit') || stderrLower.includes('403')) {
    console.warn('github-pr-bodies: rate-limited; falling back to cache. Retry in ~60s.')
    return
  }
  const msg = (e.message ?? 'unknown error').slice(0, 200)
  console.warn(`github-pr-bodies: gh fetch failed (${msg}); falling back to cache`)
}

/**
 * Parse the `gh api graphql` JSON response into a `GraphqlPage`.
 * Exported for tests. Return shape includes pagination cursor so the
 * caller can loop until `hasNextPage === false`.
 */
export function parseGraphqlResponse(raw: string): GraphqlPage | null {
  try {
    const parsed = JSON.parse(raw) as {
      data?: {
        search?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
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
    const search = parsed.data?.search
    if (!search) return { nodes: [], hasNextPage: false, endCursor: null }
    const nodes: CachedPr[] = []
    for (const n of search.nodes ?? []) {
      if (typeof n.number !== 'number') continue
      nodes.push({
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
    return {
      nodes,
      hasNextPage: Boolean(search.pageInfo?.hasNextPage),
      endCursor: search.pageInfo?.endCursor ?? null,
    }
  } catch {
    return null
  }
}
