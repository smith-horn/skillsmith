/**
 * @fileoverview Recover a skill's GitHub source from its `.git/config` origin.
 * @module @skillsmith/core/provenance/git-config
 * @see SMI-5407
 *
 * Offline only. No git binary, no network: we parse the INI-style config file
 * directly. Normalizes both scp-like (`git@github.com:owner/repo.git`) and URL
 * (`https://github.com/owner/repo.git`) remotes. Non-github hosts return null.
 */

import * as fs from 'fs'
import * as path from 'path'

import type { RecoveredSource } from './types.js'

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

/**
 * Strip a trailing `.git` and any trailing slashes from a repo segment.
 * Uses string iteration rather than a `/\/+$/`-style regex to avoid CodeQL
 * `js/polynomial-redos` on the user-controlled `.git/config` content. SMI-5407.
 */
function stripGitSuffix(repo: string): string {
  let end = repo.length
  while (end > 0 && repo[end - 1] === '/') end--
  const trimmed = repo.slice(0, end)
  if (trimmed.length >= 4 && trimmed.slice(-4).toLowerCase() === '.git') {
    return trimmed.slice(0, -4)
  }
  return trimmed
}

/**
 * A safe GitHub owner/repo segment: ASCII alphanumeric plus `.`/`_`/`-`, and
 * never `.`/`..`. Without this, a crafted `.git/config`
 * `url = git@github.com:../evil` yields owner `..`, corrupting the stored
 * `owner/repo` id + URL. SMI-5407 governance.
 */
function isSafeSegment(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..'
}

/**
 * Normalize a raw git remote URL into a canonical {@link RecoveredSource}.
 * Returns null for non-github hosts or unparseable shapes.
 */
export function normalizeGitHubRemote(rawUrl: string): RecoveredSource | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  let owner: string | undefined
  let repo: string | undefined

  // scp-like syntax: git@github.com:owner/repo(.git)
  const scp = /^[^@]+@([^:]+):(.+)$/.exec(trimmed)
  if (scp && !trimmed.includes('://')) {
    if (!GITHUB_HOSTS.has(scp[1].toLowerCase())) return null
    const segments = scp[2].split('/').filter(Boolean)
    if (segments.length < 2) return null
    owner = segments[0]
    repo = stripGitSuffix(segments[1])
  } else {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }
    if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) return null
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length < 2) return null
    owner = segments[0]
    repo = stripGitSuffix(segments[1])
  }

  if (!owner || !repo) return null
  if (!isSafeSegment(owner) || !isSafeSegment(repo)) return null
  return { owner, repo, url: `https://github.com/${owner}/${repo}` }
}

/** Extract the `url` of the `[remote "origin"]` section from a git config. */
function extractOriginUrl(config: string): string | null {
  let inOrigin = false
  for (const line of config.split('\n')) {
    const trimmed = line.trim()
    const section = /^\[(.+)\]$/.exec(trimmed)
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1].trim())
      continue
    }
    if (inOrigin) {
      const match = /^url\s*=\s*(.+)$/.exec(trimmed)
      if (match) return match[1].trim()
    }
  }
  return null
}

/**
 * Read `<skillDir>/.git/config` and recover the origin remote's GitHub source.
 * Returns null when the file is missing, has no origin url, or the remote is
 * not a github.com repository.
 */
export function parseGitConfigRemote(skillDir: string): RecoveredSource | null {
  const configPath = path.join(skillDir, '.git', 'config')
  let content: string
  try {
    content = fs.readFileSync(configPath, 'utf-8')
  } catch {
    return null
  }
  const url = extractOriginUrl(content)
  if (!url) return null
  return normalizeGitHubRemote(url)
}
