/**
 * SMI-6531 (A1 step 6c-i): the walker's intent (P4c), a write that deletes
 * nothing, split out of `prune.walk.ts` for the file-length limit (the
 * misplacement record is in `prune.misplaced.ts`). The deletion walk itself stays
 * module-private in `prune.walk.ts` (spike PR-17). fs is the DEFAULT export,
 * looked up at call time, and every write is exclusive (`wx`).
 *
 * @module @skillsmith/core/install/prune.walk.stage
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { INTENT_VERSION, recordOf } from './prune.metadata.js'
import type { MetaRecord, PruneIntent } from './prune.metadata.js'
import type { PruneJob } from './prune.job.js'
import { renameNoReplace } from './prune.walk.shared.js'

/** The intent a fresh run writes into its staging directory before it moves anything. */
export function intentFor(job: PruneJob, pruneId: string): PruneIntent {
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
