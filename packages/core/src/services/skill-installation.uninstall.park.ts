/**
 * SMI-6531 (A1 step 8-i-a-1): uninstall parks the skill folder instead of
 * deleting it (A1 plan §3.8, park-caller row 3; UD27, UD32; ADR-166 D-1).
 *
 * Row 3 is early-bound (§3.3 "Order, one per caller"). When `performUninstall`
 * reads the folder (`seen.stat`), `prepareUninstallPark` binds the skills root
 * (R and `.skillsmith-staging/`), runs UD25's clock gate with its probes in ST,
 * hashes the folder and binds its identity (`gateAndBind`). That happens with
 * or without `force` (UD27): the hash is the guard, and the modification check
 * `force` skips is not. The identity `gateAndBind` binds must be the one
 * `seen.stat` read (dev, ino, birthtime, file type), or the folder changed
 * between the two reads and nothing moves (`kept/identity-changed`).
 *
 * `runUninstallPark` then takes lock 1, runs `check`, and parks through the
 * park-result path (`park-report.ts`) with the hash, identity and probe 2's
 * birthtime it kept, so an edit or a substitute made after the read is refused
 * by the park (`kept/identity-changed`: the bound identity includes birthtime,
 * so for this early-bound caller it already refuses any substitute made after
 * probe 2, and the probe threshold never decides).
 * The folder lands at `<R>/.skillsmith-parked/<opId>/<name>-<rnd>`. On
 * `parked`, the manifest entry is dropped inside lock 1. On `kept`, `held` or
 * `stopped` it stays and the uninstall is reported not done (exit 4 in
 * `skillsmith remove`, UD32). Nothing here deletes a byte.
 *
 * After lock 1 is released: the space warning (once, from the reporter) and
 * the `.gitignore` hints for a staging or parked area this run created (T-N1).
 *
 * @module @skillsmith/core/services/skill-installation.uninstall.park
 */
import { randomBytes } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { LockOrderError } from '../config/lock-tracker.js'
import { gateAndBind } from '../install/park-clock-gate.js'
import type { ParkIdentity, ParkResult } from '../install/park-result.js'
import { identityOf, sameIdentity } from '../install/park-tree.identity.js'
import { human } from '../install/parked-usage.js'
import { PARKED_INDEX_FILE } from '../install/parked-index.name.js'
import { createParkReporter } from './park-report.js'
import type { ManifestManager } from './skill-manifest.js'
import { installedSkillsOf } from './skill-manifest.js'
import type {
  SkillManifestEntry,
  UninstallNotDone,
  UninstallParkSeams,
} from './skill-installation.types.js'
import { sameRecord } from './skill-installation.uninstall.helpers.js'
import { rootKeyOf } from './skill-swap.area.js'
import { bindSkillsRoot, withSkillWriteLock } from './skill-write-lock.js'
import { parkedAreaGitignoreHint } from './skill-write-lock.gitignore.js'
import { SkillWriteStop } from './skill-write-lock.types.js'
import type { SkillsRootBinding } from './skill-write-lock.types.js'

/** What the gate and the bind kept, to pass at park time. */
export interface PreparedUninstallPark {
  binding: SkillsRootBinding
  name: string
  opId: string
  guardHash: string
  expectIdentity: ParkIdentity
  maxBirthtimeNs: bigint
}

/** `skillsmith restore <opId>`: row 3's restore line. */
export const restoreCommandFor = (opId: string): string => `skillsmith restore ${opId}`

const stopOf = (
  installPath: string,
  stop: SkillWriteStop
): { ok: false; notDone: UninstallNotDone } => ({
  ok: false,
  notDone: { path: installPath, status: 'stopped', reason: stop.code, detail: stop.detail },
})

/**
 * Binds R and ST, runs the clock gate, hashes the folder and binds its
 * identity, at the moment uninstall read it. Nothing moves here; the only
 * entries made are ST (when absent) and the gate's two probes, each removed
 * right after it is read.
 */
export async function prepareUninstallPark(a: {
  skillsDir: string
  installPath: string
  seen: BigIntStats
  seams: UninstallParkSeams
}): Promise<
  { ok: true; prepared: PreparedUninstallPark } | { ok: false; notDone: UninstallNotDone }
> {
  const opId = a.seams.opId ?? randomBytes(16).toString('hex')
  let binding: SkillsRootBinding
  try {
    binding = await bindSkillsRoot(a.skillsDir)
  } catch (err) {
    if (err instanceof SkillWriteStop) return stopOf(a.installPath, err)
    throw err
  }
  const name = path.basename(a.installPath)
  const g = await gateAndBind({
    probeDir: binding.stagingDir,
    parentAbs: binding.root,
    name,
    opId,
  })
  if (!g.ok) {
    const left = 'leftProbe' in g && g.leftProbe !== null ? ` (probe left at ${g.leftProbe})` : ''
    return {
      ok: false,
      notDone: {
        path: a.installPath,
        status: 'stopped',
        reason: g.reason,
        ...(g.errno === null ? {} : { errno: g.errno }),
        detail: `${g.detail}${left}`,
      },
    }
  }
  // D6: the hash and identity are of the folder `seen.stat` read, or of nothing.
  if (!sameIdentity(identityOf(a.seen), g.expectIdentity)) {
    return {
      ok: false,
      notDone: {
        path: a.installPath,
        status: 'kept',
        reason: 'identity-changed',
        detail: `${a.installPath} changed between the uninstall's read and its hash`,
      },
    }
  }
  await a.seams.afterBind?.()
  return {
    ok: true,
    prepared: {
      binding,
      name,
      opId,
      guardHash: g.guardHash,
      expectIdentity: g.expectIdentity,
      maxBirthtimeNs: g.maxBirthtimeNs,
    },
  }
}

/** The manifest drop's outcome. */
export type ManifestDrop = { kind: 'dropped' | 'claimed' } | { kind: 'failed'; error: string }

/**
 * Drops `manifestKey` only while it still describes the record uninstall
 * loaded (round 16-18): a concurrent install of the same name keeps its own
 * record. Never throws.
 */
export async function dropManifestEntry(
  manifest: ManifestManager,
  manifestKey: string,
  loaded: SkillManifestEntry
): Promise<ManifestDrop> {
  let claimed = false
  try {
    await manifest.updateSafely((current) => {
      // Reset: a lost lock reruns this callback once (SMI-7143).
      claimed = false
      const entry = installedSkillsOf(current)[manifestKey]
      if (entry !== undefined && !sameRecord(entry, loaded)) {
        claimed = true
        return current
      }
      const next: typeof current = {
        ...current,
        installedSkills: { ...installedSkillsOf(current) },
      }
      delete next.installedSkills[manifestKey]
      return next
    })
  } catch (err) {
    if (err instanceof LockOrderError) throw err
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
  return { kind: claimed ? 'claimed' : 'dropped' }
}

/** What the park under lock 1 ended as. */
export type UninstallParkOutcome =
  | { status: 'parked'; park: ParkResult; manifest: ManifestDrop }
  | { status: 'not-done'; notDone: UninstallNotDone }

export interface UninstallParkRun {
  outcome: UninstallParkOutcome
  usageWarning: string | null
  hints: string[]
}

/** Not done, from a park that returned `kept`, `held` or `stopped`. */
function notDoneOf(installPath: string, opId: string, r: ParkResult): UninstallNotDone {
  const held = r.status === 'held'
  return {
    path: installPath,
    status: r.status === 'kept' ? 'kept' : held ? 'held' : 'stopped',
    reason: r.reason ?? r.status,
    ...(r.errno === null ? {} : { errno: r.errno }),
    ...(r.detail === null ? {} : { detail: r.detail }),
    // The restore line only where a parked copy exists (`held`); `kept` and
    // `stopped` moved nothing, so there is nothing to restore.
    ...(held
      ? { parkedPath: String(r.heldPath ?? r.path), restoreCommand: restoreCommandFor(opId) }
      : {}),
  }
}

/**
 * Lock 1, `check`, the park; on `parked` the manifest drop, inside lock 1.
 * Then, with lock 1 released, the space warning and the hints.
 */
export async function runUninstallPark(
  p: PreparedUninstallPark,
  a: {
    installPath: string
    client: string
    manifest: ManifestManager
    manifestKey: string
    loaded: SkillManifestEntry
    seams: UninstallParkSeams
  }
): Promise<UninstallParkRun> {
  const reporter = createParkReporter({ park: a.seams.park })
  const R = p.binding.root
  const indexPath = path.join(path.dirname(path.resolve(a.manifest.path)), PARKED_INDEX_FILE)
  const locked = await withSkillWriteLock(p.binding, 'uninstall', async (ctx) => {
    await a.seams.beforePark?.()
    ctx.check()
    const r = await reporter.park(R, p.name, {
      client: a.client,
      caller: 'uninstall',
      kind: 'uninstall',
      opId: p.opId,
      guardHash: p.guardHash,
      expectIdentity: p.expectIdentity,
      maxBirthtimeNs: p.maxBirthtimeNs,
      rootKey: rootKeyOf(R),
      indexPath,
    })
    if (r.status !== 'parked') {
      return { r, outcome: { status: 'not-done', notDone: notDoneOf(a.installPath, p.opId, r) } }
    }
    const manifest = await dropManifestEntry(a.manifest, a.manifestKey, a.loaded)
    return { r, outcome: { status: 'parked', park: r, manifest } }
  })
  // Lock 1 is released here.
  const hints: string[] = []
  if (locked.gitignoreHint !== undefined) hints.push(locked.gitignoreHint)
  if (locked.ok && locked.value.r.parkedAreaCreated === true) {
    const hint = await parkedAreaGitignoreHint(R, p.opId).catch((err: unknown) => {
      if (err instanceof LockOrderError) throw err
      return null
    })
    if (hint !== null) hints.push(hint)
  }
  const extraRoots = a.seams.usage?.roots ?? []
  const usageWarning = await reporter.finish({
    listing: { ...a.seams.usage, roots: [...extraRoots, R] },
  })
  const outcome: UninstallParkOutcome = locked.ok
    ? (locked.value.outcome as UninstallParkOutcome)
    : { status: 'not-done', notDone: stopOf(a.installPath, locked.stop).notDone }
  return { outcome, usageWarning, hints }
}

/** The extras every uninstall result carries from the park-result path. */
export function parkExtras(run: { usageWarning: string | null; hints: string[] }): {
  usageWarning?: string
  hints?: string[]
} {
  return {
    ...(run.usageWarning === null ? {} : { usageWarning: run.usageWarning }),
    ...(run.hints.length === 0 ? {} : { hints: run.hints }),
  }
}

/** The one line a not-done uninstall reports: the path, the status and the reason. */
export function notDoneMessage(skillName: string, n: UninstallNotDone): string {
  const why = n.detail === undefined ? n.reason : `${n.reason}: ${n.detail}`
  const where =
    n.parkedPath === undefined
      ? `The folder is still at ${n.path}`
      : `The folder is whole at ${n.parkedPath}; ${String(n.restoreCommand)} puts it back`
  return (
    `Skill "${skillName}" was not uninstalled: setting aside ${n.path} ended ${n.status} (${why}). ` +
    `${where}, and its manifest entry was kept.`
  )
}

/** The parked line: where the folder went, about how much it holds, and the prune command. */
export function parkedMessage(skillName: string, park: ParkResult, opId: string): string {
  const bytes = typeof park.bytes === 'number' ? `about ${human(park.bytes)}` : 'its space'
  return (
    `Skill "${skillName}" has been uninstalled successfully. Its folder was set aside at ` +
    `${String(park.path)}; to reclaim ${bytes}, see \`skillsmith doctor backups --prune --op ${opId}\`.`
  )
}
