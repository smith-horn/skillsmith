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
