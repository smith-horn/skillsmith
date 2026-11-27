/**
 * SMI-7260: driver-independent views of a database handle's read-only state.
 *
 * Only the sql.js (WASM) driver exposes `readOnlyReason` and `seal()`: a
 * file-backed sql.js handle never writes to disk, and is read-only once sealed
 * (see drivers/sqljsDriver.ts). The native driver has neither. Read
 * structurally so callers need not know which driver they hold.
 */

import type { Database } from './database-interface.js'
import type { WasmAdvice } from './wasm-read-only.js'

/**
 * Why this handle refuses writes, as one line for the user, or `undefined`
 * when it may write. Set only by the sql.js driver, once a file-backed handle
 * is sealed.
 */
export function readOnlyReasonOf(db: Database): string | undefined {
  const reason = (db as { readOnlyReason?: unknown }).readOnlyReason
  return typeof reason === 'string' ? reason : undefined
}

/**
 * SMI-7271: the native-driver advice a sql.js handle captured when it opened,
 * or `undefined` for any other handle. Read structurally, like the reason.
 */
export function nativeAdviceOf(db: Database): WasmAdvice | undefined {
  const advice = (db as { nativeAdvice?: unknown }).nativeAdvice
  return typeof advice === 'object' && advice !== null ? (advice as WasmAdvice) : undefined
}

/**
 * Whether writes on this handle will be refused: a sealed sql.js handle, or a
 * handle either driver opened with `{ readonly: true }`.
 */
export function isReadOnlyHandle(db: Database): boolean {
  return readOnlyReasonOf(db) !== undefined || db.readonly === true
}

/**
 * Seal a handle after its opener has finished setting it up (SMI-7260 D1).
 *
 * A sql.js handle for a database file that did not exist starts as a writable
 * in-memory database so its opener can build the schema; this makes it
 * read-only for every later caller. A no-op on the native driver, on
 * `:memory:`, and on a handle that is already sealed.
 */
export function sealDatabase(db: Database): void {
  const seal = (db as { seal?: unknown }).seal
  if (typeof seal === 'function') (seal as () => void).call(db)
}
