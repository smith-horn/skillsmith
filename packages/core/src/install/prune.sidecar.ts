/**
 * SMI-6531 (A1 step 6c-i): the stable read and the strict sidecar schema for
 * prune (ADR-166 D-11), ported from the SMI-6676 spike's `prune.sidecar.mjs`.
 *
 * Two stores carry a sidecar beside each copy, and both are parsed here:
 *  - a parked copy (`<area>/.skillsmith-parked/<opId>/<name>-<8 hex>`, sidecar
 *    written by `park-tree.postmove.ts`), in one of three shapes: `U` (parked
 *    without a guard hash), `Q` (verified after the move) and `H` (held). Its
 *    recorded hash is `postMoveTreeHash`;
 *  - a kept tree in the update backup area (`<area>/<dirName>/<opId>` or
 *    `<opId>.<kind>[.<k>]`, sidecar `Sidecar` from `skill-swap.sidecar.ts`),
 *    shape `B`, checked by the one shared strict parser
 *    (`backup-sidecar.strict.ts`) plus where the tree sits. Its recorded hash
 *    is `treeHash`.
 * A sidecar that fails the schema of its store counts as unverified, never
 * clean (ADR-166 D-10 item 4).
 *
 * The strict schema itself has no filesystem access and lives in
 * `prune.sidecar.strict.ts` (re-exported here), so doctor's fs-free
 * classifier can ask restore's own sidecar question (SMI-6531, #3283).
 *
 * fs is imported as the DEFAULT export only, and every call looks its method
 * up at call time, so an interposer sees every call (D-11 "Enforcement in tests").
 *
 * No caller yet: 6c-ii's listing and 6c-iii's `--prune --apply` use it.
 *
 * @module @skillsmith/core/install/prune.sidecar
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { errCode } from './park-result.js'

export { parseSidecarStrict } from './prune.sidecar.strict.js'
export type { SidecarParse, SidecarShape, SidecarStore } from './prune.sidecar.strict.js'

/** A stable read that succeeded: the bytes, and the descriptor's metadata. */
export interface StableReadOk {
  ok: true
  bytes: Buffer
  dev: bigint
  ino: bigint
  size: bigint
  mode: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

export type StableRead =
  | StableReadOk
  | {
      ok: false
      reason:
        | 'unreadable'
        | 'not-a-file'
        | 'too-large'
        | 'replaced-while-reading'
        | 'changed-while-reading'
      errno: string | null
    }

/**
 * The stable read: open with O_NOFOLLOW, require the descriptor's inode to be
 * the one lstat names, read everything, fstat again, and require size, mtimeNs
 * and ctimeNs unchanged. A same-size write between the two reads changes ctime
 * (ns resolution where the filesystem has it) and is reported, never returned
 * as data.
 *
 * `afterRead` is a test seam: called after the read, before the second fstat.
 * `maxBytes` refuses a larger file (`too-large`) before it is opened, and
 * again from the descriptor's own size before anything is read.
 */
export function readStable(
  p: string,
  { afterRead, maxBytes }: { afterRead?: () => void; maxBytes?: number } = {}
): StableRead {
  let ls: BigIntStats
  try {
    ls = fs.lstatSync(p, { bigint: true })
  } catch (err) {
    return { ok: false, reason: 'unreadable', errno: errCode(err) }
  }
  if (!ls.isFile()) return { ok: false, reason: 'not-a-file', errno: null }
  if (maxBytes !== undefined && ls.size > BigInt(maxBytes)) {
    return { ok: false, reason: 'too-large', errno: null }
  }
  let fd: number
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (err) {
    return { ok: false, reason: 'unreadable', errno: errCode(err) }
  }
  try {
    const a = fs.fstatSync(fd, { bigint: true })
    if (a.ino !== ls.ino || a.dev !== ls.dev) {
      return { ok: false, reason: 'replaced-while-reading', errno: null }
    }
    if (maxBytes !== undefined && a.size > BigInt(maxBytes)) {
      return { ok: false, reason: 'too-large', errno: null }
    }
    const bytes = fs.readFileSync(fd)
    if (typeof afterRead === 'function') afterRead()
    const b = fs.fstatSync(fd, { bigint: true })
    if (
      b.size !== a.size ||
      b.mtimeNs !== a.mtimeNs ||
      b.ctimeNs !== a.ctimeNs ||
      BigInt(bytes.length) !== a.size
    ) {
      return { ok: false, reason: 'changed-while-reading', errno: null }
    }
    return {
      ok: true,
      bytes,
      dev: a.dev,
      ino: a.ino,
      size: a.size,
      mode: a.mode,
      mtimeNs: a.mtimeNs,
      ctimeNs: a.ctimeNs,
    }
  } catch (err) {
    return { ok: false, reason: 'unreadable', errno: errCode(err) }
  } finally {
    fs.closeSync(fd)
  }
}
