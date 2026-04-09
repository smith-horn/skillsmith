/**
 * Pure helpers extracted from audit-standards.mjs for SMI-3987 / SMI-3986.
 *
 * These are referenced by both:
 * - scripts/audit-standards.mjs (Check 11 & Check 23)
 * - scripts/tests/audit-standards.test.ts (unit tests via dynamic ESM import)
 *
 * The plan (docs/internal/implementation/smi-3987-3986-audit-standards-fixes.md)
 * originally called for hoisting these helpers to the top of audit-standards.mjs
 * itself, matching the convention in scripts/ci/check-supply-chain-pins.mjs.
 * That convention wraps the CLI body in a `main()` function so dynamic imports
 * don't trigger side effects. audit-standards.mjs is ~1670 lines and wrapping
 * its CLI body in `main()` would require indenting every line by 2 spaces — a
 * pure-mechanical change that bloats the diff and obscures the actual fix.
 *
 * Pragmatic adjustment: extract the 3 pure helpers to this small companion
 * file. The test imports from here directly. audit-standards.mjs imports them
 * by name and uses them inside its existing check blocks. Same plan-review E3
 * intent (use real exports, not shadow re-implementation), without the
 * indentation churn.
 *
 * Zero dependencies. No I/O. No side effects.
 */

/**
 * Parse a semver-ish version string into [major, minor, patch].
 * Returns null if the string does not start with `<int>.<int>.<int>`.
 * Prerelease tags and build metadata are ignored (sufficient for the npm
 * override specs used in root package.json — none use prereleases).
 */
export const parseSemver = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * Minimal zero-dep semver subset matching the operators used in root
 * package.json overrides: ^, ~, >=, >, and exact-literal. Sufficient for
 * Check 11's "did this override actually take effect?" question. Not a
 * general-purpose semver implementation — DO NOT use for application code.
 */
export const satisfies = (version, spec) => {
  const vp = parseSemver(version)
  if (!vp) return false
  if (spec.startsWith('^')) {
    const sp = parseSemver(spec.slice(1))
    if (!sp) return false
    if (sp[0] > 0) {
      return vp[0] === sp[0] && (vp[1] > sp[1] || (vp[1] === sp[1] && vp[2] >= sp[2]))
    }
    // ^0.x.y is tighter: locks minor
    return vp[0] === 0 && vp[1] === sp[1] && vp[2] >= sp[2]
  }
  if (spec.startsWith('~')) {
    const sp = parseSemver(spec.slice(1))
    if (!sp) return false
    return vp[0] === sp[0] && vp[1] === sp[1] && vp[2] >= sp[2]
  }
  if (spec.startsWith('>=')) {
    const sp = parseSemver(spec.slice(2).trim())
    if (!sp) return false
    if (vp[0] !== sp[0]) return vp[0] > sp[0]
    if (vp[1] !== sp[1]) return vp[1] > sp[1]
    return vp[2] >= sp[2]
  }
  if (spec.startsWith('>')) {
    const sp = parseSemver(spec.slice(1).trim())
    if (!sp) return false
    if (vp[0] !== sp[0]) return vp[0] > sp[0]
    if (vp[1] !== sp[1]) return vp[1] > sp[1]
    return vp[2] > sp[2]
  }
  // Literal / exact pin
  return version === spec
}

// SMI-NNNN extraction patterns for Check 23. Subject-line refs always count
// as completion claims. Body refs only count when prefixed by a closing
// keyword (closes/closed/fix/fixes/fixed/resolve/resolves/resolved). The
// {1,20} cap on the captured run is a sanity bound — realistic max is ~5-10
// SMIs per marker; cap is documented but not strictly required.
const SUBJECT_ISSUE_RE = /\b(SMI-\d+)\b/gi
const CLOSES_MARKER_RE =
  /\b(closes|closed|fix|fixes|fixed|resolve|resolves|resolved)[:]?\s+((?:SMI-\d+[,\s]*){1,20})/gi
const BODY_ISSUE_RE = /\bSMI-\d+\b/gi

/**
 * Return the set of SMI-NNNN refs that this commit CLAIMS to complete.
 *
 * Counted as completion claims:
 *   1. Any SMI-NNNN that appears in the subject line.
 *   2. SMI-NNNN that appears in the body AFTER a closing keyword
 *      (closes/closed/fix/fixes/fixed/resolve/resolves/resolved), with or
 *      without the trailing colon. Example matches:
 *        - "closes: SMI-1234"
 *        - "fixes SMI-1234, SMI-5678" (no colon, multiple refs)
 *        - "Closed: SMI-1234"
 *
 * NOT counted (the SMI-3987 cite-in-body false positive fix):
 *   - SMI refs that appear in the body without a closing keyword prefix.
 *     Example: "per SMI-3099 doc" → not counted.
 *
 * Returns a Set of upper-cased SMI-NNNN strings.
 */
export const extractCompletionIssues = (subject, body) => {
  const out = new Set()
  let m
  // Subject line: every SMI-NNNN counts
  SUBJECT_ISSUE_RE.lastIndex = 0
  while ((m = SUBJECT_ISSUE_RE.exec(subject))) out.add(m[1].toUpperCase())
  // Body: only after a closes-marker
  CLOSES_MARKER_RE.lastIndex = 0
  while ((m = CLOSES_MARKER_RE.exec(body))) {
    const run = m[2]
    let s
    BODY_ISSUE_RE.lastIndex = 0
    while ((s = BODY_ISSUE_RE.exec(run))) out.add(s[0].toUpperCase())
  }
  return out
}
