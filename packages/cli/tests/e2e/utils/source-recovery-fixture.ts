/**
 * @fileoverview Shared real-filesystem fixture for the SMI-5407 source-recovery
 * end-to-end / integration suite.
 * @see SMI-5407
 *
 * NOT a `*.test.ts` file, so vitest never executes it as a test. It only
 * touches `fs` / `path` and the `@skillsmith/core` DB factory; it computes no
 * homedir-derived state, so it is safe to import statically (the homedir-frozen
 * manifest modules are imported dynamically by the test files themselves).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { createDatabaseAsync, initializeSchema } from '@skillsmith/core'

/** A minimal but parser-valid SKILL.md body. `extra` lands inside frontmatter. */
export function skillMd(name: string, extra?: string): string {
  const extraLine = extra ? `\n${extra}` : ''
  return (
    `---\n` +
    `name: ${name}\n` +
    `description: ${name} fixture for source recovery\n` +
    `author: fixtureowner${extraLine}\n` +
    `---\n\n` +
    `# ${name}\n\n` +
    `Body content for ${name}.\n`
  )
}

function writeSkillDir(root: string, name: string, body: string): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body)
  return dir
}

function writeGitConfig(dir: string, originUrl: string): void {
  const config =
    `[core]\n\trepositoryformatversion = 0\n` +
    `[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'config'), config)
}

/** Directory basenames produced by {@link writeSourceFixture}. */
export const FIXTURE_DIRS = {
  git: 'git-skill',
  https: 'https-skill',
  plugin: 'plugin-skill',
  registry: 'registry-skill',
  collision: 'collision-skill',
  backup: 'something.backup-20260101-120000',
  unknown: 'unknown-skill',
} as const

/** Canonical GitHub owner/repo carried by both git fixtures (ssh + https). */
export const GIT_OWNER = 'wrsmith108'
export const GIT_REPO = 'linear-claude-skill'

/**
 * Materialize the canonical fixture tree under `root`. Returns the absolute
 * directory paths keyed by {@link FIXTURE_DIRS} key.
 */
export function writeSourceFixture(root: string): Record<keyof typeof FIXTURE_DIRS, string> {
  fs.mkdirSync(root, { recursive: true })

  // (a) git remote — scp/ssh form.
  const git = writeSkillDir(root, FIXTURE_DIRS.git, skillMd(FIXTURE_DIRS.git))
  writeGitConfig(git, `git@github.com:${GIT_OWNER}/${GIT_REPO}.git`)

  // git remote — https form (same owner/repo as the ssh fixture).
  const https = writeSkillDir(root, FIXTURE_DIRS.https, skillMd(FIXTURE_DIRS.https))
  writeGitConfig(https, `https://github.com/${GIT_OWNER}/${GIT_REPO}.git`)

  // (b) plugin manifest.
  const plugin = writeSkillDir(root, FIXTURE_DIRS.plugin, skillMd(FIXTURE_DIRS.plugin))
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true })
  fs.writeFileSync(
    path.join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ repository: 'https://github.com/o/r' }, null, 2)
  )

  // (c) registry single-name match; (d) collision two-name match.
  const registry = writeSkillDir(root, FIXTURE_DIRS.registry, skillMd(FIXTURE_DIRS.registry))
  const collision = writeSkillDir(root, FIXTURE_DIRS.collision, skillMd(FIXTURE_DIRS.collision))

  // (e) backup snapshot dir — listed, never scanned.
  const backup = writeSkillDir(root, FIXTURE_DIRS.backup, skillMd('something'))

  // (f) no .git, no plugin, no registry row.
  const unknown = writeSkillDir(root, FIXTURE_DIRS.unknown, skillMd(FIXTURE_DIRS.unknown))

  return { git, https, plugin, registry, collision, backup, unknown }
}

/** A skills-row seed spec for the CLI candidate-lookup database. */
export interface SkillSeedRow {
  id: string
  name: string
  repoUrl: string
  qualityScore?: number
}

/**
 * Create a file-backed skills DB at `dbPath` and insert `rows` into `skills`.
 * Opened and closed synchronously so the CLI can re-open the same file.
 */
export async function seedSkillsDb(dbPath: string, rows: SkillSeedRow[]): Promise<void> {
  const db = await createDatabaseAsync(dbPath)
  try {
    initializeSchema(db)
    const insert = db.prepare(
      'INSERT INTO skills (id, name, repo_url, quality_score) VALUES (?, ?, ?, ?)'
    )
    for (const row of rows) {
      insert.run(row.id, row.name, row.repoUrl, row.qualityScore ?? 0.5)
    }
  } finally {
    db.close()
  }
}

/**
 * Replica of `diff.ts:buildRawUrl` (SMI-5406) — used to assert a backfilled
 * `source` is in the exact form View-Changes accepts. Kept byte-identical to
 * the production regex so the assertion stays load-bearing.
 */
export function buildRawUrl(source: string): string | null {
  if (source.startsWith('https://raw.githubusercontent.com/')) return source
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?/.exec(source)
  if (!m) return null
  const [, owner, repo, ref = 'main'] = m
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/SKILL.md`
}
