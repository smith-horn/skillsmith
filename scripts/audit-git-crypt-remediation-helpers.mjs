/**
 * Helper for audit-standards.mjs Check 61 (SMI-5702 git-crypt filter
 * registration hardening) and its executable twin,
 * scripts/tests/git-crypt-remediation-strings.test.ts (T11).
 *
 * `git config --local --unset filter.git-crypt.{smudge,clean}` against the
 * shared repo-wide `.git/config` caused two real repo-wide corruption
 * incidents (SMI-5702, recurrence 12 days later as SMI-5861) when an
 * operator or agent ran a printed remediation snippet literally. Both the
 * CI gate (Check 61, via this file) and the unit test (T11) walk the SAME
 * file set and assert the SAME zero-occurrence invariant, so a green unit
 * suite and a green CI gate can never silently disagree -- see
 * docs/internal/implementation/smi-5702-worktree-git-crypt-filter-deadlock.md.
 *
 * Scope: fails on any `--unset` within 3 lines of a `filter.git-crypt`
 * mention, repo-wide, EXCEPT:
 *   - .git/, node_modules/, dist/, .worktrees/, .git-crypt/ (binary/VCS
 *     internals, or a nested worktree checkout that duplicates this
 *     repo's own history under a gitignored path)
 *   - .ruvector/ (the local skillsmith-doc-retrieval semantic-search index,
 *     gitignored and never present in CI -- its embeddings payload verbatim-
 *     copies chunked text from indexed docs, including historical snippets
 *     that legitimately quote the pre-fix pattern under the docs-exempt
 *     carve-out below; without this exclusion, `npm run audit:standards`
 *     non-reproducibly fails only on machines with a stale local index)
 *   - docs/internal/{implementation,retros,code_review,pr-reviews}/**
 *     (historical plan docs, retros, code-review reports, and PR-review
 *     reports legitimately quote the old broken snippet as before/after
 *     examples -- code_review/ added after the SMI-5873 fix's own
 *     post-merge retro report tripped this exact check; pr-reviews/ added
 *     after the SMI-5702 Wave 4 PR-review report (2026-07-28) tripped it
 *     the same way, quoting the banned pattern while verifying it was
 *     fixed in the reviewed PR)
 *   - this file and audit-standards.mjs itself, and the T11 test file --
 *     each legitimately names the banned pattern in comments/regex source
 *     to describe what it detects
 *
 * SMI-5702 Wave 4 (this commit): the skillsmith-strategy submodule
 * mount-points (.claude/skills, .claude/plans, .claude/hive-mind) used to
 * be exempted here, pending a separate PR against that submodule's own
 * checkout, gated behind that repo's own review, sequenced last so the
 * main-repo fix wasn't blocked on it. That PR (skillsmith-strategy#11) has
 * now merged and this commit bumps the pointer to it, so the exemption is
 * retired -- these mount-points are scanned like any other path from here
 * on, closing the regression gap a standing carve-out would otherwise
 * leave (nothing in this submodule's own repo re-runs this check, since it
 * has no CI of its own).
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const EXCLUDED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  '.worktrees',
  '.git-crypt',
  '.ruvector',
])

// Files that legitimately contain the literal banned substrings in
// comments, regex source, or descriptive strings, not as an executable
// remediation snippet.
const SELF_EXEMPT_FILES = new Set([
  'scripts/audit-standards.mjs',
  'scripts/audit-git-crypt-remediation-helpers.mjs',
  'scripts/tests/git-crypt-remediation-strings.test.ts',
  // Deliberately reproduces the pre-fix corruption precondition as a test
  // fixture (programmatic `git config --local --unset` setup calls, never
  // printed to an operator) -- not a remediation string in the sense this
  // check exists to ban. Same rationale as the docs-exempt carve-out above,
  // applied to test code instead of historical plan prose.
  'scripts/tests/create-worktree-base.test.ts',
  // SMI-5702 Wave 4 (skillsmith-strategy#11): both files' own fix comments
  // describe the banned pattern they just removed, the same "describe what
  // it detects/fixed" rationale as this file's own self-exemption above --
  // not executable remediation snippets.
  '.claude/skills/git-crypt/SKILL.md',
  '.claude/skills/git-crypt/scripts/git-crypt-worktree.sh',
])

const UNSET_RE = /--unset/
const FILTER_GIT_CRYPT_RE = /filter\.git-crypt/

function isDocsExemptPath(relPath) {
  return (
    relPath.startsWith('docs/internal/implementation/') ||
    relPath.startsWith('docs/internal/retros/') ||
    relPath.startsWith('docs/internal/code_review/') ||
    relPath.startsWith('docs/internal/pr-reviews/')
  )
}

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry)) continue
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(full, out)
    } else if (st.isFile()) {
      out.push(full)
    }
  }
}

/**
 * Walk `repoRoot` and return every {file, line, text} occurrence of
 * `--unset` within 3 lines of a `filter.git-crypt` mention, excluding the
 * paths documented in this file's header.
 *
 * @param {string} repoRoot
 * @returns {Array<{file: string, line: number, text: string}>}
 */
export function findGitCryptUnsetRemediations(repoRoot) {
  const files = []
  walk(repoRoot, files)

  const findings = []
  for (const full of files) {
    const relPath = relative(repoRoot, full).split('\\').join('/')
    if (SELF_EXEMPT_FILES.has(relPath)) continue
    if (isDocsExemptPath(relPath)) continue

    let content
    try {
      content = readFileSync(full, 'utf8')
    } catch {
      continue // binary/unreadable -- can't contain a matching text line
    }
    if (!FILTER_GIT_CRYPT_RE.test(content) || !UNSET_RE.test(content)) continue

    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!UNSET_RE.test(lines[i])) continue
      const windowStart = Math.max(0, i - 3)
      const windowEnd = Math.min(lines.length, i + 4)
      const window = lines.slice(windowStart, windowEnd).join('\n')
      if (FILTER_GIT_CRYPT_RE.test(window)) {
        findings.push({ file: relPath, line: i + 1, text: lines[i].trim() })
      }
    }
  }
  return findings
}
