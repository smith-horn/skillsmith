/**
 * SMI-6531 (A1 step 6c-ii-b): the pure helpers `planPrune` orders and digests
 * with. No fs; the only builtin is `crypto`.
 *
 *  - `bytewise`: UD60's order, ascending by the UTF-8 bytes (`Buffer.compare`).
 *    Default `sort()` and `localeCompare` both compare UTF-16 code units, which
 *    put U+1F600 (a surrogate pair, 0xD83D...) before U+FF5A; the bytes put
 *    U+FF5A (EF BD 9A) first (design note section 5.1, M-ORD, measured).
 *  - `groupDigest`: sha256 over a canonical serialization of the lock path and,
 *    per item in bytewise `copyPath` order, its `copyPath`, `rootIdentity`
 *    (bigints as decimal strings, `fmt` included), the sidecar bytes' sha256,
 *    `approvedHash`, `klass`, kind and tier (design note section 2).
 *
 * @module @skillsmith/core/install/prune.select.digest
 */
import crypto from 'node:crypto'
import type { PlanItem } from './prune.plan.types.js'

/** Ascending bytewise order of two strings' UTF-8 encodings (UD60). */
export const bytewise = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

const sha256 = (data: string | Buffer): string =>
  crypto.createHash('sha256').update(data).digest('hex')

/** First 16 hex characters of sha256 over a skills root, as `rootKeyOf` in `skill-swap.area.ts`. */
export const rootKeyOf = (root: string): string => sha256(root).slice(0, 16)

/** The fields of one item the digest covers, in a fixed order. */
function canonicalItem(i: PlanItem): unknown[] {
  const id = i.rootIdentity
  return [
    i.copyPath,
    [String(id.dev), String(id.ino), String(id.birthtimeNs), String(id.fmt)],
    i.sidecarRead === null ? null : sha256(i.sidecarRead.bytes),
    i.approvedHash,
    i.klass,
    i.kind,
    i.tier,
  ]
}

/** sha256 over the group's lock path and its items, in bytewise `copyPath` order. */
export function groupDigest(lockPath: string, items: readonly PlanItem[]): string {
  const ordered = [...items].sort((a, b) => bytewise(a.copyPath, b.copyPath))
  return sha256(JSON.stringify([lockPath, ordered.map(canonicalItem)]))
}
