/**
 * audit-realpath-asymmetry-helpers — heuristic detector for the SMI-4697
 * realpath-asymmetry signature.
 *
 * Background: PR #920 fixed two instances of the same anti-pattern (SMI-4688
 * skill-pack-audit, SMI-4692 skill-installation.service): a path comparison
 * where one operand had been resolved through `fs.realpath` and the other
 * had not. On macOS `/var/folders` symlinks to `/private/var/folders`, so
 * `startsWith()` / `===` between an `fs.realpath`'d path and a `path.resolve`'d
 * sibling silently fails — Linux `/tmp` has no symlink prefix and never sees it.
 *
 * Detection (heuristic, regex-based; intentionally narrow):
 *   1. Skip files that don't mention `realpath`.
 *   2. Collect R_VARS — variables assigned the result of `fs.realpath(...)` /
 *      `realpathSync(...)` / `realpathSync.native(...)`. Three assignment
 *      shapes: const/let initializer, deferred assignment after `let X;`
 *      declaration (try/catch fallback pattern).
 *   3. Collect N_VARS — variables assigned `path.resolve(...)` / `resolve(...)` /
 *      `path.join(...)` / `join(...)`, and NOT also assigned a realpath result.
 *   4. For each line containing `.startsWith(`, `.endsWith(`, `===`, or `!==`,
 *      check whether one operand is an R_VAR and the other an N_VAR. If so,
 *      emit a violation.
 *   5. Suppress when the matched line OR the immediately-preceding line
 *      contains `audit-allow:realpath-asymmetry`.
 *
 * Accepted limitations (false-negatives we tolerate to keep the helper small):
 *   - Comparisons threading R_VAR through a template literal before comparing
 *     (e.g. `` `${R}/${name}`.startsWith(N) ``) are not detected.
 *   - Inline-call comparisons not assigned to a variable (e.g.
 *     `(await fs.realpath(p)).startsWith(other)`) are not detected.
 *   - Reassignment chains beyond the immediate `X = await fs.realpath(...)` form.
 *
 * Future contributors who hit a mis-classification: add
 *   `// audit-allow:realpath-asymmetry — <reason>`
 * on the line above the comparison. If the case is genuinely novel, extend
 * the regex passes below.
 *
 * SMI-4758 — issue link: https://linear.app/smith-horn-group/issue/SMI-4758
 */

const REALPATH_INIT_RE =
  /(?:const|let|var)\s+(\w+)(?:\s*:\s*[^=]+?)?\s*=\s*(?:await\s+)?(?:fs\.)?realpath(?:Sync)?(?:\.native)?\(/

const REALPATH_DEFERRED_RE =
  /^\s*(\w+)\s*=\s*(?:await\s+)?(?:fs\.)?realpath(?:Sync)?(?:\.native)?\(/

const RAW_PATH_INIT_RE =
  /(?:const|let|var)\s+(\w+)(?:\s*:\s*[^=]+?)?\s*=\s*(?:path\.)?(?:resolve|join)\(/

const COMPARISON_RES = [
  // X.startsWith(Y) or X.startsWith(Y + ...)
  { re: /(\w+)\.startsWith\(\s*(\w+)/g, op: 'startsWith' },
  // X.endsWith(Y...)
  { re: /(\w+)\.endsWith\(\s*(\w+)/g, op: 'endsWith' },
  // X === Y or X !== Y (only bare-identifier on both sides)
  { re: /\b(\w+)\s*(?:===|!==)\s*(\w+)\b/g, op: '===' },
]

const SUPPRESS_TAG = 'audit-allow:realpath-asymmetry'

/**
 * @param {string} content - file content (utf8)
 * @param {string} filePath - file path (used in returned messages only)
 * @returns {{violations: Array<{line: number, lhs: string, rhs: string, op: string}>}}
 */
export function findRealpathAsymmetry(content, filePath) {
  if (!/realpath/.test(content)) return { violations: [] }

  const lines = content.split('\n')

  // Pass 1: collect R_VARS (realpath-tainted) — captures both initializer and
  // deferred-assignment forms.
  const R_VARS = new Set()
  for (const line of lines) {
    const m1 = line.match(REALPATH_INIT_RE)
    if (m1) R_VARS.add(m1[1])
    const m2 = line.match(REALPATH_DEFERRED_RE)
    if (m2) R_VARS.add(m2[1])
  }

  // Pass 2: collect N_VARS (raw path) — variables assigned via resolve/join,
  // and not also realpath-tainted.
  const N_VARS = new Set()
  for (const line of lines) {
    const m = line.match(RAW_PATH_INIT_RE)
    if (m && !R_VARS.has(m[1])) N_VARS.add(m[1])
  }

  if (R_VARS.size === 0 || N_VARS.size === 0) return { violations: [] }

  // Pass 3: scan comparisons.
  const violations = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const prev = i > 0 ? lines[i - 1] : ''
    if (line.includes(SUPPRESS_TAG) || prev.includes(SUPPRESS_TAG)) continue

    for (const { re, op } of COMPARISON_RES) {
      // Reset regex global state by recreating per line scan
      const localRe = new RegExp(re.source, re.flags)
      let m
      while ((m = localRe.exec(line)) !== null) {
        const a = m[1]
        const b = m[2]
        if (a === b) continue
        const aIsR = R_VARS.has(a)
        const bIsR = R_VARS.has(b)
        const aIsN = N_VARS.has(a)
        const bIsN = N_VARS.has(b)
        if ((aIsR && bIsN) || (aIsN && bIsR)) {
          violations.push({
            line: i + 1,
            lhs: a,
            rhs: b,
            op,
          })
          break
        }
      }
    }
  }

  return { violations }
}
