/**
 * SMI-2180: Database Driver Exports
 *
 * Re-exports all database drivers and utilities.
 */

export {
  BetterSqlite3Database,
  createBetterSqlite3Database,
  isBetterSqlite3Available,
} from './betterSqlite3Driver.js'

// sql.js driver will be added in Wave 2 (SMI-2182)
// export { SqlJsDatabase, createSqlJsDatabase } from './sqljsDriver.js'
