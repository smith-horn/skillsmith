/**
 * @fileoverview PLACEHOLDER — `.skillsmith-staging/` recovery-record check
 * for the update eligibility gate (SMI-6532, A2 §4.2).
 * @module @skillsmith/core/services/update-target.probe.recovery
 * @see docs/internal/implementation/update-safety-and-source-resolution.md §4.2
 *
 * `.skillsmith-staging/` RECORD CHECK — DOCUMENTED AMBIGUITY. §4.2 says a
 * missing tracked folder named by a `.skillsmith-staging/` record is
 * `recovery-pending`, not plain-missing. A1's staging writer
 * (`skill-write-lock.ts`, `skill-swap.ts`) and its `record.json` schema do
 * not exist in this tree yet (confirmed: no `skill-write-lock*`/
 * `skill-swap*` file exists under `packages/core/src/services/` as of this
 * writing). `defaultRecoveryPendingChecker` below is therefore the SAME
 * kind of placeholder as `temporaryManifestEvidenceResolver`
 * (`update-target.evidence.ts`) — injectable via `ProbeInput.
 * checkRecoveryPending` (declared in `./update-target.probe.ts`), with a
 * best-effort default scan, swapped out once A1's real record shape lands.
 * This is flagged back to the requester as an open ambiguity, not silently
 * guessed at as settled fact.
 *
 * WHY THIS IS ITS OWN FILE, NOT PART OF `update-target.probe.ts`: this
 * placeholder's whole purpose is to be replaced WHOLESALE, as a single
 * unit, the moment A1's real `record.json` schema lands — not edited
 * incrementally alongside the rest of the probe. A thing destined to be
 * swapped out entire belongs in its own file, so that swap is a clean file
 * replacement (plus updating the one import in `update-target.probe.ts`),
 * never a diff threaded through code that has nothing to do with A1.
 *
 * `RecoveryPendingChecker` is imported from `update-target.probe.types.ts`,
 * NOT from `update-target.probe.ts` — this module and `probe.ts` never
 * import from each other (see `update-target.probe.types.ts`'s own
 * fileoverview for why that appearance, even as a type-only import that
 * erases before any runtime cycle could exist, was worth removing).
 */

import * as fs from 'fs/promises'
import * as path from 'path'

import type { RecoveryPendingChecker } from './update-target.probe.types.js'

const STAGING_DIRNAME = '.skillsmith-staging'
const STAGING_RESERVED = new Set(['.kept', '.trash', '.quarantine'])

/**
 * PLACEHOLDER — see this module's fileoverview `.skillsmith-staging/`
 * section. Best-effort scan: read every non-reserved entry directly under
 * `<skillsDir>/.skillsmith-staging/`, parse its `record.json`, and treat the
 * directory as named if any string VALUE anywhere in the parsed record
 * equals `dir` or `dirName`.
 *
 * Fails SAFE, not permissive: any error reading `.skillsmith-staging/`
 * itself, or one op dir's `record.json`, is treated as "not named" (false)
 * — the caller then reports plain `probe-failed` (still blocking) rather
 * than ever reaching a permissive `ok`.
 */
export const defaultRecoveryPendingChecker: RecoveryPendingChecker = async ({
  skillsDir,
  dir,
  dirName,
}) => {
  const stagingDir = path.join(skillsDir, STAGING_DIRNAME)
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(stagingDir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || STAGING_RESERVED.has(entry.name)) continue
    const recordPath = path.join(stagingDir, entry.name, 'record.json')
    let raw: string
    try {
      raw = await fs.readFile(recordPath, 'utf-8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (recordNames(parsed, dir, dirName)) return true
  }
  return false
}

function recordNames(value: unknown, dir: string, dirName: string): boolean {
  if (typeof value === 'string') return value === dir || value === dirName
  if (Array.isArray(value)) return value.some((v) => recordNames(v, dir, dirName))
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((v) => recordNames(v, dir, dirName))
  }
  return false
}
