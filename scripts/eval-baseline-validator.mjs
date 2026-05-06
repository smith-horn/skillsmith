#!/usr/bin/env node
// SMI-4764 Wave 0: Pre-push validator for retrieval eval baseline freshness.
//
// When ranking files (rerank.ts, search.ts, corpus.config.json, gold-set.json)
// are part of the push, this script enforces that:
//   1. baseline.json is also in the diff (else: reject with repro command)
//   2. baseline.json's sha256 has a matching signature in .signatures.log
//      (signatures are written by eval-runner.ts on each real-mode run)
//   3. The signature timestamp is fresh:
//        - Ranking-only changes  (rerank.ts, search.ts): 7-day window
//        - Corpus or gold-set changes: 24-hour window
//
// Mode branching:
//   SKILLSMITH_EVAL_CANONICAL=true  → validation failure exits 1 (block push)
//   else                            → validation failure prints to stderr and
//                                     exits 0 (advisory mode, push proceeds)
//
// The pre-push hook invokes this script with the pushed-ref args ($1..$4)
// from husky/git. If those are unavailable, falls back to comparing
// `@{upstream}..HEAD`. If still unresolved, exits 0 (no-op) — the script must
// not break unrelated PRs that happen not to push ranking changes.

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

/**
 * Resolve the diff range to inspect.
 *
 * Pre-push hook receives lines on stdin in the form:
 *   <local_ref> <local_sha> <remote_ref> <remote_sha>
 * For new branches remote_sha is all zeros — fall back to the merge-base with
 * origin/main for those, since we still want to validate the ranking diff.
 */
function resolveDiffRange() {
  // Try stdin first (husky passes it through).
  let stdinData = ''
  try {
    stdinData = readFileSync(0, 'utf8')
  } catch {
    // No stdin available (interactive run, tests, etc.) — fall through.
  }

  const lines = stdinData.split('\n').filter((l) => l.trim().length > 0)
  for (const line of lines) {
    const parts = line.split(/\s+/)
    if (parts.length >= 4) {
      const localSha = parts[1]
      const remoteSha = parts[3]
      const zeros = '0000000000000000000000000000000000000000'
      if (localSha === zeros) {
        // Delete-only push, nothing to validate.
        return null
      }
      if (remoteSha === zeros) {
        // New branch: diff against origin/main merge-base.
        try {
          const base = execFileSync('git', ['merge-base', 'origin/main', localSha], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
          }).trim()
          return { base, head: localSha }
        } catch {
          // origin/main not fetched? Fall through.
        }
      } else {
        return { base: remoteSha, head: localSha }
      }
    }
  }

  // Fallback: compare HEAD to upstream tracking branch if set.
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
    return { base: upstream, head }
  } catch {
    return null
  }
}

function listChangedFiles(range) {
  if (range === null) return []
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${range.base}..${range.head}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    return out.split('\n').filter((l) => l.length > 0)
  } catch {
    return []
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

function lookupSignature(sha) {
  const logPath = join(REPO_ROOT, SIGNATURES_REL)
  if (!existsSync(logPath)) return null
  const lines = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
  for (const line of lines) {
    const [logSha, timestamp, headSha] = line.split('\t')
    if (logSha === sha) {
      return { sha: logSha, timestamp, headSha }
    }
  }
  return null
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
  const range = resolveDiffRange()
  const changed = listChangedFiles(range)
  const { rankingOnly, corpus, baselineChanged } = classifyDiff(changed)

  // If no ranking files changed at all, this validator is a no-op.
  if (!rankingOnly && !corpus) {
    return
  }

  // Rule 1: baseline.json must be in the diff.
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
    return // unreachable in canonical mode; in advisory we keep going for hygiene only
  }

  // Rule 2: baseline.json sha must have a signature.
  const sha = readBaselineSha()
  if (sha === null) {
    emit('baseline.json not found at expected path; cannot validate signature.')
    return
  }
  const sig = lookupSignature(sha)
  if (sig === null) {
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

  // Rule 3: signature freshness.
  const sigTime = Date.parse(sig.timestamp)
  if (Number.isNaN(sigTime)) {
    emit(`signature has unparseable timestamp: ${sig.timestamp}`)
    return
  }
  const ageMs = Date.now() - sigTime
  // Corpus changes get the tighter window even if ranking-only files are also
  // present in the same push (corpus drift dominates the staleness risk).
  const windowMs = corpus ? CORPUS_FRESHNESS_MS : RANKING_FRESHNESS_MS
  if (ageMs > windowMs) {
    const hours = (ageMs / MS_PER_HOUR).toFixed(1)
    const limit = corpus ? '24h (corpus/gold-set)' : '7d (ranking-only)'
    emit(
      [
        `baseline.json signature is stale: ${hours}h old, limit ${limit}.`,
        'Re-run real-mode to refresh:',
        `  ${REAL_MODE_REPRO}`,
      ].join('\n')
    )
    return
  }

  // All checks passed — silent success.
}

main()
