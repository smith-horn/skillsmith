/**
 * Check 78 (SMI-7164): in a pull_request run, `git merge-base origin/<base> HEAD` must resolve.
 *
 * Checks 45, 50, 51, 54 and 77 compute the PR's diff from that merge-base. When the checkout
 * cannot produce it (a depth-1 clone, a single-branch clone, or a depth-1 clone plus a depth-1
 * fetch of the base tip), those checks skip or fail with text that never points at the checkout.
 * This check tests the property they depend on directly. Shallowness is printed as a diagnostic
 * only: a deepened shallow clone can resolve the merge-base, and a full single-branch clone cannot.
 *
 * I/O is injected (`execFile(args)` runs `git <args>` and returns stdout) so the verdict logic
 * is unit-testable; `runCheck78FromEnv` is the one entry point both the full audit and
 * `--only pr-merge-base` call, so the subprocess tests exercise what CI runs.
 */
import { execFileSync } from 'node:child_process'

const FIX =
  "In CI: set fetch-depth: 0 on this job's actions/checkout step, and do not restrict it to a single branch. " +
  'Locally: git fetch origin <base>; in a worktree container git may be unusable (SMI-6332). (SMI-7164)'

/** First `fatal:`/`error:` line of git's stderr, else its first non-empty line, else ''. */
export function gitErrorLine(stderr) {
  const lines = String(stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? ''
}

function shallowFlag(execFile) {
  try {
    const out = String(execFile(['rev-parse', '--is-shallow-repository'])).trim()
    return out === 'true' || out === 'false' ? out : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function runCheck78({ baseRef, execFile, pass, fail, warn }) {
  if (!baseRef) {
    pass('Check 78: not a PR run: not applicable')
    return
  }
  let mergeBase
  try {
    mergeBase = String(execFile(['merge-base', `origin/${baseRef}`, 'HEAD'])).trim()
  } catch (err) {
    // A non-zero exit carries a numeric status; a spawn failure (git missing) or a
    // timeout kill does not.
    if (typeof err?.status !== 'number') {
      warn(`Check 78: could not run git: ${err?.message ?? String(err)}`)
      return
    }
    // merge-base exits 1 with no output when the fetched history holds no common
    // ancestor (a depth-1 clone plus a depth-1 fetch of the base tip does this).
    const why =
      gitErrorLine(err.stderr) ||
      (err.status === 1
        ? 'no common ancestor in the fetched history: git merge-base exited 1'
        : gitErrorLine(err.message)) ||
      'git exited non-zero'
    fail(
      `Check 78: PR merge-base unresolvable: Checks 45, 50, 51, 54 and 77 cannot compute this PR's diff (${why}; shallow=${shallowFlag(execFile)})`,
      FIX
    )
    return
  }
  pass(`Check 78: PR merge-base resolves (${mergeBase.slice(0, 12)})`)
}

// The timeout bounds a hung git (a lock, a stuck network filesystem). A kill carries no
// numeric status, so runCheck78 warns rather than passing.
export const GIT_TIMEOUT_MS = 30_000
const makeGit = (timeoutMs) => (args) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  })

/** The audit's single entry point. Returns false when it failed, for `--only` exit status. */
export function runCheck78FromEnv({
  env = process.env,
  timeoutMs = GIT_TIMEOUT_MS,
  execFile = makeGit(timeoutMs),
  pass,
  fail,
  warn,
}) {
  let failed = false
  runCheck78({
    baseRef: env.GITHUB_BASE_REF,
    execFile,
    pass,
    fail: (msg, fix) => {
      failed = true
      fail(msg, fix)
    },
    warn,
  })
  return !failed
}
