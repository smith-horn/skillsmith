/**
 * Security Scanner — shared fetch-correlation utilities
 * @module @skillsmith/core/security/scanner/SecurityScanner.fetch-correlation
 *
 * SMI-6033 Wave 2: extracted out of SecurityScanner.compound.ts so every
 * provenance-conditioned detector (chmod today; xattr/gatekeeper_bypass,
 * archive_evasion, and paste_host_fetch in later Wave 2 steps) correlates a
 * target file's basename against a fetch command's download destination
 * using the SAME fetch-verb regex and the SAME distance-independent
 * basename-matching logic, instead of drifting copies. Pure functions of
 * their arguments — no scanner instance state. Byte-identical structure is
 * mirrored in the edge twin (security-scanner-edge.fetch-correlation.ts) —
 * see that file's header for the parity-test pointer. Pure extraction, no
 * behavior change: the exported names/bodies are unchanged from their
 * previous inline copies in SecurityScanner.compound.ts (only
 * `CHMOD_FETCH_CONTEXT` is renamed to the generic `FETCH_COMMAND_PATTERN`,
 * since it is no longer chmod-specific).
 */

/**
 * Matches an actual fetch COMMAND (curl/wget/git-clone, or npx immediately
 * followed by a URL) — not bare prose tokens (`# downloaded`, `See
 * https://…`, `npx tool init`) which false-fire when used as a correlation
 * gate on their own. Generic name (not chmod-specific, formerly
 * `CHMOD_FETCH_CONTEXT`): every provenance-conditioned detector that needs to
 * know whether a line issues a fetch reuses this single pattern.
 */
export const FETCH_COMMAND_PATTERN =
  /\b(?:curl|wget)\b|\bgit\s+clone\b|\bnpx\b[^\n]{0,80}https?:\/\//i

/**
 * Escape a string for safe interpolation into a `new RegExp(...)` pattern.
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * SMI-5431: the IMPLICIT download destination of a fetch command — the file
 * written with NO explicit -o/-O/--output<space>/> redirect: `wget <url>` (no
 * -O/-o) → URL last segment; `git clone <url>` → repo dir (minus `.git`);
 * `curl --output=<file>` (equals form, missed by the explicit regex). A bare
 * `curl <url>` GET writes to STDOUT → '' (never correlates). ReDoS-safe.
 */
export function implicitDownloadBasename(line: string): string {
  const lastSegment = (urlAfterScheme: string): string => {
    const noFrag = urlAfterScheme.split(/[?#]/)[0]
    const slash = noFrag.indexOf('/') // first slash = end of host
    if (slash < 0) return '' // host only -> wget writes index.html
    const path = noFrag.slice(slash + 1).replace(/\/+$/, '')
    return path === '' ? '' : (path.split('/').pop() ?? '')
  }
  const wget = line.match(/\bwget\b(?![^\n]{0,200}\s-[oO]\b)[^\n]{0,200}?https?:\/\/(\S{1,400})/i)
  if (wget) return lastSegment(wget[1])
  const clone = line.match(/\bgit\s+clone\b[^\n]{0,200}?https?:\/\/(\S{1,400})/i)
  if (clone) return lastSegment(clone[1]).replace(/\.git$/i, '')
  const curlEq = line.match(/\bcurl\b[^\n]{0,200}?--output=['"]?(\S{1,400})/i)
  if (curlEq) return curlEq[1].replace(/['"]/g, '').split('/').pop() ?? ''
  return ''
}

/**
 * Distance-independent correlation: is `targetBasename` (already normalized
 * by the caller — quotes stripped, path-prefix stripped down to the final
 * segment) the DOWNLOAD DESTINATION of any fetch command line, anywhere in
 * the document (not just physically adjacent)? Covers explicit destinations
 * (-o/-O/--output<space>/>, with an optional leading path) via regex, and
 * implicit destinations (wget/git-clone/curl --output=) via exact-token
 * equality against `implicitDownloadBasename`. Anchored on the destination,
 * NOT basename-anywhere, so a URL path/query/header value (a known FP class)
 * and a bare `curl <url>` GET (writes to stdout) never correlate.
 *
 * Callers gate the minimum basename length themselves before calling (both
 * existing chmod callers require ≥3 chars) — this function imposes no
 * minimum, so a future caller's own length policy stays a caller decision.
 */
export function isCorrelatedWithFetchDestination(
  targetBasename: string,
  fetchLines: readonly string[]
): boolean {
  const re = new RegExp(
    `(?:-o|-O|--output|>>?)\\s*['"]?(?:[^\\s'"]*/)?${escapeRegExp(targetBasename)}(?:[\\s'"?]|$)`
  )
  return fetchLines.some((l) => re.test(l) || implicitDownloadBasename(l) === targetBasename)
}
