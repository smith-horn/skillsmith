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
 * key resolves to. A checkout where the file does not exist at all
 * structurally cannot have run the probe, so {@link hasExpectedByPassed}
 * treats an `absent` reading as "not elapsed" — never as a reason to render
 * loudly. This is a read-only derivation: nothing here writes state, by
 * design (the session-priming reader must never gain a write side effect).
 *
 * SMI-6967 M-3 correction of this doc comment's own prior claim. `git`
 * writes file content at checkout/merge time with the CURRENT wall-clock
 * time as mtime (it does not preserve the commit's authorship date) — but
 * the prior wording here implied the window only reopens when a NEW probe
 * version is installed. Measured and false: `git checkout <other> && git
 * checkout <back>`, a `git stash`/`pop`, a rebase replay, or any non-`-a`
 * copy ALL rewrite the file's bytes on disk even when the content is
 * BYTE-IDENTICAL to what was already there, and every one of those bumps
 * mtime to "now." So the window can reopen on a long-lived checkout that
 * never installed anything new — a false "not elapsed" on a writer that may
 * in fact be broken. This always errs in ONE direction: toward SUPPRESSING
 * the loud render, never toward a false alarm (a checkout can only look
 * newer than it is, never older) — consistent with every other gate in this
 * module preferring silence to a false positive. A genuinely monotonic,
 * reader-side-only anchor would close this; two candidates worth evaluating
 * before implementing either (not done here, unasked): the OLDEST mtime
 * among this checkout's `~/.skillsmith` state-dir siblings (a proxy for "when
 * this machine first ran anything from this feature," read-only from the
 * reader's side), or a writer-persisted first-seen timestamp (the probe
 * itself records, on its very first successful write for a key, an
 * `installedAt` that never gets overwritten — this does add a write, which
 * is exactly what this module's own design note above rules out for the
 * READER, but not necessarily for the WRITER).
 */

import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/**
 * SMI-6967 L-2: `mainRepoKey` must be a real absolute path before it is
 * joined and handed to `statSync` — `join('', 'scripts', …)` silently
 * resolves to a path relative to `process.cwd()`, which can stat an
 * unrelated file that happens to exist there and report a wrong, misleading
 * `installed` verdict instead of failing closed. Returns `null` for an
 * empty or non-absolute key so the caller never performs that stat at all.
 */
export function resolveProbeScriptPath(mainRepoKey: string): string | null {
  if (!mainRepoKey || !isAbsolute(mainRepoKey)) return null
  return join(mainRepoKey, 'scripts', 'ruflo-bridge-probe.mjs')
}

/**
 * SMI-6967 H-2: a THREE-way outcome, not `Date | null`. The prior two-way
 * shape collapsed "the probe script was never installed" (ENOENT —
 * structurally cannot have run; correctly quiet) and "the filesystem could
 * not answer the question" (EACCES, ENOTDIR, ELOOP, … — a reader-axis
 * failure) onto the same `null`, so every permission error or other I/O
 * fault silently suppressed the loud render forever, exactly the "could not
 * ask is never silently healthy" rule this whole module exists to enforce
 * one layer up. Measured with positive and negative controls as a non-root
 * uid: a readable script, an `EACCES` directory, and a genuinely absent
 * script all returned the SAME `null` before this fix.
 */
export type ProbeInstall =
  | { kind: 'installed'; at: Date }
  | { kind: 'absent' } // ENOENT only — structurally cannot have run
  | { kind: 'unknown'; errno: string } // anything else — could not ask

/**
 * When THIS checkout's working tree first received the probe script. See
 * this module's own doc comment for why this is the anchor, and
 * {@link ProbeInstall}'s doc comment for why the result is three-way.
 */
export function resolveProbeInstalledAt(mainRepoKey: string): ProbeInstall {
  const scriptPath = resolveProbeScriptPath(mainRepoKey)
  if (scriptPath === null) return { kind: 'absent' }
  try {
    return { kind: 'installed', at: statSync(scriptPath).mtime }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unknown', errno: code ?? String(err) }
  }
}

/** One day — the same grace sizing D1.2 originally chose, now applied per-checkout rather than globally. */
export const EXPECTED_BY_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * Whether `now` is past the point THIS checkout may expect a probe entry to
 * exist. `install.kind === 'absent'` (the probe script was never on disk in
 * this checkout) always means "not elapsed" — a checkout that structurally
 * cannot have run the probe is never treated as overdue. SMI-6967 H-2:
 * `install.kind === 'unknown'` (could not even determine whether the script
 * is installed) always means "elapsed" — a reader that cannot do its job
 * must say so loudly, never silently pass as healthy.
 */
export function hasExpectedByPassed(
  now: Date,
  install: ProbeInstall,
  graceMs: number = EXPECTED_BY_GRACE_MS
): boolean {
  if (install.kind === 'absent') return false
  if (install.kind === 'unknown') return true
  return now.getTime() - install.at.getTime() >= graceMs
}
