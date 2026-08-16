/**
 * Security Scanner — shared fetch-correlation utilities
 * @module @skillsmith/core/security/scanner/SecurityScanner.fetch-correlation
 *
 * SMI-6033 Wave 2: extracted out of SecurityScanner.compound.ts so every
 * provenance-conditioned detector (chmod, xattr/gatekeeper_bypass,
 * archive_evasion, paste_host_fetch) correlates a target file against a fetch
 * command's download destination using the SAME fetch-verb regex and the SAME
 * distance-independent matching logic, instead of drifting copies. Pure
 * functions of their arguments — no scanner instance state. Byte-identical
 * structure is mirrored in the edge twin
 * (security-scanner-edge.fetch-correlation.ts) — see that file's header for
 * the parity-test pointer.
 *
 * SMI-6033 Wave 3 (adversarial-review fix): correlation is now
 * DIRECTORY-PATH-AWARE. It previously matched on the final path segment
 * (basename) alone, with zero directory awareness — so two entirely unrelated
 * files that merely shared a filename registered as "correlated": a
 * legitimate `curl -o /tmp/install.sh <url>` fetch alongside a separate,
 * pre-existing `./vendor/other-tool/install.sh` that gets `chmod +x`'d
 * elsewhere in the same skill. Because this utility IS the shared provenance
 * gate behind the xattr / archive / paste-host "correlated ->
 * standalone-critical" escalations, that false positive is a
 * quarantine-level one, not a cosmetic one.
 *
 * The rule, in one sentence: when BOTH sides carry directory information the
 * normalized directories must be EQUAL; when EITHER side is a bare filename
 * (no directory information at all — `wget https://x/install.sh` writes into
 * the CWD, `chmod +x install.sh` names no directory) fall back to
 * final-segment matching, because there is then no path information to
 * distinguish the two by. Normalization (`normalizeCorrelationPath`) strips
 * quotes, collapses empty segments, drops `.` and resolves `..`, so
 * `./vendor/tool/x` and `vendor/tool/x` are the same directory while `/tmp`
 * and `vendor/tool` are not. An absolute path with no intermediate directory
 * (`/install.sh`) normalizes to the real directory `/` — NOT to "no
 * directory information" — so it does not silently fall back.
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
 * A path split into its normalized directory component and its final segment.
 * `dir` is the empty string ONLY when the raw path carried no directory
 * information at all (a bare filename, or a `./`-prefixed one, which names
 * the same CWD-relative location) — that empty string is what triggers the
 * basename-only fallback in `isCorrelatedWithFetchDestination`.
 */
export interface NormalizedCorrelationPath {
  dir: string
  base: string
}

/**
 * Normalize a raw path captured out of a shell command into
 * `{ dir, base }`: strip quotes, drop empty (`//`) and `.` segments, resolve
 * `..` lexically, and preserve absolute-vs-relative as a real distinction
 * (`/tmp/x` and `tmp/x` are different locations, so they must not correlate).
 * Lexical only — the scanner never touches the filesystem, so there is no
 * symlink/realpath resolution to do and none is implied.
 */
export function normalizeCorrelationPath(raw: string): NormalizedCorrelationPath {
  const cleaned = raw.replace(/['"]/g, '')
  const isAbsolute = cleaned.startsWith('/')
  const segments: string[] = []
  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      const last = segments[segments.length - 1]
      if (last !== undefined && last !== '..') segments.pop()
      else if (!isAbsolute) segments.push('..')
      continue
    }
    segments.push(segment)
  }
  const base = segments.pop() ?? ''
  return { dir: isAbsolute ? '/' + segments.join('/') : segments.join('/'), base }
}

/**
 * The normalized final segment of `rawPath`. Callers use this for their own
 * minimum-length gate (every current caller requires >= 3 chars) before
 * handing the FULL path to `isCorrelatedWithFetchDestination` — the length
 * policy stays a caller decision, exactly as it was before this file became
 * path-aware.
 */
export function correlationTargetBasename(rawPath: string): string {
  return normalizeCorrelationPath(rawPath).base
}

/**
 * Do two normalized directory components refer to the same location for
 * correlation purposes? An empty component means "this side carried no
 * directory information at all", in which case there is nothing to
 * distinguish the two paths by and final-segment matching stands on its own
 * (the `wget https://x/install.sh` + `chmod +x install.sh` case, which MUST
 * keep correlating). Two non-empty components must be equal.
 */
function directoriesCorrelate(a: string, b: string): boolean {
  if (a === '' || b === '') return true
  return a === b
}

/**
 * SMI-5431: the IMPLICIT download destination of a fetch command — the file
 * written with NO explicit -o/-O/--output<space>/> redirect: `wget <url>` (no
 * -O/-o) → URL last segment; `git clone <url>` → repo dir (minus `.git`);
 * `curl --output=<file>` (equals form, missed by the explicit regex). A bare
 * `curl <url>` GET writes to STDOUT → '' (never correlates). ReDoS-safe.
 *
 * SMI-6033 Wave 3: returns the destination PATH, not a bare basename — the
 * `curl --output=/tmp/p` form carries a real directory the correlation check
 * now compares against. The wget / git-clone forms genuinely have no
 * directory component (both write into the CWD), so they still yield a bare
 * final segment; that is a property of those commands, not discarded
 * information.
 */
export function implicitDownloadDestination(line: string): string {
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
  if (curlEq) return curlEq[1].replace(/['"]/g, '')
  return ''
}

/**
 * Distance-independent correlation: is `targetPath` (the raw path captured
 * from the caller's own command — quotes and directory prefix INCLUDED; this
 * function normalizes) the DOWNLOAD DESTINATION of any fetch command line,
 * anywhere in the document (not just physically adjacent)? Covers explicit
 * destinations (-o/-O/--output<space>/>, with an optional leading path) via
 * regex, and implicit destinations (wget/git-clone/curl --output=) via
 * `implicitDownloadDestination`. Anchored on the destination, NOT
 * basename-anywhere, so a URL path/query/header value (a known FP class) and
 * a bare `curl <url>` GET (writes to stdout) never correlate.
 *
 * Final segments must always match; directories must additionally match
 * whenever BOTH sides carry one (see this file's header for the full rule and
 * the FP class it closes).
 *
 * Callers gate the minimum basename length themselves before calling (every
 * current caller requires >= 3 chars, via `correlationTargetBasename`) — this
 * function imposes no minimum, so a future caller's own length policy stays a
 * caller decision.
 */
export function isCorrelatedWithFetchDestination(
  targetPath: string,
  fetchLines: readonly string[]
): boolean {
  const target = normalizeCorrelationPath(targetPath)
  if (target.base === '') return false
  // The optional leading-path group is CAPTURED (it used to be non-capturing
  // and thrown away) so the destination's own directory can be compared.
  const re = new RegExp(
    `(?:-o|-O|--output|>>?)\\s*['"]?((?:[^\\s'"]*/)?${escapeRegExp(target.base)})(?:[\\s'"?]|$)`,
    'g'
  )
  for (const line of fetchLines) {
    for (const match of line.matchAll(re)) {
      if (directoriesCorrelate(target.dir, normalizeCorrelationPath(match[1]).dir)) return true
    }
    const implicit = implicitDownloadDestination(line)
    if (implicit === '') continue
    const destination = normalizeCorrelationPath(implicit)
    if (destination.base !== target.base) continue
    if (directoriesCorrelate(target.dir, destination.dir)) return true
  }
  return false
}
