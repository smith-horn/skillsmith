/**
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §4.2
 * @see SMI-6532 A2, T-G2 (probe errors fail closed)
 *
 * ## Ambiguity notes (reported back per the task's own instruction)
 *
 * 1. §4.2's boundary between a "metadata error" (`lstat`, `realpath`,
 *    `readdir` -> `probe-failed`) and a "read or hash error ... on SKILL.md
 *    or any file in the write set" (-> `unreadable`) does not say which
 *    bucket a per-FILE `lstat` failure (as opposed to a directory-level
 *    `lstat`) belongs to — `lstat` is named under "metadata errors" in
 *    general, but the write-set enumeration also needs an `lstat` per file
 *    to tell a regular file from a symlink/dir/other before hashing it. This
 *    probe resolves it as: directory/ancestor/git-walk `lstat` = metadata =
 *    `probe-failed`; a write-set MEMBER's own `lstat` (part of reading that
 *    specific file) = `unreadable`, grouped with its `readFile` outcome.
 * 2. §4.2's `.skillsmith-staging/` `recovery-pending` check runs on A1's
 *    record scan (SMI-6531 step 5, `skill-swap.records.ts`): the default
 *    checker is true for a VERIFIED record naming the folder, present or
 *    missing, and throws (so the probe says `probe-failed`) when the staging
 *    can't be listed. `unreadableStagingRecords` is row 0b.
 * 3. §4.2 doesn't say what happens when `dir` exists but is not a directory
 *    (e.g. a stray file at that path). This probe treats it as an immediate
 *    metadata error (`probe-failed`, `ENOTDIR`), not "missing" — retrying
 *    can't fix a file blocking the slot, so retry would be pure waste.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'

import { probeUpdateTarget, defaultRecoveryPendingChecker } from './update-target.probe.js'
import { unreadableStagingRecords } from './update-target.probe.recovery.js'
import { computeRecordSha256 } from './skill-swap.js'
import type { SwapRecord } from './skill-swap.js'
import { hasRecordedLocalEdit } from './skill-identity-classification.js'
import { hashContent } from './skill-installation.helpers.js'

// This file no longer mocks `skill-installation.target-guard.js`. Before
// SMI-6532's round-following-A0.6 fix, `probeUpdateTarget` called
// `hasGitAncestorBetween` and this file wrapped it (`vi.fn(actual.fn)`) so a
// test could assert it was NOT called for the realpath-escapes-skillsDir
// case. The probe no longer calls that function AT ALL — see
// `update-target.probe.git-ancestor.ts`'s fileoverview for why — so "was it
// called" is no longer a meaningful assertion here; the dedicated
// `update-target.probe.git-ancestor.test.ts` tests that module's own walk
// directly, mechanism included (its own RED-TEST CONTROL block reproduces
// the bug this change fixes, through `checkInstallTarget`'s own public API —
// `hasGitAncestorBetween` itself is private again, SMI-6841 finding 5).

// Hoisted, mutable EACCES-injection registry read by the mocked fs/promises
// below -- both this file and everything it imports (including
// `skill-installation.target-guard.ts`'s own `fs.lstat` calls during the git
// walk) see the SAME mocked module, so injecting a path here reaches the
// probe's transitive git-walk call too (T-G2's "on an ancestor during the
// git walk" fixture). The `lstat` set gates BOTH `fs.lstat` AND `fs.stat` --
// F1 (SMI-6532) changed `checkPresence`'s directory check from `lstat` to
// `stat` (follow symlinks, so a symlinked skill dir isn't fabricated-ENOTDIR),
// so a fixture asserting "the target dir itself is inaccessible" must deny
// whichever syscall the implementation actually uses, not pin one of them.
const eaccesInjections = vi.hoisted(() => ({
  lstat: new Set<string>(),
  readFile: new Set<string>(),
}))

function eaccesError(op: string, p: string): NodeJS.ErrnoException {
  const err = new Error(`EACCES: permission denied, ${op} '${p}'`) as NodeJS.ErrnoException
  err.code = 'EACCES'
  return err
}

function makeFsMock(actual: typeof import('fs/promises')) {
  const lstat = (async (p: unknown, ...rest: unknown[]) => {
    if (typeof p === 'string' && eaccesInjections.lstat.has(p)) throw eaccesError('lstat', p)
    return (actual.lstat as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof actual.lstat
  const stat = (async (p: unknown, ...rest: unknown[]) => {
    if (typeof p === 'string' && eaccesInjections.lstat.has(p)) throw eaccesError('stat', p)
    return (actual.stat as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof actual.stat
  const readFile = (async (p: unknown, ...rest: unknown[]) => {
    if (typeof p === 'string' && eaccesInjections.readFile.has(p)) throw eaccesError('open', p)
    return (actual.readFile as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof actual.readFile
  return { ...actual, default: { ...actual, lstat, stat, readFile }, lstat, stat, readFile }
}

vi.mock('node:fs/promises', async (importOriginal) =>
  makeFsMock(await importOriginal<typeof import('node:fs/promises')>())
)
vi.mock('fs/promises', async (importOriginal) =>
  makeFsMock(await importOriginal<typeof import('fs/promises')>())
)

let root = ''

function mkSkill(rel: string, skillMd = 'body'): string {
  const dir = path.join(root, rel)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd)
  return dir
}

/**
 * Writes `<root>/.skillsmith-staging/<opId>/record.json`: a record that
 * verifies as this root's (its hash computed here), naming `realDir` and
 * `comparedPath`.
 */
function putRecord(opId: string, realDir: string, comparedPath: string = realDir): string {
  const identity = { dev: '1', ino: '2', birthtimeNs: '3', fmt: 'f' }
  const body: Omit<SwapRecord, 'recordSha256'> = {
    schema: 1,
    op: 'update',
    opId,
    pid: 1234,
    host: 'host-a',
    uid: 1000,
    target: {
      comparedPath,
      realDir,
      skillsDir: root,
      manifestPath: path.join(root, 'manifest.json'),
      manifestKey: path.basename(realDir),
      client: 'claude-code',
      scope: 'global',
      dirName: path.basename(comparedPath),
    },
    rootIdentity: identity,
    opDirIdentity: identity,
    oldIdentity: identity,
    newIdentity: identity,
    preTree: 'pre',
    postTree: 'post',
    preEntry: null,
    postEntry: null,
    backupDest: path.join(root, 'backup', opId),
  }
  const opDir = path.join(root, '.skillsmith-staging', opId)
  fs.mkdirSync(opDir, { recursive: true })
  const file = path.join(opDir, 'record.json')
  fs.writeFileSync(file, JSON.stringify({ ...body, recordSha256: computeRecordSha256(body) }))
  return file
}

/** Makes `<root>/.skillsmith-staging` a plain file, so listing it fails (ENOTDIR). */
function breakStaging(): void {
  fs.writeFileSync(path.join(root, '.skillsmith-staging'), 'not a directory')
}

beforeEach(() => {
  // SMI-6532 review round 4, MINOR 3: canonicalize the temp root ONCE, here,
  // rather than leaving it as `os.tmpdir()`'s raw string. On macOS,
  // `os.tmpdir()` returns a path under `/var/...`, itself a symlink to
  // `/private/var/...` — so an un-canonicalized `root` and a `realpath`'d
  // value derived from a path under it are different strings for the SAME
  // directory. This module is specifically about realpath comparisons, so a
  // fixture that ignores realpath is especially the wrong kind of wrong:
  // several assertions below compare a raw `root`-derived path against a
  // `gitAncestor.path` this module resolved via `realpath`, and those two
  // fail to match on a macOS HOST (never inside the Linux dev container,
  // where `/tmp` carries no such symlink) — 3 tests, measured.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-')))
})

afterEach(() => {
  eaccesInjections.lstat.clear()
  eaccesInjections.readFile.clear()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe('probeUpdateTarget — RED-TEST CONTROL (SMI-6598)', () => {
  it("reproduces today's read-error-as-null bug this probe replaces: an EACCES on SKILL.md is reported as 'not edited'", async () => {
    // Verbatim shape of manage.update.identity.ts:66-78 feeding
    // skill-identity-classification.ts's hasRecordedLocalEdit -- the exact
    // two call sites T-G2 names as the live bug. This control must stay
    // failing (i.e. `edited` must stay `false`) as long as that code is
    // unfixed -- it is not a desired outcome, it is proof the bug exists.
    const dir = mkSkill('locked-skill')
    const skillMdPath = path.join(dir, 'SKILL.md')
    eaccesInjections.readFile.add(skillMdPath)

    let localContent: string | null
    try {
      localContent = await (await import('fs/promises')).readFile(skillMdPath, 'utf-8')
    } catch {
      localContent = null // manage.update.identity.ts:75-76, verbatim
    }
    const localHash = localContent !== null ? hashContent(localContent) : null

    const edited = hasRecordedLocalEdit({ contentHash: 'deadbeef' }, localHash)

    expect(edited).toBe(false) // <- the bug: unreadable reads as "not edited"
  })

  it('the new probe never does this: the same fixture yields `unreadable`, not `ok`', async () => {
    const dir = mkSkill('locked-skill')
    eaccesInjections.readFile.add(path.join(dir, 'SKILL.md'))

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'locked-skill',
      writeSet: ['SKILL.md'],
    })

    expect(outcome.kind).toBe('unreadable')
  })
})

describe('probeUpdateTarget — T-G2 probe errors fail closed', () => {
  it('EACCES on SKILL.md -> unreadable, never ok/eligible-shaped', async () => {
    const dir = mkSkill('foo')
    eaccesInjections.readFile.add(path.join(dir, 'SKILL.md'))

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'foo',
      writeSet: [],
    })

    expect(outcome).toEqual({
      kind: 'unreadable',
      error: { path: path.join(dir, 'SKILL.md'), errno: 'EACCES' },
    })
  })

  it('EACCES on the target dir itself -> probe-failed, no retry (not ENOENT)', async () => {
    const dir = mkSkill('bar')
    eaccesInjections.lstat.add(dir)

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'bar',
      writeSet: [],
    })

    expect(outcome).toEqual({ kind: 'probe-failed', error: { path: dir, errno: 'EACCES' } })
  })

  it('EACCES on an ancestor during the git walk -> probe-failed', async () => {
    const dir = mkSkill('baz')
    // The walk climbs dir -> skillsDir; fail the ancestor's `.git` lstat.
    eaccesInjections.lstat.add(path.join(root, '.git'))

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'baz',
      writeSet: [],
    })

    // `probeGitAncestor`'s own walk (`update-target.probe.git-ancestor.ts`)
    // sanitizes the error against the DIRECTORY being checked (`root`), not
    // the joined `.git` path it lstat'd internally — that directory is
    // `root` here (the ancestor one level above `dir`). `probeUpdateTarget`
    // intercepts the walk's `undetermined; reason: 'stat-error'` exit and
    // converts it into this same `probe-failed` shape.
    expect(outcome).toEqual({
      kind: 'probe-failed',
      error: { path: root, errno: 'EACCES' },
    })
  })

  it('never returns ok, no-baseline, git-managed or local shapes for any EACCES fixture above', async () => {
    const forbiddenKinds = new Set(['ok'])
    const dir1 = mkSkill('f1')
    eaccesInjections.readFile.add(path.join(dir1, 'SKILL.md'))
    const outcome1 = await probeUpdateTarget({
      dir: dir1,
      skillsDir: root,
      dirName: 'f1',
      writeSet: [],
    })
    expect(forbiddenKinds.has(outcome1.kind)).toBe(false)

    const dir2 = mkSkill('f2')
    eaccesInjections.lstat.add(dir2)
    const outcome2 = await probeUpdateTarget({
      dir: dir2,
      skillsDir: root,
      dirName: 'f2',
      writeSet: [],
    })
    expect(forbiddenKinds.has(outcome2.kind)).toBe(false)
  })
})

describe('probeUpdateTarget — retry rule (§4.2)', () => {
  it('succeeds when a missing tracked folder reappears by attempt 3, sleeping exactly twice at 20ms', async () => {
    const dir = path.join(root, 'reappearing')
    let sleepCalls = 0
    const sleep = vi.fn(async (ms: number) => {
      sleepCalls++
      expect(ms).toBe(20)
      if (sleepCalls === 2) {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'SKILL.md'), 'body')
      }
    })

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'reappearing',
      writeSet: [],
      sleep,
    })

    expect(sleep).toHaveBeenCalledTimes(2)
    expect(outcome.kind).toBe('ok')
  })

  it('reports probe-failed (ENOENT) after 3 attempts when it never reappears and no staging record names it', async () => {
    const dir = path.join(root, 'gone')
    const sleep = vi.fn(async (ms: number) => {
      expect(ms).toBe(20)
    })

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'gone',
      writeSet: [],
      sleep,
      checkRecoveryPending: async () => false,
    })

    expect(sleep).toHaveBeenCalledTimes(2) // between 1->2 and 2->3, never after the final attempt
    expect(outcome).toEqual({ kind: 'probe-failed', error: { path: dir, errno: 'ENOENT' } })
  })

  it('reports recovery-pending, not probe-failed, when a staging record names the missing dir', async () => {
    const dir = path.join(root, 'mid-swap')
    const sleep = vi.fn(async () => {})
    const checkRecoveryPending = vi.fn(async (input: { dir: string; dirName: string }) => {
      expect(input.dir).toBe(dir)
      expect(input.dirName).toBe('mid-swap')
      return true
    })

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'mid-swap',
      writeSet: [],
      sleep,
      checkRecoveryPending,
    })

    expect(checkRecoveryPending).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ kind: 'recovery-pending' })
  })

  it('uses the DEFAULT checker when none is injected, against a real staging record', async () => {
    // Every other test here injects `checkRecoveryPending`, so none of them
    // exercises `probeUpdateTarget`'s own default-parameter wiring
    // (`input.checkRecoveryPending ?? defaultRecoveryPendingChecker`).
    // Breaking that `??` arm would leave the recovery check dead — a missing
    // folder mid-swap would report `probe-failed` instead of
    // `recovery-pending` — and every existing test would still pass, because
    // each supplies its own checker.
    //
    // So this one deliberately injects NOTHING and writes a verified staging
    // record on disk, exercising the default end to end.
    const dir = path.join(root, 'mid-swap-default')
    putRecord('1'.repeat(32), dir)

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'mid-swap-default',
      writeSet: [],
      sleep: async () => {},
      // checkRecoveryPending deliberately omitted — that is the point.
    })

    expect(outcome).toEqual({ kind: 'recovery-pending' })
  })

  it('a PRESENT folder named by a verified record is recovery-pending too (a crash after rename 2), the default checker', async () => {
    const dir = mkSkill('crashed-after-rename-2')
    const other = mkSkill('unrelated-skill')
    putRecord('2'.repeat(32), dir)

    const named = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'crashed-after-rename-2',
      writeSet: [],
    })
    // Control, same root and same record: another present folder is probed as usual.
    const unrelated = await probeUpdateTarget({
      dir: other,
      skillsDir: root,
      dirName: 'unrelated-skill',
      writeSet: [],
    })

    expect(named).toEqual({ kind: 'recovery-pending' })
    expect(unrelated.kind).toBe('ok')
  })

  it('the default checker that cannot list the staging fails closed: probe-failed for a present and a missing folder', async () => {
    const present = mkSkill('present-staging-broken')
    const missing = path.join(root, 'missing-staging-broken')
    breakStaging()

    const a = await probeUpdateTarget({
      dir: present,
      skillsDir: root,
      dirName: 'present-staging-broken',
      writeSet: [],
      sleep: async () => {},
    })
    const b = await probeUpdateTarget({
      dir: missing,
      skillsDir: root,
      dirName: 'missing-staging-broken',
      writeSet: [],
      sleep: async () => {},
    })

    // The error names the path that failed (the staging), not the skill folder.
    const staging = path.join(root, '.skillsmith-staging')
    expect(a).toEqual({ kind: 'probe-failed', error: { path: staging, errno: 'ENOTDIR' } })
    expect(b).toEqual({ kind: 'probe-failed', error: { path: staging, errno: 'ENOTDIR' } })
  })

  it('the DEFAULT checker also says NO when no staging record names the dir', async () => {
    // The companion to the test above, and the reason it exists is worth
    // stating: that one alone pins only that the default is REACHED, not that
    // it DISCRIMINATES. Red-testing it with `async () => false` (the author's
    // own choice of mutation) catches nothing here, because a default hardwired
    // to `async () => true` passes it — measured, it survived. A test that
    // would still pass if the code computed its answer some other way is
    // pinning an output shape, not a behaviour (SMI-6732).
    //
    // The two together pin both directions: record present -> recovery-pending,
    // record absent -> probe-failed. Neither constant default satisfies both.
    const dir = path.join(root, 'gone-no-record')
    // Deliberately NO .skillsmith-staging/ anywhere under `root`.

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'gone-no-record',
      writeSet: [],
      sleep: async () => {},
      // checkRecoveryPending deliberately omitted — that is the point.
    })

    expect(outcome).toEqual({ kind: 'probe-failed', error: { path: dir, errno: 'ENOENT' } })
  })

  it('a non-directory occupying dir is an immediate probe-failed (ENOTDIR), never retried', async () => {
    const dir = path.join(root, 'a-plain-file')
    fs.writeFileSync(dir, 'not a dir')
    const sleep = vi.fn(async () => {})

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'a-plain-file',
      writeSet: [],
      sleep,
    })

    expect(sleep).not.toHaveBeenCalled()
    expect(outcome).toEqual({ kind: 'probe-failed', error: { path: dir, errno: 'ENOTDIR' } })
  })
})

describe('probeUpdateTarget — F1: a symlinked skill directory is probed, not fabricated-ENOTDIR', () => {
  it('a symlink-to-directory target counts as present, not a metadata error', async () => {
    const realDir = mkSkill('f1-real', 'body')
    const linkDir = path.join(root, 'f1-linked')
    fs.symlinkSync(realDir, linkDir, 'dir')

    const outcome = await probeUpdateTarget({
      dir: linkDir,
      skillsDir: root,
      dirName: 'f1-linked',
      writeSet: [],
    })

    expect(outcome.kind).toBe('ok')
  })

  it('a broken symlink target falls into the retry/missing path (ENOENT), not an immediate ENOTDIR', async () => {
    const linkDir = path.join(root, 'f1-broken-link')
    fs.symlinkSync(path.join(root, 'nonexistent-target'), linkDir, 'dir')
    const sleep = vi.fn(async () => {})

    const outcome = await probeUpdateTarget({
      dir: linkDir,
      skillsDir: root,
      dirName: 'f1-broken-link',
      writeSet: [],
      sleep,
      checkRecoveryPending: async () => false,
    })

    expect(sleep).toHaveBeenCalledTimes(2)
    expect(outcome).toEqual({
      kind: 'probe-failed',
      error: { path: linkDir, errno: 'ENOENT' },
    })
  })

  it("reaches a `.git` through a symlinked dir's realpath chain — a git clone visible only via the symlink target is detected", async () => {
    // Shape from the spec (fan-out.ts:226): skillsDir/pdf -> skillsDir/clone/docs/pdf,
    // where `clone` (not `pdf`'s own lexical parent) has `.git`. Only a walk
    // starting from `dir`'s REALPATH ever visits `clone` — reaching this walk
    // at all first requires checkPresence to accept the symlinked `dir` (F1).
    const clone = path.join(root, 'f1-clone')
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true })
    const realSkillDir = path.join(clone, 'docs', 'pdf')
    fs.mkdirSync(realSkillDir, { recursive: true })
    fs.writeFileSync(path.join(realSkillDir, 'SKILL.md'), 'body')
    const linkPath = path.join(root, 'f1-pdf')
    fs.symlinkSync(realSkillDir, linkPath, 'dir')

    const outcome = await probeUpdateTarget({
      dir: linkPath,
      skillsDir: root,
      dirName: 'f1-pdf',
      writeSet: [],
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.gitAncestor).toEqual({ kind: 'found', path: clone })
  })
})

describe('probeUpdateTarget — CRITICAL fix: a symlink whose realpath escapes skillsDir never runs the (unbounded) git walk', () => {
  it('the shipped fan-out shape (relative symlink out of its own skillsDir) reports gitAncestor: undetermined/escapes-root — a `.git` far outside skillsDir is never found', async () => {
    // Mirrors fan-out.ts:224-226's shipped install shape and the finding's
    // own repro: `~/.cursor/skills/<skill>` -> `../../.claude/skills/<skill>`,
    // a RELATIVE symlink whose realpath resolves OUTSIDE its own skillsDir.
    // A `.git` sits at the role $HOME plays in the finding — an ancestor far
    // above skillsDir that an UNBOUNDED walk (the bug) would wrongly reach
    // and report as `found`. `probeGitAncestor` (`update-target.probe.git-
    // ancestor.ts`) asserts containment BEFORE any walk starts, so this
    // never gets that far — the dedicated
    // `update-target.probe.git-ancestor.test.ts` covers the mechanism
    // directly (including a RED-TEST CONTROL reproducing the old bug through
    // `checkInstallTarget`, whose own rule (d) still runs `hasGitAncestor-
    // Between`'s logic unmodified); this integration test pins the value
    // `probeUpdateTarget`'s own `ok` outcome surfaces.
    const home = path.join(root, 'gov-home')
    const cursorSkills = path.join(home, '.cursor', 'skills')
    const claudeSkills = path.join(home, '.claude', 'skills')
    fs.mkdirSync(cursorSkills, { recursive: true })
    const realSkillDir = path.join(claudeSkills, 'escaper')
    fs.mkdirSync(realSkillDir, { recursive: true })
    fs.writeFileSync(path.join(realSkillDir, 'SKILL.md'), 'body')
    // The `.git` an unbounded walk would wrongly find — at $HOME, well above
    // `cursorSkills` (the `skillsDir` this probe is given).
    fs.mkdirSync(path.join(home, '.git'))

    const linkPath = path.join(cursorSkills, 'escaper')
    const relTarget = path.relative(path.dirname(linkPath), realSkillDir)
    fs.symlinkSync(relTarget, linkPath, 'dir')

    const outcome = await probeUpdateTarget({
      dir: linkPath,
      skillsDir: cursorSkills,
      dirName: 'escaper',
      writeSet: [],
    })

    // `undetermined`, never a permissive `found`/`none`/`null` — and never
    // `probe-failed` either (that would erase the F1 symlink-following fix
    // for every in-bounds symlinked target).
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.gitAncestor).toEqual({
      kind: 'undetermined',
      reason: 'escapes-root',
    })
  })
})

describe('probeUpdateTarget — F2: a non-regular SKILL.md is data for the classifier, not a probe failure', () => {
  it('SKILL.md as a symlink -> ok, entryType symlink, skillMdHash null, never probe-failed', async () => {
    const dir = path.join(root, 'f2-symlink-skillmd')
    fs.mkdirSync(dir, { recursive: true })
    const targetFile = path.join(dir, 'target.txt')
    fs.writeFileSync(targetFile, 'target body')
    fs.symlinkSync(targetFile, path.join(dir, 'SKILL.md'))

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'f2-symlink-skillmd',
      writeSet: [],
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.skillMdHash).toBeNull()
    // Finding 3: the reason for the null hash sits on the SAME object, not
    // only one level down in files[0] — see ProbeOk.skillMdEntryType's own
    // doc comment for why a bare null must never be readable alone.
    expect(outcome.skillMdEntryType).toBe('symlink')
    expect(outcome.files[0]).toEqual({ rel: 'SKILL.md', sha256: null, entryType: 'symlink' })
  })

  it('SKILL.md as a directory -> ok, entryType directory, skillMdHash null, never probe-failed', async () => {
    const dir = path.join(root, 'f2-dir-skillmd')
    fs.mkdirSync(path.join(dir, 'SKILL.md'), { recursive: true })

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'f2-dir-skillmd',
      writeSet: [],
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.skillMdHash).toBeNull()
    expect(outcome.skillMdEntryType).toBe('directory')
    expect(outcome.files[0]).toEqual({ rel: 'SKILL.md', sha256: null, entryType: 'directory' })
  })

  it('Finding 3: skillMdEntryType is undefined (not set) for an ordinary regular-file SKILL.md — only a null skillMdHash ever carries a reason', async () => {
    const dir = mkSkill('f2-regular-skillmd', 'ordinary content')

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'f2-regular-skillmd',
      writeSet: [],
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.skillMdHash).not.toBeNull()
    expect(outcome.skillMdEntryType).toBeUndefined()
  })
})

describe('probeUpdateTarget — F3: an absolute write-set entry is refused, not silently contained', () => {
  it('refuses an absolute write-set entry rather than joining it onto dir', async () => {
    const dir = mkSkill('f3-abs-escaper')
    const outsideAbs = path.join(root, 'etc-passwd-stand-in.txt')
    fs.writeFileSync(outsideAbs, 'root:x:0:0::/root:/bin/bash\n')

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'f3-abs-escaper',
      writeSet: [outsideAbs],
    })

    expect(outcome).toEqual({
      kind: 'unreadable',
      error: { path: outsideAbs, errno: 'EINVAL' },
    })
  })
})

describe('probeUpdateTarget — F7: dedupes a write-set member against its normalized spelling', () => {
  it('./SKILL.md and SKILL.md collapse into one probed entry, one hash', async () => {
    const dir = mkSkill('f7-dedupe', 'the content')

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'f7-dedupe',
      writeSet: ['./SKILL.md', 'SKILL.md'],
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.files).toHaveLength(1)
    expect(outcome.files[0]?.rel).toBe('SKILL.md')
    expect(outcome.skillMdHash).toBe(
      createHash('sha256').update(Buffer.from('the content')).digest('hex')
    )
  })
})

describe('probeUpdateTarget — F8: an injected checkRecoveryPending that rejects fails closed', () => {
  it('a throwing injected checkRecoveryPending becomes probe-failed, never an uncaught rejection', async () => {
    const dir = path.join(root, 'f8-seam-throws')
    const sleep = vi.fn(async () => {})
    const checkRecoveryPending = vi.fn(async () => {
      throw new Error('seam exploded')
    })

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'f8-seam-throws',
      writeSet: [],
      sleep,
      checkRecoveryPending,
    })

    expect(checkRecoveryPending).toHaveBeenCalledTimes(1)
    expect(outcome.kind).toBe('probe-failed')
  })
})

describe('probeUpdateTarget — ok outcome contents', () => {
  it('hashes SKILL.md and write-set members as raw bytes (not decoded/re-encoded strings)', async () => {
    // A byte sequence that is invalid UTF-8 on its own, so a
    // decode-then-rehash implementation (`hashContent(buf.toString('utf-8'))`)
    // would silently replace the invalid bytes with U+FFFD before hashing,
    // producing a DIFFERENT digest than hashing the raw bytes directly.
    const dir = mkSkill('bin-skill', 'body')
    const assetPath = path.join(dir, 'asset.bin')
    const rawBytes = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x80])
    fs.writeFileSync(assetPath, rawBytes)

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'bin-skill',
      writeSet: ['asset.bin'],
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    const asset = outcome.files.find((f) => f.rel === 'asset.bin')
    expect(asset?.sha256).toBe(createHash('sha256').update(rawBytes).digest('hex'))
  })

  it('SKILL.md is always probed even when omitted from writeSet, and appears first in files', async () => {
    const dir = mkSkill('always-skillmd', 'the content')
    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'always-skillmd',
      writeSet: ['other.txt'],
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.files[0]?.rel).toBe('SKILL.md')
    expect(outcome.skillMdHash).toBe(
      createHash('sha256').update(Buffer.from('the content')).digest('hex')
    )
  })

  it('flags a symlink write-set member with entryType, sha256 null, never throws', async () => {
    const dir = mkSkill('symlinked')
    const linkPath = path.join(dir, 'link.txt')
    fs.symlinkSync(path.join(dir, 'SKILL.md'), linkPath)

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'symlinked',
      writeSet: ['link.txt'],
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    const link = outcome.files.find((f) => f.rel === 'link.txt')
    expect(link).toEqual({ rel: 'link.txt', sha256: null, entryType: 'symlink' })
  })

  it('flags a directory write-set member with entryType directory', async () => {
    const dir = mkSkill('dir-member')
    fs.mkdirSync(path.join(dir, 'subdir'))

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'dir-member',
      writeSet: ['subdir'],
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.files.find((f) => f.rel === 'subdir')).toEqual({
      rel: 'subdir',
      sha256: null,
      entryType: 'directory',
    })
  })

  it("flags a FIFO write-set member with entryType 'other' (SMI-6841 finding 6) — the row-12 shape §4.3's own text names ('a symlink, dir, hardlink or other type') that had no test anywhere: neither isFile() nor isSymbolicLink() nor isDirectory()", async () => {
    const dir = mkSkill('fifo-member')
    const fifoPath = path.join(dir, 'pipe')
    execFileSync('mkfifo', [fifoPath])

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'fifo-member',
      writeSet: ['pipe'],
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.files.find((f) => f.rel === 'pipe')).toEqual({
      rel: 'pipe',
      sha256: null,
      entryType: 'other',
    })
  })

  it("flags a hardlinked write-set member with hardLinked:true (§4.3 row 12's fourth unsupported shape, closed here): nlink>1 on a REGULAR file, no entryType", async () => {
    const dir = mkSkill('hardlinked')
    const original = path.join(dir, 'shared.txt')
    fs.writeFileSync(original, 'shared bytes')
    // A second name for the SAME inode, outside the skill dir entirely —
    // the write-set member itself is what's probed; the second name only
    // has to exist for `nlink` to read >1 via the write-set member's OWN
    // lstat.
    const secondName = path.join(root, 'outside-hardlink-target.txt')
    fs.linkSync(original, secondName)

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'hardlinked',
      writeSet: ['shared.txt'],
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    const shared = outcome.files.find((f) => f.rel === 'shared.txt')
    expect(shared).toEqual({
      rel: 'shared.txt',
      sha256: createHash('sha256').update(Buffer.from('shared bytes')).digest('hex'),
      hardLinked: true,
    })
  })

  it('regular-file control: an ordinary single-link file has no hardLinked key at all — the signal discriminates rather than firing on every regular file', async () => {
    const dir = mkSkill('single-link')
    const filePath = path.join(dir, 'solo.txt')
    fs.writeFileSync(filePath, 'solo bytes')

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'single-link',
      writeSet: ['solo.txt'],
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    const solo = outcome.files.find((f) => f.rel === 'solo.txt')
    expect(solo).toEqual({
      rel: 'solo.txt',
      sha256: createHash('sha256').update(Buffer.from('solo bytes')).digest('hex'),
    })
    expect(solo && 'hardLinked' in solo).toBe(false)
  })

  it('directory control: a write-set member that is a directory (POSIX-inherent nlink>1) is flagged via entryType alone, never hardLinked', async () => {
    const dir = mkSkill('dir-not-hardlink')
    fs.mkdirSync(path.join(dir, 'subdir'))

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'dir-not-hardlink',
      writeSet: ['subdir'],
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    const subdir = outcome.files.find((f) => f.rel === 'subdir')
    expect(subdir).toEqual({ rel: 'subdir', sha256: null, entryType: 'directory' })
    expect(subdir && 'hardLinked' in subdir).toBe(false)
  })

  it('symlink control: a write-set member that is a symlink is flagged via entryType alone, never hardLinked', async () => {
    const dir = mkSkill('symlink-not-hardlink')
    const linkPath = path.join(dir, 'link.txt')
    fs.symlinkSync(path.join(dir, 'SKILL.md'), linkPath)

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'symlink-not-hardlink',
      writeSet: ['link.txt'],
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    const link = outcome.files.find((f) => f.rel === 'link.txt')
    expect(link).toEqual({ rel: 'link.txt', sha256: null, entryType: 'symlink' })
    expect(link && 'hardLinked' in link).toBe(false)
  })

  it('an absent write-set member (not yet on disk) is sha256 null with no entryType, not an error', async () => {
    const dir = mkSkill('add-only')
    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'add-only',
      writeSet: ['new-file.txt'],
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.files.find((f) => f.rel === 'new-file.txt')).toEqual({
      rel: 'new-file.txt',
      sha256: null,
    })
  })

  it('refuses a write-set member that escapes dir via a `..` component', async () => {
    const dir = mkSkill('escaper')
    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'escaper',
      writeSet: ['../outside.txt'],
    })
    expect(outcome.kind).toBe('unreadable')
    if (outcome.kind !== 'unreadable') throw new Error('unreachable')
    expect(outcome.error.errno).toBe('EINVAL')
  })

  it('gitAncestor is { kind: "none" } when no .git ancestor exists — the walk ran and found nothing, never a bare null', async () => {
    const dir = mkSkill('no-git')
    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'no-git',
      writeSet: [],
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.gitAncestor).toEqual({ kind: 'none' })
  })

  it('gitAncestor is populated when a real .git ancestor exists', async () => {
    const dir = mkSkill('has-git')
    fs.mkdirSync(path.join(root, '.git'))
    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'has-git',
      writeSet: [],
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.gitAncestor).toEqual({ kind: 'found', path: root })
  })
})

describe('defaultRecoveryPendingChecker — on A1 record scan (SMI-6531 step 5)', () => {
  const ask = (dir: string): ReturnType<typeof defaultRecoveryPendingChecker> =>
    defaultRecoveryPendingChecker({ skillsDir: root, dir, dirName: path.basename(dir) })

  it('returns false when .skillsmith-staging/ is absent', async () => {
    expect(await ask(path.join(root, 'x'))).toBe(false)
  })

  it('true for a present folder named by a verified record: by realDir and by comparedPath', async () => {
    const byReal = mkSkill('by-real')
    const byCompared = mkSkill('by-compared')
    putRecord('1'.repeat(32), byReal, path.join(root, 'elsewhere-a'))
    putRecord('2'.repeat(32), path.join(root, 'elsewhere-b'), byCompared)
    expect(await ask(byReal)).toBe(true)
    expect(await ask(byCompared)).toBe(true)
  })

  it('true for a MISSING folder named by a verified record: by realDir and by comparedPath', async () => {
    const byReal = path.join(root, 'gone-by-real')
    const byCompared = path.join(root, 'gone-by-compared')
    putRecord('1'.repeat(32), byReal, path.join(root, 'elsewhere-a'))
    putRecord('2'.repeat(32), path.join(root, 'elsewhere-b'), byCompared)
    expect(fs.existsSync(byReal) || fs.existsSync(byCompared)).toBe(false)
    expect(await ask(byReal)).toBe(true)
    expect(await ask(byCompared)).toBe(true)
  })

  it("true for a symlinked folder whose TARGET a record names (the record's realDir)", async () => {
    const target = mkSkill('link-target')
    const link = path.join(root, 'linked-skill')
    fs.symlinkSync(target, link, 'dir')
    putRecord('1'.repeat(32), target, path.join(root, 'elsewhere'))
    expect(await ask(link)).toBe(true)
  })

  it('false for a record naming another folder, and for a prefix-sharing name; true for the exact name', async () => {
    const skill = mkSkill('skill')
    putRecord('1'.repeat(32), path.join(root, 'skill2'))
    putRecord('2'.repeat(32), path.join(root, 'skil'))
    expect(await ask(skill)).toBe(false)
    // Control: the same staging does name skill2.
    expect(await ask(path.join(root, 'skill2'))).toBe(true)
  })

  it('false for an unrelated record, and never throws on a corrupt one beside it', async () => {
    putRecord('1'.repeat(32), path.join(root, 'other'))
    const corruptOp = path.join(root, '.skillsmith-staging', 'op-3')
    fs.mkdirSync(corruptOp, { recursive: true })
    fs.writeFileSync(path.join(corruptOp, 'record.json'), '{not json')
    expect(await ask(path.join(root, 'reappearing'))).toBe(false)
    // Control: the scan did read the staging, it is the named folder that decides.
    expect(await ask(path.join(root, 'other'))).toBe(true)
  })

  it('a record that does not verify names nothing: a hand-written { target: dir } is not a record', async () => {
    const dir = path.join(root, 'fake-named')
    const opDir = path.join(root, '.skillsmith-staging', 'op-1')
    fs.mkdirSync(opDir, { recursive: true })
    fs.writeFileSync(path.join(opDir, 'record.json'), JSON.stringify({ target: dir }))
    expect(await ask(dir)).toBe(false)
  })

  it('skips every dot-named staging entry (the rule is the dot prefix: .kept, .trash, .quarantine, .parked) even holding a verified record', async () => {
    const dir = path.join(root, 'reappearing')
    for (const reserved of ['.kept', '.trash', '.quarantine', '.parked']) {
      putRecord(reserved, dir)
    }
    expect(await ask(dir)).toBe(false)
    // Control: the same record under a plain op name does name it.
    putRecord('3'.repeat(32), dir)
    expect(await ask(dir)).toBe(true)
  })

  it('resolves { error } naming the staging path and errno when the staging cannot be listed', async () => {
    breakStaging()
    expect(await ask(path.join(root, 'x'))).toEqual({
      error: { path: path.join(root, '.skillsmith-staging'), errno: 'ENOTDIR' },
    })
  })
})

describe('unreadableStagingRecords (row 0b)', () => {
  it('{ ok: true, opIds: [] } with no staging at all', async () => {
    expect(await unreadableStagingRecords(root)).toEqual({ ok: true, opIds: [] })
  })

  it('{ ok: true, opIds: [] } with only verified records', async () => {
    putRecord('1'.repeat(32), path.join(root, 'a'))
    putRecord('2'.repeat(32), path.join(root, 'b'))
    expect(await unreadableStagingRecords(root)).toEqual({ ok: true, opIds: [] })
  })

  it('names the unreadable record beside verified ones', async () => {
    putRecord('1'.repeat(32), path.join(root, 'a'))
    expect(await unreadableStagingRecords(root)).toEqual({ ok: true, opIds: [] })
    const badOp = '9'.repeat(32)
    fs.mkdirSync(path.join(root, '.skillsmith-staging', badOp))
    fs.writeFileSync(path.join(root, '.skillsmith-staging', badOp, 'record.json'), '{not json')
    putRecord('2'.repeat(32), path.join(root, 'b'))
    expect(await unreadableStagingRecords(root)).toEqual({ ok: true, opIds: [badOp] })
  })

  it('{ ok: false } with the errno when the staging cannot be listed', async () => {
    breakStaging()
    const r = await unreadableStagingRecords(root)
    expect(r).toMatchObject({ ok: false, error: { errno: 'ENOTDIR' } })
  })

  it('{ ok: true, opIds: [] } when the skills root does not exist', async () => {
    expect(await unreadableStagingRecords(path.join(root, 'no-such-root'))).toEqual({
      ok: true,
      opIds: [],
    })
  })

  it('{ ok: false } when the root cannot be resolved for another reason (a symlink loop)', async () => {
    const a = path.join(root, 'loop-a')
    const b = path.join(root, 'loop-b')
    fs.symlinkSync(b, a)
    fs.symlinkSync(a, b)
    expect(await unreadableStagingRecords(a)).toMatchObject({
      ok: false,
      error: { errno: 'ELOOP' },
    })
  })
})

describe('defaultRecoveryPendingChecker: errors name the path that failed', () => {
  it('an unresolvable skills root resolves { error: { path: skillsDir } }', async () => {
    const a = path.join(root, 'root-loop-a')
    const b = path.join(root, 'root-loop-b')
    fs.symlinkSync(b, a)
    fs.symlinkSync(a, b)
    expect(
      await defaultRecoveryPendingChecker({ skillsDir: a, dir: path.join(a, 'x'), dirName: 'x' })
    ).toEqual({ error: { path: a, errno: 'ELOOP' } })
  })

  it('a realpath(dir) error other than ENOENT/ENOTDIR (ELOOP) resolves { error: { path: dir } }, not false', async () => {
    // The probe's presence check also fails on a symlink loop; it is the
    // checker's own answer that is pinned here, and the probe's outcome below.
    const a = path.join(root, 'dir-loop-a')
    const b = path.join(root, 'dir-loop-b')
    fs.symlinkSync(b, a)
    fs.symlinkSync(a, b)
    putRecord('1'.repeat(32), path.join(root, 'other'))
    expect(
      await defaultRecoveryPendingChecker({ skillsDir: root, dir: a, dirName: 'dir-loop-a' })
    ).toEqual({ error: { path: a, errno: 'ELOOP' } })
    const outcome = await probeUpdateTarget({
      dir: a,
      skillsDir: root,
      dirName: 'dir-loop-a',
      writeSet: [],
      sleep: async () => {},
    })
    expect(outcome.kind).toBe('probe-failed')
  })

  it('a ENOTDIR under dir (a file where a parent should be) is still matched by path, not an error', async () => {
    fs.writeFileSync(path.join(root, 'a-file'), 'x')
    const dir = path.join(root, 'a-file', 'child')
    putRecord('1'.repeat(32), dir)
    expect(await defaultRecoveryPendingChecker({ skillsDir: root, dir, dirName: 'child' })).toBe(
      true
    )
  })
})

describe('probeUpdateTarget — a presence error is still checked against the records', () => {
  it('EACCES on the folder, named by a verified record: recovery-pending, and the checker was asked', async () => {
    const dir = mkSkill('eacces-named')
    putRecord('1'.repeat(32), dir)
    eaccesInjections.lstat.add(dir)
    const checkRecoveryPending = vi.fn(defaultRecoveryPendingChecker)

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'eacces-named',
      writeSet: [],
      checkRecoveryPending,
    })

    expect(checkRecoveryPending).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ kind: 'recovery-pending' })
  })

  it('paired control: the same EACCES with no record is probe-failed with that error, the checker still asked', async () => {
    const dir = mkSkill('eacces-unnamed')
    putRecord('1'.repeat(32), path.join(root, 'some-other-skill'))
    eaccesInjections.lstat.add(dir)
    const checkRecoveryPending = vi.fn(defaultRecoveryPendingChecker)

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'eacces-unnamed',
      writeSet: [],
      checkRecoveryPending,
    })

    expect(checkRecoveryPending).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ kind: 'probe-failed', error: { path: dir, errno: 'EACCES' } })
  })

  it('a presence error wins over a checker { error }: the folder own failure is reported', async () => {
    const dir = mkSkill('eacces-and-broken-staging')
    eaccesInjections.lstat.add(dir)
    breakStaging()

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'eacces-and-broken-staging',
      writeSet: [],
    })

    expect(outcome).toEqual({ kind: 'probe-failed', error: { path: dir, errno: 'EACCES' } })
  })

  it('a presence error wins over a checker that rejects, too', async () => {
    const dir = mkSkill('eacces-and-throwing-checker')
    eaccesInjections.lstat.add(dir)
    const checkRecoveryPending = vi.fn(async () => {
      throw Object.assign(new Error('checker broke'), { code: 'EIO' })
    })

    const outcome = await probeUpdateTarget({
      dir,
      skillsDir: root,
      dirName: 'eacces-and-throwing-checker',
      writeSet: [],
      checkRecoveryPending,
    })

    expect(checkRecoveryPending).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ kind: 'probe-failed', error: { path: dir, errno: 'EACCES' } })
  })
})

describe('the record check names paths under the skills root as given (PR #3164 retro)', () => {
  it('a symlinked skillsDir: a staging failure is reported under the link, never its target', async () => {
    const target = path.join(root, 'real-target-dir')
    const link = path.join(root, 'skills-link')
    fs.mkdirSync(target)
    fs.symlinkSync(target, link)
    fs.writeFileSync(path.join(target, '.skillsmith-staging'), 'not a directory')
    const dir = path.join(link, 'some-skill')
    const want = { path: path.join(link, '.skillsmith-staging'), errno: 'ENOTDIR' }

    expect(
      await defaultRecoveryPendingChecker({ skillsDir: link, dir, dirName: 'some-skill' })
    ).toEqual({ error: want })
    expect(await unreadableStagingRecords(link)).toEqual({ ok: false, error: want })
    // Paired: the same failure through the target itself names the target.
    expect(await unreadableStagingRecords(target)).toEqual({
      ok: false,
      error: { path: path.join(target, '.skillsmith-staging'), errno: 'ENOTDIR' },
    })
  })

  it('a symlinked skillsDir: an entry the scan cannot lstat is named under the link, staging folder included', async () => {
    const target = path.join(root, 'real-target-dir')
    const link = path.join(root, 'skills-link')
    fs.mkdirSync(path.join(target, '.skillsmith-staging', 'op-entry'), { recursive: true })
    fs.symlinkSync(target, link)
    const entry = path.join(target, '.skillsmith-staging', 'op-entry')
    // The scan lstats through node:fs, which the module mock above does not cover.
    const orig = fs.promises.lstat.bind(fs.promises)
    let fired = 0
    const spy = vi.spyOn(fs.promises, 'lstat').mockImplementation((async (
      ...a: Parameters<typeof fs.promises.lstat>
    ) => {
      if (a[0] === entry) {
        fired++
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }
      return orig(...a)
    }) as typeof fs.promises.lstat)
    try {
      expect(await unreadableStagingRecords(link)).toEqual({
        ok: false,
        error: { path: path.join(link, '.skillsmith-staging', 'op-entry'), errno: 'EACCES' },
      })
      expect(fired).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})
