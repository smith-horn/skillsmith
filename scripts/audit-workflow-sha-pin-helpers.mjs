/**
 * audit-workflow-sha-pin-helpers — validates that every `uses:` directive in
 * `.github/workflows/**` references a remote action via a 40-hex commit SHA.
 *
 * Background: governance retro 2026-05-06 surfaced that
 * `.github/workflows/wasm-env-snapshot.yml` had merged with
 * `actions/setup-node@v6` (floating tag) while every other workflow in the
 * repo SHA-pins. CI's existing `audit:standards` Check 37 only validates
 * `node-version:` consistency — it does not enforce SHA-pinning. PR #975
 * commit 06267d27 inline-fixed the one offender; this helper backstops the
 * convention so the next instance is caught at PR time, not at audit time.
 *
 * Repo convention: `<owner>/<repo>(/<path>)?@<40-hex-sha> # <human-tag>`
 *   e.g. `actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f # v6`
 *
 * Excluded shapes (not subject to the rule):
 *   - Local actions: `./.github/actions/foo`
 *   - Docker images: `docker://alpine:3.18`
 *
 * Reusable workflow calls (`org/repo/.github/workflows/foo.yml@<ref>`) follow
 * the same SHA-pin rule.
 *
 * SMI-4758 — issue link: https://linear.app/smith-horn-group/issue/SMI-4758
 */

const USES_RE = /^\s*-?\s*uses:\s+(.+?)\s*(?:#.*)?$/
const SHA_RE = /^[a-f0-9]{40}$/

/**
 * @param {string} content - workflow file contents
 * @param {string} filePath - relative workflow path (used in messages only)
 * @returns {Array<{line: number, value: string, kind: 'floating-tag' | 'branch-ref' | 'no-version' | 'malformed'}>}
 */
export function findUnpinnedActionUses(content, filePath) {
  const violations = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(USES_RE)
    if (!m) continue
    const ref = m[1].trim().replace(/^['"]|['"]$/g, '')

    // Skip non-remote refs.
    if (ref.startsWith('./')) continue
    if (ref.startsWith('docker://')) continue

    // Must contain a single '@' separating the action path from the ref.
    const atIdx = ref.indexOf('@')
    if (atIdx === -1) {
      violations.push({ line: i + 1, value: ref, kind: 'no-version' })
      continue
    }

    const actionRef = ref.slice(atIdx + 1)
    if (SHA_RE.test(actionRef)) continue // 40-hex SHA → pinned, OK

    // Classify the violation kind.
    if (/^v?\d+(?:\.\d+)*(?:-[\w.-]+)?$/.test(actionRef)) {
      violations.push({ line: i + 1, value: ref, kind: 'floating-tag' })
    } else if (/^(?:main|master|develop|HEAD|latest)$/.test(actionRef)) {
      violations.push({ line: i + 1, value: ref, kind: 'branch-ref' })
    } else {
      violations.push({ line: i + 1, value: ref, kind: 'malformed' })
    }
  }

  return violations
}
