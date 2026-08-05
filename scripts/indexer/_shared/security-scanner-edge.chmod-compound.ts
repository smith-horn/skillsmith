/**
 * SMI-5424 PR2 / SMI-5879: Edge scanner owner-perm chmod compound signal.
 * @module scripts/indexer/_shared/security-scanner-edge.chmod-compound (Node port)
 *
 * Split out of security-scanner-edge.ts to keep it under the 500-line
 * convention this module family follows (SMI-5402/SMI-5879). Byte-identical
 * body across both _shared twins (parity test enforces); only the @module
 * header line differs.
 */

import type { SecurityFinding, LineContext } from './security-scanner-edge.context.ts'
import { classifyMatch } from './security-scanner-edge.context.ts'
import { safeRegexTest } from './security-scanner-edge.regex-utils.ts'

// ============================================================================
// Owner-perm chmod compound signal
// ============================================================================

// SMI-5424 PR2: owner-permission chmod is a COMPOUND signal, not standalone.
// `chmod 755 ./bin/cli` / `chmod 600 .env` / `chmod +x build.sh` are benign idioms
// that the broad owner-perm pattern previously false-fired as
// privilege_escalation:critical. Owner-perm chmod now emits ONLY when either a fetch
// COMMAND (curl/wget/git-clone/npx-to-URL) is within ±1 line of it, OR the file it
// targets is the download DESTINATION (the `-o`/`-O`/`--output`/`>`/`>>` target) of a
// fetch command anywhere in the content (distance-independent correlation, so filler
// lines between the download and the chmod can't evade the ±1 window) — the "download
// a payload, chmod it, run it" supply-chain
// shape — which kills the standalone FP AND preserves the chmod co-signal that
// escalateCodeExecution requires (it only accepts high/critical non-doc co-signals,
// so chmod cannot simply be downgraded). World-writable and setuid/setgid chmod stay
// standalone-critical in PRIVILEGE_ESCALATION_PATTERNS; `alreadyFlaggedLines` skips
// those so we never double-emit on one line.
const OWNER_PERM_CHMOD = /\bchmod\s+(?:[0-7]{3,4}|[ugoa]*\+x)\b/i
// FIX-1: actual fetch COMMANDS only. The prior weak tokens (bare `fetch`/`download`/
// `downloaded`, a bare `https?://`, a bare `npx`) false-fired on benign prose next to
// an owner-perm chmod. Keep curl/wget/git-clone, and `npx` only when followed by a URL.
const CHMOD_FETCH_CONTEXT = /\b(?:curl|wget)\b|\bgit\s+clone\b|\bnpx\b[^\n]{0,80}https?:\/\//i
// FIX-2: the file an owner-perm chmod targets (capture its path), so a download command
// anywhere in the content that references the same file correlates with the chmod even
// when filler lines space them outside the ±1 window.
const CHMOD_TARGET = /\bchmod\s+(?:[0-7]{3,4}|[ugoa]*\+x)\s+(\S+)/i
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
// SMI-5431: the IMPLICIT download destination of a fetch command — the file written with
// NO explicit -o/-O/--output<space>/> redirect: `wget <url>` (no -O/-o) → URL last segment;
// `git clone <url>` → repo dir (minus `.git`); `curl --output=<file>` (equals form, missed by
// the explicit regex). A bare `curl <url>` GET writes to STDOUT → '' (never correlates). ReDoS-safe.
function implicitDownloadBasename(line: string): string {
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
 * Owner-perm chmod compound signal — see comment above. Emits HIGH (non-doc) / low
 * (doc) privilege_escalation when an owner-perm chmod is within ±1 line of a fetch
 * command OR targets that command's DOWNLOAD DESTINATION anywhere — explicit
 * (-o/-O/--output<space>/>) or, per SMI-5431, implicit (wget no -O / git clone / curl
 * --output=). A bare `curl <url>` GET writes no file so it is never correlated. Lines
 * already flagged critical by the standalone patterns are skipped to avoid double-emit.
 * The ONLY uncaught residual: a spaced `curl … | bash` (no filename) + a non-adjacent chmod.
 */
export function scanChmodFetchCompound(
  lines: string[],
  contexts: LineContext[],
  alreadyFlaggedLines: ReadonlySet<number>
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  // FIX-2: lines carrying a fetch command, for distance-independent correlation.
  const fetchLines = lines.filter((l) => CHMOD_FETCH_CONTEXT.test(l))
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    if (alreadyFlaggedLines.has(lineNumber)) continue
    const match = safeRegexTest(OWNER_PERM_CHMOD, line)
    if (!match) continue
    const window = [lines[index - 1] ?? '', line, lines[index + 1] ?? ''].join('\n')
    const adjacentFetch = CHMOD_FETCH_CONTEXT.test(window)
    // FIX-2 + SMI-5431: correlate the chmod target basename (≥3 chars) against a fetch
    // command's DOWNLOAD DESTINATION anywhere — explicit (-o/-O/--output<space>/>, with an
    // optional leading path) via regex, OR implicit (wget/git-clone/curl --output=) via
    // exact-token equality. Anchored on the destination, NOT basename-anywhere, so a URL
    // path / query / header value (governance FP class) and a bare curl GET do not correlate.
    let correlated = false
    const tm = line.match(CHMOD_TARGET)
    if (tm) {
      const base = tm[1].replace(/['"]/g, '').split('/').pop() ?? ''
      if (base.length >= 3) {
        const re = new RegExp(
          `(?:-o|-O|--output|>>?)\\s*['"]?(?:[^\\s'"]*/)?${escapeRegExp(base)}(?:[\\s'"?]|$)`
        )
        correlated = fetchLines.some((l) => re.test(l) || implicitDownloadBasename(l) === base)
      }
    }
    if (!adjacentFetch && !correlated) continue
    const { inDocContext, confidence } = classifyMatch(contexts[index], line, match.index ?? 0)
    findings.push({
      type: 'privilege_escalation',
      severity: inDocContext ? 'low' : 'high',
      message: `chmod of a fetched/downloaded file (compound with a download verb): "${match[0].slice(0, 50)}"`,
      lineNumber,
      location: line.trim().slice(0, 100),
      inDocumentationContext: inDocContext,
      confidence,
    })
  }
  return findings
}
