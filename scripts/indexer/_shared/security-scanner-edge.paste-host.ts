/**
 * SMI-6033 Wave 3 (Gap 4 fix): Edge paste/snippet-host reputation +
 * fetch-context escalation detector
 * @module scripts/indexer/_shared/security-scanner-edge.paste-host (Node port)
 *
 * Port of @skillsmith/core SecurityScanner.paste-host.ts. The originally-
 * shipped version of this detector (commit b74c18436) implemented a
 * SIMPLER, and in one specific way INCORRECT, design relative to the
 * approved plan (docs/internal/implementation/smi-6033-clawhavoc-scanner-gaps.md,
 * Gap 4): it used a single flat PASTE_HOST_DOMAINS list (incorrectly
 * including transfer.sh/file.io alongside glot.io/pastebin.com) and treated
 * ANY same-line fetch of a paste-host URL as standalone-critical, with no
 * requirement that the fetched content actually be EXECUTED. This file
 * fixes both:
 *
 *   1. Two separate reputation tiers (security-scanner-edge.patterns.ts):
 *      `ANON_PASTE_HOSTS` (+ `URL_SHORTENER_DOMAINS`, execution-gated the
 *      same way) vs. `TRANSIENT_TRANSFER_HOSTS` (never standalone-critical —
 *      a deliberate, documented exception for legitimate
 *      debugging/incident-response fetches of ephemeral reproducers).
 *   2. Execution evidence is now REQUIRED for `ANON_PASTE_HOSTS`/shorteners
 *      to reach critical — either (a) the URL is piped directly to an
 *      interpreter on the same line (`curl <url> | bash`, no intermediate
 *      file), (b) `npx <url>` directly executes the fetched content (no
 *      pipe, no intermediate file either), or (c) the fetch destination is
 *      subsequently executed/chmod'd/sourced ELSEWHERE in the content,
 *      correlated via the shared `isCorrelatedWithFetchDestination` utility
 *      (security-scanner-edge.fetch-correlation.ts). Fetched-but-not-
 *      executed, or merely linked, now correctly produces no finding at all.
 *
 * (a)/(b) are a NEW, local execution-detection shape distinct from (c):
 * `isCorrelatedWithFetchDestination` only detects "was this basename later
 * written as a fetch command's DOWNLOAD DESTINATION, then referenced
 * elsewhere" — it has no notion of a same-line direct pipe/direct-exec (no
 * intermediate file at all). The direct-pipe/npx-direct-exec patterns below
 * are local to this file (not promoted to the shared fetch-correlation
 * module) and are deliberately scoped to "the URL being piped/executed is
 * specifically a paste-host or shortener domain."
 *
 * `TRANSIENT_TRANSFER_HOSTS` never reaches critical: it emits
 * `paste_host_fetch` at medium whenever it is an actual fetch target
 * (same-line fetch verb), regardless of execution evidence — `curl
 * file.io/x | bash` alone staying sub-threshold is intentional, not a gap.
 *
 * Unlike the archive_evasion/gatekeeper_bypass ports, edge has no
 * pre-existing URL extraction or allowlisted-domain detector at all (edge's
 * category set has always been narrower than core's by design — no
 * `url`/`pii`/`ssrf`/`social_engineering` categories, per the plan's Context
 * section) — so `extractUrls` below is a fresh, self-contained, exported
 * utility (not a promotion of an existing private method the way it was on
 * the core side), reusable by any future edge detector that needs URL
 * extraction. A merely-linked or fetched-but-not-executed paste-host URL
 * therefore produces NO finding at all on edge (a documented, edge-only
 * divergence from core, where the pre-existing `scanUrls` `url`:medium
 * finding still covers those cases).
 *
 * Known, documented residual (static scanner, no network I/O): redirect-
 * chain/final-host resolution is out of scope by design — custom domains,
 * redirects, and compromised allowlisted hosts are a known residual.
 *
 * Byte-identical body across both _shared twins (parity test enforces); only
 * the @module header line above differs. Pure Deno/Web APIs, no Node deps.
 */

import type { SecurityFinding, LineContext } from './security-scanner-edge.context.ts'
import { isDocumentationContext } from './security-scanner-edge.context.ts'
import {
  ANON_PASTE_HOSTS,
  TRANSIENT_TRANSFER_HOSTS,
  URL_SHORTENER_DOMAINS,
} from './security-scanner-edge.patterns.ts'
import {
  FETCH_COMMAND_PATTERN,
  isCorrelatedWithFetchDestination,
} from './security-scanner-edge.fetch-correlation.ts'

// ReDoS protection: maximum line length for regex matching (mirrors scanner).
const MAX_LINE_LENGTH = 10000

function safeRegexTest(pattern: RegExp, input: string): RegExpMatchArray | null {
  const safeInput = input.length > MAX_LINE_LENGTH ? input.slice(0, MAX_LINE_LENGTH) : input
  return safeInput.match(pattern)
}

// URL_SHORTENER_DOMAINS folds into the SAME critical-eligibility set as
// ANON_PASTE_HOSTS (both require execution evidence to reach critical) —
// they are exported separately from patterns.ts purely for documentation
// clarity (a shortener is not a "content host" the way pastebin is).
const ANON_PASTE_HOST_SET = new Set(
  [...ANON_PASTE_HOSTS, ...URL_SHORTENER_DOMAINS].map((d) => d.toLowerCase())
)
const TRANSIENT_TRANSFER_HOST_SET = new Set(TRANSIENT_TRANSFER_HOSTS.map((d) => d.toLowerCase()))

type PasteHostTier = 'anon' | 'transient' | null

/** A URL found in scanned content, plus the (1-indexed) line it appeared on. */
export interface ExtractedUrl {
  url: string
  line: number
}

/**
 * Fresh, self-contained URL-extraction utility — see module header for why
 * this is not a promotion of an existing private method (edge has none).
 */
export function extractUrls(lines: string[]): ExtractedUrl[] {
  const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi
  const results: ExtractedUrl[] = []

  for (const [index, line] of lines.entries()) {
    let match
    while ((match = urlPattern.exec(line)) !== null) {
      results.push({ url: match[0], line: index + 1 })
    }
  }

  return results
}

/** Which reputation tier (if any) does `url`'s hostname belong to? */
function classifyPasteHostTier(url: string): PasteHostTier {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  const matchesSet = (set: Set<string>): boolean => {
    for (const domain of set) {
      if (hostname === domain || hostname.endsWith('.' + domain)) return true
    }
    return false
  }
  if (matchesSet(ANON_PASTE_HOST_SET)) return 'anon'
  if (matchesSet(TRANSIENT_TRANSFER_HOST_SET)) return 'transient'
  return null
}

// Direct pipe to an interpreter, no intermediate file: `curl <url> | bash`.
// Anchored at the FIRST pipe and scoped to "the piped URL is specifically
// the paste-host/shortener URL under test" by requiring the URL text to
// appear BEFORE that pipe, alongside a fetch verb (curl/wget).
const FETCH_VERB_PATTERN = /\b(?:curl|wget)\b/i
const PIPE_TO_INTERPRETER_TAIL =
  /^\|\s*(?:sudo\s+(?:-[A-Za-z]+\s+)?)?(?:(?:ba|z|da)?sh|python[23]?|node|ruby|perl|php|fish|bun|deno)\b/i

function isDirectPipeToInterpreter(url: string, lineContent: string): boolean {
  const pipeIndex = lineContent.indexOf('|')
  if (pipeIndex < 0) return false
  const beforePipe = lineContent.slice(0, pipeIndex)
  if (!beforePipe.includes(url)) return false
  if (!safeRegexTest(FETCH_VERB_PATTERN, beforePipe)) return false
  return safeRegexTest(PIPE_TO_INTERPRETER_TAIL, lineContent.slice(pipeIndex)) !== null
}

// npx directly executes whatever it fetches from a URL — no pipe, no
// intermediate file — so this is its own direct-execution shape (the same
// "npx immediately followed by a URL" clause FETCH_COMMAND_PATTERN already
// uses to decide "is this line a fetch target" doubles as execution
// evidence here, since npx never just downloads).
const NPX_DIRECT_EXEC_PATTERN = /\bnpx\b[^\n]{0,80}https?:\/\//i

// Execution/chmod/source instructions whose target basename is correlated
// against a paste-host/shortener fetch's download destination via the
// shared `isCorrelatedWithFetchDestination`. Deliberately local to this file
// (not imported from security-scanner-edge.compound.ts) — same
// normalization (strip quotes, take the final path segment, ≥3-char gate)
// as compound.ts's own chmod correlation.
const CHMOD_TARGET =
  /\bchmod\s+(?:-[A-Za-z]+\s+)?(?:[0-7]{3,4}|[ugoa]*(?:[+\-=][rwxXstugo]+(?:,[ugoa]*[+\-=][rwxXstugo]*)*)+)\s+(\S+)/i
const DIRECT_EXEC_TARGET =
  /\b(?:sudo\s+)?(?:(?:ba|z|da)?sh|python[23]?|node|ruby|perl|php|fish|bun|deno)\s+(\.{0,2}\/?[\w-]+(?:[./][\w-]+)*)/i
const DOT_SLASH_EXEC_TARGET = /(?:^|[\s;&|])\.\/([\w-]+(?:[./][\w-]+)*)/
// "sourced" is deliberately scoped to the portable `source X` keyword, not
// the bare POSIX `. X` alias — the latter is too easily confused with prose
// ("... . More info at ...") to be worth the extra correlation-signal noise.
const SOURCE_TARGET = /(?:^|[;&|]\s*)source\s+(\.{0,2}\/?[\w-]+(?:[./][\w-]+)+)/i
const EXEC_TARGET_PATTERNS = [
  CHMOD_TARGET,
  DIRECT_EXEC_TARGET,
  DOT_SLASH_EXEC_TARGET,
  SOURCE_TARGET,
]

/** Every exec/chmod/source target basename (≥3 chars, normalized) across the document. */
function collectExecTargetBasenames(lines: readonly string[]): string[] {
  const basenames: string[] = []
  for (const line of lines) {
    for (const pattern of EXEC_TARGET_PATTERNS) {
      const m = safeRegexTest(pattern, line)
      if (!m?.[1]) continue
      const base = m[1].replace(/['"]/g, '').split('/').pop() ?? ''
      if (base.length >= 3) basenames.push(base)
    }
  }
  return basenames
}

/** Was `fetchLine`'s download destination later executed/chmod'd/sourced elsewhere? */
function isExecutedElsewhereCorrelated(
  fetchLine: string,
  execTargetBasenames: readonly string[]
): boolean {
  return execTargetBasenames.some((base) => isCorrelatedWithFetchDestination(base, [fetchLine]))
}

export function scanPasteHostFetch(lines: string[], contexts: LineContext[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const urls = extractUrls(lines)
  const execTargetBasenames = collectExecTargetBasenames(lines)

  for (const { url, line } of urls) {
    const tier = classifyPasteHostTier(url)
    if (!tier) continue

    const lineIndex = line - 1
    const lineContent = lines[lineIndex] ?? ''
    // The URL is a fetch TARGET only when a fetch verb appears on the SAME
    // line — deliberately not widened to a bounded window; see module
    // header.
    const isFetchTarget = safeRegexTest(FETCH_COMMAND_PATTERN, lineContent) !== null
    if (!isFetchTarget) continue

    const inDocContext = isDocumentationContext(contexts[lineIndex])

    if (tier === 'transient') {
      // Always medium/co-signal-eligible, NEVER standalone-critical —
      // regardless of execution evidence. See security-scanner-edge.
      // patterns.ts's TRANSIENT_TRANSFER_HOSTS comment for the rationale.
      findings.push({
        type: 'paste_host_fetch',
        severity: inDocContext ? 'low' : 'medium',
        message: `Ephemeral file-transfer host URL fetched (never standalone-critical by design): ${url}`,
        lineNumber: line,
        location: lineContent.trim().slice(0, 100),
        inDocumentationContext: inDocContext,
        confidence: inDocContext ? 'low' : 'medium',
      })
      continue
    }

    // tier === 'anon' (ANON_PASTE_HOSTS or a URL shortener): critical
    // requires actual EXECUTION evidence, not just a fetch.
    const executed =
      isDirectPipeToInterpreter(url, lineContent) ||
      safeRegexTest(NPX_DIRECT_EXEC_PATTERN, lineContent) !== null ||
      isExecutedElsewhereCorrelated(lineContent, execTargetBasenames)
    if (!executed) continue

    findings.push({
      type: 'paste_host_fetch',
      // Standalone-critical (execution evidence required, see above) — doc
      // context is the only downgrade, matching every other detector's
      // noise-reduction convention in this Wave.
      severity: inDocContext ? 'low' : 'critical',
      message: `Paste/snippet-host URL is the target of an execution instruction: ${url}`,
      lineNumber: line,
      location: lineContent.trim().slice(0, 100),
      inDocumentationContext: inDocContext,
      confidence: inDocContext ? 'low' : 'high',
    })
  }

  return findings
}
