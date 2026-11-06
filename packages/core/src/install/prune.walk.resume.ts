/**
 * SMI-6531 (A1 step 6c-i): what a resumed run checks before it touches
 * anything, beyond what the job itself can say. `decodeJob` is fs-free, so it
 * cannot read the intent a crashed run left on disk; these checks can:
 *  1. the staging directory passes `resumeStagingProblem`;
 *  2. no misplacement record names an entry that still exists, and no
 *     `misplaced-unrecorded` marker is present (F1, owner decision
 *     2026-11-06: a misplaced entry is never deleted);
 *  3. the job agrees with the intent: the same leaf, the intent's own op dir,
 *     a sidecar path that is the staged one or the intent's original, and
 *     sidecar bytes whose sha256 is the one the intent approved. A leftover
 *     with no intent (a staged orphan) must name `S` as its op dir and at
 *     most the staged sidecar.
 * Read-only; nothing here deletes.
 *
 * @module @skillsmith/core/install/prune.walk.resume
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { errCode } from './park-result.js'
import type { PruneJob } from './prune.job.js'
import { parseIntentStrict } from './prune.metadata.js'
import type { MetaRecord } from './prune.metadata.js'
import { misplacedState } from './prune.misplaced.js'
import { readStable } from './prune.sidecar.js'
import { resumeStagingProblem } from './prune.walk.shared.js'

export type ResumeCheck =
  | { ok: true; cleared: Record<string, MetaRecord> }
  | { ok: false; reason: string; detail: string }

const INTENT_MAX_BYTES = 16 * 1024

/** The checks a resumed job (`job.S` set) must pass before anything else runs. */
export function checkResume(job: PruneJob & { S: string }): ResumeCheck {
  const S = job.S
  const no = (reason: string, detail: string): ResumeCheck => ({ ok: false, reason, detail })
  const bad = resumeStagingProblem(S, job.stagingRoot, job.rootIdentity.dev)
  if (bad !== null) return no('staging-unusable', `${S}: ${bad}`)
  let names: string[]
  try {
    names = fs.readdirSync(S)
  } catch (err) {
    return no('staging-unusable', `${S}: unreadable (${errCode(err)})`)
  }
  const mp = misplacedState(S, names)
  if (mp.blocking.length > 0) return no('misplaced-pending', mp.blocking.join('; '))
  const staged = path.join(S, 'sidecar.json')
  if (!names.includes('intent.json')) {
    if (job.opDir !== S)
      return no('resume-mismatch', 'a leftover without an intent resumes with opDir S')
    if (job.sidecarPath !== null && job.sidecarPath !== staged) {
      return no('resume-mismatch', 'a leftover without an intent has at most the staged sidecar')
    }
    return { ok: true, cleared: mp.cleared }
  }
  const rs = readStable(path.join(S, 'intent.json'), { maxBytes: INTENT_MAX_BYTES })
  const intent = rs.ok ? parseIntentStrict(rs.bytes) : null
  if (intent === null) return no('resume-mismatch', "intent.json is not Skillsmith's intent")
  if (intent.leaf !== job.leaf) return no('resume-mismatch', 'the leaf is not the intent’s')
  if (job.opDir !== path.dirname(intent.copyPath)) {
    return no('resume-mismatch', 'opDir is not the op dir the intent recorded')
  }
  if (![null, staged, intent.sidecarPath].includes(job.sidecarPath)) {
    return no('resume-mismatch', 'sidecarPath is neither the staged sidecar nor the intent’s')
  }
  if (job.sidecarRead !== null) {
    const sha = crypto.createHash('sha256').update(job.sidecarRead.bytes).digest('hex')
    if (sha !== intent.approvedSidecarSha256) {
      return no('sidecar-not-approved', 'the sidecar bytes are not the ones the intent approved')
    }
  }
  return { ok: true, cleared: mp.cleared }
}
