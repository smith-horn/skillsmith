/**
 * Helper for audit-standards.mjs Check 69 (SMI-6515 Wave 2 -- absolute
 * `--separate-git-dir` writer ban) and its executable twin,
 * scripts/tests/gitdir-writer-check.test.ts.
 *
 * `git clone --separate-git-dir=<ABSOLUTE PATH>` produces a submodule
 * gitfile (`.git`) that resolves on the host that wrote it and breaks
 * every containerized git command that reads it -- the repo is
 * bind-mounted at /app inside skillsmith-dev-1 and every worktree
 * container, so an absolute host path never resolves there.
 *
 * docs/internal/implementation/smi-6515-absolute-gitdir-detector.md
 * confirms TWO writers of this exact bad form: git's own
 * `git submodule--helper clone` internals (git's own code, reached
 * whenever `git submodule update --init` is interrupted between its
 * clone and finalize steps -- this check cannot see or prevent that half,
 * and is not what it is scored against) and this repo's own documented
 * recipe (.claude/development/git-crypt-guide.md, SMI-6015 stall-recovery
 * section). This check closes the second writer -- the one this repo's
 * own tracked files can regress -- by flagging any tracked file that
 * contains an absolute `--separate-git-dir` invocation with no mandatory
 * rewrite-to-relative step nearby.
 *
 * Ships at FAIL, per the plan's original Wave 2 Step 2 spec. This is a
 * DIFFERENT question from Wave 0's cache-error-direction measurement
 * (conservative MISS, never a false HIT), which governs the severity of
 * a future detector for the untracked, machine-local GITDIR ARTIFACT
 * (out of scope here, see Wave 3). This check is not that detector: it
 * scans TRACKED files for a writer pattern that regresses a fix, which is
 * a fully CI-enforceable, zero-false-positive-surface invariant -- the
 * plan's own rationale for shipping it hard, matching the precedent set
 * by Check 61 (also `fail()` from day one, also a tracked-file
 * remediation-string ban with a narrow, reasoned allow-list).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

// Files that legitimately contain the literal banned substring. Every
// entry needs its own reason here -- an unexplained allow-list entry is
// how a check quietly stops checking.
const SELF_EXEMPT_FILES = new Set([
  // This check's own source names the pattern it detects, in comments
  // and in the regex literal itself.
  'scripts/audit-gitdir-writer-helpers.mjs',
  // This check's test fixtures deliberately construct the banned pattern
  // to prove the detector fires on it.
  'scripts/tests/gitdir-writer-check.test.ts',
  // The ONE file allowed to demonstrate the syntax: the SMI-6015
  // stall-recovery recipe this check exists to keep honest. Its
  // corrected form (SMI-6515) still needs to pass an absolute-shaped
  // path to `--separate-git-dir` -- git always writes an absolute
  // gitdir line regardless of whether the argument itself was relative
  // or absolute (confirmed by direct reproduction during SMI-6515, see
  // finding 7 in the plan doc's Investigation section, not assumed) --
  // so there is no relative-input form that would avoid this. What
  // makes the recipe safe is the mandatory rewrite-to-relative step that
  // immediately follows it, which this check cannot itself verify by
  // grep alone. A human review of any future edit to this file's recipe
  // is still required; this allowlist entry is not a substitute for one.
  '.claude/development/git-crypt-guide.md',
])

function isDocsExemptPath(relPath) {
  return (
    // Implementation plan docs (this plan's own doc included) quote the
    // banned pattern verbatim as before/after investigation evidence --
    // a narrative record of a defect, not a live writer of it.
    relPath.startsWith('docs/internal/implementation/') ||
    // Retro reports quote a banned pattern as the incident under review,
    // for the same reason implementation plans do.
    relPath.startsWith('docs/internal/retros/') ||
    // Post-merge code-review reports quote a banned pattern while
    // verifying a specific PR fixed it (e.g. this plan's own SMI-6515
    // review round).
    relPath.startsWith('docs/internal/code_review/') ||
    // Pre-merge PR-review reports quote a banned pattern the same way,
    // before merge rather than after.
    relPath.startsWith('docs/internal/pr-reviews/')
  )
}

const ABSOLUTE_SEPARATE_GIT_DIR_RE = /--separate-git-dir[= ]\//

/**
 * Enumerate `git ls-files --recurse-submodules` output for `repoRoot` --
 * the actual tracked-file set, not a filesystem walk. A prior version of
 * this check walked the filesystem with `readdirSync` and reported the
 * resulting count under a "tracked file(s) scanned" label; that label was
 * false (it scans whatever happens to be on disk, gitignored or not, up
 * to 1000+ files off from the real tracked count) and its value is not
 * stable -- an untracked local scratch file changes it. `git ls-files` is
 * the actual tracked set, so the label is now true as written.
 *
 * `--recurse-submodules` (rather than plain `git ls-files`) matters here
 * specifically: this repo's `docs/internal` is a submodule containing the
 * `implementation/`, `retros/`, `code_review/`, and `pr-reviews/`
 * subdirectories `isDocsExemptPath` below exempts by design -- without
 * `--recurse-submodules`, `git ls-files` reports `docs/internal` as one
 * opaque gitlink entry and never lists anything inside it, silently
 * un-scanning that entire allow-listed surface rather than correctly
 * exempting it. Confirmed safe for an uninitialized/missing submodule too
 * (the external-contributor case, gate #3 SMI-4829): `--recurse-submodules`
 * degrades to the same gitlink-only listing plain `ls-files` would give,
 * exit 0, no error -- verified by direct reproduction (init a repo with a
 * submodule, then `git submodule deinit` it and remove its directory
 * entirely; `git ls-files --recurse-submodules` still lists the gitlink
 * path and exits 0 in both states).
 *
 * Deliberately does NOT fall back to a filesystem walk if `git` is
 * unavailable or fails (detached gitdir, corrupt index, git binary
 * missing, `repoRoot` not a git working tree, etc.) -- a silent fallback
 * would reproduce exactly the bug this function exists to fix: a count
 * that no longer matches what the label claims. Callers that need this
 * check to degrade instead of hard-fail must catch and handle that
 * explicitly at the call site; this function will not quietly relabel a
 * different measurement as "tracked".
 *
 * @param {string} repoRoot
 * @returns {string[]} tracked file paths, relative to `repoRoot`, forward-slash separated
 */
function listTrackedFiles(repoRoot) {
  let out
  try {
    out = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z', '--recurse-submodules'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
  } catch (err) {
    throw new Error(
      `findAbsoluteSeparateGitDirWriters: \`git -C ${repoRoot} ls-files\` failed (${err.message}). ` +
        'This check reports its denominator as "tracked file(s) scanned" and will not silently ' +
        'substitute an untracked filesystem walk under that label -- fix git availability/repo ' +
        `state for ${repoRoot} (is it a real git working tree?) rather than suppressing this error.`
    )
  }
  return out.split('\0').filter((p) => p.length > 0)
}

/**
 * Enumerate `repoRoot`'s git-tracked files and report every
 * {file, line, text} occurrence of an absolute `--separate-git-dir`
 * invocation (`--separate-git-dir=/...` or `--separate-git-dir /...`),
 * excluding the paths documented in this file's header, alongside the
 * denominator: how many tracked files were actually read and tested
 * against the pattern. A verification that can pass vacuously has to
 * report what it examined, not just its verdict -- and what it examined
 * has to be what it claims to have examined.
 *
 * @param {string} repoRoot
 * @returns {{filesChecked: number, findings: Array<{file: string, line: number, text: string}>}}
 */
export function findAbsoluteSeparateGitDirWriters(repoRoot) {
  const trackedPaths = listTrackedFiles(repoRoot)

  let filesChecked = 0
  const findings = []
  for (const relPath of trackedPaths) {
    if (SELF_EXEMPT_FILES.has(relPath)) continue
    if (isDocsExemptPath(relPath)) continue

    let content
    try {
      content = readFileSync(join(repoRoot, relPath), 'utf8')
    } catch {
      // Binary/unreadable, or a submodule gitlink entry (a directory on
      // disk, not a file) -- can't contain a matching text line.
      continue
    }
    filesChecked++
    if (!ABSOLUTE_SEPARATE_GIT_DIR_RE.test(content)) continue

    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (ABSOLUTE_SEPARATE_GIT_DIR_RE.test(lines[i])) {
        findings.push({ file: relPath, line: i + 1, text: lines[i].trim() })
      }
    }
  }
  return { filesChecked, findings }
}

/**
 * The sanctioned call-site catch that `listTrackedFiles`' own header requires
 * (SMI-6575). `findAbsoluteSeparateGitDirWriters` throws rather than relabel an
 * untracked filesystem walk as "tracked" -- correct, and unchanged. What was
 * missing was any caller honouring the instruction to catch: Check 69's call
 * site in audit-standards.mjs did not, so inside a worktree dev container the
 * unhandled throw killed the whole audit. There `/app/.git` is a FILE naming a
 * HOST path under the main checkout's `.git/worktrees/<name>`, which is not
 * mounted, so `git ls-files` exits 128 (SMI-6524 is the umbrella root cause).
 * CI never saw it: `quality-checks` runs on the host runner under the SMI-4647
 * pure-JS carve-out, where git resolves normally.
 *
 * Returns a verdict instead of throwing. The unevaluated verdict is explicitly
 * NOT a pass -- a check that self-skips to pass is the SMI-6118 / SMI-6332
 * failure mode elsewhere in this same audit, and it is worse than a crash
 * because it is invisible. Callers must render it as its own third outcome.
 *
 * Severity splits on CI because the two environments mean different things: a
 * CI runner always has a working git, so an unevaluated Check 69 there is a
 * real breakage that must block. Locally it is the expected, understood state
 * of every worktree container, so it warns.
 *
 * @param {string} repoRoot
 * @param {{isCI?: boolean}} [options]
 * @returns {{status: 'evaluated', filesChecked: number, findings: Array<{file: string, line: number, text: string}>}
 *          |{status: 'not_evaluated', reason: string, severity: 'fail' | 'warn'}}
 */
export function evaluateAbsoluteSeparateGitDirWriters(repoRoot, options = {}) {
  try {
    const { filesChecked, findings } = findAbsoluteSeparateGitDirWriters(repoRoot)
    return { status: 'evaluated', filesChecked, findings }
  } catch (err) {
    return {
      status: 'not_evaluated',
      reason: err instanceof Error ? err.message : String(err),
      severity: options.isCI ? 'fail' : 'warn',
    }
  }
}

const GITDIR_WRITER_FIX_CI =
  'A CI runner always has a working git, so this is a real breakage, not the known ' +
  'worktree-container state. Check that the checkout step ran and that the working tree ' +
  'is a real git repository.'

const GITDIR_WRITER_FIX_LOCAL =
  'Expected inside a worktree dev container, where /app/.git names an unmounted host path ' +
  '(SMI-6524). Run `npm run audit:standards` on the HOST, or in the main checkout ' +
  'container, to evaluate Check 69.'

const GITDIR_WRITER_FIX_FINDING =
  'Use a mandatory rewrite-to-relative step immediately after the clone (temp file + ' +
  'rename), and verify with `git -C <path> rev-parse --git-dir` ON THE HOST (in-container ' +
  "git does not work in a worktree, SMI-6549). See .claude/development/git-crypt-guide.md's " +
  'SMI-6015 stall-recovery section for the corrected pattern.'

/**
 * Turn a verdict into the exact lines Check 69 should report (SMI-6575).
 *
 * This lives here, not inline in audit-standards.mjs, for one reason found the
 * hard way: the first draft of the SMI-6575 fix put this branching in the audit
 * script, scoped a destructure inside one branch, and left the findings loop
 * referencing two out-of-scope names. That ReferenceError was reachable only
 * when a finding exists -- a state this repo never produces -- so no test, no
 * typecheck (`.mjs` is excluded) and no lint run (`.mjs` is eslint-ignored)
 * could see it. A cross-family pre-merge gate caught it as an untested branch.
 *
 * Moving the branching into an exported pure function makes every outcome,
 * including the findings loop, directly testable, and leaves the audit script
 * with a flat dispatch that has no branch-local bindings to get wrong.
 *
 * `severity` is the name of the audit's own reporter to call: `pass`, `warn`
 * or `fail`. There is deliberately no 'skip' -- an unevaluated check reports as
 * warn or fail, never as a pass.
 *
 * @param {ReturnType<typeof evaluateAbsoluteSeparateGitDirWriters>} verdict
 * @returns {Array<{severity: 'pass' | 'warn' | 'fail', message: string, fix?: string}>}
 */
export function gitDirWriterReportLines(verdict) {
  if (verdict.status === 'not_evaluated') {
    return [
      {
        severity: verdict.severity,
        message:
          'Check 69: NOT EVALUATED — could not enumerate tracked files, so nothing was ' +
          `scanned: ${verdict.reason}`,
        fix: verdict.severity === 'fail' ? GITDIR_WRITER_FIX_CI : GITDIR_WRITER_FIX_LOCAL,
      },
    ]
  }

  const { filesChecked, findings } = verdict

  if (findings.length === 0) {
    return [
      {
        severity: 'pass',
        message:
          'Check 69: no absolute `--separate-git-dir` invocation found ' +
          `(${filesChecked} tracked file(s) scanned outside the allow-listed recipe)`,
      },
    ]
  }

  // WARN, not fail. The cross-family pre-merge gate (ADR-128) established that
  // this detector cannot justify blocking in its current form, in both
  // directions at once:
  //
  //   MISSES real writers -- the pattern requires a literal `/` right after `=`
  //   or one space, so every quoted form (`--separate-git-dir="$HOME/x"`,
  //   `--separate-git-dir='/abs'`), a line continuation before the value, and
  //   any variable indirection all pass straight through.
  //
  //   BLOCKS harmless prose -- documentation that merely quotes the bad
  //   invocation to warn against it trips the same pattern.
  //
  // A gate that blocks documentation while missing the invocations it bans is
  // worse than one that reports. Promoting this to fail() requires quote-aware
  // and continuation-aware parsing that can also tell an executable line from
  // prose; until that exists, the signal is worth keeping and the block is not.
  return findings.map((f) => ({
    severity: 'warn',
    message:
      `Check 69: ${f.file}:${f.line} — absolute \`--separate-git-dir\` found among ` +
      `${filesChecked} scanned file(s): ${f.text}`,
    fix: GITDIR_WRITER_FIX_FINDING,
  }))
}
