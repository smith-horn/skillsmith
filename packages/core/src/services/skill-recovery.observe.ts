/**
 * SMI-6531 (A1 step 6b-i): what the classifier reads of an op dir whose
 * record file failed, for `--park` (design § 1.1, bf-1k0 Major 1).
 *
 * `observeUnreadable(r, euid, cls, op, names)` runs only for an `unreadable`
 * class whose op dir was `lstat`ed as a directory and listed (the record file
 * itself failed: it could not be opened or read, is not a regular file, does
 * not parse, does not verify, or is inconsistent). It reads, through the
 * reader so the re-plan digest covers each:
 *
 *  - a no-follow `lstat` of every entry of OP, which binds the identities the
 *    park's entry check (`opDiffers`, UD40) requires;
 *  - `treeHash(OP)`: `treeHashOf`, the same `pathTreeRecord` walk and
 *    `computeTreeHash` the park's guard uses (`gateAndBind` calls
 *    `computePathTreeHash`). OP is guardable exactly when this is `ok`, and
 *    `--park` is offered only then: there is no unverified park. Because the
 *    fact is in the transcript, a change between the plan and the re-plan
 *    under lock 1 (guardable to not, or a file added) is `plan-changed`;
 *  - `owner.json`, when present, parsed as an object: the source of O1's
 *    attribution (client and parked index), validated elsewhere.
 *
 * The check is mount-tolerant, as `treeHashOf` is, while the park refuses a
 * mount, so "guardable" does not promise the park moves OP (C14): a mount
 * inside OP passes here and ends `kept/mount-inside-tree` with nothing moved.
 *
 * Read-only, through the reader only (this module has no `fs`).
 *
 * @module @skillsmith/core/services/skill-recovery.observe
 */
import path from 'node:path'
import type { ClassifierReader } from './skill-recovery.reader.js'
import type { RecoveryClass, StatFact } from './skill-recovery.types.js'
import { OWNER_FILE } from './skill-swap.types.js'

/** The most of `owner.json` the classifier reads. */
export const OWNER_CAP = 4096

type Unreadable = Extract<RecoveryClass, { kind: 'unreadable' }>

/** Parses bytes as a JSON object, or null. */
function objectOf(bytes: Buffer | null): Record<string, unknown> | null {
  if (bytes === null) return null
  try {
    const v: unknown = JSON.parse(bytes.toString('utf8'))
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Attaches what `--park` needs to an `unreadable` class whose op dir was listed. */
export function observeUnreadable(
  r: ClassifierReader,
  euid: number,
  cls: Unreadable,
  op: Extract<StatFact, { ok: true }>,
  names: readonly string[]
): Unreadable {
  const entries = [...names]
    .sort()
    .map((name) => ({ name, stat: r.stat(path.join(cls.opDir, name)) }))
  const hash = r.treeHash(cls.opDir)
  const owner = names.includes(OWNER_FILE)
    ? objectOf(r.readFile(path.join(cls.opDir, OWNER_FILE), OWNER_CAP).bytes)
    : null
  return {
    ...cls,
    observed: {
      identity: op.identity,
      uid: op.uid,
      otherUid: op.uid !== euid ? op.uid : null,
      entries,
      hash,
      owner,
    },
  }
}
