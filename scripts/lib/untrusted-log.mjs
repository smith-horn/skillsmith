/**
 * Print text a PR author (or any PR-write integration) controls, such as an opt-out's reason
 * paragraph, without letting GitHub Actions parse it as workflow commands (SMI-7164).
 *
 * A line like `::error file=x,line=1::...` in printed text would otherwise become a forged
 * annotation. `::stop-commands::<token>` makes the runner ignore commands until `::<token>::`.
 * The token is random per call, so the text cannot guess it and end the window early.
 * Outside Actions the two marker lines are inert.
 */
import { randomBytes } from 'node:crypto'

export function logUntrusted(text, { log = console.log, token } = {}) {
  const t = token ?? randomBytes(16).toString('hex')
  log(`::stop-commands::${t}`)
  log(text)
  log(`::${t}::`)
}
