/**
 * SMI-6192: `packages/website/.vercel` is git-ignored Vercel adapter build
 * output. `getFilesRecursive()` (scripts/audit-standards.mjs, Checks 2/3/4/41
 * among its callers) had no skip-list entry for `.vercel`, so every source
 * scan descended into it — and on Docker Desktop for Mac, a freshly-written
 * file under `packages/website/.vercel/output` could be listed by a
 * `readdirSync` and then throw `ENOENT` on a subsequent `statSync` moments
 * later (virtiofs directory-cache incoherence — see the plan doc's Root
 * Cause section for the live stack trace). Check 41 was the only
 * `getFilesRecursive('packages', ...)` caller not wrapped in `try/catch`,
 * so that `ENOENT` crashed the entire `npm run audit:standards` process
 * instead of degrading to a `fail()` line.
 *
 * Full plan: docs/internal/implementation/smi-6192-website-vercel-output-eacces.md
 *
 * This file exercises the REAL production code for both fixes, not a
 * reimplementation — the plan explicitly calls out
 * scripts/tests/audit-standards-apps-root.test.ts's verbatim re-implementation
 * of `getFilesRecursive` as a known anti-pattern not to repeat here.
 *
 *   1. `.vercel` skip-list — `getFilesRecursive` was extracted (SMI-6192)
 *      into the new, side-effect-free scripts/audit-file-walker-helpers.mjs
 *      companion module (mirroring the existing audit-*-helpers.mjs
 *      convention already used ~10 times elsewhere in this file family —
 *      e.g. audit-realpath-asymmetry-helpers.mjs). Unlike
 *      scripts/audit-standards.mjs itself — which cannot be safely imported
 *      from a test process, because doing so runs its entire ~70-check audit
 *      as an import side effect — this companion module has no top-level
 *      side effects, so its export is imported and called directly here.
 *
 *   2. Check 41's try/catch — Check 41's body was factored (SMI-6192) into a
 *      standalone `runRealpathAsymmetryCheck()` function and registered in
 *      CHECK_REGISTRY as a narrow `--only realpath-asymmetry` entry point
 *      (the same dispatch mechanism scripts/tests/audit-standards-frontmatter.test.ts
 *      already uses for `--only retro-frontmatter`). This test drives it as
 *      a real subprocess against a fixture directory containing a broken
 *      symlink — `readdirSync` lists the entry, `statSync` (which follows
 *      symlinks) then throws ENOENT resolving it, deterministically
 *      reproducing the exact "listed but gone" failure shape observed live,
 *      without `chmod 0000` (the plan explains why that approach doesn't
 *      reproduce ENOENT and is unreliable when tests run as root in Docker).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { getFilesRecursive } from '../audit-file-walker-helpers.mjs'
import { makeFixtureTempDir } from './_lib/git-fixture-env.js'

const REPO_ROOT = join(import.meta.dirname ?? __dirname, '..', '..')
const AUDIT = join(REPO_ROOT, 'scripts', 'audit-standards.mjs')

function runAuditOnly(checkName: string, cwd: string) {
  return spawnSync('node', [AUDIT, '--only', checkName], {
    encoding: 'utf8',
    env: process.env,
    cwd,
  })
}

describe('audit-standards: .vercel skip-list (SMI-6192)', () => {
  let tmpRoot: string | null = null

  afterEach(() => {
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
    tmpRoot = null
  })

  it('never returns files under packages/website/.vercel (output dir + a stray sibling)', () => {
    tmpRoot = makeFixtureTempDir('audit-standards-vercel-skip')

    // The exact shape of the live incident: a Vercel adapter function bundle
    // under .vercel/output/_functions.
    const functionsDir = join(tmpRoot, 'packages', 'website', '.vercel', 'output', '_functions')
    mkdirSync(functionsDir, { recursive: true })
    writeFileSync(join(functionsDir, 'virtual_astro_middleware.mjs'), 'export default () => {}\n')

    // A sibling stray file directly under .vercel (not inside output/) — proves
    // the skip excludes the whole .vercel subtree, not just this one bundle
    // path, and proves exclusion rather than mere absence from the fixture.
    const strayFile = join(tmpRoot, 'packages', 'website', '.vercel', 'stray.ts')
    writeFileSync(strayFile, 'export const x = 1\n')

    // Positive control: a normal source file that MUST still be returned,
    // proving the walker isn't just returning an empty list.
    const srcDir = join(tmpRoot, 'packages', 'website', 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'index.ts'), 'export const ok = 1\n')

    const found = getFilesRecursive(join(tmpRoot, 'packages'), ['.ts', '.mjs'])

    expect(found).not.toContain(join(functionsDir, 'virtual_astro_middleware.mjs'))
    expect(found).not.toContain(strayFile)
    expect(found).toContain(join(srcDir, 'index.ts'))
  })

  it('regression: a repo with no .vercel directory at all behaves exactly as before', () => {
    tmpRoot = makeFixtureTempDir('audit-standards-vercel-skip')
    const srcDir = join(tmpRoot, 'packages', 'website', 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'index.ts'), 'export const ok = 1\n')

    const found = getFilesRecursive(join(tmpRoot, 'packages'), ['.ts'])
    expect(found).toEqual([join(srcDir, 'index.ts')])
  })
})

describe('audit-standards Check 41: try/catch on filesystem race (SMI-6192)', () => {
  let tmpRoot: string | null = null

  afterEach(() => {
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
    tmpRoot = null
  })

  it('degrades to a fail() line instead of crashing on an ENOENT readdir/stat race', () => {
    tmpRoot = makeFixtureTempDir('audit-standards-check41-race')

    // Reproduce "readdirSync lists it, statSync can't find it" deterministically:
    // a broken symlink. readdirSync lists the entry by name regardless of
    // whether its target exists; statSync (which follows symlinks) then
    // throws ENOENT resolving a target that was never created. This is the
    // same failure shape as the live incident (a file present in a directory
    // listing that a subsequent stat can no longer find), without relying on
    // a timing-dependent real race or chmod 0000 (which the plan confirms
    // does not reproduce ENOENT and is unreliable when running as root).
    const racyDir = join(tmpRoot, 'packages', 'racy-fixture')
    mkdirSync(racyDir, { recursive: true })
    const missingTarget = join(racyDir, 'does-not-exist-target.ts')
    symlinkSync(missingTarget, join(racyDir, 'racy.ts'))

    const result = runAuditOnly('realpath-asymmetry', tmpRoot)

    // No uncaught-exception crash: Node's unhandled-exception dump prints the
    // raw error + stack trace to stderr and ends with a "Node.js vX.Y.Z" line.
    // None of that should appear once Check 41 is try/catch-wrapped.
    expect(result.stderr).not.toMatch(/ENOENT/)
    expect(result.stderr).not.toMatch(/at getFilesRecursive/)
    expect(result.stderr).not.toMatch(/Node\.js v\d+\.\d+\.\d+/)

    // The try/catch converts the thrown ENOENT into a graceful fail() line on
    // stdout instead.
    expect(result.stdout).toMatch(/Error checking realpath-asymmetry/)
    expect(result.stdout).toMatch(/ENOENT/)

    // The process still exits with a normal (non-crash) exit code, not a
    // signal kill (null) or an uncaught-exception status inconsistent with
    // the dispatcher's own `process.exit(hadFailure ? 1 : 0)` contract.
    expect(result.status).toBe(1)
    expect(result.signal).toBeNull()
  })

  it('regression: passes cleanly against a fixture with no filesystem race', () => {
    tmpRoot = makeFixtureTempDir('audit-standards-check41-race')
    const okDir = join(tmpRoot, 'packages', 'ok-fixture')
    mkdirSync(okDir, { recursive: true })
    writeFileSync(join(okDir, 'clean.ts'), 'export const ok = 1\n')

    const result = runAuditOnly('realpath-asymmetry', tmpRoot)

    expect(result.stderr).not.toMatch(/ENOENT/)
    expect(result.stdout).toMatch(/No realpath-asymmetry path comparisons found/)
    expect(result.status).toBe(0)
    expect(result.signal).toBeNull()
  })
})
