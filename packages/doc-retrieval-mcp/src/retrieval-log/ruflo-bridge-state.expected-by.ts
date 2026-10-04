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
 * needs no write from the reader — originally the mtime of the probe script
 * (`scripts/ruflo-bridge-probe.mjs`) as checked out in the main repo this
 * key resolves to; see the SMI-6967 PR-gate (H-B) correction below for why
 * that anchor was replaced. A checkout where the file does not exist at all
 * structurally cannot have run the probe, so {@link hasExpectedByPassed}
 * treats an `absent` reading as "not elapsed" — never as a reason to render
 * loudly. This is a read-only derivation: nothing here writes state, by
 * design (the session-priming reader must never gain a write side effect).
 *
 * SMI-6967 M-3 correction of this doc comment's own prior claim (superseded
 * by the H-B fix below, kept for the historical record of WHY mtime was
 * wrong). `git` writes file content at checkout/merge time with the CURRENT
 * wall-clock time as mtime (it does not preserve the commit's authorship
 * date) — but the prior wording here implied the window only reopens when a
 * NEW probe version is installed. Measured and false: `git checkout <other>
 * && git checkout <back>`, a `git stash`/`pop`, a rebase replay, or any
 * non-`-a` copy ALL rewrite the file's bytes on disk even when the content
 * is BYTE-IDENTICAL to what was already there, and every one of those bumps
 * mtime to "now." So the window could reopen on a long-lived checkout that
 * never installed anything new — a false "not elapsed" on a writer that may
 * in fact be broken, and the reopening is RENEWABLE: every rewrite resets
 * the clock again, so a checkout under active rebase could suppress the
 * loud render indefinitely.
 *
 * SMI-6967 PR-gate (H-B) fix: the anchor is now the COMMIT DATE of the
 * revision that last changed the probe script (`git log -1 --format=%cI --
 * scripts/ruflo-bridge-probe.mjs`, resolved against the main repo), not the
 * working tree's mtime. This is:
 *   - Monotonic and immune to the whole mtime-rewrite class above — a
 *     checkout/rebase/stash-restore/copy that leaves the script's bytes
 *     unchanged does not move the anchor, because nothing short of a new
 *     commit touching the file changes what `git log` reports for it.
 *   - IDENTICAL across every checkout of the same commit (unlike mtime,
 *     which is a local filesystem artifact of when the bytes landed on
 *     THIS disk).
 *   - Reader-only: `git log` never writes anything.
 *   - Still responsive to a genuinely NEW probe version — a real commit
 *     touching the script moves the anchor forward, which correctly resets
 *     the grace period for a new capability.
 * Accepted consequence: a fresh clone of a repo where the probe landed
 * months ago renders "verdict not evaluated" on its very first session —
 * true and actionable (the line names the exact command to run), not a
 * regression; this is a deliberate trade, not an oversight.
 *
 * Every failure path fails LOUD, matching {@link ProbeInstall}'s existing
 * `unknown` contract: `git log` failing, being unavailable (no git binary,
 * not a repository), or returning empty (the file is on disk but untracked
 * — no commit has ever touched it) all read as `unknown`, same as any other
 * reader-axis failure. A commit date that PARSES but lies in the future
 * (clock skew, or archive metadata that preserved a bogus date) also reads
 * as `unknown` rather than being silently clamped to "installed" — a lying
 * answer is exactly what `unknown` exists to flag, not a reason to trust the
 * number anyway. The script being absent from disk (ENOENT) is unaffected
 * by this fix and still reads as `absent`: that is a question about the
 * CURRENT working tree, which `statSync` answers correctly regardless of
 * what anchors the timestamp once the file does exist.
 */

import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { stripGitDiscoveryEnv } from '../_lib/git-fixture-env.js'

/** Single definition of the probe script's repo-relative path — shared by {@link resolveProbeScriptPath} and the `git log` pathspec below so the two can never drift apart. */
const PROBE_RELATIVE_PATH = join('scripts', 'ruflo-bridge-probe.mjs')

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
  return join(mainRepoKey, PROBE_RELATIVE_PATH)
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
 * `git log -1 --format=%cI -- <relPath>`, resolved against `repoDir`. Returns
 * `null` for ANY failure — no git binary, `repoDir` is not a repository, a
 * timeout, or the path has no commit history (untracked/never committed,
 * which exits 0 with empty stdout rather than an error) — the caller folds
 * every one of those into `{ kind: 'unknown' }`, never into `{ kind: 'absent'
 * }` (that axis is decided by the `statSync` existence check that runs
 * before this is ever called).
 *
 * `stripGitDiscoveryEnv` (SMI-5126's production read-path scrub, the same
 * helper `git-commits.ts`'s adapter uses for an analogous `git log` read)
 * strips `GIT_DIR`/`GIT_WORK_TREE`/etc so an ambient discovery var exported
 * by a wrapping hook cannot redirect this read to the wrong repository.
 */
function resolveGitCommitDateIso(repoDir: string, relPath: string): string | null {
  let out: string
  try {
    out = execFileSync('git', ['log', '-1', '--format=%cI', '--', relPath], {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: 5_000,
      env: stripGitDiscoveryEnv({ GIT_OPTIONAL_LOCKS: '0' }),
      // Measured (not assumed): Node's execFileSync leaks a failing child's
      // stderr straight to THIS process's own stderr even with no `stdio`
      // override at all — the thrown error's `.stderr` field is populated
      // either way, but the bytes also print live unless stdio is spelled
      // out explicitly. This runs from the SessionStart priming hook, so a
      // git failure here (no repo, no git binary) must stay silent on the
      // "could not ask" path — the caller already renders that loudly as
      // its own `unknown` line; a raw "fatal: not a git repository" leaking
      // onto the user's terminal on top of that would be confusing noise
      // from a mechanism nothing here surfaces as a fault.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return null
  }
  const iso = out.trim()
  return iso || null
}

/**
 * When THIS checkout last received a COMMITTED change to the probe script
 * (via `git log`, not the working tree's mtime — see this module's own doc
 * comment for the full H-B rationale and why mtime was wrong). `now` is
 * accepted as a parameter (defaulting to the real clock) so a future-dated
 * commit is judged against the SAME instant the caller's own staleness
 * arithmetic uses, and so tests can pin it. See {@link ProbeInstall}'s doc
 * comment for why the result is three-way.
 */
export function resolveProbeInstalledAt(mainRepoKey: string, now: Date = new Date()): ProbeInstall {
  const scriptPath = resolveProbeScriptPath(mainRepoKey)
  if (scriptPath === null) return { kind: 'absent' }
  try {
    statSync(scriptPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unknown', errno: code ?? String(err) }
  }

  const iso = resolveGitCommitDateIso(mainRepoKey, PROBE_RELATIVE_PATH)
  if (iso === null) {
    return {
      kind: 'unknown',
      errno: `git log could not date ${PROBE_RELATIVE_PATH} (no git, not a repository, no commit history, or a timeout)`,
    }
  }
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) {
    return { kind: 'unknown', errno: `git log returned an unparseable commit date: ${iso}` }
  }
  if (ms > now.getTime()) {
    return { kind: 'unknown', errno: `git-reported commit date is in the future: ${iso}` }
  }
  return { kind: 'installed', at: new Date(ms) }
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
