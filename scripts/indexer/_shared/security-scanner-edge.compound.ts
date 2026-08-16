/**
 * SMI-6033 Wave 1: Edge chmod+fetch compound signal detector
 * @module scripts/indexer/_shared/security-scanner-edge.compound (Node port)
 *
 * Extracted from security-scanner-edge.ts (previously inline, lines 236-336)
 * so the parent file has headroom under the 500-line audit:standards gate for
 * the sensitive_path port that follows in the same wave. Mirrors the split
 * shape of the core reference implementation (SecurityScanner.compound.ts,
 * SMI-5434) — pure extraction, no behavior change. Byte-identical body across
 * both _shared twins (parity test enforces); only the @module header line
 * above differs.
 *
 * SMI-6033 Wave 2: `escapeRegExp`, `implicitDownloadDestination`, the
 * fetch-verb regex (renamed from `CHMOD_FETCH_CONTEXT` to the generic
 * `FETCH_COMMAND_PATTERN`), and the distance-independent destination-matching
 * logic were extracted further, into the sibling
 * security-scanner-edge.fetch-correlation.ts — the xattr/gatekeeper_bypass,
 * archive_evasion, and paste_host_fetch detectors reuse them from there.
 */

import type { SecurityFinding, LineContext } from './security-scanner-edge.context.ts'
import { classifyMatch } from './security-scanner-edge.context.ts'
import {
  FETCH_COMMAND_PATTERN,
  correlationTargetBasename,
  isCorrelatedWithFetchDestination,
} from './security-scanner-edge.fetch-correlation.ts'

// ReDoS protection: maximum line length for regex matching (mirrors scanner).
const MAX_LINE_LENGTH = 10000

function safeRegexTest(pattern: RegExp, input: string): RegExpMatchArray | null {
  const safeInput = input.length > MAX_LINE_LENGTH ? input.slice(0, MAX_LINE_LENGTH) : input
  return safeInput.match(pattern)
}

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
// FIX-2: the file an owner-perm chmod targets (capture its path), so a download command
// anywhere in the content that references the same file correlates with the chmod even
// when filler lines space them outside the ±1 window.
const CHMOD_TARGET = /\bchmod\s+(?:[0-7]{3,4}|[ugoa]*\+x)\s+(\S+)/i

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
  const fetchLines = lines.filter((l) => FETCH_COMMAND_PATTERN.test(l))
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    if (alreadyFlaggedLines.has(lineNumber)) continue
    const match = safeRegexTest(OWNER_PERM_CHMOD, line)
    if (!match) continue
    const window = [lines[index - 1] ?? '', line, lines[index + 1] ?? ''].join('\n')
    const adjacentFetch = FETCH_COMMAND_PATTERN.test(window)
    // FIX-2 + SMI-5431: correlate the chmod target (final segment ≥3 chars) against a fetch
    // command's DOWNLOAD DESTINATION anywhere — explicit (-o/-O/--output<space>/>, with an
    // optional leading path) via regex, OR implicit (wget/git-clone/curl --output=) via
    // exact-token equality. Anchored on the destination, NOT basename-anywhere, so a URL
    // path / query / header value (governance FP class) and a bare curl GET do not correlate.
    // SMI-6033 Wave 3: the FULL captured path is handed to the shared utility (it used to be
    // reduced to a bare basename here, discarding the directory the utility now compares).
    let correlated = false
    const tm = line.match(CHMOD_TARGET)
    if (tm) {
      const targetPath = tm[1].replace(/['"]/g, '')
      if (correlationTargetBasename(targetPath).length >= 3) {
        correlated = isCorrelatedWithFetchDestination(targetPath, fetchLines)
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

// SMI-6033 Wave 2/3 (Gap 5, tiered per the plan's "Product decision:
// Gatekeeper-bypass carve-out", resolved 2026-08-14): xattr Gatekeeper-bypass
// detector. `xattr -c <file>` (clear ALL extended attributes) or
// `xattr -d com.apple.quarantine <file>` (delete just the quarantine
// attribute, with or without a combined `-r` recursive flag) strips macOS's
// "downloaded from the internet" Gatekeeper warning from an unsigned binary.
//
// NOT unconditionally standalone-critical: `critical` requires the xattr
// target's path to be correlated with a fetch destination elsewhere in
// the content (the shared isCorrelatedWithFetchDestination utility, same as
// scanChmodFetchCompound above). Uncorrelated usage stays `medium`,
// regardless of `isHighTrustAuthor`.
//
// `isHighTrustAuthor` (default `false`) is the trust-tier carve-out: when the
// correlated (would-be-critical) form fires AND the caller has verified the
// skill's author is high-trust, severity downgrades to `medium` instead of
// `critical` — a downgrade, not a full exemption (even a high-trust account
// can be compromised; a `medium` finding still counts toward the
// two-distinct-medium-signal escalation rule). This parameter must be
// sourced from a VERIFIED author signal (the indexer's own resolved GitHub
// repo owner), never a self-declared SKILL.md frontmatter field. There is no
// offline caller of this edge module in this codebase (skill_validate uses
// core's SecurityScanner instead), but the same default-closed contract
// applies: omitted, this stays always-critical for the correlated form.
// Checksum/signature-verification prose near the command does NOT downgrade
// a non-high-trust correlated form — no such logic exists here.
//
// Two bounded, ReDoS-safe TRIGGER patterns (mirrors CHMOD_TARGET's
// capture-then-inspect style): XATTR_CLEAR_ALL matches any `-c`-bearing flag
// cluster within 40 chars of `xattr`; XATTR_DELETE_QUARANTINE matches a
// `-d`-bearing flag cluster immediately followed by the literal
// `com.apple.quarantine` attribute name (covers a combined `-dr`/`-rd`
// cluster AND two separate `-r -d com.apple.quarantine` tokens).
// Reading/writing a DIFFERENT attribute (`-l`, `-p <name>`, `-w <name>
// <value>`) matches neither. A second, TARGET-capturing sibling of each
// pattern (below) exists ONLY to extract the xattr'd file's path for the
// correlation check — it never changes whether a line trips the detector.
const XATTR_CLEAR_ALL = /\bxattr\b[^\n]{0,40}-[a-zA-Z]*c[a-zA-Z]*\b/i
const XATTR_DELETE_QUARANTINE =
  /\bxattr\b[^\n]{0,40}-[a-zA-Z]*d[a-zA-Z]*\s+['"]?com\.apple\.quarantine\b/i
const XATTR_CLEAR_ALL_TARGET = /\bxattr\b[^\n]{0,40}-[a-zA-Z]*c[a-zA-Z]*\b\s+['"]?(\S+)/i
const XATTR_DELETE_QUARANTINE_TARGET =
  /\bxattr\b[^\n]{0,40}-[a-zA-Z]*d[a-zA-Z]*\s+['"]?com\.apple\.quarantine\b['"]?\s+['"]?(\S+)/i

/**
 * The FILE target of an xattr Gatekeeper-bypass command — used only for the
 * fetch-correlation trust-tier check. Extraction failure yields '' (never
 * correlates); it does not affect whether the line trips the detector.
 * SMI-6033 Wave 3: returns the FULL path (quotes stripped), not a bare
 * basename — the shared correlation utility is now directory-aware and must
 * not be handed a path-stripped target.
 */
function extractXattrTargetPath(line: string): string {
  const m =
    safeRegexTest(XATTR_CLEAR_ALL_TARGET, line) ??
    safeRegexTest(XATTR_DELETE_QUARANTINE_TARGET, line)
  if (!m) return ''
  return m[1].replace(/['"]/g, '')
}

/**
 * Xattr Gatekeeper-bypass signal — see comment above. Doc-context downgrades
 * to low; otherwise correlated-and-not-high-trust is critical, everything
 * else (uncorrelated, or correlated-but-high-trust) is medium.
 */
export function scanGatekeeperBypass(
  lines: string[],
  contexts: LineContext[],
  isHighTrustAuthor = false
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const fetchLines = lines.filter((l) => FETCH_COMMAND_PATTERN.test(l))
  for (const [index, line] of lines.entries()) {
    const match =
      safeRegexTest(XATTR_CLEAR_ALL, line) ?? safeRegexTest(XATTR_DELETE_QUARANTINE, line)
    if (!match) continue
    const { inDocContext, confidence } = classifyMatch(contexts[index], line, match.index ?? 0)
    const targetPath = extractXattrTargetPath(line)
    const correlated =
      correlationTargetBasename(targetPath).length >= 3 &&
      isCorrelatedWithFetchDestination(targetPath, fetchLines)
    const critical = !inDocContext && correlated && !isHighTrustAuthor
    findings.push({
      type: 'gatekeeper_bypass',
      severity: inDocContext ? 'low' : critical ? 'critical' : 'medium',
      message: `xattr command strips the macOS Gatekeeper quarantine attribute: "${match[0].trim().slice(0, 100)}"`,
      lineNumber: index + 1,
      location: line.trim().slice(0, 100),
      inDocumentationContext: inDocContext,
      confidence,
    })
  }
  return findings
}
