/**
 * SMI-6531 (A1 step 7b): `buildUpdateTarget`, plan §3.1's `UpdateTarget` for
 * an existing tracked folder. Reads only; refuses with `UpdateRefusal`.
 *
 * - `realDir` is the native `fs.promises.realpath(comparedPath)` and R the
 *   native realpath of `skillsDir`, with no lexical fallback: a failure
 *   refuses `probe-failed`. `realDir` must be a direct child of R, never R
 *   itself (the swap renames it into R's staging), `lstat` a directory and
 *   not a symlink, and on R's device (a mount at `R/foo` would fail rename 1
 *   with `EXDEV` after the record is published). Each failure is
 *   `identity-mismatch`, the reason §4.3 gives an escaping real path.
 * - `dirName` is `basename(comparedPath)` and names the key; the upstream
 *   name never does. A symlinked `comparedPath` whose target is another
 *   direct child of R is accepted.
 * - §4.3 row 4 comes from A2's own code, not a copy: the entry verdict from
 *   `entryInstallPathVerdict` and `resolvedPathVerdict`
 *   (`update-target.evidence.ts`) and its reason from `rowFourReason`
 *   (`update-target-gate.rules.ts`). No entry is `untracked` (Q8: `update`
 *   adopts untracked folders before it plans); any present entry whose
 *   `installPath` is not an absolute string (a string, number, boolean or
 *   array entry included), or resolves elsewhere, is `manifest-key-conflict`.
 *   7b resolves with the native realpath (A2 falls back to the lexical path);
 *   an errno other than `ENOENT`/`ENOTDIR` there is `probe-failed`. The entry
 *   is read with `Object.hasOwn` (`rawEntryAt`), where A2 indexes the parsed
 *   object, so a key named after an `Object.prototype` member reads as no entry.
 * - A key that names `realDir` but does not own it under UD22's rule
 *   (`skill-update.owner.ts`) is `identity-mismatch` naming the owner.
 *
 * @module @skillsmith/core/services/skill-update.target
 */
import fs, { type BigIntStats } from 'node:fs'
import path from 'node:path'
import { identityOf } from '../install/park-tree.identity.js'
import { resolveCompanionAgentPath, type ClientId } from '../install/paths.js'
import type { InstallScope } from '../install/workspace-scope.js'
import { manifestKeyFor } from './skill-installation.helpers.js'
import { canonicalize, isPlainObject } from './skill-manifest.canonical.js'
import type { JsonObject } from './skill-manifest.canonical.js'
import { rawEntryAt } from './skill-manifest.entry.js'
import { readManifestState } from './skill-manifest.read-state.js'
import { treeHashOf } from './skill-tree.js'
import { manifestKeyOwner } from './skill-update.owner.js'
import type { UpdateRefusal, UpdateTargetResult } from './skill-update.types.js'
import { entryInstallPathVerdict, resolvedPathVerdict } from './update-target.evidence.js'
import { rowFourReason } from './update-target-gate.rules.js'

export interface BuildUpdateTargetInput {
  skillsDir: string
  client: ClientId
  /** The install scope (`global` or `workspace`). */
  scope: InstallScope
  manifestPath: string
  /** The directory `update` diffed. */
  comparedPath: string
  /** Base for a client whose companion directory is relative (only names `companionPath`). */
  companionBaseDir?: string
}

export interface BuildUpdateTargetOptions {
  /** @internal Replaces the bigint `lstat` of R and `realDir` (the same-device test seam). */
  lstat?: (p: string) => Promise<BigIntStats>
}

const codeOf = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN'
}

function refuse(
  reason: UpdateRefusal['reason'],
  detail: string,
  extra: Partial<Pick<UpdateRefusal, 'owningManifestKey' | 'path'>> = {}
): UpdateRefusal {
  return { ok: false, reason, detail, ...extra }
}

/** A native realpath, or why there is none: absent (`ENOENT`/`ENOTDIR`) or another errno. */
type Resolution = { real: string } | { absent: true } | { errno: string }

async function resolveInstallPath(p: string): Promise<Resolution> {
  try {
    return { real: await fs.promises.realpath(p) }
  } catch (err) {
    const code = codeOf(err)
    return code === 'ENOENT' || code === 'ENOTDIR' ? { absent: true } : { errno: code }
  }
}

/**
 * Native realpaths of every entry's absolute `installPath`, for UD22's owner
 * rule. A relative path is never resolved (it would resolve against the cwd),
 * and another key's path that fails to resolve, for any reason, names nothing.
 */
async function installPathsResolved(rawManifest: unknown): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  if (!isPlainObject(rawManifest) || !isPlainObject(rawManifest.installedSkills)) return out
  for (const entry of Object.values(rawManifest.installedSkills)) {
    if (!isPlainObject(entry) || typeof entry.installPath !== 'string') continue
    const p = entry.installPath
    if (!path.isAbsolute(p) || out.has(p)) continue
    const r = await resolveInstallPath(p)
    out.set(p, 'real' in r ? r.real : null)
  }
  return out
}

/**
 * §4.3 row 4 for the key's own entry, by A2's code: the verdict from
 * `entryInstallPathVerdict` and `resolvedPathVerdict` (`update-target.evidence.ts`),
 * the reason from `rowFourReason` (`update-target-gate.rules.ts`). Only the
 * resolution is 7b's: the native realpath, where A2 falls back to the lexical
 * path. A path absent on disk (`ENOENT`/`ENOTDIR`) names nothing, so it is a
 * mismatch; any other errno cannot be classified either way and is
 * `probe-failed`. That check sits after the shape verdict (only a valid
 * absolute path is resolved) and before the path verdict (it needs the
 * resolution). `null` when the entry names `realDir`.
 */
async function rowFourRefusal(
  rawEntry: unknown,
  manifestKey: string,
  realDir: string,
  comparedPath: string
): Promise<UpdateRefusal | null> {
  const shape = entryInstallPathVerdict(rawEntry)
  if ('disqualifiedBy' in shape) {
    return refuse(
      rowFourReason(shape.disqualifiedBy) ?? 'manifest-key-conflict',
      shape.disqualifiedBy === 'no-entry'
        ? `no manifest entry "${manifestKey}" tracks ${comparedPath}`
        : `the manifest entry "${manifestKey}" has a missing or invalid installPath (not an absolute path)`,
      { path: comparedPath }
    )
  }
  const own = shape.installPath
  if (own === realDir) return null
  const r = await resolveInstallPath(own)
  if ('errno' in r) {
    return refuse(
      'probe-failed',
      `the manifest entry "${manifestKey}" records ${own}, which could not be resolved (${r.errno})`,
      { path: own }
    )
  }
  const real = 'real' in r ? r.real : null
  const verdict = resolvedPathVerdict(real, realDir)
  if (verdict === null) return null
  return refuse(
    rowFourReason(verdict) ?? 'manifest-key-conflict',
    real === null
      ? `the manifest entry "${manifestKey}" records ${own}, which does not resolve`
      : `the manifest entry "${manifestKey}" records ${own}, which resolves to ${real}, not ${realDir}`,
    { path: comparedPath }
  )
}

function companionPathOf(input: BuildUpdateTargetInput, dirName: string): string | null {
  try {
    return resolveCompanionAgentPath(dirName, input.client, input.companionBaseDir)
  } catch {
    // A relative companion directory with no base, or a name it refuses.
    return null
  }
}

/** Builds the target for the folder at `comparedPath` (plan §3.1), or refuses. */
export async function buildUpdateTarget(
  input: BuildUpdateTargetInput,
  opts: BuildUpdateTargetOptions = {}
): Promise<UpdateTargetResult> {
  const lstat = opts.lstat ?? ((p: string) => fs.promises.lstat(p, { bigint: true }))
  const { skillsDir, client, manifestPath, comparedPath } = input
  const dirName = path.basename(comparedPath)

  const read = await readManifestState(manifestPath)
  if (read.state !== 'ok' && read.state !== 'missing') {
    return refuse('manifest-unreadable', `the manifest ${manifestPath} is ${read.state}`, {
      path: manifestPath,
    })
  }
  const raw = read.raw

  let root: string
  let realDir: string
  try {
    root = await fs.promises.realpath(skillsDir)
  } catch (err) {
    return refuse(
      'probe-failed',
      `the skills root ${skillsDir} does not resolve (${codeOf(err)})`,
      {
        path: skillsDir,
      }
    )
  }
  try {
    realDir = await fs.promises.realpath(comparedPath)
  } catch (err) {
    return refuse('probe-failed', `${comparedPath} does not resolve (${codeOf(err)})`, {
      path: comparedPath,
    })
  }
  if (realDir === root || path.dirname(realDir) !== root) {
    return refuse(
      'identity-mismatch',
      `${comparedPath} resolves to ${realDir}, which is not a skill folder directly inside ${root}`,
      { path: realDir }
    )
  }
  let rootStat: BigIntStats
  let dirStat: BigIntStats
  try {
    rootStat = await lstat(root)
  } catch (err) {
    return refuse('probe-failed', `the skills root ${root} could not be read (${codeOf(err)})`, {
      path: root,
    })
  }
  try {
    dirStat = await lstat(realDir)
  } catch (err) {
    return refuse('probe-failed', `${realDir} could not be read (${codeOf(err)})`, {
      path: realDir,
    })
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    return refuse('identity-mismatch', `${realDir} is not a directory`, { path: realDir })
  }
  if (dirStat.dev !== rootStat.dev) {
    return refuse('identity-mismatch', `${realDir} is on another device than ${root}`, {
      path: realDir,
    })
  }

  const manifestKey = manifestKeyFor(dirName, client)
  const rawEntry = rawEntryAt(raw, manifestKey)
  const rowFour = await rowFourRefusal(rawEntry, manifestKey, realDir, comparedPath)
  if (rowFour !== null) return rowFour
  // Row 4 passed, so the entry has a string `installPath`: JSON gives that only to an object.
  if (!isPlainObject(rawEntry)) {
    return refuse('manifest-key-conflict', `the manifest entry "${manifestKey}" is not an object`)
  }
  const resolved = await installPathsResolved(raw)
  const owner = manifestKeyOwner(raw, realDir, (p) => resolved.get(p) ?? null)
  if (owner !== null && owner !== manifestKey) {
    return refuse(
      'identity-mismatch',
      `${realDir} is owned by the manifest entry "${owner}", not "${manifestKey}"`,
      { path: realDir, owningManifestKey: owner }
    )
  }

  const tree = treeHashOf(realDir)
  if (!tree.ok) {
    return refuse(
      tree.reason,
      `${tree.path} could not be hashed (${tree.reason}${tree.errno ? `, ${tree.errno}` : ''})`,
      { path: tree.path }
    )
  }
  return {
    ok: true,
    target: {
      skillsDir,
      realSkillsDir: root,
      client,
      scope: input.scope,
      stateRoot: path.dirname(manifestPath),
      manifestPath,
      manifestKey,
      comparedPath,
      realDir,
      dirName,
      identity: identityOf(dirStat),
      preTree: tree.hash,
      companionPath: companionPathOf(input, dirName),
      preEntry: canonicalize(rawEntry) as JsonObject,
    },
  }
}
