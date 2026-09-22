/**
 * @fileoverview Tests for sandbox-path.ts (SMI-6358).
 * @module @skillsmith/cli/utils/sandbox-path.test
 *
 * Every case below is a review finding that landed on the inline helper this
 * module replaced. They are written as behaviour rather than as regression
 * notes, but the mapping is deliberate:
 *
 *   round 1  a denylist permitted every tree but one   -> "rejects a path outside the root"
 *   round 2  textual compare ignored symlinks          -> the symlink cases
 *   round 2  /tmp vs /private/tmp on macOS             -> "treats two spellings of one dir as equal"
 *   round 3  bare catch swallowed every errno          -> "propagates a resolution failure"
 *
 * Real filesystem, not a mock: the subject IS path resolution, so faking it
 * would leave the tests asserting the fake. Everything is created under
 * mkdtemp and removed afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { resolveRealPath, isInside, assertInside } from './sandbox-path.js'

let root: string
let outside: string

beforeAll(() => {
  // Resolved immediately: on macOS mkdtemp returns a /var/... path that is
  // itself a symlink to /private/var, and a test whose fixture is unresolved
  // cannot distinguish a correct answer from an accidental one.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-path-root-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-path-outside-')))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('isInside', () => {
  it('accepts a path beneath the root', () => {
    expect(isInside(join(root, 'a', 'b.json'), root)).toBe(true)
  })

  it('rejects a path outside the root', () => {
    expect(isInside(join(outside, 'b.json'), root)).toBe(false)
  })

  it('rejects the root itself — inside means strictly beneath', () => {
    expect(isInside(root, root)).toBe(false)
  })

  it('rejects a sibling whose name merely extends the root', () => {
    // The bug a bare string prefix has: "/x-other" starts with "/x".
    expect(isInside(`${root}-other/file.json`, root)).toBe(false)
  })

  it('rejects a path that climbs back out with ..', () => {
    expect(isInside(join(root, '..', 'escaped.json'), root)).toBe(false)
  })

  it('accepts a target that does not exist yet, under a parent that does', () => {
    // The common case: the file is about to be created.
    expect(isInside(join(root, 'not-created-yet.json'), root)).toBe(true)
  })
})

describe('symlinks — the finding a textual compare missed', () => {
  it('rejects a link that sits inside the root but points outside it', () => {
    const target = join(outside, 'real.json')
    writeFileSync(target, '{}')
    const link = join(root, 'looks-local.json')
    symlinkSync(target, link)

    // Textually this path is beneath root. Resolved, it is not.
    expect(link.startsWith(root + sep)).toBe(true)
    expect(isInside(link, root)).toBe(false)
  })

  it('rejects a file under a symlinked DIRECTORY pointing outside', () => {
    const realDir = join(outside, 'real-dir')
    mkdirSync(realDir, { recursive: true })
    const linkedDir = join(root, 'linked-dir')
    symlinkSync(realDir, linkedDir)

    // Resolving only the final segment would miss this; the parent is the link.
    expect(isInside(join(linkedDir, 'new-file.json'), root)).toBe(false)
  })

  it('accepts a link inside the root that points elsewhere inside the root', () => {
    const target = join(root, 'inner.json')
    writeFileSync(target, '{}')
    const link = join(root, 'alias.json')
    symlinkSync(target, link)
    expect(isInside(link, root)).toBe(true)
  })
})

describe('two spellings of one directory', () => {
  it('treats an unresolved and a resolved spelling of the root as equal', () => {
    // The macOS case in general form: /tmp is a symlink to /private/tmp, so
    // os.tmpdir() and its realpath are different strings for one directory.
    // Passing the unresolved spelling as the root must not reject a child
    // expressed in the resolved one, or vice versa.
    const unresolvedRoot = join(tmpdir(), root.slice(realpathSync(tmpdir()).length + 1))
    expect(isInside(join(root, 'f.json'), unresolvedRoot)).toBe(true)
    expect(isInside(join(unresolvedRoot, 'f.json'), root)).toBe(true)
  })
})

describe('resolution failures propagate rather than degrade', () => {
  it('propagates a symlink cycle instead of falling back to a textual answer', () => {
    // A bare `catch` returns the textual path here, which is precisely the
    // input that needed resolving — the shape of the round-3 finding.
    const a = join(root, 'cycle-a')
    const b = join(root, 'cycle-b')
    symlinkSync(b, a)
    symlinkSync(a, b)

    expect(() => resolveRealPath(a)).toThrow(/ELOOP/)
    expect(() => isInside(a, root)).toThrow(/ELOOP/)
  })

  it('still resolves a missing path, which is the one safe fallback', () => {
    expect(() => resolveRealPath(join(root, 'absent', 'deeper.json'))).not.toThrow()
  })
})

describe('assertInside', () => {
  it('returns silently for a permitted path', () => {
    expect(() => assertInside(join(root, 'ok.json'), root, 'writeFileSync')).not.toThrow()
  })

  it('names the operation, the path and the root when it refuses', () => {
    const bad = join(outside, 'nope.json')
    try {
      assertInside(bad, root, 'renameSync')
      throw new Error('expected assertInside to throw')
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('renameSync')
      expect(msg).toContain(bad)
      expect(msg).toContain(root)
    }
  })
})
