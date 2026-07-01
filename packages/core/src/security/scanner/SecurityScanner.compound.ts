// Extracted from SecurityScanner.scanners.ts (SMI-5434) — previously lines 259–360.
/**
 * Security Scanner — compound chmod+fetch signal detector
 * @module @skillsmith/core/security/scanner/SecurityScanner.compound
 *
 * SMI-5434: Section 2 of SecurityScanner.scanners.ts extracted so that the
 * upcoming SMI-5433 regex widening (~40 lines) can land without breaching the
 * 500-line audit:standards gate. Pure functions of (content, alreadyFlaggedLines,
 * lineContexts) — no scanner instance state.
 */

import type { SecurityFinding } from './types.js'
import type { LineContext } from './SecurityScanner.helpers.js'
import {
  analyzeMarkdownContext,
  isDocumentationContext,
  isWithinInlineCode,
} from './SecurityScanner.helpers.js'
import { safeRegexTest } from './regex-utils.js'

/**
 * SMI-5424 PR2: owner-permission chmod is a COMPOUND signal, not standalone —
 * `chmod 755 ./bin/cli` / `chmod +x build.sh` previously false-fired
 * privilege_escalation:critical. It now emits HIGH only when a fetch COMMAND
 * (curl/wget/git-clone/npx-to-URL) is within ±1 line OR the chmod target is the
 * DOWNLOAD DESTINATION of a fetch command anywhere (distance-independent, so filler
 * lines can't evade the ±1 window) — the "download a payload, chmod it, run it" shape.
 * Kills the FP while PRESERVING the chmod co-signal escalateCodeExecution needs (it
 * only accepts high/critical non-doc co-signals). World-writable / setuid chmod stay
 * standalone-critical in PRIVILEGE_ESCALATION_PATTERNS; `alreadyFlaggedLines` prevents
 * double-emit. SMI-5431: "destination" covers explicit (-o/-O/--output<space>/>) AND
 * implicit (wget no -O / git clone / curl --output=) targets; a bare `curl <url>` GET
 * writes to STDOUT so it is NOT correlated (the URL-path-segment FP a prior review caught).
 * The ONLY uncaught residual: a SPACED `curl … | bash` (no filename) + a NON-adjacent chmod.
 */
// SMI-5433: widened to cover comma-separated symbolic (a+w,o+x), recursive flag (-R/-Rv),
// and assignment operator (u=rwx,g=rx) evasion forms. The optional `(?:-[A-Za-z]+\s+)?`
// cluster covers -R, -Rv, -fR and any single-dash letter cluster POSIX chmod supports;
// `[+\-=]` covers +, -, = operators; `[rwxXstugo]*` (zero-or-more) means `chmod a=`
// (empty body, clears perms) also matches — intentional TP behavior per plan.
// FIX (adversarial review SMI-5433): `[ugoa]*` (zero-or-more, not `+` one-or-more) so
// that bare `chmod +x foo` (no u/g/o/a prefix — the most common make-executable form
// in install scripts and malicious droppers) still matches.
const OWNER_PERM_CHMOD =
  /\bchmod\s+(?:-[A-Za-z]+\s+)?(?:[0-7]{3,4}|[ugoa]*(?:[+\-=][rwxXstugo]+(?:,[ugoa]*[+\-=][rwxXstugo]*)*)+)/i
// FIX-1: actual fetch COMMANDS only — bare prose tokens (`# downloaded`, `See https://…`,
// `npx tool init`) false-fired next to a chmod. curl/wget/git-clone, and npx only with a URL.
const CHMOD_FETCH_CONTEXT = /\b(?:curl|wget)\b|\bgit\s+clone\b|\bnpx\b[^\n]{0,80}https?:\/\//i
// FIX-2: capture the chmod target path so a fetch command anywhere correlates by basename.
// SMI-5433: prefix widened to match the same extended forms as OWNER_PERM_CHMOD; capture
// group (\S+) (the target path) is unchanged.
const CHMOD_TARGET =
  /\bchmod\s+(?:-[A-Za-z]+\s+)?(?:[0-7]{3,4}|[ugoa]*(?:[+\-=][rwxXstugo]+(?:,[ugoa]*[+\-=][rwxXstugo]*)*)+)\s+(\S+)/i
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

export function scanChmodFetchCompound(
  content: string,
  alreadyFlaggedLines: ReadonlySet<number>,
  lineContexts?: LineContext[]
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)
  // FIX-2: lines carrying a fetch command, for distance-independent correlation.
  // H-6 (SMI-5433): route through safeRegexTest so the 10,000-char cap applies uniformly
  // to the per-line filter too (CHMOD_FETCH_CONTEXT is provably linear, so this is
  // defense-in-depth consistency, not a ReDoS fix).
  const fetchLines = lines.filter((l) => safeRegexTest(CHMOD_FETCH_CONTEXT, l) !== null)

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    // World-writable / setuid already emitted critical for this line — skip.
    if (alreadyFlaggedLines.has(lineNumber)) return
    const match = safeRegexTest(OWNER_PERM_CHMOD, line)
    if (!match) return
    // Bounded ±1-line window for the download-then-chmod adjacency.
    const window = [lines[index - 1] ?? '', line, lines[index + 1] ?? ''].join('\n')
    // H-6 (SMI-5433): route through safeRegexTest for the 10,000-char cap.
    const adjacentFetch = safeRegexTest(CHMOD_FETCH_CONTEXT, window) !== null
    // FIX-2 + SMI-5431: correlate the chmod target basename (≥3 chars) against a fetch
    // command's DOWNLOAD DESTINATION anywhere — explicit (-o/-O/--output<space>/>, with an
    // optional leading path) via regex, OR implicit (wget/git-clone/curl --output=) via
    // exact-token equality. Anchored on the destination, NOT basename-anywhere, so a URL
    // path / query / header value (governance FP class) and a bare curl GET do not correlate.
    let correlated = false
    // H-6 (SMI-5433): route through safeRegexTest for the 10,000-char cap.
    const tm = safeRegexTest(CHMOD_TARGET, line)
    if (tm) {
      const base = tm[1].replace(/['"]/g, '').split('/').pop() ?? ''
      if (base.length >= 3) {
        const re = new RegExp(
          `(?:-o|-O|--output|>>?)\\s*['"]?(?:[^\\s'"]*/)?${escapeRegExp(base)}(?:[\\s'"?]|$)`
        )
        correlated = fetchLines.some((l) => re.test(l) || implicitDownloadBasename(l) === base)
      }
    }
    if (!adjacentFetch && !correlated) return // benign standalone chmod — no finding

    const ctx = contexts[index]
    const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
    const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
    findings.push({
      type: 'privilege_escalation',
      // HIGH (not critical): enough to trip Gate-A AND serve as an
      // escalateCodeExecution co-signal, without re-introducing a critical FP.
      severity: inDocContext ? 'low' : 'high',
      message: `chmod of a fetched/downloaded file (compound with a download verb): "${match[0]}"`,
      location: line.trim().slice(0, 100),
      lineNumber,
      category: 'privilege_escalation',
      inDocumentationContext: inDocContext,
      confidence: inDocContext ? 'low' : 'high',
    })
  })

  return findings
}
