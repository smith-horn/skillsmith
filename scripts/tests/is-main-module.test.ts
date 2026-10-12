/**
 * isMainModule: the cases that distinguish it from the two older spellings it
 * replaces (see the helper's header). Each arm names the spelling it fails.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { canonicalize, isMainModule } from '../lib/is-main-module.mjs'

// The prefix carries a space and a non-ASCII char on purpose: every arm then
// runs through a percent-encoded import.meta.url (`%20`, `%C3%BC`), which is
// the case the helper exists for -- SMI-6767's dominant spelling compares
// the encoded URL against the raw path and measured exit 0 with no output
// from such a directory. A helper that skipped percent-decoding passed every
// arm until this prefix changed.
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'is main module ü-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('isMainModule', () => {
  it('direct invocation: the module is main', () => {
    withTempDir((dir) => {
      const f = path.join(dir, 'a.mjs')
      writeFileSync(f, '')
      expect(isMainModule(pathToFileURL(f).href, f)).toBe(true)
    })
  })

  it('through a symlink chain and a symlinked directory: still main (the pathToFileURL(argv[1]).href spelling says false)', () => {
    withTempDir((dir) => {
      // real/a.mjs; linkdir -> real (a symlinked directory prefix);
      // link1 -> real/a.mjs (a target RELATIVE to the link's own directory);
      // link2 -> link1 (a chain). A one-level readlink resolves none of these
      // fully; realpathSync does.
      const real = path.join(dir, 'real')
      mkdirSync(real)
      const f = path.join(real, 'a.mjs')
      writeFileSync(f, '')
      const linkdir = path.join(dir, 'linkdir')
      symlinkSync(real, linkdir)
      const link1 = path.join(dir, 'link1.mjs')
      symlinkSync(path.join('real', 'a.mjs'), link1)
      const link2 = path.join(dir, 'link2.mjs')
      symlinkSync(link1, link2)
      expect(isMainModule(pathToFileURL(f).href, link1)).toBe(true)
      expect(isMainModule(pathToFileURL(f).href, link2)).toBe(true)
      expect(isMainModule(pathToFileURL(f).href, path.join(linkdir, 'a.mjs'))).toBe(true)
    })
  })

  it('relative argv[1] and a dotted path: still main', () => {
    withTempDir((dir) => {
      const f = path.join(dir, 'a.mjs')
      writeFileSync(f, '')
      const rel = path.relative(process.cwd(), f)
      expect(isMainModule(pathToFileURL(f).href, rel)).toBe(true)
      expect(isMainModule(pathToFileURL(f).href, path.join(dir, '.', 'a.mjs'))).toBe(true)
    })
  })

  it('a path that no longer exists: still main when both name the same file (the catch->false spelling says false, which for a CLI is a silent exit 0)', () => {
    const gone = path.join(tmpdir(), 'is-main-module-gone', 'never-written.mjs')
    expect(isMainModule(pathToFileURL(gone).href, gone)).toBe(true)
    expect(canonicalize(gone)).toBe(gone)
    // The joint case: a RELATIVE argv[1] naming a path that cannot be
    // realpath'ed. A fallback that returned the raw input instead of the
    // resolved path passed both single-case arms and failed this one.
    expect(isMainModule(pathToFileURL(gone).href, path.relative(process.cwd(), gone))).toBe(true)
  })

  it('a different file: not main', () => {
    withTempDir((dir) => {
      const a = path.join(dir, 'a.mjs')
      const b = path.join(dir, 'b.mjs')
      writeFileSync(a, '')
      writeFileSync(b, '')
      expect(isMainModule(pathToFileURL(a).href, b)).toBe(false)
    })
  })

  it('no argv[1] (node -e, REPL): not main -- and does not throw', () => {
    // The vitest worker has its own argv[1] (forks.js), so passing
    // `undefined` explicitly just triggers the default parameter and
    // compares against that file -- a duplicate of the "different file"
    // arm that never reaches the `!argv1` guard. Measured: with the guard
    // deleted, that form still passed while `node --input-type=module -e`
    // threw ERR_INVALID_ARG_TYPE in resolve(). So make argv[1] genuinely
    // absent and call with ONE argument, the shape production uses.
    const saved = process.argv
    try {
      process.argv = [process.argv[0]]
      expect(isMainModule(pathToFileURL('/x/y.mjs').href)).toBe(false)
    } finally {
      process.argv = saved
    }
    // cwd-based URL on purpose: a helper that fell THROUGH the guard would
    // compare canonicalize('') === cwd and return true, so this fails
    // loudly; with '/x/y.mjs' it returned false for a reason unrelated to
    // the guard (measured: three guard-weakening mutations survived it).
    expect(isMainModule(pathToFileURL(process.cwd()).href, '')).toBe(false)
  })

  it('a non-file module URL: not main, by design, and does not throw', () => {
    expect(isMainModule('data:text/javascript,export{}', '/x/y.mjs')).toBe(false)
  })
})
