/**
 * @fileoverview checkInstallTarget() — one test per rule.
 * @see SMI-6529 Wave A0
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { checkInstallTarget } from '../../../src/services/skill-installation.target-guard.js'
import type { SkillManifestEntry } from '../../../src/services/skill-installation.types.js'

const roots: string[] = []

async function makeRoot(label: string): Promise<{ root: string; skillsDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'target-guard-' + label + '-'))
  roots.push(root)
  const skillsDir = path.join(root, 'skills')
  await fs.mkdir(skillsDir, { recursive: true })
  return { root, skillsDir }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })))
})

function baseEntry(installPath: string): SkillManifestEntry {
  return {
    id: 'author/skill',
    name: 'skill',
    version: '1.0.0',
    source: 'github:author/skill',
    installPath,
    installedAt: '2026-01-01T00:00:00.000Z',
    lastUpdated: '2026-01-01T00:00:00.000Z',
  }
}

describe('checkInstallTarget (SMI-6529 Wave A0)', () => {
  it('fresh ENOENT: ok, preExisted false', async () => {
    const { skillsDir } = await makeRoot('fresh')
    const installPath = path.join(skillsDir, 'my-skill')

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: undefined,
      force: false,
    })

    expect(result).toEqual({ ok: true, preExisted: false })
  })

  it('rule (a): expectedInstallPath mismatch refuses even on a fresh ENOENT path', async () => {
    const { skillsDir } = await makeRoot('mismatch')
    const installPath = path.join(skillsDir, 'my-skill')
    const expectedInstallPath = path.join(skillsDir, 'other-dir')

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: undefined,
      force: true, // force does NOT override this
      expectedInstallPath,
    })

    expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_MISMATCH' })
  })

  // F6 (review round 1): both sides of rule (a) must resolve through the
  // identical symmetric helper, so a symlinked path spelling (macOS
  // /var -> /private/var) doesn't produce a false mismatch.
  it('rule (a) / F6: a symlinked parent spelling of expectedInstallPath does NOT false-positive as a mismatch', async () => {
    const { root, skillsDir } = await makeRoot('mismatch-symlink')
    const installPath = path.join(skillsDir, 'my-skill')
    await fs.mkdir(installPath, { recursive: true })
    // A symlinked ALIAS of skillsDir itself (mirrors macOS's real
    // /var/folders -> /private/var/folders) — expectedInstallPath is spelled
    // through the alias, installPath through the real path. Same real
    // directory, two different lexical strings.
    const skillsDirAlias = path.join(root, 'skills-alias')
    await fs.symlink(skillsDir, skillsDirAlias, 'dir')
    const expectedInstallPath = path.join(skillsDirAlias, 'my-skill')

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: baseEntry(installPath),
      force: true,
      expectedInstallPath,
    })

    expect(result).not.toMatchObject({ code: 'INSTALL_TARGET_MISMATCH' })
    expect(result).toEqual({ ok: true, preExisted: true })
  })

  it('rule (c): install target exists but is not a directory', async () => {
    const { skillsDir } = await makeRoot('not-dir')
    const installPath = path.join(skillsDir, 'my-skill')
    await fs.writeFile(installPath, 'not a directory')

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: undefined,
      force: true,
    })

    expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_NOT_DIRECTORY' })
  })

  it('rule (d): a .git entry directly at the install target refuses, even under force', async () => {
    const { skillsDir } = await makeRoot('git-target')
    const installPath = path.join(skillsDir, 'my-skill')
    await fs.mkdir(path.join(installPath, '.git'), { recursive: true })

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: baseEntry(installPath),
      force: true,
    })

    expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_GIT_WORKTREE' })
  })

  it('rule (d): a .git entry in an ancestor STRICTLY BETWEEN installPath and skillsDir refuses', async () => {
    const { skillsDir } = await makeRoot('git-parent')
    // installPath is nested TWO levels below skillsDir; .git sits at the
    // intermediate level (neither installPath itself nor skillsDir itself),
    // proving the walk visits every level in between, not just the endpoints.
    const midDir = path.join(skillsDir, 'mid')
    const installPath = path.join(midDir, 'leaf')
    await fs.mkdir(installPath, { recursive: true })
    await fs.mkdir(path.join(midDir, '.git'), { recursive: true })

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: baseEntry(installPath),
      force: true,
    })

    expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_GIT_WORKTREE' })
  })

  it('rule (d): a .git FILE (worktree pointer) also counts, not just a directory', async () => {
    const { skillsDir } = await makeRoot('git-file')
    const installPath = path.join(skillsDir, 'my-skill')
    await fs.mkdir(installPath, { recursive: true })
    await fs.writeFile(path.join(installPath, '.git'), 'gitdir: ../.git/worktrees/my-skill\n')

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: baseEntry(installPath),
      force: true,
    })

    expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_GIT_WORKTREE' })
  })

  it("rule (d) does not fire above skillsDir: a .git at skillsDir's PARENT is out of scope", async () => {
    const { root, skillsDir } = await makeRoot('git-above')
    await fs.mkdir(path.join(root, '.git'), { recursive: true }) // one level ABOVE skillsDir
    const installPath = path.join(skillsDir, 'my-skill')
    await fs.mkdir(installPath, { recursive: true })

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: baseEntry(installPath),
      force: true,
    })

    // Falls through to the untracked/tracked rules instead — proves the walk
    // never climbed past skillsDir.
    expect(result).not.toMatchObject({ code: 'INSTALL_TARGET_GIT_WORKTREE' })
  })

  it('rule (e): an untracked pre-existing directory with NO manifest entry refuses, even under force', async () => {
    const { skillsDir } = await makeRoot('untracked-none')
    const installPath = path.join(skillsDir, 'my-skill')
    await fs.mkdir(installPath, { recursive: true })

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: undefined,
      force: true,
    })

    expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_UNTRACKED' })
  })

  it('rule (e): a manifest entry pointing at a DIFFERENT (e.g. leaked/stale) directory refuses', async () => {
    const { skillsDir } = await makeRoot('untracked-elsewhere')
    const installPath = path.join(skillsDir, 'my-skill')
    await fs.mkdir(installPath, { recursive: true })
    // A stale entry pointing at a temp dir that no longer exists — the exact
    // "leaked temp install dir" shape a stray/orphaned manifest write can
    // leave behind. realpath() falls back to path.resolve() for this.
    const staleInstallPath = path.join(os.tmpdir(), 'never-existed-' + Date.now())

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: baseEntry(staleInstallPath),
      force: true,
    })

    expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_UNTRACKED' })
  })

  it('rule (e): a manifestEntry.installPath reached via a symlink is still recognized as the SAME tracked path (realpath aliasing)', async () => {
    const { root, skillsDir } = await makeRoot('symlink-alias')
    const installPath = path.join(skillsDir, 'my-skill')
    await fs.mkdir(installPath, { recursive: true })
    // Mirrors macOS's real /var/folders -> /private/var/folders symlink: the
    // manifest entry's recorded path and the live installPath can be two
    // different (but realpath-equivalent) strings for the SAME directory.
    const symlinkAlias = path.join(root, 'alias-to-install')
    await fs.symlink(installPath, symlinkAlias, 'dir')

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: baseEntry(symlinkAlias),
      force: true,
    })

    expect(result).toEqual({ ok: true, preExisted: true })
  })

  // F5 (review round 1) / ADR-155 §3+§5: a path-matching entry that is ITSELF
  // untracked by Skillsmith's own trust model (an ADR-139 adoption, or a
  // user's local assertion) must still refuse — `force` never overrides
  // this. Without this, `skillsmith install <id> --force` over an adopted or
  // local directory would silently overwrite the user's own skill.
  it("F5: a path-matching entry with source:'unknown' (ADR-139 adoption) refuses even under force", async () => {
    const { skillsDir } = await makeRoot('adopted-untracked')
    const installPath = path.join(skillsDir, 'my-skill')
    await fs.mkdir(installPath, { recursive: true })

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: { ...baseEntry(installPath), source: 'unknown' },
      force: true,
    })

    expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_UNTRACKED' })
  })

  it("F5: a path-matching entry with provenance:'local' refuses even under force", async () => {
    const { skillsDir } = await makeRoot('local-untracked')
    const installPath = path.join(skillsDir, 'my-skill')
    await fs.mkdir(installPath, { recursive: true })

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: { ...baseEntry(installPath), provenance: 'local' },
      force: true,
    })

    expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_UNTRACKED' })
  })

  it('rule (f): tracked + no force -> ALREADY_INSTALLED', async () => {
    const { skillsDir } = await makeRoot('tracked-noforce')
    const installPath = path.join(skillsDir, 'my-skill')
    await fs.mkdir(installPath, { recursive: true })

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: baseEntry(installPath),
      force: false,
    })

    expect(result).toMatchObject({ ok: false, code: 'ALREADY_INSTALLED' })
  })

  it('rule (f): tracked + force -> ok, preExisted true', async () => {
    const { skillsDir } = await makeRoot('tracked-force')
    const installPath = path.join(skillsDir, 'my-skill')
    await fs.mkdir(installPath, { recursive: true })

    const result = await checkInstallTarget({
      installPath,
      skillsDir,
      manifestEntry: baseEntry(installPath),
      force: true,
    })

    expect(result).toEqual({ ok: true, preExisted: true })
  })

  // SMI-6529 H1 (round 2, reviewer probe-guard.mjs P1 — "THE exact H1 exploit"):
  // installPath is a symlink into a SUBDIRECTORY of a git clone that itself
  // lives inside skillsDir. The LEXICAL ancestor walk never crosses the
  // symlink boundary (path.dirname on the symlink's own string jumps
  // straight to skillsDir); only a REALPATH walk finds the clone's `.git`.
  describe('H1: symlink-to-git-clone bypass (round 2)', () => {
    it('P1: symlink -> subdirectory of an in-skillsDir git clone refuses, even under force', async () => {
      const { skillsDir } = await makeRoot('h1-p1')
      const clone = path.join(skillsDir, 'anthropic-skills')
      await fs.mkdir(path.join(clone, '.git'), { recursive: true })
      const target = path.join(clone, 'document-skills', 'pdf')
      await fs.mkdir(target, { recursive: true })
      await fs.writeFile(path.join(target, 'SKILL.md'), 'UNCOMMITTED USER WORK')
      const installPath = path.join(skillsDir, 'pdf')
      await fs.symlink(target, installPath, 'dir')

      const result = await checkInstallTarget({
        installPath,
        skillsDir,
        manifestEntry: baseEntry(installPath),
        force: true,
      })

      expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_GIT_WORKTREE' })
    })

    it('P2: symlink -> the git clone ROOT itself (not a subdirectory) refuses', async () => {
      const { skillsDir } = await makeRoot('h1-p2')
      const clone = path.join(skillsDir, 'some-clone')
      await fs.mkdir(path.join(clone, '.git'), { recursive: true })
      const installPath = path.join(skillsDir, 'aliased')
      await fs.symlink(clone, installPath, 'dir')

      const result = await checkInstallTarget({
        installPath,
        skillsDir,
        manifestEntry: baseEntry(installPath),
        force: true,
      })

      expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_GIT_WORKTREE' })
    })

    it('P4: skillsDir itself is a git repo refuses', async () => {
      const { skillsDir } = await makeRoot('h1-p4')
      await fs.mkdir(path.join(skillsDir, '.git'), { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })

      const result = await checkInstallTarget({
        installPath,
        skillsDir,
        manifestEntry: baseEntry(installPath),
        force: true,
      })

      expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_GIT_WORKTREE' })
    })

    it('P5: a symlinked skillsDir whose real ancestry has .git ABOVE its own real target does NOT refuse', async () => {
      const { root } = await makeRoot('h1-p5')
      // A "dotfiles repo" with .git at its root; skillsDir is a symlink
      // pointing at a SUBDIRECTORY of it (never itself carrying .git) — the
      // walk must stop at skillsDir's own real location, never climb past it.
      const dotfilesRepo = path.join(root, 'dotfiles')
      await fs.mkdir(path.join(dotfilesRepo, '.git'), { recursive: true })
      const realSkillsDir = path.join(dotfilesRepo, 'generated', 'skills')
      await fs.mkdir(realSkillsDir, { recursive: true })
      const skillsDirAlias = path.join(root, 'skills-symlink')
      await fs.symlink(realSkillsDir, skillsDirAlias, 'dir')
      const installPath = path.join(skillsDirAlias, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })

      const result = await checkInstallTarget({
        installPath,
        skillsDir: skillsDirAlias,
        manifestEntry: baseEntry(installPath),
        force: true,
      })

      expect(result).not.toMatchObject({ code: 'INSTALL_TARGET_GIT_WORKTREE' })
      expect(result).toEqual({ ok: true, preExisted: true })
    })
  })

  // SMI-6529 L13: the GIT_WORKTREE tip/message names the actual git root and
  // is worded differently depending on whether it's installPath itself.
  describe('L13: tailored git-worktree message', () => {
    it('names installPath itself when .git is directly there', async () => {
      const { skillsDir } = await makeRoot('l13-direct')
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(path.join(installPath, '.git'), { recursive: true })

      const result = await checkInstallTarget({
        installPath,
        skillsDir,
        manifestEntry: baseEntry(installPath),
        force: true,
      })

      expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_GIT_WORKTREE' })
      if (!result.ok) {
        expect(result.error).toContain(installPath)
        expect(result.error).not.toContain('rooted at')
        expect(result.tips?.[0]).toContain('git -C "' + installPath + '"')
      }
    })

    it('names the ancestor git root when .git is above installPath', async () => {
      const { skillsDir } = await makeRoot('l13-ancestor')
      const midDir = path.join(skillsDir, 'mid')
      const installPath = path.join(midDir, 'leaf')
      await fs.mkdir(installPath, { recursive: true })
      await fs.mkdir(path.join(midDir, '.git'), { recursive: true })

      const result = await checkInstallTarget({
        installPath,
        skillsDir,
        manifestEntry: baseEntry(installPath),
        force: true,
      })

      expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_GIT_WORKTREE' })
      if (!result.ok) {
        expect(result.error).toContain('rooted at')
        expect(result.error).toContain(midDir)
        expect(result.tips?.[0]).toContain('git -C "' + midDir + '"')
      }
    })
  })

  // SMI-6529 L16: an lstat error the guard can't interpret as "definitely
  // absent" must fail CLOSED (treated as a git-worktree hit), never silently
  // as "no .git here."
  describe('L16: pathHasGitEntry fails closed on an unexpected lstat error', () => {
    it('EACCES on the .git lstat refuses as INSTALL_TARGET_GIT_WORKTREE', async () => {
      const { skillsDir } = await makeRoot('l16-eacces')
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })
      const gitPath = path.join(installPath, '.git')

      vi.doMock('fs/promises', async () => {
        const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
        return {
          ...actual,
          default: actual,
          lstat: vi.fn((p: string, ...rest: unknown[]) => {
            if (p === gitPath) {
              const err = new Error('EACCES: permission denied, lstat') as NodeJS.ErrnoException
              err.code = 'EACCES'
              return Promise.reject(err)
            }
            return (actual.lstat as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
          }),
        }
      })
      try {
        vi.resetModules()
        const { checkInstallTarget: checkInstallTargetMocked } =
          await import('../../../src/services/skill-installation.target-guard.js')
        const result = await checkInstallTargetMocked({
          installPath,
          skillsDir,
          manifestEntry: baseEntry(installPath),
          force: true,
        })
        expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_GIT_WORKTREE' })
      } finally {
        vi.doUnmock('fs/promises')
        vi.resetModules()
      }
    })

    // SMI-6529 #16 (round 4): the refusal CODE from the test above is
    // correct and unchanged — L16's fail-closed behavior is not in
    // question. What was wrong is the MESSAGE: a plain boolean collapsed
    // "found a .git entry" and "couldn't tell" into the same `true`, so an
    // EACCES was reported to the user as "is a git working tree," which is
    // simply false — we never actually saw a `.git` entry, we just
    // couldn't check for one. This test asserts the message now names the
    // real reason (the exact errno) instead of the false claim.
    it('EACCES on the .git lstat produces an ACCURATE message ("could not check ... EACCES"), never the false "is a git working tree" claim', async () => {
      const { skillsDir } = await makeRoot('smi16-eacces-message')
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })
      const gitPath = path.join(installPath, '.git')

      vi.doMock('fs/promises', async () => {
        const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
        return {
          ...actual,
          default: actual,
          lstat: vi.fn((p: string, ...rest: unknown[]) => {
            if (p === gitPath) {
              const err = new Error('EACCES: permission denied, lstat') as NodeJS.ErrnoException
              err.code = 'EACCES'
              return Promise.reject(err)
            }
            return (actual.lstat as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
          }),
        }
      })
      try {
        vi.resetModules()
        const { checkInstallTarget: checkInstallTargetMocked } =
          await import('../../../src/services/skill-installation.target-guard.js')
        const result = await checkInstallTargetMocked({
          installPath,
          skillsDir,
          manifestEntry: baseEntry(installPath),
          force: true,
        })
        expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_GIT_WORKTREE' })
        if (!result.ok) {
          expect(result.error).toContain('Could not check')
          expect(result.error).toContain('EACCES')
          expect(result.error).not.toMatch(/is a git working tree/)
          expect(result.error).not.toMatch(/lives inside a git working tree/)
        }
      } finally {
        vi.doUnmock('fs/promises')
        vi.resetModules()
      }
    })
  })

  // SMI-6529 N5 (round 4, reviewer probe-preflight.mjs): a CALLER could hand
  // `checkInstallTarget` an `installPath` that isn't actually inside
  // `skillsDir` at all (e.g. a pre-flight that computed `installPath` from
  // a different client's manifest entry than the `skillsDir` it passed).
  // Without this containment check, rule (d)'s ancestor walk never meets
  // `skillsDir` and silently climbs all the way to the filesystem root —
  // exactly the `~/.claude` (a real git repo) false-refusal probe-preflight
  // .mjs demonstrated.
  describe('N5: containment check — installPath must be inside skillsDir', () => {
    it('refuses when installPath is neither lexically nor (via realpath) really inside skillsDir', async () => {
      const { root, skillsDir } = await makeRoot('n5-outside')
      // A sibling directory, NOT nested under skillsDir at all.
      const outsideDir = path.join(root, 'totally-unrelated')
      await fs.mkdir(outsideDir, { recursive: true })

      const result = await checkInstallTarget({
        installPath: outsideDir,
        skillsDir,
        manifestEntry: undefined,
        force: true,
      })

      expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_MISMATCH' })
      if (!result.ok) {
        expect(result.error).toContain('not inside skills directory')
      }
    })

    it('still passes for a legitimate symlinked installPath whose REALPATH resolves inside skillsDir, even though its lexical spelling does not', async () => {
      const { root, skillsDir } = await makeRoot('n5-symlink-inside')
      const realTarget = path.join(skillsDir, 'my-skill')
      await fs.mkdir(realTarget, { recursive: true })
      // A symlink OUTSIDE skillsDir's own lexical tree that resolves INSIDE
      // it — e.g. a fan-out symlink at an unrelated client path.
      const symlinkedInstallPath = path.join(root, 'elsewhere-link')
      await fs.symlink(realTarget, symlinkedInstallPath, 'dir')

      const result = await checkInstallTarget({
        installPath: symlinkedInstallPath,
        skillsDir,
        manifestEntry: baseEntry(realTarget),
        force: false,
      })

      // Must reach the normal tracked/already-installed rules, never the
      // new containment refusal.
      if (!result.ok) {
        expect(result.error).not.toContain('not inside skills directory')
      }
    })
  })

  // SMI-6529 L17: a manifest entry with a missing/non-absolute installPath
  // refuses with a clear, structured error — never a raw TypeError.
  describe('L17: unusable manifest-entry installPath', () => {
    it('refuses when the matching manifest entry has no installPath', async () => {
      const { skillsDir } = await makeRoot('l17-missing')
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })
      const entry = { ...baseEntry(installPath) } as Partial<SkillManifestEntry>
      delete entry.installPath

      await expect(
        checkInstallTarget({
          installPath,
          skillsDir,
          manifestEntry: entry as SkillManifestEntry,
          force: true,
        })
      ).resolves.toMatchObject({ ok: false, code: 'INSTALL_TARGET_UNTRACKED' })
    })

    it('refuses when the matching manifest entry has a RELATIVE installPath', async () => {
      const { skillsDir } = await makeRoot('l17-relative')
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })

      const result = await checkInstallTarget({
        installPath,
        skillsDir,
        manifestEntry: { ...baseEntry(installPath), installPath: './my-skill' },
        force: true,
      })

      expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_UNTRACKED' })
    })
  })

  // SMI-6529 M5 (reviewer probe-expected-enoent.mjs): `update` sets
  // `expectedInstallPath` to a path that no longer exists on disk — must
  // refuse rather than silently create a brand-new directory there.
  describe('M5: expectedInstallPath no longer exists on disk', () => {
    it('refuses INSTALL_TARGET_MISMATCH when expectedInstallPath is gone', async () => {
      const { skillsDir } = await makeRoot('m5-gone')
      const installPath = path.join(skillsDir, 'foo') // never created — ENOENT

      const result = await checkInstallTarget({
        installPath,
        skillsDir,
        manifestEntry: { ...baseEntry(installPath), source: 'github:a/foo' },
        force: true,
        expectedInstallPath: installPath,
      })

      expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_MISMATCH' })
      if (!result.ok) {
        expect(result.error).toContain('no longer exists')
      }
    })
  })

  // SMI-6529 M8 (reviewer probe-guard.mjs P8): a fresh (ENOENT) computed
  // install path must not silently reuse a manifest key whose recorded entry
  // points at a DIFFERENT, still-live directory.
  describe('M8: stale-vs-live manifest entry on a fresh (ENOENT) install path', () => {
    it('refuses when the manifest entry points elsewhere and that path still exists', async () => {
      const { skillsDir } = await makeRoot('m8-live-elsewhere')
      const installPath = path.join(skillsDir, 'foo') // ENOENT — fresh computed path
      const elsewhere = path.join(skillsDir, 'foo-elsewhere')
      await fs.mkdir(elsewhere, { recursive: true }) // the OTHER path still exists

      const result = await checkInstallTarget({
        installPath,
        skillsDir,
        manifestEntry: baseEntry(elsewhere),
        force: false,
      })

      expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_MISMATCH' })
    })

    it('refuses when the manifest entry is marked local, even if its recorded path is gone', async () => {
      const { skillsDir } = await makeRoot('m8-local-gone')
      const installPath = path.join(skillsDir, 'foo') // ENOENT
      const goneElsewhere = path.join(skillsDir, 'foo-gone') // never created

      const result = await checkInstallTarget({
        installPath,
        skillsDir,
        manifestEntry: { ...baseEntry(goneElsewhere), provenance: 'local' },
        force: true,
      })

      expect(result).toMatchObject({ ok: false, code: 'INSTALL_TARGET_UNTRACKED' })
    })

    it('proceeds as a fresh install when the manifest entry is genuinely stale (recorded path also gone, not local)', async () => {
      const { skillsDir } = await makeRoot('m8-stale')
      const installPath = path.join(skillsDir, 'foo') // ENOENT
      const goneElsewhere = path.join(skillsDir, 'foo-gone') // never created, not local

      const result = await checkInstallTarget({
        installPath,
        skillsDir,
        manifestEntry: baseEntry(goneElsewhere),
        force: false,
      })

      expect(result).toEqual({ ok: true, preExisted: false })
    })
  })
})
