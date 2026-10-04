/**
 * SMI-6967 H-1 correction, split out of `ruflo-bridge-state.ts` to stay under
 * this repo's <500-line-per-file convention (CLAUDE.md § CI Health
 * Requirements) — a leaf module with no dependency on the rest of that file.
 *
 * The gate below originally compared `now` against a single hardcoded
 * wall-clock date (`DEFAULT_EXPECTED_BY_ISO`, A5.5.2's `expectedBy` — see
 * smi-6744-ruflo-intelligence-substrate-repair.md:126-130). That date is the
 * same for every checkout, so a checkout created (or re-cloned) after that
 * date had already elapsed the grace window on its very first session,
 * before it had ever had a chance to merge anything — the gate exists to
 * distinguish "this checkout hasn't had a chance yet" from "the writer is
 * broken," and a global constant cannot do that once enough wall-clock time
 * has passed for EVERY checkout, not just old ones.
 *
 * Fix: anchor the grace window to something genuinely per-checkout that
 * needs no write from the reader — the mtime of the probe script
 * (`scripts/ruflo-bridge-probe.mjs`) as checked out in the main repo this
 * key resolves to. `git` writes file content at checkout/merge time with the
 * CURRENT wall-clock time as mtime (it does not preserve the commit's
 * authorship date), so a freshly-created checkout gets a recent mtime and an
 * old checkout keeps an old one. A checkout where the file does not exist at
 * all structurally cannot have run the probe, so {@link hasExpectedByPassed}
 * treats a null `installedAt` as "not elapsed" — never as a reason to render
 * loudly. This is a read-only derivation: nothing here writes state, by
 * design (the session-priming reader must never gain a write side effect).
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'

export function resolveProbeScriptPath(mainRepoKey: string): string {
  return join(mainRepoKey, 'scripts', 'ruflo-bridge-probe.mjs')
}

/**
 * When THIS checkout's working tree first received the probe script, or
 * `null` when the script is not present on disk at all (an older checkout
 * that predates this feature, or one that has never merged it). See this
 * module's own doc comment for why this is the anchor.
 */
export function resolveProbeInstalledAt(mainRepoKey: string): Date | null {
  try {
    return statSync(resolveProbeScriptPath(mainRepoKey)).mtime
  } catch {
    return null
  }
}

/** One day — the same grace sizing D1.2 originally chose, now applied per-checkout rather than globally. */
export const EXPECTED_BY_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Whether `now` is past the point THIS checkout may expect a probe entry to
 * exist. `installedAt === null` (the probe script was never on disk in this
 * checkout) always means "not elapsed" — a checkout that structurally
 * cannot have run the probe is never treated as overdue.
 */
export function hasExpectedByPassed(
  now: Date,
  installedAt: Date | null,
  graceMs: number = EXPECTED_BY_GRACE_MS
): boolean {
  if (installedAt === null) return false
  return now.getTime() - installedAt.getTime() >= graceMs
}
