#!/usr/bin/env node
// SMI-4191: detect drift between npm-published versions and GitHub Releases.
// Runs hourly from .github/workflows/detect-release-drift.yml to catch the
// local `npm publish --ignore-scripts -w` fallback path (CLAUDE.md line 487)
// that bypasses publish.yml and therefore never creates a GH Release.
//
// For each tracked package:
//   - Read local `packages/<pkg>/package.json` version (the main-branch state)
//   - Compare to latest GH Release tag matching `@skillsmith/<pkg>-v*`
//   - If local is newer AND was actually published to npm, create the missing release
//   - If tag already exists (race with publish.yml), treat as success
//
// Idempotent: running twice is a no-op.
//
// Usage:
//   node scripts/detect-release-drift.mjs           # heal drift
//   node scripts/detect-release-drift.mjs --dry-run # report only, don't create
//
// Exit codes:
//   0 — success (no drift, or drift healed)
//   1 — fatal error (missing dep, auth failure, etc)
//
// Emits JSON to stdout describing actions taken (one object per package).

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractSection } from './extract-changelog-section.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = join(__dirname, '..')

/** Packages we monitor. Enterprise is GitHub Packages — different flow. */
export const TRACKED_PACKAGES = [
  {
    short: 'core',
    dir: 'packages/core',
    npmName: '@skillsmith/core',
    tagPrefix: '@skillsmith/core-v',
  },
  {
    short: 'mcp-server',
    dir: 'packages/mcp-server',
    npmName: '@skillsmith/mcp-server',
    tagPrefix: '@skillsmith/mcp-server-v',
  },
  { short: 'cli', dir: 'packages/cli', npmName: '@skillsmith/cli', tagPrefix: '@skillsmith/cli-v' },
]

/**
 * Abstraction over shell calls. Tests inject mocks.
 * @typedef {{
 *   readPackageVersion: (dir: string) => string,
 *   readChangelog: (dir: string) => string,
 *   npmView: (name: string, version: string) => boolean,
 *   ghReleaseView: (tag: string) => boolean,
 *   ghReleaseCreate: (args: { tag: string, title: string, notesBody: string }) => { ok: true } | { ok: false, reason: 'already_exists' | 'error', stderr: string },
 * }} IO
 */

/**
 * Default I/O using execFileSync + fs.
 * @returns {IO}
 */
export function defaultIO() {
  return {
    readPackageVersion: (dir) => {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf-8'))
      return pkg.version
    },
    readChangelog: (dir) => {
      const path = join(REPO_ROOT, dir, 'CHANGELOG.md')
      if (!existsSync(path)) return ''
      return readFileSync(path, 'utf-8')
    },
    npmView: (name, version) => {
      try {
        const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim()
        return out === version
      } catch {
        return false
      }
    },
    ghReleaseView: (tag) => {
      try {
        execFileSync('gh', ['release', 'view', tag], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        return true
      } catch {
        return false
      }
    },
    ghReleaseCreate: ({ tag, title, notesBody }) => {
      try {
        execFileSync(
          'gh',
          ['release', 'create', tag, '--title', title, '--notes', notesBody, '--target', 'main'],
          {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        )
        return { ok: true }
      } catch (err) {
        const stderr = err?.stderr?.toString?.() ?? String(err)
        if (/already_exists|already exists|422/i.test(stderr)) {
          return { ok: false, reason: 'already_exists', stderr }
        }
        return { ok: false, reason: 'error', stderr }
      }
    },
  }
}

/**
 * Process a single tracked package. Returns a status object.
 * @param {typeof TRACKED_PACKAGES[number]} pkg
 * @param {IO} io
 * @param {{ dryRun: boolean }} opts
 */
export function processPackage(pkg, io, opts) {
  const localVersion = io.readPackageVersion(pkg.dir)
  const tag = `${pkg.tagPrefix}${localVersion}`
  const result = {
    package: pkg.short,
    localVersion,
    tag,
    action: 'none',
    reason: '',
  }

  // If the release already exists, no drift.
  if (io.ghReleaseView(tag)) {
    result.action = 'none'
    result.reason = 'tag_exists'
    return result
  }

  // Release missing — but only create if npm actually has this version.
  // Otherwise we'd be creating releases for un-published local bumps.
  if (!io.npmView(pkg.npmName, localVersion)) {
    result.action = 'none'
    result.reason = 'npm_not_published'
    return result
  }

  // Extract notes. Missing CHANGELOG section → log and skip (don't fail).
  const changelog = io.readChangelog(pkg.dir)
  const section = extractSection(changelog, localVersion)
  if (!section.ok) {
    result.action = 'skip'
    result.reason = section.reason === 'no-baseline' ? 'no_baseline' : 'changelog_section_missing'
    return result
  }

  const notesBody = section.body.length > 0 ? section.body : `Release ${localVersion}.`

  if (opts.dryRun) {
    result.action = 'would_create'
    result.reason = 'dry_run'
    return result
  }

  const create = io.ghReleaseCreate({
    tag,
    title: `${pkg.npmName} v${localVersion}`,
    notesBody,
  })

  if (create.ok) {
    result.action = 'created'
    result.reason = 'ok'
  } else if (create.reason === 'already_exists') {
    // Race with publish.yml — someone created it between our view and create.
    result.action = 'none'
    result.reason = 'race_already_exists'
  } else {
    result.action = 'error'
    result.reason = create.stderr.slice(0, 200)
  }
  return result
}

function parseArgs(argv) {
  let dryRun = false
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true
  }
  return { dryRun }
}

function main() {
  const { dryRun } = parseArgs(process.argv.slice(2))
  const io = defaultIO()
  const results = TRACKED_PACKAGES.map((pkg) => processPackage(pkg, io, { dryRun }))
  const errors = results.filter((r) => r.action === 'error')

  for (const r of results) {
    process.stdout.write(JSON.stringify(r) + '\n')
  }

  if (errors.length > 0) {
    process.stderr.write(`drift detector finished with ${errors.length} errors\n`)
    process.exit(1)
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) main()
