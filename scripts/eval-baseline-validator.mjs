#!/usr/bin/env node
// SMI-4764 Wave 0: Pre-push validator for retrieval eval baseline freshness.
//
// When ranking files (rerank.ts, search.ts, corpus.config.json, gold-set.json)
// are part of the push, this script enforces that:
//   1. baseline.json is also in the diff (else: reject with repro command)
//   2. baseline.json's sha256 has a matching signature in .signatures.log
//      (signatures are written by eval-runner.ts on each real-mode run)
//   3. That signature's recorded git HEAD (SMI-5708 Item #5) is the commit
//      currently being validated, or an ANCESTOR of it — not required to
//      match exactly. This tolerates the routine case of new commits
//      landing on the same branch after the signature was recorded (this
//      repo's wave-branch-stacking convention, SMI-2597, stacks Wave N+1's
//      commits on top of Wave N's), where an exact-match requirement would
//      false-reject a still-legitimately-fresh signature. It does NOT cover
//      an actual `git rebase`/`commit --amend`: those produce a NEW commit
//      sha that is a SIBLING of the original (same parent), not a
//      descendant of it — ancestor-checking correctly requires a fresh
//      signature after an actual rebase/amend, since the content
//      relationship to what was signed is no longer guaranteed (Codex
//      review finding — an earlier version of this comment incorrectly
//      implied rebase/amend was itself tolerated).
//   4. The signature timestamp is fresh:
//        - Ranking-only changes  (rerank.ts, search.ts): 7-day window
//        - Corpus or gold-set changes: 24-hour window
//
// HONEST SCOPE (SMI-5708 Item #5(b)): this whole validator is a
// per-developer ACCIDENTAL-STALENESS check, not a security control. It
// exists to catch "you forgot to re-run the eval before pushing" or "you
// pushed from a branch whose baseline.json was never actually validated
// against this history." It does NOT, and structurally CANNOT, stop a
// determined bad actor: baseline.json and .signatures.log are both ordinary
// tracked files, so anyone with write access can hand-edit baseline.json,
// compute its sha256, and append a matching line — with any headSha they
// like, including a real current HEAD — to .signatures.log in the very
// same commit. A pass from this script proves only "a signature exists
// whose content-hash and headSha-ancestry are consistent with this push,"
// never "a real eval run actually produced this baseline.json." Real
// provenance would require CI-side signing (an artifact signature tied to
// the evaluated commit + corpus hash + runner config hash, generated only
// by trusted CI) — tracked as a follow-up (SMI-5708 Item #5(c)), not built
// in this pass. Nothing downstream should read a pass here as more than
// "looks fresh," and certainly not as a provenance/security guarantee.
//
// Mode branching:
//   SKILLSMITH_EVAL_CANONICAL=true  → validation failure exits 1 (block push)
//   else                            → validation failure prints to stderr and
//                                     exits 0 (advisory mode, push proceeds)
//
// The pre-push hook invokes this script with the pushed-ref data on stdin
// (Phase 0 of .husky/pre-push stashes git's stdin and replays it here so the
// hook can also consume it for delete-only detection).
//
// Falls back to comparing `@{upstream}..HEAD` if stdin is unavailable. If
// still unresolved, exits 0 (no-op) — the script must not break unrelated
// PRs that happen not to push ranking changes.

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const BASELINE_REL = 'packages/doc-retrieval-mcp/eval/baseline.json'
const SIGNATURES_REL = 'packages/doc-retrieval-mcp/eval/.signatures.log'

// Mirrors RANKING_FILES in packages/doc-retrieval-mcp/eval/check-baseline-drift.ts
// (kept in sync; if these drift, audit:standards check 41 should catch it in
// Wave 3). gold-set.json is treated as "corpus class" for freshness windows.
const RANKING_ONLY_FILES = [
  'packages/doc-retrieval-mcp/src/rerank.ts',
  'packages/doc-retrieval-mcp/src/search.ts',
]
const CORPUS_FILES = [
  'packages/doc-retrieval-mcp/src/corpus.config.json',
  'packages/doc-retrieval-mcp/eval/gold-set.json',
]

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR
const RANKING_FRESHNESS_MS = 7 * MS_PER_DAY
const CORPUS_FRESHNESS_MS = 24 * MS_PER_HOUR

const REAL_MODE_REPRO =
  "docker exec -w /app skillsmith-dev-1 sh -c 'SKILLSMITH_REPO_ROOT=/app RETRIEVAL_EVAL_REAL=1 npm run eval:retrieval --workspace=packages/doc-retrieval-mcp'"

function isCanonicalMode() {
  return process.env.SKILLSMITH_EVAL_CANONICAL === 'true'
}

// SMI-5708 Item #14: distinguishes "no upstream to diff against" (genuine
// no-op) from "upstream IS configured but resolution failed" (a real
// failure), via git's own branch config rather than parsing `@{upstream}`'s
// fragile/locale-dependent error text.
function hasUpstreamConfigured() {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    execFileSync('git', ['config', '--get', `branch.${branch}.merge`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the diff range to inspect.
 *
 * Pre-push hook stashes git's stdin and replays it here. Lines come in the form:
 *   <local_ref> <local_sha> <remote_ref> <remote_sha>
 * For new branches remote_sha is all zeros — fall back to the merge-base with
 * origin/main for those, since we still want to validate the ranking diff.
 *
 * SMI-5708 Item #14: used to fall through to a bare `return null` on ANY
 * resolution failure (origin/main not fetched, `@{upstream}` unresolvable) —
 * indistinguishable from a genuine no-op (delete-only push, no upstream
 * configured), the same "silent pass when it can't verify" bug Item #2
 * closed one layer down in `listChangedFiles()`. Now returns
 * `{ ok: true, range }` (`range` may be `null` for a genuine no-op) or
 * `{ ok: false, error }`, routed through the same `emit()` mechanism.
 */
function resolveDiffRange() {
  // Try stdin first (husky / pre-push replay).
  let stdinData = ''
  try {
    stdinData = readFileSync(0, 'utf8')
  } catch {
    // No stdin available (interactive run, tests, etc.) — fall through.
  }

  // SMI-5708 Item #14 (Codex round-2 finding): a resolution failure on ANY
  // ref must take absolute priority over a range resolved on a DIFFERENT
  // ref in the same multi-ref push, regardless of which line comes first —
  // "we couldn't fully verify part of what's being pushed" must not be
  // silently overridden by an unrelated ref's clean resolution. So a
  // successful range is stored (first one wins if there are several), not
  // returned immediately, and `lastError` is checked ahead of it once the
  // loop finishes.
  let lastError = null
  let resolvedRange = null
  let sawParseableLine = false
  const lines = stdinData.split('\n').filter((l) => l.trim().length > 0)
  for (const line of lines) {
    const parts = line.split(/\s+/)
    if (parts.length >= 4) {
      sawParseableLine = true
      const localSha = parts[1]
      const remoteSha = parts[3]
      const zeros = '0000000000000000000000000000000000000000'
      if (localSha === zeros) {
        // Delete-only for THIS ref — a multi-ref push has one line per ref,
        // so this doesn't mean the whole push has nothing to diff.
        continue
      }
      if (remoteSha === zeros) {
        // New branch: diff against origin/main merge-base.
        try {
          const base = execFileSync('git', ['merge-base', 'origin/main', localSha], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
          }).trim()
          if (resolvedRange === null) resolvedRange = { base, head: localSha }
        } catch (err) {
          // origin/main not fetched (or any other merge-base failure) —
          // genuine resolution failure, not a no-op.
          lastError = `merge-base origin/main failed: ${err instanceof Error ? err.message : String(err)}`
        }
      } else if (resolvedRange === null) {
        resolvedRange = { base: remoteSha, head: localSha }
      }
    }
  }

  // A recorded failure from ANY line always wins, even over a range
  // successfully resolved on a different line in the same push.
  if (lastError) return { ok: false, error: lastError }
  if (resolvedRange) return { ok: true, range: resolvedRange }
  // At least one usable line existed and all of them were delete-only —
  // a genuine no-op, not a fallback scenario (don't go compare against the
  // upstream tracking branch when the push itself already said "delete-only").
  if (sawParseableLine) return { ok: true, range: null }

  // Fallback: no usable stdin data at all (interactive run, tests, etc.).
  if (!hasUpstreamConfigured()) {
    return { ok: true, range: null }
  }

  try {
    const upstream = execFileSync('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim()
    return { ok: true, range: { base: upstream, head } }
  } catch (err) {
    return {
      ok: false,
      error: `upstream resolution failed despite an upstream being configured: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Resolve the changed-file list for `range`, distinguishing "diff resolved
 * with zero files" from "diff resolution itself failed" (SMI-5708 Item #2).
 *
 * `range === null` is a deliberate, pre-existing no-op case (delete-only
 * push, or no stdin/no upstream to fall back to -- see resolveDiffRange's
 * doc comment) and is NOT a failure: it returns `{ ok: true, files: [] }`
 * unchanged from before this fix.
 *
 * A thrown `git diff` (e.g. the resolved base/head sha is unreachable in a
 * shallow clone) previously returned `[]` here too, indistinguishable from
 * "nothing changed" -- silently defeating the whole validator. That case now
 * returns `{ ok: false, error }` so the caller can fail closed in canonical
 * mode instead of treating it as a no-op.
 */
function listChangedFiles(range) {
  if (range === null) return { ok: true, files: [] }
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${range.base}..${range.head}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    return { ok: true, files: out.split('\n').filter((l) => l.length > 0) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function classifyDiff(changedFiles) {
  const set = new Set(changedFiles)
  const rankingOnly = RANKING_ONLY_FILES.some((f) => set.has(f))
  const corpus = CORPUS_FILES.some((f) => set.has(f))
  const baselineChanged = set.has(BASELINE_REL)
  return { rankingOnly, corpus, baselineChanged, set }
}

function readBaselineSha() {
  const baselinePath = join(REPO_ROOT, BASELINE_REL)
  if (!existsSync(baselinePath)) return null
  const content = readFileSync(baselinePath, 'utf8')
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Returns EVERY line in `.signatures.log` whose content-hash matches `sha`,
 * not just the first (Codex review finding, High). The same baseline.json
 * content can legitimately be re-signed more than once within the log's
 * 15-line FIFO window -- e.g. a developer re-runs the eval to refresh a
 * signature after the corpus/gold-set/ranking files didn't actually change
 * the output. Returning only the first (oldest) match meant a stale entry
 * for that content -- e.g. one whose headSha is no longer an ancestor of
 * HEAD -- could reject a push even though a LATER entry for the exact same
 * content has a perfectly valid headSha. The caller must consider every
 * returned entry, not just the first.
 */
function lookupSignatures(sha) {
  const logPath = join(REPO_ROOT, SIGNATURES_REL)
  if (!existsSync(logPath)) return []
  const lines = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
  const matches = []
  for (const line of lines) {
    const [logSha, timestamp, headSha] = line.split('\t')
    if (logSha === sha) {
      matches.push({ sha: logSha, timestamp, headSha })
    }
  }
  return matches
}

/**
 * SMI-5708 Item #5(a) — is `candidateSha` the current git HEAD, or an
 * ancestor of it?
 *
 * A signature's headSha is captured at the moment a real-mode run wrote
 * baseline.json (emitBaselineSignature() in eval-runner-signatures.ts). By
 * the time a push is validated, HEAD has often moved forward — later
 * commits landed on the SAME branch after the signature was recorded
 * (SMI-2597's wave-branch-stacking convention makes this routine: Wave N+1
 * stacks its commits on top of Wave N's). Requiring an EXACT match would
 * false-reject a signature that is still legitimately fresh in that case.
 * Accepting "ancestor of HEAD" (or equal) closes the obvious replay gap (a
 * signature recorded against some unrelated commit — a different branch, or
 * one never merged into this history) without false-rejecting the routine
 * case. This does NOT tolerate an actual `git rebase`/`commit --amend`: those
 * produce a new sha that is a SIBLING of the original commit (same parent),
 * not a descendant — correctly requiring a fresh signature, since ancestry
 * to what was signed is no longer guaranteed (Codex review finding).
 *
 * Fails closed: any git error (unresolvable/unknown sha, shallow clone
 * missing the needed history, etc.) returns false, the same as "not an
 * ancestor" — an unverifiable headSha must not be treated as a pass.
 */
function isHeadShaAcceptable(candidateSha) {
  if (!candidateSha || candidateSha.trim().length === 0) return false
  let currentHead
  try {
    currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim()
  } catch {
    return false
  }
  if (candidateSha === currentHead) return true
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', candidateSha, currentHead], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    // execFileSync throws on a non-zero exit; reaching here means git
    // reported exit 0 (candidateSha IS an ancestor of currentHead).
    return true
  } catch {
    // Non-zero exit (not an ancestor) and thrown errors (unknown revision,
    // detached/missing history) are both treated as "not acceptable."
    return false
  }
}

function emit(failure) {
  // failure is a string describing the reason. Format consistently for both
  // canonical (blocking) and advisory (warn) modes.
  const banner = isCanonicalMode()
    ? 'eval-baseline-validator: BLOCK (canonical mode)'
    : 'eval-baseline-validator: WARN (advisory mode — push will proceed)'
  process.stderr.write(`\n${banner}\n${failure}\n\n`)
  if (isCanonicalMode()) {
    process.exit(1)
  }
  // advisory mode: warn but exit 0
  process.exit(0)
}

function main() {
  const rangeResult = resolveDiffRange()

  // SMI-5708 Item #14: resolveDiffRange() itself failing (origin/main not
  // fetched, upstream configured but unresolvable) is distinct from its
  // genuine no-op cases (delete-only push, no upstream at all) -- route it
  // through the same emit() mechanism as listChangedFiles()'s own failure
  // case just below, rather than silently passing a bare `null` range
  // through to listChangedFiles(), which would treat it identically to an
  // intentional no-op.
  if (!rangeResult.ok) {
    emit(
      [
        'Failed to resolve the git diff range needed to check ranking/baseline freshness',
        '(this is a range-resolution failure, not "nothing to check").',
        `Cause: ${rangeResult.error}`,
        '',
        'The validator cannot verify whether ranking-relevant files changed, so it',
        'cannot confirm baseline.json is fresh.',
      ].join('\n')
    )
    return
  }

  const diffResult = listChangedFiles(rangeResult.range)

  // Diff resolution failure -- distinct from range === null's genuine no-op.
  // Route through the existing emit() dual-mode helper: canonical mode
  // blocks (exit 1), advisory mode warns with a message that says plainly
  // "diff resolution failed" rather than looking like "no changes detected"
  // (plan-review finding L1 -- reuse the existing canonical/advisory
  // machinery here rather than inventing a second mode-detection path).
  if (!diffResult.ok) {
    emit(
      [
        'Failed to resolve the git diff needed to check ranking/baseline freshness',
        '(this is a diff-resolution failure, not "no changes detected").',
        `Cause: ${diffResult.error}`,
        '',
        'The validator cannot verify whether ranking-relevant files changed, so it',
        'cannot confirm baseline.json is fresh.',
      ].join('\n')
    )
    return
  }

  const changed = diffResult.files
  const { rankingOnly, corpus, baselineChanged } = classifyDiff(changed)

  // If no ranking files changed at all, this validator is a no-op.
  if (!rankingOnly && !corpus) {
    return
  }

  // Rule 1: baseline.json must be in the diff. emit() exits in both modes,
  // so the return after it is unreachable — kept defensively in case emit()
  // is ever refactored to no-op.
  if (!baselineChanged) {
    emit(
      [
        'Ranking-relevant files changed but baseline.json is not in this push.',
        '',
        'Run real-mode locally to refresh the baseline:',
        `  ${REAL_MODE_REPRO}`,
        '',
        'Then commit packages/doc-retrieval-mcp/eval/baseline.json and push again.',
      ].join('\n')
    )
    return
  }

  // Rule 2: baseline.json sha must have a signature.
  const sha = readBaselineSha()
  if (sha === null) {
    emit('baseline.json not found at expected path; cannot validate signature.')
    return
  }
  const candidates = lookupSignatures(sha)
  if (candidates.length === 0) {
    emit(
      [
        'baseline.json was hand-edited or stale: its sha256 is not in .signatures.log.',
        'Each real-mode run appends a fresh signature; running the eval will fix this.',
        '',
        `  ${REAL_MODE_REPRO}`,
      ].join('\n')
    )
    return
  }

  // Rule 3 (SMI-5708 Item #5): at least one candidate's recorded headSha must
  // be the current HEAD, or an ancestor of it. There can be MULTIPLE log
  // entries with this exact content-hash (Codex review finding, High) --
  // e.g. the same baseline.json content was re-signed after a commit that
  // didn't change it -- so an older entry's stale headSha must not shadow a
  // later entry's valid one. Filter to headSha-acceptable candidates first;
  // only reject outright if NONE qualify.
  const headShaOk = candidates.filter((c) => isHeadShaAcceptable(c.headSha))
  if (headShaOk.length === 0) {
    const recorded = candidates.map((c) => c.headSha || '(none)').join(', ')
    emit(
      [
        'baseline.json signature was recorded against a commit that is not the',
        'current HEAD and not one of its ancestors.',
        `  recorded headSha(s): ${recorded}`,
        '',
        'This usually means the signature came from an unrelated branch, or a',
        'commit that was never merged into this history — not from a real-mode',
        'run validated against this push. Re-run real-mode locally to produce a',
        'fresh signature tied to this branch:',
        '',
        `  ${REAL_MODE_REPRO}`,
      ].join('\n')
    )
    return
  }

  // Rule 4: at least one headSha-acceptable candidate must also be fresh.
  // Corpus changes get the tighter window even if ranking-only files are also
  // present in the same push (corpus drift dominates the staleness risk).
  const windowMs = corpus ? CORPUS_FRESHNESS_MS : RANKING_FRESHNESS_MS
  let newestAgeMs = null
  const anyFresh = headShaOk.some((c) => {
    const sigTime = Date.parse(c.timestamp)
    if (Number.isNaN(sigTime)) return false
    const ageMs = Date.now() - sigTime
    if (newestAgeMs === null || ageMs < newestAgeMs) newestAgeMs = ageMs
    return ageMs <= windowMs
  })
  if (!anyFresh) {
    const hours = newestAgeMs === null ? 'unknown' : (newestAgeMs / MS_PER_HOUR).toFixed(1)
    const limit = corpus ? '24h (corpus/gold-set)' : '7d (ranking-only)'
    emit(
      [
        `baseline.json signature is stale: ${hours}h old (newest headSha-acceptable entry), limit ${limit}.`,
        'Re-run real-mode to refresh:',
        `  ${REAL_MODE_REPRO}`,
      ].join('\n')
    )
    return
  }

  // All checks passed — silent success.
}

main()
