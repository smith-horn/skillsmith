/**
 * isMainModule: the cases that distinguish it from the two older spellings it
 * replaces (see the helper's header). Each arm names the spelling it fails.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { canonicalize, isMainModule } from '../lib/is-main-module.mjs'

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'is-main-module-'))
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

  it('through a symlink: still main (the pathToFileURL(argv[1]).href spelling says false)', () => {
    withTempDir((dir) => {
      const f = path.join(dir, 'a.mjs')
      const link = path.join(dir, 'a-link.mjs')
      writeFileSync(f, '')
      symlinkSync(f, link)
      expect(isMainModule(pathToFileURL(f).href, link)).toBe(true)
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

  it('no argv[1] (node -e, REPL): not main', () => {
    expect(isMainModule(pathToFileURL('/x/y.mjs').href, undefined)).toBe(false)
    expect(isMainModule(pathToFileURL('/x/y.mjs').href, '')).toBe(false)
  })

  it('a non-file module URL: not main, by design, and does not throw', () => {
    expect(isMainModule('data:text/javascript,export{}', '/x/y.mjs')).toBe(false)
  })
})
