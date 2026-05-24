/**
 * Shared GitHub SKILL.md fetch helpers
 * @module scripts/indexer/_shared/skill-md-fetch
 *
 * Extracted from `dequarantine-false-positives.ts` (SMI-5165 DRY refactor) so
 * that both the SMI-5161 sweep and the SMI-5165 stale-revalidation sweep share
 * identical URL-parsing and content-fetch logic without duplication.
 *
 * The module is intentionally narrow: URL parsing + GitHub Contents API fetch.
 * No Supabase, no scanning, no side effects.
 */

/** The pieces needed to fetch a skill's SKILL.md via the GitHub Contents API. */
export interface ParsedSkillUrl {
  owner: string
  repo: string
  /** Branch/tag; undefined => repo default branch. */
  ref?: string
  /** Directory containing SKILL.md; '' for repo root. */
  dir: string
  /** GitHub Contents API URL for the SKILL.md file. */
  apiUrl: string
}

/** Public prefix for all GitHub repo URLs indexed by Skillsmith. */
export const GITHUB_PREFIX = 'https://github.com/'

/**
 * Reconstruct the GitHub Contents API URL for a quarantined row's SKILL.md.
 *
 * Handles both stored `repo_url` shapes:
 *  - bare repo `https://github.com/owner/repo` (SKILL.md at root, default branch)
 *  - tree-path `https://github.com/owner/repo/tree/{ref}/{dir...}` (SKILL.md at {dir})
 *
 * `skill_path` is used as a fallback directory when `repo_url` is bare but a
 * path was recorded separately. The first segment after `tree/` is taken as the
 * ref; slashed branch names (rare for indexed skills) would mis-parse and simply
 * 404 → the row stays quarantined (safe; never a false clear).
 *
 * Returns null when the URL is not a parseable github.com repo URL.
 */
export function parseSkillMdUrl(
  repoUrl: string | null,
  skillPath: string | null
): ParsedSkillUrl | null {
  if (!repoUrl || !repoUrl.startsWith(GITHUB_PREFIX)) return null

  const rest = repoUrl.slice(GITHUB_PREFIX.length).replace(/\/+$/, '')
  const segs = rest.split('/').filter(Boolean)
  if (segs.length < 2) return null

  const [owner, repo, ...tail] = segs
  let ref: string | undefined
  let dir = ''

  if (tail[0] === 'tree' && tail.length >= 2) {
    ref = tail[1]
    dir = tail.slice(2).join('/')
  } else if (tail.length === 0 && skillPath) {
    // Bare repo URL but a separate skill_path was recorded.
    dir = skillPath.replace(/^\/+|\/+$/g, '')
  }

  const filePath = dir ? `${dir}/SKILL.md` : 'SKILL.md'

  // Defense-in-depth: a `.`/`..` path segment would let WHATWG URL
  // normalization collapse the path and escape the `/repos/{owner}/{repo}/
  // contents/` prefix, turning a benign-looking repo_url into a request against
  // an arbitrary api.github.com endpoint. GitHub-derived values cannot contain
  // these, so reject (→ parse-failed, row stays quarantined — never a misfetch).
  const segments = `${owner}/${repo}/${filePath}`.split('/')
  if (segments.some((s) => s === '.' || s === '..')) return null

  const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}${query}`

  return { owner, repo, ref, dir, apiUrl }
}

/**
 * Outcome of a SKILL.md fetch. Callers MUST distinguish `not-found` (a genuine
 * 404 — the file is gone) from `transient` (403 secondary-rate-limit, 429, 5xx,
 * network error, or an unexpected 200 body). A `transient` result must NEVER be
 * treated as "repo gone": doing so would let a rate-limit blip re-tag a live
 * skill as deleted and feed it to the destructive purge (SMI-5165 review).
 */
export type SkillMdFetch =
  | { kind: 'content'; content: string }
  | { kind: 'not-found' }
  | { kind: 'transient'; status: number }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Fetch and decode a skill's SKILL.md via the GitHub Contents API, classifying
 * the result so callers can act safely on rate limits vs genuine 404s.
 *
 * - `200` + valid base64 body → `content`.
 * - `404` → `not-found` (genuinely gone).
 * - `403`/`429`/`5xx`/network error/unexpected body → `transient`, retried up to
 *   `retries` times with backoff (honoring `Retry-After` when present).
 *
 * GitHub's secondary rate limit returns `403` *without* consuming core quota, so
 * a large sweep can see many `403`s even with quota remaining — hence the
 * explicit `transient` classification.
 */
export async function fetchSkillMd(
  parsed: ParsedSkillUrl,
  headers: Record<string, string>,
  retries = 2
): Promise<SkillMdFetch> {
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(parsed.apiUrl, { headers })
    } catch {
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt)
        continue
      }
      return { kind: 'transient', status: 0 } // network error
    }

    if (res.status === 404) return { kind: 'not-found' }

    if (res.status === 200) {
      const body = (await res.json()) as { content?: string; encoding?: string }
      if (typeof body.content !== 'string' || body.encoding !== 'base64') {
        // Unexpected 200 shape — treat as transient (never a false "gone").
        return { kind: 'transient', status: 200 }
      }
      // Contents API base64 payloads are newline-wrapped.
      return {
        kind: 'content',
        content: Buffer.from(body.content.replace(/\n/g, ''), 'base64').toString('utf-8'),
      }
    }

    // 403 / 429 / 5xx — transient; back off and retry.
    if (attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'))
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt
      )
      continue
    }
    return { kind: 'transient', status: res.status }
  }
}
