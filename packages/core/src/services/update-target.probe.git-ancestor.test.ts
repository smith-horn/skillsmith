/**
 * @fileoverview `probeGitAncestor` — the probe's own bounded git-ancestor
 * walk (SMI-6532, round following A0.6, finding 3).
 * @module @skillsmith/core/services/update-target.probe.git-ancestor.test
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §4.2
 *
 * WHY THIS FILE IS SEPARATE FROM `update-target.probe.test.ts`: this module
 * has its own contract (`ProbeGitAncestor`'s four states, plus the internal
 * `stat-error` exit `probeUpdateTarget` intercepts) and its own real bug
 * history distinct from the rest of the probe. Testing it directly, without
 * going through `probeUpdateTarget`'s retry loop and write-set handling,
 * keeps the fixtures small and each assertion aimed at exactly one exit.
 *
 * THE FINDING THIS FILE EXISTS TO PIN. `update-target.probe.git-ancestor.ts`
 * replaces a call chain that ran `isRealpathInside(dir, skillsDir)` as a
 * PRECONDITION before calling A0's `hasGitAncestorBetween(dir, skillsDir)`.
 * That precondition is a real, correct realpath-containment check — but
 * `hasGitAncestorBetween` itself runs a LEXICAL walk in its first pass,
 * bounded by `path.resolve(skillsDir)`, not a realpath. So a target whose
 * REALPATH is contained but whose LEXICAL path is not — a symlinked
 * ANCESTOR component, not the target itself — passes the precondition and
 * then runs an effectively unbounded lexical walk. The RED-TEST CONTROL
 * block below reproduces this directly, using the still-exported,
 * unmodified `hasGitAncestorBetween`/`isRealpathInside`, against the exact
 * fixture the rest of this file uses — proving the fixture reproduces the
 * real finding, not a synthetic stand-in for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { probeGitAncestor } from './update-target.probe.git-ancestor.js'
import { hasGitAncestorBetween } from './skill-installation.target-guard.js'
import { isRealpathInside } from './skill-installation.realpath-containment.js'

/** Hoisted so the `vi.mock` factory (lifted above every import) can close
 * over it — mirrors `update-target.probe.test.ts`'s own `eaccesInjections`
 * pattern, scoped down to just the one syscall this module ever makes. */
const eaccesGitPaths = vi.hoisted(() => new Set<string>())

function eaccesError(p: string): NodeJS.ErrnoException {
  const err = new Error(`EACCES: permission denied, lstat '${p}'`) as NodeJS.ErrnoException
  err.code = 'EACCES'
  return err
}

vi.mock('node:fs/promises', async (importOriginal) => makeFsMock(importOriginal))
vi.mock('fs/promises', async (importOriginal) => makeFsMock(importOriginal))

async function makeFsMock(importOriginal: () => Promise<typeof import('fs/promises')>) {
  const actual = await importOriginal()
  const lstat = (async (p: unknown, ...rest: unknown[]) => {
    if (typeof p === 'string' && eaccesGitPaths.has(p)) throw eaccesError(p)
    return (actual.lstat as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof actual.lstat
  return { ...actual, default: { ...actual, lstat }, lstat }
}

let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-ancestor-'))
})

afterEach(() => {
  eaccesGitPaths.clear()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

/**
 * The shared "realpath-contained but LEXICALLY outside skillsDir" fixture
 * every scenario A/B test below reuses:
 *
 *     root/skills/pkg        <- the REAL location, and skillsDir = root/skills
 *     root/alias -> root/skills   (a symlinked ANCESTOR, not the target itself)
 *     dir = root/alias/pkg   <- lexically under `alias`, really under `skills`
 *
 * `path.resolve(dir)` is `root/alias/pkg` — never equal to, nor a descendant
 * of, `path.resolve(skillsDir)` (`root/skills`) — so a LEXICAL walk from
 * `dir` never meets its stop condition and keeps climbing past `root/alias`,
 * past `root` itself, and beyond. `root` sits on that lexical climb while
 * being genuinely OUTSIDE the real `skillsDir` — exactly where the finding's
 * "elsewhere" `.git` was measured.
 */
function makeEscapingAncestorFixture(): { dir: string; skillsDir: string; elsewhere: string } {
  const skillsDir = path.join(root, 'skills')
  const pkg = path.join(skillsDir, 'pkg')
  fs.mkdirSync(pkg, { recursive: true })
  const alias = path.join(root, 'alias')
  fs.symlinkSync(skillsDir, alias, 'dir')
  return { dir: path.join(alias, 'pkg'), skillsDir, elsewhere: root }
}

describe('git-ancestor walk — RED-TEST CONTROL (SMI-6532 finding 3)', () => {
  it('reproduces the reuse-chain bug this walk replaces: the OLD isRealpathInside+hasGitAncestorBetween combo reports a `.git` planted OUTSIDE skillsDir as found', async () => {
    // Verbatim shape of the round-2 fix this branch shipped and then
    // replaced: check containment once via isRealpathInside, then hand off
    // to hasGitAncestorBetween unconditionally. Both functions are
    // untouched by this change (see this module's fileoverview) — this test
    // exercises them exactly as `checkInstallTarget` still does today.
    const { dir, skillsDir, elsewhere } = makeEscapingAncestorFixture()
    fs.mkdirSync(path.join(elsewhere, '.git'))

    const contained = await isRealpathInside(dir, skillsDir)
    expect(contained).toBe(true) // the precondition PASSES — realpath IS contained

    const walk = await hasGitAncestorBetween(dir, skillsDir)

    // The bug: a `.git` genuinely outside skillsDir is reported as a
    // legitimate ancestor, because the precondition proved realpath
    // containment while the walk itself bounds on a lexical path.
    expect(walk).toEqual({ kind: 'found', path: elsewhere })
  })

  it('the new probe never does this: probeGitAncestor on the identical fixture reports `none`, not `found`', async () => {
    const { dir, skillsDir, elsewhere } = makeEscapingAncestorFixture()
    fs.mkdirSync(path.join(elsewhere, '.git'))

    const outcome = await probeGitAncestor(dir, skillsDir)

    expect(outcome).toEqual({ kind: 'none' })
  })
})

describe('probeGitAncestor — every exit, with a control per state', () => {
  it('found: a `.git` directly at the target', async () => {
    const dir = path.join(root, 'skill')
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })

    expect(await probeGitAncestor(dir, root)).toEqual({ kind: 'found', path: dir })
  })

  it('found: a `.git` several real ancestors above the target', async () => {
    const clone = path.join(root, 'clone')
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true })
    const dir = path.join(clone, 'docs', 'skills', 'pkg')
    fs.mkdirSync(dir, { recursive: true })

    expect(await probeGitAncestor(dir, root)).toEqual({ kind: 'found', path: clone })
  })

  it('found: reached through a symlinked TARGET (not just a symlinked ancestor)', async () => {
    const clone = path.join(root, 'f1-clone')
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true })
    const realSkillDir = path.join(clone, 'docs', 'pdf')
    fs.mkdirSync(realSkillDir, { recursive: true })
    const linkPath = path.join(root, 'f1-pdf')
    fs.symlinkSync(realSkillDir, linkPath, 'dir')

    expect(await probeGitAncestor(linkPath, root)).toEqual({ kind: 'found', path: clone })
  })

  it('none: the walk terminates at the resolved root, several real levels up, with no `.git` anywhere', async () => {
    const dir = path.join(root, 'a', 'b', 'c')
    fs.mkdirSync(dir, { recursive: true })

    expect(await probeGitAncestor(dir, root)).toEqual({ kind: 'none' })
  })

  it('undetermined/escapes-root: an ordinary target realpath entirely outside skillsDir (no symlink needed)', async () => {
    const dir = path.join(root, 'outside', 'pkg')
    fs.mkdirSync(dir, { recursive: true })
    const skillsDir = path.join(root, 'skills')
    fs.mkdirSync(skillsDir, { recursive: true })

    expect(await probeGitAncestor(dir, skillsDir)).toEqual({
      kind: 'undetermined',
      reason: 'escapes-root',
    })
  })

  it('undetermined/escapes-root: the shipped fan-out shape — a RELATIVE symlink whose realpath escapes its own skillsDir, with a real `.git` at the escape target ($HOME-analog)', async () => {
    // Mirrors fan-out.ts:224-226's shipped install shape and the finding's
    // own repro: `~/.cursor/skills/<skill>` -> `../../.claude/skills/<skill>`.
    const home = path.join(root, 'gov-home')
    const cursorSkills = path.join(home, '.cursor', 'skills')
    const claudeSkills = path.join(home, '.claude', 'skills')
    fs.mkdirSync(cursorSkills, { recursive: true })
    const realSkillDir = path.join(claudeSkills, 'escaper')
    fs.mkdirSync(realSkillDir, { recursive: true })
    // The `.git` an unbounded walk would wrongly find — at $HOME, well above
    // `cursorSkills` (the skillsDir this walk is given).
    fs.mkdirSync(path.join(home, '.git'))

    const linkPath = path.join(cursorSkills, 'escaper')
    const relTarget = path.relative(path.dirname(linkPath), realSkillDir)
    fs.symlinkSync(relTarget, linkPath, 'dir')

    expect(await probeGitAncestor(linkPath, cursorSkills)).toEqual({
      kind: 'undetermined',
      reason: 'escapes-root',
    })
  })

  it('undetermined/depth-cap: 71 real levels deep, with a real `.git` at skillsDir itself — never reached, never reported as `none`', async () => {
    let dir = root
    for (let i = 0; i < 71; i++) dir = path.join(dir, `L${i}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(path.join(root, '.git'))

    expect(await probeGitAncestor(dir, root)).toEqual({
      kind: 'undetermined',
      reason: 'depth-cap',
    })
  })

  it('control: the SAME 71-level fixture with skillsDir moved to the deepest ancestor that IS within the cap reports found, not depth-cap — proving the cap is measured from the target, not a fixed property of "deep"', async () => {
    let dir = root
    const levels: string[] = []
    for (let i = 0; i < 71; i++) {
      dir = path.join(dir, `L${i}`)
      levels.push(dir)
    }
    fs.mkdirSync(dir, { recursive: true })
    // 10 levels up from the target — well within the 64-iteration cap.
    const nearSkillsDir = levels[levels.length - 10]!
    fs.mkdirSync(path.join(nearSkillsDir, '.git'))

    expect(await probeGitAncestor(dir, root)).toEqual({ kind: 'found', path: nearSkillsDir })
  })

  it('undetermined/stat-error: an EACCES on an in-bounds ancestor during the walk, sanitized to { path: <ancestor>, errno }', async () => {
    const dir = path.join(root, 'a', 'b')
    fs.mkdirSync(dir, { recursive: true })
    const ancestorA = path.join(root, 'a')
    eaccesGitPaths.add(path.join(ancestorA, '.git'))

    expect(await probeGitAncestor(dir, root)).toEqual({
      kind: 'undetermined',
      reason: 'stat-error',
      error: { path: ancestorA, errno: 'EACCES' },
    })
  })
})

describe("probeGitAncestor — scenarios A and B (the finding's own reproductions)", () => {
  it('scenario A: realpath-contained but lexically-outside dir, `.git` planted at the lexically-reachable-but-truly-outside location — reports `none`, never `found`', async () => {
    const { dir, skillsDir, elsewhere } = makeEscapingAncestorFixture()
    fs.mkdirSync(path.join(elsewhere, '.git'))

    expect(await probeGitAncestor(dir, skillsDir)).toEqual({ kind: 'none' })
  })

  it('positive control for scenario A: the IDENTICAL fixture, but the `.git` moved INSIDE the real bound — now correctly found, ruling out a walk that trivially always answers none', async () => {
    const { dir, skillsDir } = makeEscapingAncestorFixture()
    fs.mkdirSync(path.join(skillsDir, '.git'))

    expect(await probeGitAncestor(dir, skillsDir)).toEqual({ kind: 'found', path: skillsDir })
  })

  it('scenario B: the identical fixture with NO `.git` anywhere, but an EACCES injected at the excluded "elsewhere" location — the walk never visits it, so the outcome is a clean `none`, not `probe-failed`-shaped `stat-error`', async () => {
    const { dir, skillsDir, elsewhere } = makeEscapingAncestorFixture()
    // If containment were not enforced (a regression to the old lexical
    // walk), this injected failure would be hit and the outcome would flip
    // to `undetermined/stat-error`. It never does, because the walk is
    // bounded at skillsDir's own realpath and this path is never visited.
    eaccesGitPaths.add(path.join(elsewhere, '.git'))

    expect(await probeGitAncestor(dir, skillsDir)).toEqual({ kind: 'none' })
  })
})
