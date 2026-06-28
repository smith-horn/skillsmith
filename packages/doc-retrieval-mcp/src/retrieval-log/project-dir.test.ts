/**
 * SMI-5419 W0.1 — unit tests for the encoded-project-dir resolver.
 *
 * Isolation: each test points `$HOME` at a fresh temp dir (os.homedir() honors
 * $HOME on POSIX, which is where this runs — host + Docker Linux) so the
 * reconciler reads a controlled `~/.claude/projects/` and never the real one.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  asciiFold,
  encodeProjectSegment,
  findMainRepoRoot,
  reconcileEncodedDir,
  resetProjectDirCache,
  resolveClaudeProjectDir,
} from './project-dir.js'

let homeDir: string
let projectsDir: string
const origHome = process.env.HOME

function mkEntry(name: string): void {
  mkdirSync(join(projectsDir, name), { recursive: true })
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'projdir-'))
  projectsDir = join(homeDir, '.claude', 'projects')
  mkdirSync(projectsDir, { recursive: true })
  process.env.HOME = homeDir
  resetProjectDirCache()
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  rmSync(homeDir, { recursive: true, force: true })
  resetProjectDirCache()
})

describe('encodeProjectSegment', () => {
  it('replaces every slash with a dash, preserving case', () => {
    expect(encodeProjectSegment('/Users/foo/Bar')).toBe('-Users-foo-Bar')
  })
})

describe('asciiFold', () => {
  it('lowercases only ASCII A-Z and leaves non-ASCII untouched', () => {
    expect(asciiFold('-Users-FOO-Bar')).toBe('-users-foo-bar')
    expect(asciiFold('-İstanbul-Æ')).toBe('-İstanbul-Æ')
  })
})

describe('reconcileEncodedDir', () => {
  it('returns exact when the computed name exists verbatim', () => {
    mkEntry('-Users-foo-Bar')
    expect(reconcileEncodedDir('-Users-foo-Bar')).toEqual({
      encoded: '-Users-foo-Bar',
      state: 'exact',
    })
  })

  it('reconciles a pure casing variant to the on-disk casing', () => {
    mkEntry('-Users-Foo-Bar')
    const r = reconcileEncodedDir('-users-foo-bar')
    expect(r.state).toBe('reconciled')
    expect(r.encoded).toBe('-Users-Foo-Bar')
  })

  it('anchors casing from a descendant (worktree) entry prefix', () => {
    mkEntry('-Users-Foo-Bar--worktrees-x')
    const r = reconcileEncodedDir('-users-foo-bar')
    expect(r.state).toBe('anchored')
    expect(r.encoded).toBe('-Users-Foo-Bar')
  })

  it('does NOT match a longer sibling (substring-collision safety)', () => {
    mkEntry('-Users-Foo-Barbaz')
    const r = reconcileEncodedDir('-users-foo-bar')
    expect(r.state).toBe('miss')
    expect(r.encoded).toBe('-users-foo-bar')
  })

  it('flags ambiguous when conflicting case-variants coexist', () => {
    mkEntry('-Users-Foo-Bar')
    mkEntry('-Users-FOO-Bar')
    const r = reconcileEncodedDir('-users-foo-bar')
    expect(r.state).toBe('ambiguous')
    expect(r.candidates).toHaveLength(2)
  })

  it('misses cleanly on a fresh projects dir', () => {
    expect(reconcileEncodedDir('-Users-new-Project').state).toBe('miss')
  })
})

describe('resolveClaudeProjectDir', () => {
  it('reconciles cwd encoding and returns an absolute dir', () => {
    mkEntry('-Users-Foo-Bar')
    const r = resolveClaudeProjectDir('/Users/foo/bar')
    expect(r.state).toBe('reconciled')
    expect(r.encoded).toBe('-Users-Foo-Bar')
    expect(r.dir).toBe(join(projectsDir, '-Users-Foo-Bar'))
  })
})

describe('findMainRepoRoot', () => {
  it('returns null when no .git ancestor exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'norepo-'))
    expect(findMainRepoRoot(dir)).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the ancestor whose .git is a directory', () => {
    const repo = mkdtempSync(join(tmpdir(), 'repo-'))
    mkdirSync(join(repo, '.git'))
    const sub = join(repo, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    expect(findMainRepoRoot(sub)).toBe(repo)
    rmSync(repo, { recursive: true, force: true })
  })
})
