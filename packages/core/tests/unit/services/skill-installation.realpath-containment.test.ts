/**
 * @fileoverview {@link isResolvedPathInside} / {@link isRealpathInside} —
 *   the shared realpath-containment predicate both `isUsableDirectory` rule
 *   (c) (`skill-installation.target-guard.ts`) and `probeGitAncestor`
 *   (`update-target.probe.git-ancestor.ts`) depend on.
 * @see SMI-6532 (cross-family pre-merge gate MINOR, round following A2 step 4)
 *
 * MINOR fixed here: at a filesystem root (`realRoot === '/'` on POSIX), the
 * old `realTarget.startsWith(realRoot + path.sep)` comparison unconditionally
 * appended a SECOND separator (`'//'`), so `isResolvedPathInside('/child',
 * '/')` returned `false` — a genuine descendant of the root judged NOT
 * contained. Conservative (refuses rather than permits) but wrong.
 *
 * This file tests the PURE, synchronous `isResolvedPathInside` directly with
 * literal path strings — no real filesystem involved, so no `mkdtemp` is
 * needed for the root case (there is no safe way to `mkdir` a fixture
 * *at* `/`). The async `isRealpathInside` wrapper gets one real-tmp-dir
 * smoke test at the bottom to confirm the fix also reaches callers through
 * the resolving layer, not just the comparison in isolation.
 */
import * as fsSync from 'fs'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { describe, it, expect, afterEach } from 'vitest'

import {
  isResolvedPathInside,
  isRealpathInside,
} from '../../../src/services/skill-installation.realpath-containment.js'

describe('isResolvedPathInside — pure comparison', () => {
  it('root positive control (THE FIX): a direct child of the filesystem root is contained', () => {
    // Before the fix, `'/'.  + path.sep` produced `'//'`, which `'/child'`
    // does not start with — this is the exact case that regressed.
    expect(isResolvedPathInside('/child', '/')).toBe(true)
  })

  it('root positive control: a deeper descendant of the root is also contained', () => {
    expect(isResolvedPathInside('/a/b/c', '/')).toBe(true)
  })

  it('the root itself is contained in the root (self-equality arm)', () => {
    expect(isResolvedPathInside('/', '/')).toBe(true)
  })

  it('ordinary containment still holds for a non-root parent', () => {
    expect(isResolvedPathInside('/skills/foo', '/skills')).toBe(true)
  })

  it('the root itself, as a non-root path, is contained in itself', () => {
    expect(isResolvedPathInside('/skills', '/skills')).toBe(true)
  })

  it('an unrelated sibling is not contained', () => {
    expect(isResolvedPathInside('/other', '/skills')).toBe(false)
  })

  // Load-bearing negative control (mirrors
  // `skill-installation.target-guard.test.ts`'s `skills` vs `skills-evil`
  // "boundary" test at the async/checkInstallTarget layer): a sibling that
  // shares the root as a bare STRING PREFIX, without the separator, must
  // stay refused. This is the control that alone catches a regression to
  // `realTarget.startsWith(realRoot)` (dropping the `+ path.sep` boundary
  // entirely) — the exact off-by-one this module's fix must not reintroduce
  // while fixing the root case above.
  it('sibling-prefix negative control: a realpath sibling sharing the root as a bare string prefix (no separator) is NOT contained', () => {
    expect(isResolvedPathInside('/skills-evil/foo', '/skills')).toBe(false)
  })

  it('sibling-prefix negative control still holds when the root already ends with a separator', () => {
    expect(isResolvedPathInside('/skills-evil/foo', '/skills/')).toBe(false)
  })

  it('containment still holds when the root is passed with a trailing separator already present', () => {
    expect(isResolvedPathInside('/skills/foo', '/skills/')).toBe(true)
  })
})

// ── isRealpathInside — async wrapper smoke test ─────────────────────────

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })))
})

describe('isRealpathInside — async wrapper reaches the same fixed comparison', () => {
  it('a real child directory resolves as contained', async () => {
    // Canonicalized per CLAUDE.md ("Canonicalize temp dirs") — macOS's
    // `/tmp` is itself a symlink to `/private/tmp`, so an un-canonicalized
    // root here would make this test pass for the wrong reason (lexical
    // match) rather than the realpath comparison this module exists for.
    const root = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'containment-')))
    roots.push(root)
    const child = path.join(root, 'skill')
    await fs.mkdir(child)

    expect(await isRealpathInside(child, root)).toBe(true)
  })

  it('a real sibling directory is not contained', async () => {
    const root = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), 'containment-')))
    roots.push(root)
    const parent = path.dirname(root)
    const sibling = path.join(parent, path.basename(root) + '-evil')
    await fs.mkdir(sibling, { recursive: true })
    roots.push(sibling)

    expect(await isRealpathInside(sibling, root)).toBe(false)
  })
})
