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
import {
  FETCH_COMMAND_PATTERN,
  correlationTargetBasename,
  isCorrelatedWithFetchDestination,
} from './SecurityScanner.fetch-correlation.js'

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
// FIX-2: capture the chmod target path so a fetch command anywhere correlates by basename.
// SMI-5433: prefix widened to match the same extended forms as OWNER_PERM_CHMOD; capture
// group (\S+) (the target path) is unchanged.
const CHMOD_TARGET =
  /\bchmod\s+(?:-[A-Za-z]+\s+)?(?:[0-7]{3,4}|[ugoa]*(?:[+\-=][rwxXstugo]+(?:,[ugoa]*[+\-=][rwxXstugo]*)*)+)\s+(\S+)/i

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
  // to the per-line filter too (FETCH_COMMAND_PATTERN is provably linear, so this is
  // defense-in-depth consistency, not a ReDoS fix).
  const fetchLines = lines.filter((l) => safeRegexTest(FETCH_COMMAND_PATTERN, l) !== null)

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    // World-writable / setuid already emitted critical for this line — skip.
    if (alreadyFlaggedLines.has(lineNumber)) return
    const match = safeRegexTest(OWNER_PERM_CHMOD, line)
    if (!match) return
    // Bounded ±1-line window for the download-then-chmod adjacency.
    const window = [lines[index - 1] ?? '', line, lines[index + 1] ?? ''].join('\n')
    // H-6 (SMI-5433): route through safeRegexTest for the 10,000-char cap.
    const adjacentFetch = safeRegexTest(FETCH_COMMAND_PATTERN, window) !== null
    // FIX-2 + SMI-5431: correlate the chmod target (final segment ≥3 chars) against a fetch
    // command's DOWNLOAD DESTINATION anywhere — explicit (-o/-O/--output<space>/>, with an
    // optional leading path) via regex, OR implicit (wget/git-clone/curl --output=) via
    // exact-token equality. Anchored on the destination, NOT basename-anywhere, so a URL
    // path / query / header value (governance FP class) and a bare curl GET do not correlate.
    // SMI-6033 Wave 3: the FULL captured path is handed to the shared utility (it used to be
    // reduced to a bare basename here, discarding the directory the utility now compares).
    let correlated = false
    // H-6 (SMI-5433): route through safeRegexTest for the 10,000-char cap.
    const tm = safeRegexTest(CHMOD_TARGET, line)
    if (tm) {
      const targetPath = tm[1].replace(/['"]/g, '')
      if (correlationTargetBasename(targetPath).length >= 3) {
        correlated = isCorrelatedWithFetchDestination(targetPath, fetchLines)
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

/**
 * SMI-6033 Wave 2/3 (Gap 5, tiered per the plan's "Product decision:
 * Gatekeeper-bypass carve-out", resolved 2026-08-14): xattr Gatekeeper-bypass
 * detector.
 *
 * `xattr -c <file>` (clear ALL extended attributes) or
 * `xattr -d com.apple.quarantine <file>` (delete just the quarantine
 * attribute — with or without a combined `-r` recursive flag) strips
 * macOS's "downloaded from the internet" Gatekeeper warning from an
 * unsigned binary.
 *
 * NOT unconditionally standalone-critical: `critical` requires the xattr
 * target's path to be correlated with a fetch destination elsewhere in
 * the content (the shared `isCorrelatedWithFetchDestination` utility, same
 * as `scanChmodFetchCompound` above and `scanArchiveEvasion`'s inline-literal
 * form) — the "download a payload, strip its quarantine bit" attack shape.
 * Uncorrelated usage (e.g. a general macOS-troubleshooting doc mentioning
 * `xattr -c` with no fetched file in scope) stays `medium`, regardless of
 * `isHighTrustAuthor`.
 *
 * `isHighTrustAuthor` (default `false`) is the trust-tier carve-out: when the
 * correlated (would-be-critical) form fires AND the caller has verified the
 * skill's author is high-trust, severity downgrades to `medium` instead of
 * `critical` — a downgrade, not a full exemption, since even a high-trust
 * account can be compromised (a `medium` finding still counts toward the
 * two-distinct-medium-signal escalation rule). This parameter must be sourced
 * from a VERIFIED author signal — the indexer's own resolved GitHub repo
 * owner, never a self-declared `SKILL.md` frontmatter field, which is
 * trivially spoofable. `skill_validate`'s offline call site has no such
 * verified signal (a network call to check it would break the tool's
 * deliberately-offline design, per Gap 7) and so must never pass this
 * parameter — it stays defaulted `false`, keeping correlated xattr
 * always-critical there, full stop. Checksum/signature-verification prose
 * near the command does NOT downgrade a non-high-trust correlated form: it's
 * attacker-authored text and proves nothing about the artifact's safety, so
 * no such logic exists here.
 *
 * Two bounded, ReDoS-safe TRIGGER patterns rather than one combined
 * alternation (mirrors CHMOD_TARGET's capture-then-inspect style):
 * XATTR_CLEAR_ALL matches any `-c`-bearing flag cluster within 40 chars of
 * `xattr` (`-c`, `-cr`, `-rc`, ...); XATTR_DELETE_QUARANTINE matches a
 * `-d`-bearing flag cluster immediately followed by the literal
 * `com.apple.quarantine` attribute name (covers both a combined `-dr`/`-rd`
 * cluster and two separate `-r -d com.apple.quarantine` tokens, since the
 * attribute name always immediately follows whichever token carries `-d`).
 * Reading or writing a DIFFERENT attribute (`-l`, `-p <name>`, `-w <name>
 * <value>`) is not a bypass and does not match either pattern. A second,
 * TARGET-capturing sibling of each pattern (below) exists ONLY to extract the
 * xattr'd file's basename for the correlation check — it never changes
 * whether a line trips the detector.
 */
const XATTR_CLEAR_ALL = /\bxattr\b[^\n]{0,40}-[a-zA-Z]*c[a-zA-Z]*\b/i
const XATTR_DELETE_QUARANTINE =
  /\bxattr\b[^\n]{0,40}-[a-zA-Z]*d[a-zA-Z]*\s+['"]?com\.apple\.quarantine\b/i
const XATTR_CLEAR_ALL_TARGET = /\bxattr\b[^\n]{0,40}-[a-zA-Z]*c[a-zA-Z]*\b\s+['"]?(\S+)/i
const XATTR_DELETE_QUARANTINE_TARGET =
  /\bxattr\b[^\n]{0,40}-[a-zA-Z]*d[a-zA-Z]*\s+['"]?com\.apple\.quarantine\b['"]?\s+['"]?(\S+)/i

/**
 * The FILE target of an xattr Gatekeeper-bypass command (real xattr CLI
 * syntax is `xattr [-flags] [attr_name] target...`, so the target always
 * comes right after whichever trigger variant matched) — used only for the
 * fetch-correlation trust-tier check. Extraction failure (no trailing token)
 * simply yields '' (never correlates); it does not affect whether the line
 * trips the underlying detector. SMI-6033 Wave 3: returns the FULL path
 * (quotes stripped), not a bare basename — the shared correlation utility is
 * now directory-aware and must not be handed a path-stripped target.
 */
function extractXattrTargetPath(line: string): string {
  const m =
    safeRegexTest(XATTR_CLEAR_ALL_TARGET, line) ??
    safeRegexTest(XATTR_DELETE_QUARANTINE_TARGET, line)
  if (!m) return ''
  return m[1].replace(/['"]/g, '')
}

export function scanGatekeeperBypass(
  content: string,
  lineContexts?: LineContext[],
  isHighTrustAuthor = false
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)
  // Fetch-carrying lines, for the correlation precondition (mirrors
  // scanChmodFetchCompound/scanArchiveEvasion's own fetchLines computation).
  const fetchLines = lines.filter((l) => safeRegexTest(FETCH_COMMAND_PATTERN, l) !== null)

  lines.forEach((line, index) => {
    const match =
      safeRegexTest(XATTR_CLEAR_ALL, line) ?? safeRegexTest(XATTR_DELETE_QUARANTINE, line)
    if (!match) return

    const ctx = contexts[index]
    const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
    const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false

    const targetPath = extractXattrTargetPath(line)
    const correlated =
      correlationTargetBasename(targetPath).length >= 3 &&
      isCorrelatedWithFetchDestination(targetPath, fetchLines)
    // Product decision (2026-08-14): correlated form is standalone-critical
    // UNLESS the caller has verified the author is high-trust (indexer path
    // only — see this function's header). Uncorrelated usage never reaches
    // 'critical' regardless of trust tier.
    const critical = !inDocContext && correlated && !isHighTrustAuthor

    findings.push({
      type: 'gatekeeper_bypass',
      severity: inDocContext ? 'low' : critical ? 'critical' : 'medium',
      message: `xattr command strips the macOS Gatekeeper quarantine attribute: "${match[0].trim().slice(0, 100)}"`,
      location: line.trim().slice(0, 100),
      lineNumber: index + 1,
      category: 'gatekeeper_bypass',
      inDocumentationContext: inDocContext,
      confidence: inDocContext ? 'low' : 'high',
    })
  })

  return findings
}
