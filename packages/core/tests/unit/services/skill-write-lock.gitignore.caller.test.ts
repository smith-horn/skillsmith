/**
 * SMI-6531 / SMI-6676 (mutation hunt round 2): two properties of the staging
 * `.gitignore` hint that live at the seam between the hint module and its
 * caller.
 *
 *  - the `git check-ignore` child is given the 5 s timeout when the caller
 *    passes none, and the caller's own `timeoutMs` when it does (asserted at
 *    the `execFile` call, since a 5 s wait is not something to sit through);
 *  - `withSkillWriteLock` asks about the skills root's REAL path R, not the
 *    caller's spelling of it: with `git` missing, the `.git` walk starts at R,
 *    so a symlink whose lexical ancestors hold a `.git` entry does not earn a
 *    hint when R's own ancestors do not, and the converse does.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const exec = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = ((...args: unknown[]) => {
    exec.calls.push(args)
    return (actual.execFile as (...a: unknown[]) => unknown)(...args)
  }) as typeof actual.execFile
  return { ...actual, execFile, default: { ...actual, execFile } }
})

import { setLockTrackerEnabledForTests } from '../../../src/config/lock-tracker.js'
import {
  STAGING_GITIGNORE_HINT,
  stagingGitignoreHint,
} from '../../../src/services/skill-write-lock.gitignore.js'
import { withSkillWriteLock } from '../../../src/services/skill-write-lock.js'
import {
  hasGitAtOrAbove,
  installStubGit,
  makeSandbox,
  put,
  removeGitFromPath,
  type Sandbox,
} from './skill-write-lock.gitignore.helpers.js'

let sb: Sandbox

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  sb = makeSandbox()
  exec.calls = []
})

afterEach(() => {
  sb.cleanup()
})

/** The options object of the i-th recorded `execFile('git', args, options, cb)` call. */
function optionsOfCall(i: number): { timeout?: number } {
  const call = exec.calls[i]
  expect(call?.[0]).toBe('git')
  return call?.[2] as { timeout?: number }
}

describe('the check-ignore child’s timeout', () => {
  it('control: the spy sees the git call (a stub git that answers "not ignored")', async () => {
    installStubGit(sb, '#!/bin/sh\nexit 1\n')
    const root = path.join(sb.dir, 'skills')
    fs.mkdirSync(root)
    expect(await stagingGitignoreHint(root)).toBe(STAGING_GITIGNORE_HINT)
    expect(exec.calls.length).toBeGreaterThan(0)
  })

  it('is 5000 ms when the caller passes no timeout', async () => {
    installStubGit(sb, '#!/bin/sh\nexit 1\n')
    const root = path.join(sb.dir, 'skills')
    fs.mkdirSync(root)
    await stagingGitignoreHint(root)
    expect(optionsOfCall(0).timeout).toBe(5000)
  })

  it('is the caller’s timeoutMs when one is passed', async () => {
    installStubGit(sb, '#!/bin/sh\nexit 1\n')
    const root = path.join(sb.dir, 'skills')
    fs.mkdirSync(root)
    await stagingGitignoreHint(root, { timeoutMs: 1234 })
    expect(optionsOfCall(0).timeout).toBe(1234)
  })
})

describe('the hint is asked about the real root, not the caller’s spelling (git missing)', () => {
  it('a symlink under a directory with a .git entry, to a root with none: no hint', async () => {
    const lexicalParent = path.join(sb.dir, 'repo-a')
    put(path.join(lexicalParent, '.git'), 'gitdir: /elsewhere\n')
    const target = path.join(sb.dir, 'plain', 'skills')
    fs.mkdirSync(target, { recursive: true })
    const link = path.join(lexicalParent, 'links-skills')
    fs.symlinkSync(target, link)
    // The precondition that makes the case mean something: R has no .git above it.
    expect(hasGitAtOrAbove(target)).toBe(false)
    expect(hasGitAtOrAbove(link)).toBe(true)
    removeGitFromPath(sb)
    const r = await withSkillWriteLock(link, 't', async () => 'ran')
    expect(r).toMatchObject({ ok: true, value: 'ran' })
    expect('gitignoreHint' in r).toBe(false)
  })

  it('control, the converse: a symlink with no .git above it, to a root with one: the hint', async () => {
    const repoB = path.join(sb.dir, 'repo-b')
    put(path.join(repoB, '.git'), 'gitdir: /elsewhere\n')
    const target = path.join(repoB, 'skills')
    fs.mkdirSync(target, { recursive: true })
    const plain = path.join(sb.dir, 'plain-link-parent')
    fs.mkdirSync(plain)
    const link = path.join(plain, 'skills')
    fs.symlinkSync(target, link)
    expect(hasGitAtOrAbove(link)).toBe(false)
    expect(hasGitAtOrAbove(target)).toBe(true)
    removeGitFromPath(sb)
    const r = await withSkillWriteLock(link, 't', async () => 'ran')
    expect(r).toMatchObject({ ok: true, value: 'ran', gitignoreHint: STAGING_GITIGNORE_HINT })
  })
})
