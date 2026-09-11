/**
 * @fileoverview writeInstallFiles() — the disk-write + rollback core of skill install.
 * @module @skillsmith/core/services/skill-installation.io.write
 * @see SMI-6529 Wave A0 round 2: split out of skill-installation.io.ts to stay
 *   under the 500-line CI gate once the M4/M7/M10/L14/L15 fixes landed — pure
 *   move for everything that predates this split, no behavior change to it.
 *   Re-exported from skill-installation.io.ts so every existing
 *   `from './skill-installation.io.js'` import site is unaffected.
 * @see SMI-6529 round 4 (N1/N2/N8/N9/N11/N12): confirmation-review fixes —
 *   see each inline comment below for the specific finding it closes.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { safeWriteFile, safeCreateFile } from '../utils/safe-fs.js'
import {
  CANONICAL_CLIENT,
  getCompanionAgentTarget,
  resolveCompanionAgentPath,
  type ClientId,
} from '../install/paths.js'
import {
  classifyPreWrite,
  restoreSnapshots,
  InstallRestoreError,
  type FileSnapshot,
} from './skill-installation.io.rollback.js'
import { mkdirNoFollow } from './skill-installation.io.dirs.js'

/** What {@link writeInstallFiles} wrote, plus a `rollback` that undoes it. */
export interface WriteInstallResult {
  writtenFiles: string[]
  subagentPath?: string
  /**
   * SMI-6529 M10: true when a companion agent file was NOT written because
   * this was a FRESH install (`preExisted` false) and something already
   * occupied the companion-agent target path — a pre-existing file there
   * could belong to an unrelated skill/agent the user created by hand, so a
   * brand-new install must never silently overwrite it. A forced reinstall
   * of an already-tracked skill (`preExisted` true) still overwrites it, on
   * the theory that Skillsmith itself most likely generated it originally.
   */
  companionSkipped?: boolean
  /**
   * SMI-6529 M7: restores every file this call overwrote to its pre-install
   * bytes/mode and removes everything it created fresh — the SAME cleanup
   * `writeInstallFiles` runs on its own internal write failure, exposed so a
   * caller whose LATER step fails (e.g. the manifest update in
   * `finalizeSuccessfulInstall`) can undo a write that itself already
   * succeeded. Pass the causing error so a restore failure can be reported
   * alongside it via {@link InstallRestoreError}; on a clean restore this
   * resolves without throwing and the caller should rethrow its own error.
   */
  rollback: (causeError: unknown) => Promise<void>
}

/**
 * Write a skill's files into `installPath`, snapshotting every file it will
 * overwrite first. On failure it restores those files and removes only what
 * it created; a directory that existed before the call is never removed.
 * Callers run `checkInstallTarget` first.
 */
export async function writeInstallFiles(
  installPath: string,
  skillsDir: string,
  skillName: string,
  finalSkillContent: string,
  subSkillFiles: Array<{ filename: string; content: string }>,
  subagentContent: string | undefined,
  /**
   * SMI-5980 (Wave 3): the client this companion subagent (if any) is
   * generated for — resolves its output path via
   * `resolveCompanionAgentPath()` (install/paths.ts) instead of a hardcoded
   * `~/.claude/agents/` literal. Optional, defaulting to `CANONICAL_CLIENT`
   * (`claude-code`) so pre-existing callers/tests that never pass it keep
   * today's exact behavior unchanged.
   */
  client: ClientId = CANONICAL_CLIENT,
  /**
   * SMI-5982 code-review fix #1: explicit base dir for resolving a RELATIVE
   * `COMPANION_AGENT_TARGETS[client].dir` (Antigravity only — every other
   * client's `dir` is absolute already). Threaded through to
   * `resolveCompanionAgentPath()`'s own `baseDir` param as-is (no
   * `?? process.cwd()` fallback here) — `resolveCompanionAgentPath()` itself
   * now requires an explicit `baseDir` for every `directory-package`-mode
   * client (PR-review follow-up), so whether an omitted `companionBaseDir`
   * is acceptable is that function's call to make, not this one's.
   */
  companionBaseDir?: string
): Promise<WriteInstallResult> {
  const writtenFiles: string[] = []
  // SMI-6529: files this call OVERWROTE (snapshotted, restorable) vs. files it
  // CREATED FRESH (safe to unlink). A pre-existing file must never be deleted —
  // only ever restored to its original bytes/mode.
  const overwritten: FileSnapshot[] = []
  // SMI-6529 R5 (round 5): each fresh file carries the (dev, ino) it had when
  // this call created it, so rollback never unlinks a file another process
  // has since put at the same path.
  const createdFresh: Array<{ path: string; identity?: { dev: number; ino: number } }> = []
  // F4: nested sub-skill directories (e.g. "scripts/") THIS call created fresh —
  // removed on rollback, non-recursively, deepest first.
  const freshDirs = new Set<string>()
  let subagentPath: string | undefined
  let companionSkipped = false
  // SMI-6529 L15: whether the directory-package per-skill agent directory
  // (Antigravity's <agentsDir>/<skillName>/) already existed before this call
  // — only a directory THIS call created may ever be rmdir'd on rollback.
  let agentDirPreExisted = true
  // SMI-6529 M4/N1: per-target write queue — serializes every write racing
  // for the same on-disk target (see `writeTracked`'s own doc comment).
  const writeQueues = new Map<string, Promise<void>>()
  // SMI-5359 (retro): lexically reject an escaping installPath BEFORE any filesystem
  // mutation. path.resolve normalizes `..`, so an unsanitized skillName like '..'
  // (e.g. path.basename('foo/..')) or a compromised registry skillName cannot drive
  // installPath outside skillsDir and reach the rollback below. Thrown here, nothing
  // has been created, so no cleanup is needed.
  const resolvedInstall = path.resolve(installPath)
  const resolvedSkillsDir = path.resolve(skillsDir)
  if (
    resolvedInstall !== resolvedSkillsDir &&
    !resolvedInstall.startsWith(resolvedSkillsDir + path.sep)
  ) {
    throw new Error('Install path escapes skills directory (lexical): ' + installPath)
  }
  // Only set true once installPath is PROVEN inside skillsDir (both the lexical check
  // above and the realpath check below). The recursive rollback rm keys off this so it
  // can never force-delete an out-of-bounds path (e.g. a symlink-escape the realpath
  // check rejects after mkdir).
  let pathValidated = false
  // SMI-6529: determine BEFORE any mutation whether installPath already existed — a
  // rollback must NEVER remove a directory that existed before this call started
  // (the data-loss bug: a real user's git-cloned skill directory, `.git` included, got
  // force-deleted by a failed reinstall). `false` only on a genuine ENOENT; any other
  // lstat error is rethrown (fail closed, never guessed).
  let preExisted: boolean
  try {
    await fs.lstat(installPath)
    preExisted = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      preExisted = false
    } else {
      throw err
    }
  }

  /**
   * Classify-then-write a single tracked file. F1 (review round 1): the rollback
   * candidate MUST be recorded BEFORE `safeWriteFile` is ever called, never after
   * it "succeeds" — `safeWriteFile` opens with O_TRUNC and writes in place, which
   * is not atomic, so a write that fails mid-way (ENOSPC/EIO after truncation)
   * would otherwise leave a truncated original with no recorded snapshot to
   * restore it from.
   *
   * SMI-6529 M4 (round 2) / N1+N2 (round 4): every write is queued behind any
   * EARLIER write to the identical on-disk target — key =
   * `path.resolve(filePath).toLowerCase()`, so two DIFFERENT literal
   * filenames that normalize to the same path ("examples.md" vs
   * "./examples.md") AND a same-directory case-insensitive filesystem alias
   * ("SKILL.md" vs "skill.md" — literally the same inode on default APFS)
   * both serialize onto the SAME queue entry, closing the data race a naive
   * unserialized check has (measured live, not reasoned: the second write's
   * fast path could complete its own `safeWriteFile` BEFORE the first
   * write's own asynchronous `classifyPreWrite` had finished reading the
   * file).
   *
   * N1 (round 4): the EARLIER "only the first occurrence for a key
   * classifies" optimization was itself broken on a case-SENSITIVE
   * filesystem (Linux/CI): `README.md` and `readme.md` share the SAME
   * lowercased queue key there too, even though they are genuinely TWO
   * DIFFERENT files — the "skip classification" fast path silently
   * overwrote the second one with no snapshot at all, so a later rollback
   * lost it outright. Fixed by removing that optimization entirely — EVERY
   * queued write now classifies and snapshots its OWN target, unconditionally,
   * right before it writes. On a case-sensitive filesystem this correctly
   * snapshots two independent real files (classification always reads
   * `filePath` itself, never the lowercased key). On a case-insensitive
   * alias, the SECOND classification correctly observes the FIRST write's
   * already-applied bytes as "current" and snapshots THAT — `restoreSnapshots`'
   * REVERSE-order undo (its own doc comment) still converges the resulting
   * two-snapshot chain back to the TRUE original either way. N2 (round 4):
   * this also means a queued write whose PREDECESSOR failed (`previous`
   * rejects, swallowed by `.catch(() => {})` below so this write still gets
   * its turn) is unaffected — it classifies fresh, from whatever the real
   * on-disk state is at that moment, and is fully snapshotted/restorable
   * regardless of why the earlier write failed.
   */
  function writeTracked(filePath: string, content: string): Promise<void> {
    const key = path.resolve(filePath).toLowerCase()
    const previous = writeQueues.get(key) ?? Promise.resolve()
    const thisWrite = previous.catch(() => {}).then(() => performTrackedWrite(filePath, content))
    writeQueues.set(key, thisWrite)
    return thisWrite
  }

  async function performTrackedWrite(filePath: string, content: string): Promise<void> {
    const classification = await classifyPreWrite(filePath)
    if (classification.kind === 'regular') {
      overwritten.push(classification.snapshot)
      await safeWriteFile(filePath, content)
    } else if (classification.kind === 'absent') {
      // SMI-6529 L14(b): exclusive create. Atomic w.r.t. "did this call
      // create the file" — a race (something appears between this
      // classification and the write) aborts loudly via
      // `ExclusiveCreateRaceError` instead of silently overwriting whatever
      // just landed there.
      //
      // SMI-6529 N9 (round 4): `createdFresh` is now recorded via the
      // `onCreated` callback, which fires the INSTANT the exclusive `open()`
      // succeeds — BEFORE any content byte is written — not after
      // `safeCreateFile()` resolves. Previously, a write that failed AFTER
      // `open()` already created the (now 0-byte or partial) file never got
      // recorded at all, since the `createdFresh.push()` call sat after the
      // awaited call that just threw — leaving an orphan rollback never knew
      // to unlink.
      await safeCreateFile(filePath, content, undefined, (identity) =>
        createdFresh.push({ path: filePath, identity })
      )
    } else {
      // 'other' (symlink, directory, etc.) — record nothing. `safeWriteFile`
      // itself refuses to touch it before any byte is written, so there is
      // nothing to roll back and it must never be unlinked.
      await safeWriteFile(filePath, content)
    }
    writtenFiles.push(filePath)
  }

  /**
   * SMI-6529 M7: shared cleanup — restores every overwritten file and
   * removes everything created fresh. Runs from the internal catch block on
   * a write failure, AND is exposed as `rollback()` on the returned result
   * for a caller whose LATER step (after a successful write) fails.
   */
  async function performRollback(): Promise<string[]> {
    const restoreFailures = await restoreSnapshots(overwritten)
    for (const entry of createdFresh) {
      if (entry.identity) {
        // R5: skip a path that no longer names the file this call created.
        try {
          const current = await fs.lstat(entry.path)
          if (current.dev !== entry.identity.dev || current.ino !== entry.identity.ino) continue
        } catch {
          continue // already gone
        }
      }
      await fs.unlink(entry.path).catch(() => {})
    }
    // F4 (review round 1): remove nested sub-skill directories THIS call created
    // fresh (e.g. "scripts/") — files must be gone first (done above), and a
    // non-recursive rmdir requires children removed before parents, hence the
    // deepest-first ordering (sorted by path-separator count, not string length —
    // a short deep path must still sort before a long shallow one). Always a safe
    // no-op: ENOENT (already removed by a sibling's identical cleanup) or
    // non-empty (unexpected surviving content) are both swallowed.
    const deepestFirst = [...freshDirs].sort(
      (a, b) => b.split(path.sep).length - a.split(path.sep).length
    )
    for (const dir of deepestFirst) {
      await fs.rmdir(dir).catch(() => {})
    }
    // SMI-5982 (Wave 6) / SMI-6529 L15: 'directory-package' mode (Antigravity)
    // creates a skill-named subdirectory OUTSIDE installPath
    // (<agentsDir>/<skillName>/agent.md) that 'flat' mode never needed —
    // every other client's agents dir is a shared, pre-existing directory,
    // never created per-skill. Only rmdir it when THIS call created it
    // (`!agentDirPreExisted`) — a forced reinstall's per-skill directory that
    // pre-existed must never be removed just because this rollback ran; the
    // rmdir is non-recursive regardless (a safe no-op on non-empty content).
    if (
      subagentPath &&
      !agentDirPreExisted &&
      getCompanionAgentTarget(client).fileMode === 'directory-package'
    ) {
      await fs.rmdir(path.dirname(subagentPath)).catch(() => {})
    }
    // SMI-6529: NEVER remove installPath once it is known to have preExisted — the
    // caller (or a prior install) owned that directory before this call started.
    // Only a directory THIS call created may ever be removed, and only once it has
    // been PROVEN inside skillsDir (pathValidated) — so an untracked orphan from a
    // mid-batch Promise.all write can't survive. If mkdir or the realpath escape
    // guard threw, installPath was never validated; fall back to a non-recursive
    // rmdir, a safe no-op on a non-empty or out-of-bounds directory (NEVER a
    // recursive force-delete of an unvalidated path).
    if (!preExisted) {
      if (pathValidated) {
        await fs.rm(installPath, { recursive: true, force: true }).catch(() => {})
      } else {
        await fs.rmdir(installPath).catch(() => {})
      }
    }
    return restoreFailures
  }

  const rollback = async (causeError: unknown): Promise<void> => {
    const restoreFailures = await performRollback()
    if (restoreFailures.length > 0) {
      throw new InstallRestoreError(
        causeError instanceof Error ? causeError.message : String(causeError),
        restoreFailures,
        { cause: causeError }
      )
    }
  }

  try {
    if (preExisted) {
      // Already confirmed to exist (by the caller's own pre-write guard AND
      // this function's own lstat above) — nothing to create.
    } else {
      // SMI-6529 L14(a): create only the FINAL path segment non-recursively.
      // Any missing ANCESTOR (e.g. skillsDir itself, on a first run) is still
      // created recursively — but installPath itself must come into
      // existence via a single, non-racy mkdir: if it appears between the
      // `preExisted` check above and here (a TOCTOU race with a concurrent
      // install or an attacker), EEXIST aborts loudly instead of silently
      // proceeding to write into content that just appeared.
      await fs.mkdir(path.dirname(installPath), { recursive: true })
      try {
        await fs.mkdir(installPath)
      } catch (mkdirErr) {
        if ((mkdirErr as NodeJS.ErrnoException).code === 'EEXIST') {
          // SMI-6529 N8 (round 4): the directory that "appeared" belongs to
          // whoever won the race, NOT this call — `preExisted` (still false
          // at this point) would otherwise tell `performRollback()` this call
          // owns it and is safe to remove. Measured live: 299/300 raced
          // installs without this flip had rollback `rmdir` the WINNER's
          // freshly-created directory out from under it. Flip it to `true`
          // BEFORE throwing so rollback never touches a directory this call
          // did not create.
          preExisted = true
          throw new Error(
            'Install target "' + installPath + '" appeared during install (race) — aborting.'
          )
        }
        throw mkdirErr
      }
    }
    // SMI-4692: realpath both sides — macOS /var/folders symlinks to /private/var/folders.
    const realInstallPath = await fs.realpath(installPath)
    const expectedPrefix = await fs.realpath(skillsDir).catch(() => path.resolve(skillsDir))
    if (
      !realInstallPath.startsWith(expectedPrefix + path.sep) &&
      realInstallPath !== expectedPrefix
    ) {
      throw new Error('Install path escapes skills directory (realpath): ' + installPath)
    }
    pathValidated = true

    const mainSkillPath = path.join(installPath, 'SKILL.md')
    await writeTracked(mainSkillPath, finalSkillContent)
    // Write sub-skills in parallel. Sol final-code-review findings #2/#4: a nested filename
    // (e.g. "scripts/run.sh", used by private-registry content installs) needs its parent
    // directory created symlink-safely first — writeInstallFiles previously neither created it
    // (ENOENT on any clean install with a nested file) nor checked it for a pre-existing symlink.
    //
    // F3 (review round 1): Promise.all rejects on the FIRST failure while sibling
    // writes are still in flight — the catch block then rolls back while a slow
    // sibling can still land afterward, so its own snapshot/fresh-path is recorded
    // AFTER rollback ran and is never restored or removed. Promise.allSettled lets
    // every write finish (successfully or not) before rollback ever runs, then the
    // FIRST rejection's reason is what the caller sees.
    if (subSkillFiles.length > 0) {
      const results = await Promise.allSettled(
        subSkillFiles.map(async (subSkill) => {
          const subPath = path.join(installPath, subSkill.filename)
          // SMI-6529 N12 (round 4): containment check — a sub-skill filename
          // like "x/../../../escape.md" normalizes (via path.join, which
          // collapses ".." segments) to a path OUTSIDE installPath entirely.
          // `mkdirNoFollow()` below only guards against a pre-existing
          // SYMLINK at an intermediate segment; it does nothing to stop a
          // purely lexical escape via "..". Checked BEFORE any mkdir/write
          // for this entry, so a violation surfaces as this entry's own
          // Promise.allSettled rejection (triggering the same rollback path
          // as any other write failure) rather than ever touching disk.
          const resolvedSubPath = path.resolve(subPath)
          if (
            resolvedSubPath !== resolvedInstall &&
            !resolvedSubPath.startsWith(resolvedInstall + path.sep)
          ) {
            throw new Error('Sub-skill filename escapes install directory: ' + subSkill.filename)
          }
          const subDir = path.dirname(subPath)
          if (subDir !== installPath) {
            await mkdirNoFollow(installPath, subDir, freshDirs)
          }
          await writeTracked(subPath, subSkill.content)
        })
      )
      const firstRejection = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      )
      if (firstRejection) {
        throw firstRejection.reason
      }
    }
    // Write companion subagent if generated
    if (subagentContent) {
      subagentPath = resolveCompanionAgentPath(skillName, client, companionBaseDir)
      const agentsDir = path.dirname(subagentPath)
      if (getCompanionAgentTarget(client).fileMode === 'directory-package') {
        agentDirPreExisted = await fs.lstat(agentsDir).then(
          () => true,
          () => false
        )
      }
      await fs.mkdir(agentsDir, { recursive: true })
      // SMI-6529 M10: a FRESH install must never silently overwrite an
      // existing companion agent file — it could belong to an unrelated
      // skill/agent the user created by hand. A forced reinstall of an
      // already-tracked skill (`preExisted`) still overwrites it, tracked
      // and restorable like everything else.
      if (!preExisted) {
        const companionClassification = await classifyPreWrite(subagentPath)
        // SMI-6529 N11 (round 4): treat ANY existing non-absent entry the
        // same way — not just a 'regular' file. The old check only skipped a
        // 'regular' file, so a SYMLINKED companion path (a stale/planted
        // link) fell to the `else` branch and went through `writeTracked()`,
        // whose `safeWriteFile()` throws `SymlinkError` on it — rolling back
        // the ENTIRE install (SKILL.md, every sub-skill) over an unrelated
        // pre-existing symlink at a completely different path. A fresh
        // install must skip ('other' or 'regular') exactly the same way.
        if (companionClassification.kind !== 'absent') {
          companionSkipped = true
          subagentPath = undefined
        } else {
          await writeTracked(subagentPath, subagentContent)
        }
      } else {
        await writeTracked(subagentPath, subagentContent)
      }
    }
  } catch (writeError) {
    // SMI-6529 rollback: restore every OVERWRITTEN file to its pre-install bytes/mode
    // and unlink only files this call created fresh (subagentPath lives OUTSIDE
    // installPath, under the client's companion-agent dir — see
    // resolveCompanionAgentPath()/COMPANION_AGENT_TARGETS, install/paths.ts — but is
    // tracked via the same overwritten/createdFresh split as everything else).
    const restoreFailures = await performRollback()
    if (restoreFailures.length > 0) {
      throw new InstallRestoreError(
        writeError instanceof Error ? writeError.message : String(writeError),
        restoreFailures,
        { cause: writeError }
      )
    }
    throw writeError
  }
  return { writtenFiles, subagentPath, companionSkipped, rollback }
}
