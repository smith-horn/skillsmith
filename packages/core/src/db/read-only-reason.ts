/**
 * SMI-7260: why a database handle refuses writes, when its driver says so.
 *
 * Only the sql.js driver exposes `readOnlyReason`, set when another process may
 * hold, or has changed, the database file (see drivers/sqljsDriver.holder.ts).
 * The native driver never does. Read structurally so callers need not know
 * which driver they hold.
 */

import type { Database } from './database-interface.js'

export function readOnlyReasonOf(db: Database): string | undefined {
  const reason = (db as { readOnlyReason?: unknown }).readOnlyReason
  return typeof reason === 'string' ? reason : undefined
}
