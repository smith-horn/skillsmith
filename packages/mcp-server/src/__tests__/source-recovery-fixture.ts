/**
 * @fileoverview Self-contained real-filesystem fixture for the SMI-5407
 * `skill_recover_source` MCP dispatch e2e.
 * @see SMI-5407
 *
 * A package-local copy of the directory-tree builder. Cross-package test imports
 * are structurally invalid (TS6059/TS6307: a CLI-package file is not under
 * mcp-server's tsconfig rootDir), and there is no shared test-util package, so
 * the small fixture writer is duplicated here. Pure `fs`/`path` — no
 * `@skillsmith/core` dependency (the MCP test seeds candidates via
 * `skillRepository.create`, not a file DB).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** A minimal but parser-valid SKILL.md body. */
function skillMd(name: string): string {
  return (
    `---\n` +
    `name: ${name}\n` +
    `description: ${name} fixture for source recovery\n` +
    `author: fixtureowner\n` +
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

  const git = writeSkillDir(root, FIXTURE_DIRS.git, skillMd(FIXTURE_DIRS.git))
  writeGitConfig(git, `git@github.com:${GIT_OWNER}/${GIT_REPO}.git`)

  const https = writeSkillDir(root, FIXTURE_DIRS.https, skillMd(FIXTURE_DIRS.https))
  writeGitConfig(https, `https://github.com/${GIT_OWNER}/${GIT_REPO}.git`)

  const plugin = writeSkillDir(root, FIXTURE_DIRS.plugin, skillMd(FIXTURE_DIRS.plugin))
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true })
  fs.writeFileSync(
    path.join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ repository: 'https://github.com/o/r' }, null, 2)
  )

  const registry = writeSkillDir(root, FIXTURE_DIRS.registry, skillMd(FIXTURE_DIRS.registry))
  const collision = writeSkillDir(root, FIXTURE_DIRS.collision, skillMd(FIXTURE_DIRS.collision))
  const backup = writeSkillDir(root, FIXTURE_DIRS.backup, skillMd('something'))
  const unknown = writeSkillDir(root, FIXTURE_DIRS.unknown, skillMd(FIXTURE_DIRS.unknown))

  return { git, https, plugin, registry, collision, backup, unknown }
}
