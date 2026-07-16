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
 *
 * SMI-5708 Item #4 — both writes now go through `writeFileAtomicSync` (temp
 * file in the same directory, then `renameSync`) so an interrupted run
 * (Ctrl-C, OOM, crash) can never leave a truncated `.signatures.log` or
 * `.sig` marker on disk. `emitBaselineSignature` now returns a `boolean`
 * instead of `void`: `true` iff the write to the SHARED `.signatures.log`
 * succeeded. That file -- not the per-developer marker below, which has no
 * other reader anywhere in this repo (`grep -rn "eval-signatures"
 * packages/ scripts/` confirms it) -- is exclusively what
 * `scripts/eval-baseline-validator.mjs`'s `lookupSignatures()` consults, so
 * its failure (and only its failure) is what later produces a confusing
 * pre-push rejection with no visible link back to this run. The caller
 * (`updateBaseline()` in eval-runner-baseline.ts) plumbs this boolean up to
 * `main()`'s run summary so a developer sees it before pushing, rather than
 * only a stderr warning that can scroll past unnoticed.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
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

/**
 * Write `content` to `targetPath` via write-to-temp-then-rename so neither a
 * concurrent reader nor a process-level interruption (Ctrl-C, OOM, an
 * unhandled exception, SIGKILL) mid-write can ever observe a truncated or
 * partially-written file. This does NOT claim durability against storage-
 * level failure (power loss, kernel panic) -- neither the temp file nor the
 * containing directory is `fsync`'d, so an OS/hardware-level crash could
 * still lose the write or the rename. That guarantee isn't needed here (this
 * writes a locally-run developer eval harness's own output, not a
 * production database), but the doc comment is scoped precisely so the
 * guarantee this function DOES provide isn't over-read as covering more
 * than it does (Codex/Opus review, both flagged the original wording as an
 * overclaim).
 *
 * The temp file is created ALONGSIDE the target (same directory), not in a
 * shared OS temp dir: `fs.renameSync` is only atomic within a single
 * filesystem/directory -- a rename across filesystems can fail outright or
 * silently degrade to a non-atomic copy+delete.
 *
 * The temp filename embeds both `process.pid` and a random suffix, AND ends
 * in `.tmp` (Opus review finding): `.gitignore`'s root `*.tmp` rule only
 * matches a literal `.tmp` suffix, and both `baseline.json` and
 * `.signatures.log` live in this package's TRACKED `eval/` directory -- a
 * temp file orphaned by a crash before the cleanup branch below runs (e.g.
 * SIGKILL) needs to be gitignored, or a later `git add -A` could
 * accidentally stage it. Pid alone is not sufficient for collision
 * avoidance: pids get reused once they wrap around, so a stale temp file
 * from an earlier crashed run could collide with a later run reusing the
 * same pid. The random suffix removes that risk; `wx` (exclusive-create)
 * below makes any residual collision fail loudly rather than silently
 * overwriting another write in progress (Codex review finding -- the random
 * suffix alone made collision merely astronomically unlikely, not
 * impossible).
 *
 * On a failed write or rename, the temp file (if it still exists) is removed
 * so nothing orphaned is left behind. A SUCCESSFUL rename leaves nothing at
 * the temp path to clean up -- the rename already moved it to `targetPath`.
 */
export function writeFileAtomicSync(targetPath: string, content: string): void {
  const tempPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx' })
    renameSync(tempPath, targetPath)
  } catch (err) {
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath)
      } catch {
        // Best-effort cleanup only -- the original write/rename error below
        // is what the caller needs to see and act on; a cleanup failure on
        // top of that must not mask it.
      }
    }
    throw err
  }
}

export function emitBaselineSignature(serializedBaseline: string): boolean {
  const sha = createHash('sha256').update(serializedBaseline, 'utf8').digest('hex')
  const timestamp = new Date().toISOString()
  const headSha = getGitHeadSha()
  const line = `${sha}\t${timestamp}\t${headSha}`

  // 1. FIFO log (committed, shared). Read existing, append, trim to last N,
  // write atomically. This is the ONE write whose outcome the return value
  // reports -- see this function's doc comment above.
  let sharedLogWriteSucceeded = true
  try {
    const existing = existsSync(SIGNATURES_LOG_PATH)
      ? readFileSync(SIGNATURES_LOG_PATH, 'utf8')
          .split('\n')
          .filter((l) => l.length > 0)
      : []
    existing.push(line)
    const trimmed = existing.slice(-SIGNATURE_LOG_MAX_LINES)
    writeFileAtomicSync(SIGNATURES_LOG_PATH, trimmed.join('\n') + '\n')
  } catch (err) {
    sharedLogWriteSucceeded = false
    process.stderr.write(`warning: failed to update .signatures.log: ${String(err)}\n`)
  }

  // 2. Per-developer marker (ignored by git). No other script in this repo
  // reads it, so its failure is logged but does not affect the return value.
  try {
    // Walk up from eval/ to repo root: eval/ -> doc-retrieval-mcp/ -> packages/ -> repo
    const repoRoot = join(__dirname, '..', '..', '..')
    const markerDir = join(repoRoot, '.skillsmith', 'eval-signatures')
    mkdirSync(markerDir, { recursive: true })
    const shortSha = sha.slice(0, 8)
    writeFileAtomicSync(join(markerDir, `${shortSha}.sig`), line + '\n')
  } catch (err) {
    process.stderr.write(`warning: failed to write per-developer signature: ${String(err)}\n`)
  }

  return sharedLogWriteSucceeded
}
