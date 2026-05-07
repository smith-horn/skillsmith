/**
 * SMI-4764 Wave 0 — signature emission helpers extracted from eval-runner.ts
 * to keep the parent file under the 500-line gate (SMI-3493 / check-file-length).
 *
 * After each real-mode write, append `<sha256>\t<ISO-timestamp>\t<git-HEAD>`
 * to two locations:
 *   1. eval/.signatures.log — committed FIFO, last 15 entries (plan §6).
 *   2. .skillsmith/eval-signatures/<short-sha>.sig — per-developer marker,
 *      ignored by git, consumed by scripts/eval-baseline-validator.mjs.
 *
 * Failures are non-fatal: a real-mode run that produced a baseline.json should
 * not be invalidated by a signature-side I/O hiccup. The pre-push validator
 * re-checks freshness independently.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const SIGNATURES_LOG_PATH = join(__dirname, '.signatures.log')
export const SIGNATURE_LOG_MAX_LINES = 15

function getGitHeadSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
    }).trim()
  } catch {
    return 'unknown'
  }
}

export function emitBaselineSignature(serializedBaseline: string): void {
  const sha = createHash('sha256').update(serializedBaseline, 'utf8').digest('hex')
  const timestamp = new Date().toISOString()
  const headSha = getGitHeadSha()
  const line = `${sha}\t${timestamp}\t${headSha}`

  // 1. FIFO log (committed). Read existing, append, trim to last N.
  try {
    const existing = existsSync(SIGNATURES_LOG_PATH)
      ? readFileSync(SIGNATURES_LOG_PATH, 'utf8')
          .split('\n')
          .filter((l) => l.length > 0)
      : []
    existing.push(line)
    const trimmed = existing.slice(-SIGNATURE_LOG_MAX_LINES)
    writeFileSync(SIGNATURES_LOG_PATH, trimmed.join('\n') + '\n', 'utf8')
  } catch (err) {
    process.stderr.write(`warning: failed to update .signatures.log: ${String(err)}\n`)
  }

  // 2. Per-developer marker (ignored by git).
  try {
    // Walk up from eval/ to repo root: eval/ -> doc-retrieval-mcp/ -> packages/ -> repo
    const repoRoot = join(__dirname, '..', '..', '..')
    const markerDir = join(repoRoot, '.skillsmith', 'eval-signatures')
    mkdirSync(markerDir, { recursive: true })
    const shortSha = sha.slice(0, 8)
    writeFileSync(join(markerDir, `${shortSha}.sig`), line + '\n', 'utf8')
  } catch (err) {
    process.stderr.write(`warning: failed to write per-developer signature: ${String(err)}\n`)
  }
}
