/**
 * SMI-6531 (#3283): the part of `skillsmith restore`'s decision that a copy's
 * sidecar bytes and its fresh tree hash settle, with no filesystem access, so
 * `planRestore` (`skill-restore.ts`) and doctor's install classifier
 * (`skill-recovery.classify.install.ts`, FI4's note) ask one function and
 * cannot disagree on it.
 *
 *  - `sidecarVerdict`: restore's first refusals, in its order: no sidecar
 *    bytes, a sidecar that fails the strict parked schema, or an origin that is
 *    not absolute (`origin-unknown`); a kind this version does not know
 *    (`restore-kind-unknown`); a kind whose origin is Skillsmith's own scratch
 *    space (`nothing-to-restore-into`). Each refusal carries restore's own
 *    message.
 *  - `contentsOf` and `saysDiffers`: whether restore's done message will say
 *    the copy "differs from what was set aside" (a held copy, or one whose
 *    fresh hash is not the sidecar's).
 *
 * The rest of restore's decision needs the filesystem at the time it runs (a
 * mount inside the copy, the origin's parent, the lock, the target) and stays
 * in `planRestore`.
 *
 * @module @skillsmith/core/services/skill-restore.verdict
 */
import path from 'node:path'
import { parseSidecarStrict } from '../install/prune.sidecar.strict.js'
import { restoreClassOf } from './skill-restore.kinds.js'
import type { RestoreContents, RestoreRefusalReason } from './skill-restore.types.js'

type SidecarVerdict<R extends { bytes: Buffer } = { bytes: Buffer }> =
  | {
      ok: true
      /** The sidecar read the verdict came from (never null once it is ok). */
      read: R
      /** The strictly parsed sidecar. */
      sidecar: Record<string, unknown>
      kind: string
      /** Where the copy came from: absolute. */
      origin: string
      /** The park held it (`hold: true`). */
      held: boolean
    }
  | { ok: false; reason: RestoreRefusalReason; message: string }

/**
 * Restore's sidecar-settled verdict on the parked copy at `copyPath`, whose
 * op directory is named `parentName`, from its sidecar's read (null: none).
 * On `ok: true` it returns that read, so a caller's type narrows to non-null.
 */
export function sidecarVerdict<R extends { bytes: Buffer }>(
  read: R | null,
  copy: { copyPath: string; parentName: string }
): SidecarVerdict<R> {
  const unknownOrigin: SidecarVerdict<R> = {
    ok: false,
    reason: 'origin-unknown',
    message: `The record beside \`${copy.copyPath}\` can't be read, so where it came from is unknown. Copy what you need from it by hand.`,
  }
  if (read === null) return unknownOrigin
  const parsed = parseSidecarStrict(read.bytes, { ...copy, store: 'parked' })
  if (!parsed.ok) return unknownOrigin
  const sc = parsed.sidecar
  const kind = String(sc.kind)
  const origin = String(sc.originPath)
  if (!path.isAbsolute(origin)) return unknownOrigin
  const cls = restoreClassOf(kind)
  if (cls === null) {
    return {
      ok: false,
      reason: 'restore-kind-unknown',
      message: `\`${copy.copyPath}\` has a kind (\`${kind}\`) this version of Skillsmith doesn't know, so it won't restore it.`,
    }
  }
  if (!cls.restorable) {
    return {
      ok: false,
      reason: 'nothing-to-restore-into',
      message: `\`${copy.copyPath}\` came from Skillsmith's own ${cls.what}, so there is nothing to restore it into. Copy what you need from it by hand.`,
    }
  }
  return { ok: true, read, sidecar: sc, kind, origin, held: sc.hold === true }
}

/** Whether the copy still holds what its sidecar recorded, from the hash taken now. */
export function contentsOf(
  sidecar: Record<string, unknown>,
  freshHash: string | null
): RestoreContents {
  const recorded = typeof sidecar.treeHash === 'string' ? sidecar.treeHash : null
  if (recorded === null)
    return { state: 'not-checked', why: 'no hash was recorded when it was set aside' }
  if (freshHash === null) return { state: 'not-checked', why: 'the copy could not be hashed now' }
  return { state: recorded === freshHash ? 'unchanged' : 'changed' }
}

/** Restore's done message says the copy "differs from what was set aside". */
export const saysDiffers = (held: boolean, contents: RestoreContents): boolean =>
  held || contents.state === 'changed'
