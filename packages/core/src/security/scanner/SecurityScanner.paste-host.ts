/**
 * Security Scanner — paste/snippet-host reputation + fetch-context escalation
 * @module @skillsmith/core/security/scanner/SecurityScanner.paste-host
 *
 * SMI-6033 Wave 3 (Gap 4 fix): the originally-shipped version of this
 * detector (commit b74c18436) implemented a SIMPLER, and in one specific way
 * INCORRECT, design relative to the approved plan
 * (docs/internal/implementation/smi-6033-clawhavoc-scanner-gaps.md, Gap 4):
 * it used a single flat PASTE_HOST_DOMAINS list (incorrectly including
 * transfer.sh/file.io alongside glot.io/pastebin.com) and treated ANY
 * same-line fetch of a paste-host URL as standalone-critical, with no
 * requirement that the fetched content actually be EXECUTED. This file fixes
 * both:
 *
 *   1. Two separate reputation tiers (patterns.ts): `ANON_PASTE_HOSTS` (+
 *      `URL_SHORTENER_DOMAINS`, execution-gated the same way) vs.
 *      `TRANSIENT_TRANSFER_HOSTS` (never standalone-critical — a deliberate,
 *      documented exception for legitimate debugging/incident-response
 *      fetches of ephemeral reproducers).
 *   2. Execution evidence is now REQUIRED for `ANON_PASTE_HOSTS`/shorteners
 *      to reach critical — either (a) the URL is piped directly to an
 *      interpreter on the same line (`curl <url> | bash`, no intermediate
 *      file), (b) `npx <url>` directly executes the fetched content (no
 *      pipe, no intermediate file either), or (c) the fetch destination is
 *      subsequently executed/chmod'd/sourced ELSEWHERE in the content,
 *      correlated via the shared `isCorrelatedWithFetchDestination` utility
 *      (SecurityScanner.fetch-correlation.ts). Fetched-but-not-executed, or
 *      merely linked, now correctly stays at the existing scanUrls()
 *      `url`:medium finding — no new finding here.
 *
 * (a)/(b) are a NEW, local execution-detection shape distinct from (c):
 * `isCorrelatedWithFetchDestination` only detects "was this basename later
 * written as a fetch command's DOWNLOAD DESTINATION, then referenced
 * elsewhere" — it has no notion of a same-line direct pipe/direct-exec (no
 * intermediate file at all). The direct-pipe/npx-direct-exec patterns below
 * are local to this file (not promoted to the shared fetch-correlation
 * module, which Gap 5's concurrent xattr fix does not touch) and are
 * deliberately scoped to "the URL being piped/executed is specifically a
 * paste-host or shortener domain" — `CODE_EXECUTION_PATTERNS`' own curl|bash
 * pattern (patterns.ts) already fires independently for ANY curl|bash
 * regardless of domain reputation; this file adds the DOMAIN-REPUTATION-aware
 * escalation on top.
 *
 * `TRANSIENT_TRANSFER_HOSTS` never reaches critical: it emits
 * `paste_host_fetch` at medium whenever it is an actual fetch target
 * (same-line fetch verb), regardless of execution evidence — `curl
 * file.io/x | bash` alone staying sub-threshold is intentional, not a gap
 * (see patterns.ts's `TRANSIENT_TRANSFER_HOSTS` comment for the rationale).
 *
 * Known, documented residual (static scanner, no network I/O): redirect-
 * chain/final-host resolution is out of scope by design — custom domains,
 * redirects, and compromised allowlisted hosts are a known residual.
 */

import type { SecurityFinding } from './types.js'
import type { LineContext } from './SecurityScanner.helpers.js'
import { analyzeMarkdownContext, isDocumentationContext } from './SecurityScanner.helpers.js'
import { extractUrls } from './SecurityScanner.urls.js'
import { ANON_PASTE_HOSTS, TRANSIENT_TRANSFER_HOSTS, URL_SHORTENER_DOMAINS } from './patterns.js'
import { safeRegexCheck, safeRegexTest } from './regex-utils.js'
import {
  FETCH_COMMAND_PATTERN,
  isCorrelatedWithFetchDestination,
} from './SecurityScanner.fetch-correlation.js'

// URL_SHORTENER_DOMAINS folds into the SAME critical-eligibility set as
// ANON_PASTE_HOSTS (both require execution evidence to reach critical) —
// they are exported separately from patterns.ts purely for documentation
// clarity (a shortener is not a "content host" the way pastebin is).
const ANON_PASTE_HOST_SET = new Set(
  [...ANON_PASTE_HOSTS, ...URL_SHORTENER_DOMAINS].map((d) => d.toLowerCase())
)
const TRANSIENT_TRANSFER_HOST_SET = new Set(TRANSIENT_TRANSFER_HOSTS.map((d) => d.toLowerCase()))

type PasteHostTier = 'anon' | 'transient' | null

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
// Anchored at the FIRST pipe (mirrors CODE_EXECUTION_PATTERNS' own curl|bash
// shape in patterns.ts) and scoped to "the piped URL is specifically the
// paste-host/shortener URL under test" by requiring the URL text to appear
// BEFORE that pipe, alongside a fetch verb (curl/wget).
const FETCH_VERB_PATTERN = /\b(?:curl|wget)\b/i
const PIPE_TO_INTERPRETER_TAIL =
  /^\|\s*(?:sudo\s+(?:-[A-Za-z]+\s+)?)?(?:(?:ba|z|da)?sh|python[23]?|node|ruby|perl|php|fish|bun|deno)\b/i

function isDirectPipeToInterpreter(url: string, lineContent: string): boolean {
  const pipeIndex = lineContent.indexOf('|')
  if (pipeIndex < 0) return false
  const beforePipe = lineContent.slice(0, pipeIndex)
  if (!beforePipe.includes(url)) return false
  if (!safeRegexCheck(FETCH_VERB_PATTERN, beforePipe)) return false
  return safeRegexCheck(PIPE_TO_INTERPRETER_TAIL, lineContent.slice(pipeIndex))
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
// (not imported from SecurityScanner.compound.ts, which Gap 5's concurrent
// xattr fix is editing) — same normalization (strip quotes, take the final
// path segment, ≥3-char gate) as compound.ts's own chmod correlation.
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

export function scanPasteHostFetch(
  content: string,
  lineContexts?: LineContext[]
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)
  const urls = extractUrls(content)
  const execTargetBasenames = collectExecTargetBasenames(lines)

  for (const { url, line } of urls) {
    const tier = classifyPasteHostTier(url)
    if (!tier) continue

    const lineIndex = line - 1
    const lineContent = lines[lineIndex] ?? ''
    // The URL is a fetch TARGET only when a fetch verb appears on the SAME
    // line — deliberately not widened to a bounded window (unlike the
    // chmod/archive compound signals) since a URL literally is the thing
    // being fetched when a fetch verb shares its line; widening would risk
    // correlating an unrelated fetch command to an unrelated nearby
    // paste-host mention.
    const isFetchTarget = safeRegexTest(FETCH_COMMAND_PATTERN, lineContent) !== null
    if (!isFetchTarget) continue // merely linked -> scanUrls()'s url:medium finding already covers this

    const ctx = contexts[lineIndex]
    const inDocContext = ctx ? isDocumentationContext(ctx) : false

    if (tier === 'transient') {
      // Always medium/co-signal-eligible, NEVER standalone-critical —
      // regardless of execution evidence. See patterns.ts's
      // TRANSIENT_TRANSFER_HOSTS comment for the rationale.
      findings.push({
        type: 'paste_host_fetch',
        severity: inDocContext ? 'low' : 'medium',
        message: `Ephemeral file-transfer host URL fetched (never standalone-critical by design): ${url}`,
        location: lineContent.trim().slice(0, 100),
        lineNumber: line,
        category: 'paste_host_fetch',
        inDocumentationContext: inDocContext,
        confidence: inDocContext ? 'low' : 'medium',
      })
      continue
    }

    // tier === 'anon' (ANON_PASTE_HOSTS or a URL shortener): critical
    // requires actual EXECUTION evidence, not just a fetch.
    const executed =
      isDirectPipeToInterpreter(url, lineContent) ||
      safeRegexCheck(NPX_DIRECT_EXEC_PATTERN, lineContent) ||
      isExecutedElsewhereCorrelated(lineContent, execTargetBasenames)
    if (!executed) continue // fetched but not executed -> scanUrls()'s url:medium finding already covers this

    findings.push({
      type: 'paste_host_fetch',
      // Standalone-critical (execution evidence required, see above) — doc
      // context is the only downgrade, matching every other detector's
      // noise-reduction convention in this Wave.
      severity: inDocContext ? 'low' : 'critical',
      message: `Paste/snippet-host URL is the target of an execution instruction: ${url}`,
      location: lineContent.trim().slice(0, 100),
      lineNumber: line,
      category: 'paste_host_fetch',
      inDocumentationContext: inDocContext,
      confidence: inDocContext ? 'low' : 'high',
    })
  }

  return findings
}
