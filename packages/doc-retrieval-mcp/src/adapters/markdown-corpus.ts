import { readFile, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { minimatch } from 'minimatch'

import { stripGitDiscoveryEnv } from '../_lib/git-fixture-env.js'
import { chunkDocument } from '../indexer.helpers.js'
import type { AdapterContext, AdapterFile, ChunkMetadata, SourceAdapter } from '../types.js'

/**
 * The legacy markdown corpus behaviour extracted as a `SourceAdapter`
 * (SMI-4450 Wave 1 Step 4). Preserves the prior `indexer.ts` semantics
 * verbatim: glob expansion, git-diff incremental path, and lazy per-file
 * content read inside `chunk()`.
 *
 * This is the default adapter — a corpus with no `adapters: []` config
 * still gets the markdown-corpus path wired in by the registry.
 */
export function createMarkdownCorpusAdapter(): SourceAdapter {
  return {
    kind: 'markdown-corpus',
    lifetime: 'long-term',
    listFiles,
    listDeletedPaths,
    chunk,
  }
}

async function listFiles(ctx: AdapterContext): Promise<AdapterFile[]> {
  const all = new Set(await expandGlobs(ctx.cfg.globs, ctx.repoRoot))

  if (ctx.mode === 'full') {
    return [...all].sort().map((rel) => toAdapterFile(rel, ctx.repoRoot))
  }

  const changed = ctx.lastSha ? gitChangedFiles(ctx.repoRoot, ctx.lastSha) : [...all]

  return changed
    .filter((rel) => all.has(rel) && existsSync(join(ctx.repoRoot, rel)))
    .map((rel) => toAdapterFile(rel, ctx.repoRoot))
}

async function listDeletedPaths(ctx: AdapterContext): Promise<string[]> {
  if (ctx.mode === 'full') return []
  if (!ctx.lastSha) return []

  const all = new Set(await expandGlobs(ctx.cfg.globs, ctx.repoRoot))
  const changed = gitChangedFiles(ctx.repoRoot, ctx.lastSha)
  return changed.filter((rel) => all.has(rel) && !existsSync(join(ctx.repoRoot, rel)))
}

async function chunk(file: AdapterFile, ctx: AdapterContext): Promise<ChunkMetadata[]> {
  const abs = file.absolutePath ?? join(ctx.repoRoot, file.logicalPath)
  let raw: string
  try {
    raw = file.rawContent.length > 0 ? file.rawContent : await readFile(abs, 'utf8')
  } catch {
    return []
  }
  const chunks = chunkDocument(raw, file.logicalPath, ctx.cfg)
  // SMI-4703 §1: reaches the corpus via a human-reviewed PR merge — tier-a
  // unconditionally, no injection scan (exempt per plan Change #5).
  return chunks.map((c) => ({
    ...c,
    kind: 'markdown-doc',
    lifetime: 'long-term' as const,
    provenanceTier: 'tier-a' as const,
  }))
}

function toAdapterFile(rel: string, root: string): AdapterFile {
  return {
    logicalPath: rel,
    rawContent: '',
    absolutePath: join(root, rel),
  }
}

async function expandGlobs(patterns: string[], cwd: string): Promise<string[]> {
  let rawEntries: Dirent[]
  try {
    rawEntries = (await readdir(cwd, {
      recursive: true,
      withFileTypes: true,
    })) as unknown as Dirent[]
  } catch {
    return []
  }
  const results = new Set<string>()
  for (const entry of rawEntries) {
    if (!entry.isFile()) continue
    const relPath = relative(cwd, join(entry.parentPath, entry.name))
    for (const pattern of patterns) {
      if (minimatch(relPath, pattern, { dot: true })) {
        results.add(relPath)
        break
      }
    }
  }
  return [...results].sort()
}

// Root-repo `git diff --name-only` reports a submodule (gitlink, mode
// 160000 — e.g. docs/internal, .claude/skills) as one opaque path, never
// the files changed inside it. Left unresolved, every file inside every
// submodule silently drops out of every incremental run forever (the
// bare submodule path never matches a real glob-expanded file path) —
// discovered 2026-07-21 when a real content edit inside docs/internal
// produced a 0-file incremental run. This resolves each submodule entry
// into its own internal file diff before the caller filters against the
// glob-expanded file set.
function listSubmodulePaths(root: string): string[] {
  try {
    const out = execFileSync('git', ['config', '--file', '.gitmodules', '--get-regexp', 'path'], {
      cwd: root,
      encoding: 'utf8',
      env: stripGitDiscoveryEnv({ GIT_OPTIONAL_LOCKS: '0' }),
    })
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ')[1])
      .filter((p): p is string => Boolean(p))
  } catch {
    return []
  }
}

function submoduleCommitAt(root: string, sha: string, submodulePath: string): string | null {
  try {
    const out = execFileSync('git', ['ls-tree', sha, '--', submodulePath], {
      cwd: root,
      encoding: 'utf8',
      env: stripGitDiscoveryEnv({ GIT_OPTIONAL_LOCKS: '0' }),
    })
    const match = /^160000 commit ([0-9a-f]{40})\t/.exec(out)
    return match ? match[1] : null
  } catch {
    return null
  }
}

function submoduleChangedFiles(
  root: string,
  submodulePath: string,
  oldSha: string | null,
  newSha: string
): string[] {
  const submoduleRoot = join(root, submodulePath)
  const env = stripGitDiscoveryEnv({ GIT_OPTIONAL_LOCKS: '0' })
  try {
    // No prior SHA inside the submodule's own history (e.g. lastSha
    // predates this submodule's initialization) — every tracked file
    // counts as changed, matching the top-level "no lastSha" fallback.
    const args = oldSha
      ? ['--no-optional-locks', 'diff', '--name-only', `${oldSha}..${newSha}`]
      : ['ls-tree', '-r', '--name-only', newSha]
    const out = execFileSync('git', args, { cwd: submoduleRoot, encoding: 'utf8', env })
    return out
      .split('\n')
      .filter(Boolean)
      .map((p) => join(submodulePath, p))
  } catch {
    return []
  }
}

function gitChangedFiles(root: string, baseSha: string): string[] {
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) return []
  try {
    const out = execFileSync(
      'git',
      ['--no-optional-locks', 'diff', '--name-only', `${baseSha}..HEAD`],
      // SMI-5126: strip GIT_DISCOVERY_VARS so an ambient GIT_DIR cannot
      // override `cwd` and diff the wrong repo.
      { cwd: root, encoding: 'utf8', env: stripGitDiscoveryEnv({ GIT_OPTIONAL_LOCKS: '0' }) }
    )
    const topLevel = out.split('\n').filter(Boolean)

    const submodulePaths = new Set(listSubmodulePaths(root))
    if (submodulePaths.size === 0) return topLevel

    const resolved: string[] = []
    for (const rel of topLevel) {
      if (!submodulePaths.has(rel)) {
        resolved.push(rel)
        continue
      }
      const oldSha = submoduleCommitAt(root, baseSha, rel)
      const newSha = submoduleCommitAt(root, 'HEAD', rel)
      if (newSha) resolved.push(...submoduleChangedFiles(root, rel, oldSha, newSha))
    }
    return resolved
  } catch {
    return []
  }
}
