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
 * 2. §4.2's `.skillsmith-staging/` `recovery-pending` check depends on a
 *    `record.json` schema A1 (`skill-write-lock.ts`, `skill-swap.ts`) has
 *    not landed yet in this tree — confirmed absent. `defaultRecoveryPendingChecker`
 *    is a placeholder, injectable and swappable, the same status as
 *    `temporaryManifestEvidenceResolver`.
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

import { probeUpdateTarget, defaultRecoveryPendingChecker } from './update-target.probe.js'
import { hasRecordedLocalEdit } from './skill-identity-classification.js'
import { hashContent } from './skill-installation.helpers.js'
import { hasGitAncestorBetween } from './skill-installation.target-guard.js'

// Wraps (never replaces) `hasGitAncestorBetween` so a test can assert it was
// NOT called -- the mechanism, not just the returned value -- for the
// realpath-escapes-skillsDir case (Finding 1). Every other test in this file
// gets the real walk, since the wrapper forwards to `actual` by default; the
// Node ESM module namespace object is not configurable, so a plain
// `vi.spyOn(targetGuard, 'hasGitAncestorBetween')` throws "Cannot redefine
// property" under this runtime (see `skill-manifest.test.ts`'s own note) --
// `vi.fn(actual.fn)` wrapping at mock-registration time is the pattern that
// works.
vi.mock('./skill-installation.target-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./skill-installation.target-guard.js')>()
  return { ...actual, hasGitAncestorBetween: vi.fn(actual.hasGitAncestorBetween) }
})

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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'))
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

    // `hasGitAncestorBetween`'s own GitWalkResult reports the DIRECTORY being
    // checked (`root`), not the joined `.git` path it lstat'd internally —
    // that directory is `root` here (the ancestor one level above `dir`).
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

  it("reaches hasGitAncestorBetween's realpath branch through a symlinked dir — a git clone visible only via the symlink target is detected", async () => {
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
  it('the shipped fan-out shape (relative symlink out of its own skillsDir) reports gitAncestor: undetermined and never calls hasGitAncestorBetween — a `.git` far outside skillsDir is never found', async () => {
    // Mirrors fan-out.ts:224-226's shipped install shape and the finding's
    // own repro: `~/.cursor/skills/<skill>` -> `../../.claude/skills/<skill>`,
    // a RELATIVE symlink whose realpath resolves OUTSIDE its own skillsDir.
    // A `.git` sits at the role $HOME plays in the finding — an ancestor far
    // above skillsDir that an UNBOUNDED walk (the bug) would wrongly reach
    // and report as `found`, since walkForGitEntry's stop condition
    // (`current === stopAtAbs`) is never met once the realpath has already
    // escaped `stopAtAbs`'s own subtree.
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

    vi.mocked(hasGitAncestorBetween).mockClear()

    const outcome = await probeUpdateTarget({
      dir: linkPath,
      skillsDir: cursorSkills,
      dirName: 'escaper',
      writeSet: [],
    })

    // THE MECHANISM: the walk that would (wrongly) find $HOME's `.git` never
    // ran at all — not "ran and correctly found nothing."
    expect(hasGitAncestorBetween).not.toHaveBeenCalled()

    // THE VALUE: `undetermined`, never a permissive `found`/`none`/`null`.
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.gitAncestor).toEqual({
      kind: 'undetermined',
      reason: 'realpath-escapes-skills-dir',
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

describe('defaultRecoveryPendingChecker — placeholder, see fileoverview', () => {
  it('returns false when .skillsmith-staging/ is absent', async () => {
    expect(
      await defaultRecoveryPendingChecker({
        skillsDir: root,
        dir: path.join(root, 'x'),
        dirName: 'x',
      })
    ).toBe(false)
  })

  it('returns true when an op dir record names the dirName', async () => {
    const stagingOp = path.join(root, '.skillsmith-staging', 'op-1')
    fs.mkdirSync(stagingOp, { recursive: true })
    fs.writeFileSync(
      path.join(stagingOp, 'record.json'),
      JSON.stringify({ dirName: 'reappearing', client: 'claude-code' })
    )
    expect(
      await defaultRecoveryPendingChecker({
        skillsDir: root,
        dir: path.join(root, 'reappearing'),
        dirName: 'reappearing',
      })
    ).toBe(true)
  })

  it('returns false for an unrelated record, and never throws on a corrupt one', async () => {
    const stagingOp = path.join(root, '.skillsmith-staging', 'op-2')
    fs.mkdirSync(stagingOp, { recursive: true })
    fs.writeFileSync(path.join(stagingOp, 'record.json'), JSON.stringify({ dirName: 'other' }))
    const corruptOp = path.join(root, '.skillsmith-staging', 'op-3')
    fs.mkdirSync(corruptOp, { recursive: true })
    fs.writeFileSync(path.join(corruptOp, 'record.json'), '{not json')

    expect(
      await defaultRecoveryPendingChecker({
        skillsDir: root,
        dir: path.join(root, 'reappearing'),
        dirName: 'reappearing',
      })
    ).toBe(false)
  })

  it('skips reserved staging subdirectories (.kept, .trash, .quarantine)', async () => {
    for (const reserved of ['.kept', '.trash', '.quarantine']) {
      const dir = path.join(root, '.skillsmith-staging', reserved)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ dirName: 'reappearing' }))
    }
    expect(
      await defaultRecoveryPendingChecker({
        skillsDir: root,
        dir: path.join(root, 'reappearing'),
        dirName: 'reappearing',
      })
    ).toBe(false)
  })
})
