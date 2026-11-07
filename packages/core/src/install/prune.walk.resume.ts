/**
 * SMI-6531 (A1 step 6c-i): what a resumed run checks before it touches
 * anything. `decodeJob` is fs-free, so these checks read what a crashed run
 * left on disk:
 *  1. the staging directory passes `resumeStagingProblem`;
 *  2. `S/inventory.json` reads stably, parses strictly, and its bytes have the
 *     digest the job carries (the inventory the user was shown);
 *  3. `S` is still the staging directory the inventory recorded (R1);
 *  4. the intent, the `deleting` marker and the inventory are one run's
 *     (`runBindingProblem`: run ID, the marker's digest, the leaf), and the
 *     job's op dir is the intent's.
 * A leftover without a valid inventory, intent and marker is never resumed as
 * a delete. Read-only; nothing here deletes.
 *
 * @module @skillsmith/core/install/prune.walk.resume
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { errCode } from './park-result.js'
import { loadInventory, stagingMatches } from './prune.inventory.js'
import type { PruneInventory } from './prune.inventory.js'
import type { ResumeJob } from './prune.job.js'
import { parseDeletingStrict, parseIntentStrict, runBindingProblem } from './prune.metadata.js'
import type { MetaRecord } from './prune.metadata.js'
import { readStable } from './prune.sidecar.js'
import { resumeStagingProblem } from './prune.walk.shared.js'

export type ResumeCheck =
  | { ok: true; inv: PruneInventory; record: MetaRecord; sStat: BigIntStats }
  | { ok: false; reason: string; detail: string }

const INTENT_MAX_BYTES = 16 * 1024

/** The checks a resume job must pass before anything else runs. */
export function checkResume(job: ResumeJob): ResumeCheck {
  const S = job.S
  const no = (reason: string, detail: string): ResumeCheck => ({ ok: false, reason, detail })
  let sStat: BigIntStats
  try {
    sStat = fs.lstatSync(S, { bigint: true })
  } catch (err) {
    return no('staging-unusable', `${S}: unreadable (${errCode(err)})`)
  }
  const bad = resumeStagingProblem(S, job.stagingRoot, sStat.dev)
  if (bad !== null) return no('staging-unusable', `${S}: ${bad}`)
  const ld = loadInventory(S)
  if (!ld.ok) return no('no-inventory', `${S}: ${ld.why}; nothing is deleted without one`)
  if (ld.digest !== job.inventorySha256) {
    return no('inventory-changed', 'the inventory on disk is not the one the listing showed')
  }
  if (!stagingMatches(ld.inv.staging, sStat)) {
    return no('staging-unusable', `${S} is not the staging directory the inventory recorded`)
  }
  if (ld.inv.leaf !== job.leaf) return no('resume-mismatch', 'the leaf is not the inventory’s')
  const meta = <T>(name: string, parse: (b: Buffer) => T | null): T | null => {
    const rs = readStable(path.join(S, name), { maxBytes: INTENT_MAX_BYTES })
    return rs.ok ? parse(rs.bytes) : null
  }
  const intent = meta('intent.json', parseIntentStrict)
  const marker = meta('deleting', parseDeletingStrict)
  const unbound = runBindingProblem({ intent, marker, inv: ld.inv, digest: ld.digest })
  if (unbound !== null || intent === null) return no('inventory-unbound', `${S}: ${unbound}`)
  if (job.opDir !== path.dirname(intent.copyPath)) {
    return no('resume-mismatch', 'opDir is not the op dir the intent recorded')
  }
  return { ok: true, inv: ld.inv, record: ld.record, sStat }
}
