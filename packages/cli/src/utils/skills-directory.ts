/**
 * SMI-2713: Extracted from manage.ts — helpers for reading installed skills
 * from the global and local ~/.claude/skills directories.
 */

import { readdir, readFile, realpath, stat } from 'fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'path'
import {
  ManifestManager,
  SkillParser,
  SkillVersionRepository,
  manifestKeyFor,
  type Database,
  type SkillManifestEntry,
  type TrustTier,
} from '@skillsmith/core'
import { openCliDatabase } from './open-database.js'
import {
  CANONICAL_CLIENT,
  CLIENT_NATIVE_PATHS,
  CLIENT_WORKSPACE_SEGMENTS,
  findWorkspaceRoot,
  resolveWorkspaceManifestPath,
  type ClientId,
  type InstallScope,
} from '@skillsmith/core/install'
import { DEFAULT_DB_PATH, DEFAULT_MANIFEST_PATH } from '../config.js'
import { getLocalSkillsDir } from './local-skills-dir.js'
import {
  buildLocalScanTarget,
  buildScanTargets,
  type ScanTarget,
} from './skills-directory.scan-targets.js'

// SMI-6060: re-exported for existing call sites (manage.action.ts, tests) —
// the implementation itself lives in local-skills-dir.ts (extracted from
// this file to stay under the 500-line standard). getLocalSkillsDirDisplay
// isn't called locally in this file, so it's re-exported directly rather
// than imported into an unused local binding (GPT-5.6-Sol review follow-up).
export { getLocalSkillsDir }
export { getLocalSkillsDirDisplay } from './local-skills-dir.js'

// ADR-139 (SMI-6274 Wave 4): getInstalledSkillsPerHarness()/HarnessSkillEntry
// were extracted to skills-directory.per-harness.ts to stay under the
// 500-line standard once this file grew scope-aware — re-exported here so
// existing call sites (inventory.action.ts, tests) keep importing from this
// module unmodified (same convention as the getLocalSkillsDir re-export above).
export {
  getInstalledSkillsPerHarness,
  type HarnessSkillEntry,
} from './skills-directory.per-harness.js'

// SMI-6343 (Wave 3): computeHasUpdates() extracted to skills-directory.hash-
// comparison.ts to stay under the 500-line standard once the Wave 3
// classification logic was added — re-exported here so existing call sites
// (this file's own getSkillsFromDirectory() below, plus tests) keep
// importing from this module unmodified (same convention as above).
export { computeHasUpdates } from './skills-directory.hash-comparison.js'
import { computeHasUpdates } from './skills-directory.hash-comparison.js'

// ADR-175 / SMI-6946: the update-status type and its classifiers live in
// skills-directory.update-status.ts (the fourth extraction from this file for
// the 500-line standard) -- re-exported, same convention as above.
export {
  classifyOpenFailure,
  describeQueryFailure,
  resolveUpdateStatus,
  type UpdateStatus,
} from './skills-directory.update-status.js'
import {
  classifyOpenFailure,
  resolveUpdateStatus,
  type UpdateStatus,
} from './skills-directory.update-status.js'

export interface InstalledSkill {
  name: string
  path: string
  version: string | null
  trustTier: TrustTier
  installDate: string
  updateStatus: UpdateStatus
  /**
   * Why `updateStatus` is `unknown`, in one short human-readable clause.
   *
   * Set only for `unknown`. Callers aggregate these into **one** warning per
   * command rather than one per skill — this module deliberately performs no
   * output of its own, so the diagnostic travels out with the data.
   *
   * Explicitly `| undefined` because this package sets
   * `exactOptionalPropertyTypes`, under which an optional property may be
   * ABSENT but not present-and-undefined. Every construction site sets this key
   * unconditionally, so the union is load-bearing rather than cosmetic.
   */
  updateStatusReason?: string | undefined
  /**
   * SMI-4578: which client's directory this skill was discovered under.
   * `'local'` = repo-local `./.claude/skills`. Other values are
   * `ClientId` from the multi-client install table.
   */
  installedVia: ClientId | 'local'
  /**
   * ADR-139 (SMI-6274 Wave 4): which scope this directory resolves to —
   * `'global'` for a `CLIENT_NATIVE_PATHS` scan, `'workspace'` for a
   * repo/workspace-local scan (this is what `'local'` always was, and is
   * now also true for any OTHER client with a non-null
   * `CLIENT_WORKSPACE_SEGMENTS` entry whose workspace directory was found
   * above the current `cwd`). Part of the `(scope, client, name)` dedup key
   * `dedupeByNameAndPath` now keys on, per ADR-139 point 1 — the SMI-5894
   * keying precedent extended to this new axis.
   */
  scope: InstallScope
  /**
   * ADR-139 (SMI-6274 Wave 4): `true` when this skill is present on disk but
   * has no corresponding entry in the manifest (global or workspace-local,
   * per `scope`) that would have recorded it — a hand-copied/hand-deleted
   * install, or a manifest deleted independently of the skill directory.
   * `list` must surface this rather than silently omitting it (ADR-139
   * point 1's recovery requirement); `update`/`remove` adopt such an entry
   * instead of failing obscurely on it.
   */
  untracked: boolean
}

/**
 * SMI-1630 + SMI-4578: discovery scans every client directory
 * (`CLIENT_NATIVE_PATHS`) plus repo-local `./.claude/skills`. Local
 * skills take precedence over global; canonical (`claude-code`) takes
 * precedence over secondary clients. See `getInstalledSkills` below.
 */

/**
 * Return `true` when a directory entry resolves to a directory, following
 * symlinks. `withFileTypes` reports a symlinked directory as a symlink (not
 * a directory), so `entry.isDirectory()` alone silently skips a symlinked
 * INDIVIDUAL skill directory — exactly GH #1912's own repro
 * (`ln -s ~/.claude/skills/foo ~/.cursor/skills/foo`). Independent twin of
 * `resolvesToDirectory()` in `packages/core/src/sync/inventory-collector.ts`
 * (SMI-5717).
 *
 * `isSymbolicLink` is optional-invoked (`?.`) because several pre-existing
 * tests (`manage.skills-directory.test.ts` et al.) mock `fs/promises.readdir`
 * with plain `{ name, isDirectory: () => true }` objects that don't implement
 * the full `Dirent` interface — those mocks never claim to be a symlink, so
 * treating a missing method as `false` preserves their existing behavior.
 */
async function resolvesToDirectory(
  entryPath: string,
  isDirectory: boolean,
  isSymbolicLink: boolean
): Promise<boolean> {
  if (isDirectory) return true
  if (!isSymbolicLink) return false
  try {
    return (await stat(entryPath)).isDirectory()
  } catch {
    return false // broken symlink
  }
}

/**
 * Get skills from a specific directory.
 *
 * When dbPath is provided, opens the skill_versions table to determine
 * whether a newer content hash has been recorded since the skill was installed.
 * Reports `updateStatus: 'unknown'` when the version lookup is unavailable for
 * a reason that leaves the answer unknowable (ADR-175 § 5) — never `'current'`.
 *
 * @param skillsDir   Directory to scan for installed skills
 * @param dbPath      Optional path to the Skillsmith SQLite database
 * @param installedVia SMI-4578: which client (or `'local'`) this directory
 *                    represents — propagated onto each returned skill so
 *                    callers can render "installed via Cursor" badges.
 * @param scope       ADR-139 (SMI-6274 Wave 4): `'global'` or `'workspace'`,
 *                    propagated onto each returned skill.
 * @param manifestPath ADR-139: when provided, the manifest this directory's
 *                    installs are tracked in — loaded once, up front, to
 *                    stamp `untracked` on every discovered skill. Omitted
 *                    entirely by callers (like the per-harness inventory
 *                    scan) that don't need untracked detection, in which
 *                    case every entry gets `untracked: false`.
 */
export async function getSkillsFromDirectory(
  skillsDir: string,
  dbPath?: string,
  installedVia: ClientId | 'local' = CANONICAL_CLIENT,
  scope: InstallScope = 'global',
  manifestPath?: string
): Promise<InstalledSkill[]> {
  const skills: InstalledSkill[] = []
  const effectiveClient: ClientId = installedVia === 'local' ? CANONICAL_CLIENT : installedVia

  // ADR-139: load the manifest keys once for the whole directory scan
  // rather than per-entry — a corrupt/unreadable manifest degrades to
  // "everything in this directory is untracked" rather than throwing
  // during what is otherwise a read-only `list` scan.
  //
  // SMI-6343 (C2): also keeps the full entries (not just their keys) around
  // so `computeHasUpdates()` can read each entry's recorded
  // contentHash/originalContentHash — the real installed hash, previously
  // never actually reached (it was mistakenly read off the *parsed SKILL.md*
  // object below, which has no such fields).
  let manifestKeys: Set<string> | null = null
  let manifestEntries: Record<string, SkillManifestEntry> = {}
  if (manifestPath) {
    try {
      const manifest = await new ManifestManager(manifestPath).load()
      manifestEntries = manifest.installedSkills ?? {}
      manifestKeys = new Set(Object.keys(manifestEntries))
    } catch {
      manifestKeys = new Set()
      manifestEntries = {}
    }
  }

  // Open the version repository if a db path was provided
  let versionRepo: SkillVersionRepository | null = null
  let dbConn: Database | null = null
  // Non-null when the version lookup is unavailable for a reason that leaves
  // update state UNKNOWABLE, rather than knowably "nothing installed".
  let unknownReason: string | undefined
  // ADR-175 § 5: absence is decided BEFORE the open, because the two drivers
  // disagree about what an absent path does. Native throws SQLITE_CANTOPEN;
  // WASM **succeeds** with an empty in-memory database, so the absence would
  // resurface as a per-skill query failure and render `unknown` — wrong, since
  // an absent database is this contract's one benign case. Reachable on any
  // machine without a native build, which is the normal npx install.
  //
  // Not the precheck ADR § 2 forbids: that bars `existsSync` from classifying a
  // failure CODE, which it cannot do. This asks a different question.
  if (dbPath && existsSync(dbPath)) {
    try {
      // SMI-5139: this is a pure-read version lookup — open read-only so the
      // WASM driver does not persist (write) on close() and throw EROFS when
      // dbPath is unwritable.
      dbConn = await openCliDatabase(dbPath, { readonly: true })
      versionRepo = new SkillVersionRepository(dbConn)
    } catch (error) {
      versionRepo = null
      dbConn = null
      unknownReason = classifyOpenFailure(error, dbPath)
    }
  }

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })

    for (const entry of entries) {
      // Skip dot-prefixed directories: they are harness internals, not skills.
      // Covers .backups (created by apply_recommended_edit — SMI-5440) and any
      // other dot-dir that must not appear in inventory status. (SMI-5442)
      // Checked BEFORE resolvesToDirectory() so a dot-prefixed symlinked entry
      // never pays for a stat() call it's about to discard — matches the
      // core collector's ordering in `inventory-collector.ts`'s
      // `collectHarness()` (SMI-5717).
      if (entry.name.startsWith('.')) continue

      const skillPath = join(skillsDir, entry.name)
      // GH #1912 / SMI-5717: stat-resolve symlinked entries so an individually
      // symlinked skill directory is discovered too, not just real directories.
      const isSkillDir = await resolvesToDirectory(
        skillPath,
        entry.isDirectory(),
        entry.isSymbolicLink?.() ?? false
      )
      if (isSkillDir) {
        const skillMdPath = join(skillPath, 'SKILL.md')

        try {
          const skillMdStat = await stat(skillMdPath)
          const content = await readFile(skillMdPath, 'utf-8')
          const parser = new SkillParser()
          const parsed = parser.parse(content)

          // SMI-6343 (C2): determine hasUpdates via the shared comparator,
          // preferring the manifest's recorded installed hash over a fresh
          // on-disk hash — see computeHasUpdates()'s doc comment for why the
          // pre-fix version of this block never actually reached the
          // manifest's stored hash.
          const repo = versionRepo
          const { updateStatus, updateStatusReason } = await resolveUpdateStatus(
            repo && parsed
              ? async () => {
                  const parsedAny = parsed as unknown as Record<string, unknown>
                  const skillId = (parsedAny['id'] as string | undefined) ?? entry.name
                  const latestVersion = await repo.getLatestVersion(skillId)
                  const manifestEntry = manifestEntries[manifestKeyFor(entry.name, effectiveClient)]
                  return computeHasUpdates(manifestEntry, content, latestVersion, skillsDir)
                }
              : null,
            unknownReason,
            dbPath
          )

          skills.push({
            name: parsed?.name || entry.name,
            path: skillPath,
            version: parsed?.version || null,
            trustTier: parsed ? parser.inferTrustTier(parsed) : 'unknown',
            installDate: skillMdStat.mtime.toISOString().split('T')[0] || 'Unknown',
            updateStatus,
            updateStatusReason,
            installedVia,
            scope,
            untracked: manifestKeys
              ? !manifestKeys.has(manifestKeyFor(entry.name, effectiveClient))
              : false,
          })
        } catch (error) {
          // ENOENT: SKILL.md absent — treat as unknown skill.
          // EISDIR: SKILL.md is itself a directory (e.g. .backups/SKILL.md created
          // by apply_recommended_edit — SMI-5440). Treat the same as absent.
          // Re-throw permission errors and other unexpected errors.
          const errno = (error as NodeJS.ErrnoException).code
          if (errno !== 'ENOENT' && errno !== 'EISDIR') {
            throw error
          }

          // No SKILL.md, treat as unknown skill
          const dirStat = await stat(skillPath)
          skills.push({
            name: entry.name,
            path: skillPath,
            version: null,
            trustTier: 'unknown',
            installDate: dirStat.mtime.toISOString().split('T')[0] || 'Unknown',
            // No SKILL.md, so there is no installed version to be behind — but
            // a database fault still makes the answer unknowable, so it is not
            // unconditionally `current`.
            updateStatus: unknownReason ? 'unknown' : 'current',
            updateStatusReason: unknownReason,
            installedVia,
            scope,
            untracked: manifestKeys
              ? !manifestKeys.has(manifestKeyFor(entry.name, effectiveClient))
              : false,
          })
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  } finally {
    dbConn?.close()
  }

  return skills
}

/**
 * Resolve a path through `realpath` defensively. Returns the resolved
 * path on success, or the input path unchanged if the path is missing
 * or unreadable — dedup keying still works either way (we just won't
 * collapse symlinked aliases when the link is broken).
 *
 * Exported (SMI-6060-style split, ADR-139/SMI-6274 Wave 4) for
 * `skills-directory.per-harness.ts`, which needs the identical
 * realpath-memoization semantics for {@link getInstalledSkillsPerHarness}.
 */
export async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    return p
  }
}

/**
 * Get list of installed skills across every client directory and scope.
 *
 * SMI-4578: scans the union of `CLIENT_NATIVE_PATHS` (claude-code,
 * cursor, copilot, windsurf, agents, ...) plus repo-local
 * `./.claude/skills`. ADR-139 (SMI-6274 Wave 4) extends this to also scan
 * every OTHER client's WORKSPACE directory when one is found above `cwd`.
 * Results are deduplicated by `realpath` so a symlinked
 * `~/.agents/skills/foo` pointing at `~/.claude/skills/foo` is reported
 * once. Each entry carries `installedVia` and `scope` so the caller can
 * render "installed via Cursor (workspace)" badges.
 *
 * Precedence (first wins after dedup, WITHIN a given `(scope, client)`
 * pair): local (repo) > claude-code > cursor > copilot > windsurf > agents,
 * then each other client's workspace scan. A skill installed
 * independently under two DIFFERENT `(scope, client)` pairs now shows as
 * two rows — see {@link dedupeByNameAndPath}'s doc comment.
 *
 * @param dbPath Optional path to the Skillsmith SQLite database for
 *               update detection.
 */
/**
 * Dedup a precedence-ordered list of scan results by the `(scope, client,
 * name)` triple AND resolved path (ADR-139 point 1 — extends the SMI-5894
 * `(client, name)` keying precedent to the new scope axis). Triple-keying
 * enforces "first entry in the array wins" only for genuine duplicates
 * WITHIN the same `(scope, client)` pair (e.g. two aliases into one
 * directory); a skill independently installed under two different scopes,
 * or two different clients, now survives as two separate rows — it
 * reflects real, distinct disk state rather than being silently collapsed
 * to whichever one happened to scan first. Realpath-keying (unchanged,
 * still global across every `(scope, client)` pair — an orthogonal
 * concern) collapses symlinked aliases (e.g. `~/.agents/skills` ->
 * `~/.claude/skills`) so the symlinked entry doesn't appear twice when the
 * second hop has a different `installedVia`/`scope` label.
 *
 * Shared by {@link getInstalledSkills} (dedupes across every client/scope)
 * and {@link getInstalledSkillsForClient} (dedupes across just local + one
 * client's two scopes) so the two functions can't drift on dedup semantics
 * (SMI-5894).
 */
async function dedupeByNameAndPath(ordered: InstalledSkill[]): Promise<InstalledSkill[]> {
  const seenKeys = new Set<string>()
  const seenPaths = new Set<string>()
  const out: InstalledSkill[] = []
  for (const skill of ordered) {
    const key = `${skill.scope}::${skill.installedVia}::${skill.name}`
    if (seenKeys.has(key)) continue
    const realPath = await safeRealpath(skill.path)
    if (seenPaths.has(realPath)) continue
    seenKeys.add(key)
    seenPaths.add(realPath)
    out.push(skill)
  }
  return out
}

export async function getInstalledSkills(dbPath?: string): Promise<InstalledSkill[]> {
  const resolvedDbPath = dbPath ?? DEFAULT_DB_PATH
  const targets = buildScanTargets(process.cwd())
  const lists = await Promise.all(
    targets.map((t) =>
      getSkillsFromDirectory(t.dir, resolvedDbPath, t.installedVia, t.scope, t.manifestPath)
    )
  )
  return dedupeByNameAndPath(lists.flat())
}

/**
 * SMI-5894 (Wave 1 Steps 2/3): like {@link getInstalledSkills}, but scoped
 * to a single resolved client's directory instead of scanning + deduping
 * across every client.
 *
 * Repo-local skills (`./.claude/skills`) still take precedence, matching
 * the SMI-1630 "repo-local overrides global" rule `getInstalledSkills()`
 * already applies — local skills aren't tied to any particular client's
 * harness config, so they stay in scope regardless of which client is
 * targeted.
 *
 * This is what lets `remove`/`update --client cursor` resolve unambiguously
 * to the Cursor copy of a same-named skill, instead of being silently
 * redirected to a different client's copy by {@link getInstalledSkills}'s
 * global cross-client dedup (which keeps whichever client wins precedence,
 * not necessarily the one the caller asked about).
 *
 * ADR-139 (SMI-6274 Wave 4): also scans `client`'s WORKSPACE directory (when
 * one is found above `cwd`) alongside its global directory — this is what
 * lets a scoped `remove`/`update --client cursor --scope workspace` resolve
 * against the exact `(scope, client, name)` triple rather than only ever
 * seeing that client's global copy.
 */
export async function getInstalledSkillsForClient(
  client: ClientId,
  dbPath?: string
): Promise<InstalledSkill[]> {
  const resolvedDbPath = dbPath ?? DEFAULT_DB_PATH
  const cwd = process.cwd()

  const targets: ScanTarget[] = [
    buildLocalScanTarget(cwd),
    {
      dir: CLIENT_NATIVE_PATHS[client],
      installedVia: client,
      scope: 'global',
      manifestPath: DEFAULT_MANIFEST_PATH,
    },
  ]
  if (client !== CANONICAL_CLIENT) {
    const segments = CLIENT_WORKSPACE_SEGMENTS[client]
    const found = segments ? findWorkspaceRoot(cwd, client) : null
    if (segments && found) {
      targets.push({
        dir: join(found.root, ...segments),
        installedVia: client,
        scope: 'workspace',
        manifestPath: resolveWorkspaceManifestPath(found.root),
      })
    }
  }

  const lists = await Promise.all(
    targets.map((t) =>
      getSkillsFromDirectory(t.dir, resolvedDbPath, t.installedVia, t.scope, t.manifestPath)
    )
  )
  return dedupeByNameAndPath(lists.flat())
}
