/**
 * @fileoverview Recover a skill's GitHub source from a Claude plugin manifest.
 * @module @skillsmith/core/provenance/plugin-manifest
 * @see SMI-5407
 *
 * Offline only. Reads `<dir>/.claude-plugin/plugin.json` and normalizes the
 * `repository` field (string or `{ url }`) into a canonical source.
 */

import * as fs from 'fs'
import * as path from 'path'

import { normalizeGitHubRemote } from './git-config.js'
import type { RecoveredSource } from './types.js'

/** Pull a repository URL string out of a parsed plugin.json `repository` field. */
function extractRepositoryUrl(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null
  const repository = (parsed as Record<string, unknown>).repository
  if (typeof repository === 'string') return repository
  if (repository && typeof repository === 'object') {
    const url = (repository as Record<string, unknown>).url
    if (typeof url === 'string') return url
  }
  return null
}

/**
 * Read `<skillDir>/.claude-plugin/plugin.json` and recover its repository
 * source. Returns null when the file is missing, malformed, lacks a
 * `repository`, or the repository is not a github.com URL.
 */
export function parsePluginManifestRepository(skillDir: string): RecoveredSource | null {
  const manifestPath = path.join(skillDir, '.claude-plugin', 'plugin.json')
  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const repositoryUrl = extractRepositoryUrl(parsed)
  if (!repositoryUrl) return null
  return normalizeGitHubRemote(repositoryUrl)
}
