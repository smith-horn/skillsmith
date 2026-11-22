/**
 * SMI-6531 (A1 step 8-i-a-2): `sealInstallRecord`, the one way an install
 * record's bytes are made (design § 2.2). The staged install (8-i-a-3)
 * publishes what it returns with `publishBytes`; every fixture of this step is
 * built with it, so the classifier is tested against the writer's exact bytes.
 *
 * It refuses a `postTree` that is not a hash, or is the empty tree's (a built
 * install always holds `SKILL.md`, and an empty claim must never read as the
 * published folder); then hashes, serializes once (as `publishJson` writes
 * JSON: two-space indent and a newline) and runs the scan's own checks on
 * those exact bytes (`verifyRecordBytes`, UD47), so a record it returns is one
 * the scan accepts. It returns a result rather than throwing, and touches no
 * filesystem.
 *
 * @module @skillsmith/core/services/skill-install.record-seal
 */
import { computeInstallRecordSha256, EMPTY_TREE_HASH } from './skill-install.record-schema.js'
import type { InstallRecord } from './skill-install.record-schema.js'
import { verifyRecordBytes } from './skill-swap.record-schema.js'
import { HEX64 } from './skill-swap.record-shape.js'

/** Why `sealInstallRecord` refused a body. */
export type InstallSealWhy =
  /** JSON could not serialize it (a cycle, a `BigInt`). */
  | 'not-serializable'
  /** `postTree` is not a 64-hex hash, or is the empty tree's. */
  | 'bad-post-tree'
  /** The scan would not accept the bytes (`detail` is `verifyRecordBytes`'s reason). */
  | 'unreadable'

export type InstallSeal =
  | { ok: true; bytes: Buffer; record: InstallRecord }
  | { ok: false; why: InstallSealWhy; detail: string }

/** Seals `body` as the install record of op dir `opId` in the skills root `root`. */
export function sealInstallRecord(
  body: Omit<InstallRecord, 'recordSha256'>,
  root: string,
  opId: string
): InstallSeal {
  if (!HEX64.test(body.postTree) || body.postTree === EMPTY_TREE_HASH) {
    return { ok: false, why: 'bad-post-tree', detail: `postTree ${body.postTree}` }
  }
  let bytes: Buffer
  try {
    const sealed = { ...body, recordSha256: computeInstallRecordSha256(body) }
    bytes = Buffer.from(JSON.stringify(sealed, null, 2) + '\n')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, why: 'not-serializable', detail }
  }
  const v = verifyRecordBytes(bytes, root, opId)
  if (!v.ok) return { ok: false, why: 'unreadable', detail: v.why }
  if (v.record.op !== 'install') return { ok: false, why: 'unreadable', detail: 'not an install' }
  return { ok: true, bytes, record: v.record }
}
