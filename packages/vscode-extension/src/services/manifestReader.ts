/**
 * Manifest reader for the VS Code extension (SMI-5412).
 *
 * Reads ~/.skillsmith/manifest.json to find the upstream source URL for a
 * locally-installed skill, enabling "View Changes" to diff bare-id skills
 * against their GitHub source (recovered by SMI-5407).
 *
 * Mirror-don't-import: the extension bundles via esbuild with no-dependencies
 * and intentionally does NOT depend on @skillsmith/core or the CLI (importing
 * either would pull native modules into the VSIX bundle). Types here mirror
 * CLI's utils/manifest.ts; kept in sync manually.
 *
 * @module services/manifestReader
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirrors @skillsmith/cli/utils/manifest.ts — minimal subset)
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal manifest entry shape. Matches CLI's SkillManifestEntry. */
export interface ManifestEntry {
  id: string
  name: string
  source?: string
  installPath?: string
}

interface ManifestFile {
  installedSkills?: Record<string, ManifestEntry>
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest entry lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the manifest entry for the given skill.
 *
 * Match priority: installPath (most robust) > name > id.
 * Returns null when the manifest is absent, unreadable, or has no match.
 */
export async function readManifestEntry(skill: {
  name: string
  id: string
  path: string
}): Promise<ManifestEntry | null> {
  const manifestPath = path.join(os.homedir(), '.skillsmith', 'manifest.json')
  try {
    const content = await fs.readFile(manifestPath, 'utf-8')
    const manifest = JSON.parse(content) as ManifestFile
    const entries = Object.values(manifest.installedSkills ?? {})
    return (
      entries.find((e) => e.installPath === skill.path) ??
      entries.find((e) => e.name === skill.name) ??
      entries.find((e) => e.id === skill.id) ??
      null
    )
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub raw URL helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a GitHub repo URL to a raw.githubusercontent.com SKILL.md URL.
 *
 * Mirrors packages/cli/src/commands/diff.ts `buildRawUrl` with an added
 * `branch` parameter to support the main-then-master fallback used by
 * fetchRawSkillMd.
 *
 * Returns null for non-GitHub URLs or unrecognised shapes.
 *
 * @param source - GitHub URL, e.g. `https://github.com/owner/repo` or
 *   `https://github.com/owner/repo/tree/my-branch`
 * @param branch - Branch to use when the URL has no explicit `/tree/<ref>`
 */
export function buildRawGitHubUrl(source: string, branch = 'main'): string | null {
  if (source.startsWith('https://raw.githubusercontent.com/')) return source

  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?/.exec(source)
  if (!m) return null

  const [, owner, repo, explicitRef] = m
  const ref = explicitRef ?? branch
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/SKILL.md`
}

/**
 * Fetch the raw SKILL.md from a GitHub repository source URL.
 *
 * Tries the `main` branch first; on a 404 retries with `master`. Returns null
 * when the URL is non-GitHub, both branches return 404, or a network / timeout
 * error occurs. Callers must treat null as "source unavailable".
 */
export async function fetchRawSkillMd(source: string): Promise<string | null> {
  const TIMEOUT_MS = 10_000
  for (const branch of ['main', 'master'] as const) {
    const rawUrl = buildRawGitHubUrl(source, branch)
    if (!rawUrl) return null
    try {
      const res = await fetch(rawUrl, {
        headers: { Accept: 'text/plain' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.ok) {
        return await res.text()
      }
      if (res.status !== 404) {
        // Non-404 (5xx, auth, etc.) — retrying with master won't help
        return null
      }
      // 404 on main — fall through to master retry
    } catch {
      return null
    }
  }
  return null
}
