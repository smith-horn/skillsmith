/**
 * SMI-6531 (A1 step 6c-i): the walker's writes that delete nothing (the intent
 * at P4c, the `deleting` marker that binds the inventory to its run), the
 * shape of a stopped result, and the removal of the empty staging and op
 * directories once a run is done, split out of `prune.walk.ts` for the
 * file-length limit. The deletion walk itself stays module-private in
 * `prune.walk.ts` (spike PR-17), and only it removes metadata
 * (`removeIfIdentical`). fs is the DEFAULT export, looked up at call time, and
 * every write is exclusive (`wx`).
 *
 * @module @skillsmith/core/install/prune.walk.stage
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { errCode } from './park-result.js'
import type { PartialParkResult } from './park-result.js'
import { INTENT_VERSION, recordOf } from './prune.metadata.js'
import type { MetaRecord, PruneIntent } from './prune.metadata.js'
import type { FreshJob } from './prune.job.js'
import { Stop, renameNoReplace } from './prune.walk.shared.js'

/** The intent a fresh run writes into its staging directory before it moves anything. */
export function intentFor(job: FreshJob, pruneId: string): PruneIntent {
  return {
    pruneId,
    copyPath: job.copyPath,
    sidecarPath: job.sidecarPath,
    leaf: job.leaf,
    approvedHash: job.approvedHash,
    approvedSidecarSha256: job.sidecarRead
      ? crypto.createHash('sha256').update(job.sidecarRead.bytes).digest('hex')
      : null,
    class: job.klass,
    authorization: job.authorization,
    createdAt: new Date().toISOString(),
    pid: process.pid,
    host: process.env.HOSTNAME ?? null,
    version: INTENT_VERSION,
  }
}

/**
 * P4c: writes `S/intent.json` through a temp and a no-replace rename, so the
 * name `intent.json` only ever holds a complete intent. A failure throws and
 * leaves at most `S/intent.json.tmp`, which the leftover listing reports as
 * `partial-intent` (the copy is not moved until this returns). Returns the
 * record the run may later remove the intent by.
 */
export function writeIntent(S: string, intent: PruneIntent): MetaRecord {
  const bytes = JSON.stringify(intent, null, 2)
  const tmp = path.join(S, 'intent.json.tmp')
  const final = path.join(S, 'intent.json')
  fs.writeFileSync(tmp, bytes, { flag: 'wx' })
  renameNoReplace(tmp, final)
  return recordOf(final, bytes)
}

/**
 * The hard stop for a directory that was not itself after the walk renamed it
 * (R-misplace for a directory): the walk can't continue into it, so it stops
 * and names the random path it was left at. Nothing is renamed back.
 */
export function dirMisplacedStop(
  at: string,
  originalRel: string,
  o: { deleted: number; kept: unknown[]; skeletons: string[] }
): Stop {
  return new Stop(
    'stopped',
    'entry-misplaced',
    `${originalRel || 'the staged root'} was renamed to ${at} and left there`,
    {
      deleted: o.deleted,
      kept: o.kept,
      skeletons: o.skeletons,
      misplaced: [{ path: at, originalRel }],
    }
  )
}

/**
 * The `deleting` marker, written after the inventory and before the first
 * delete: the inventory's sha256 and the run ID the intent and the inventory
 * both carry (`pruneId`). A resume is offered and accepted only when the three
 * agree (owner decision 2026-11-07). Returns the record P4g removes it by.
 */
export function writeDeleting(S: string, pruneId: string, inventorySha256: string): MetaRecord {
  const bytes = JSON.stringify({ pruneId, inventorySha256, pid: process.pid })
  const p = path.join(S, 'deleting')
  fs.writeFileSync(p, bytes, { flag: 'wx' })
  return recordOf(p, bytes)
}

/** The result of a walk that left something: kept entries, or directories a resume never removes. */
export function notDone(
  o: { deleted: number; kept: unknown[]; skeletons: string[] },
  S: string
): PartialParkResult {
  const kept = o.kept.length > 0
  return {
    status: 'stopped',
    reason: kept ? 'unapproved-kept' : 'skeleton-left',
    detail: kept
      ? `${o.kept.length} unapproved entries kept where they are`
      : `${o.skeletons.length} directories left holding nothing approved; a resume never removes a directory`,
    deleted: o.deleted,
    kept: o.kept,
    skeletons: o.skeletons,
    stagingPath: S,
  }
}

/** P4g's last step: only empty directories are removed. S left behind is named; the op dir only on an odd error. */
export function removeEmptyDirs(S: string, opDir: string): string[] {
  const notes: string[] = []
  for (const [dir, label] of [
    [S, 'staging directory'],
    [opDir, 'op directory'],
  ] as const) {
    try {
      fs.rmdirSync(dir)
    } catch (err) {
      const code = errCode(err)
      if (dir === S || (code !== 'ENOTEMPTY' && code !== 'ENOENT')) {
        notes.push(`${label} left (${code})`)
      }
    }
  }
  return notes
}
