/**
 * SMI-5615 Mode-B diff-audit follow-up (Wave 2 pass): a single version-stamped
 * `Logger` instance shared across every CLI command file, instead of each
 * file independently calling `getLogger('cli')` (which stamps every record
 * `version: 'unknown'` — `getLogger`'s memoized default has no way to receive
 * a version after the first caller wins). `createLogger('cli', { version })`
 * is created ONCE here, at module load, using this package's real version
 * (`VERSION` from `./version.js`), so every CLI disk log record can be
 * correlated to the exact CLI build that produced it.
 */

import { createLogger, type Logger } from '@skillsmith/core/logging'
import { VERSION } from './version.js'

let cliLogger: Logger | undefined

export function getCliLogger(): Logger {
  if (!cliLogger) {
    cliLogger = createLogger('cli', { version: VERSION })
  }
  return cliLogger
}
