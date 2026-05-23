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
 * Fetch and decode a skill's SKILL.md via the GitHub Contents API.
 * Returns null on any non-200 / missing-content response (treated as fetch-failed
 * or repo-gone depending on the caller's context).
 */
export async function fetchSkillMd(
  parsed: ParsedSkillUrl,
  headers: Record<string, string>
): Promise<string | null> {
  const res = await fetch(parsed.apiUrl, { headers })
  if (!res.ok) return null
  const body = (await res.json()) as { content?: string; encoding?: string }
  if (typeof body.content !== 'string' || body.encoding !== 'base64') return null
  // Contents API base64 payloads are newline-wrapped.
  return Buffer.from(body.content.replace(/\n/g, ''), 'base64').toString('utf-8')
}
