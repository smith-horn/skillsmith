/**
 * SMI-5359 Wave 4.2c: Edge code_execution + obfuscated_directive detectors
 * @module scripts/indexer/_shared/security-scanner-edge.exec (Node port)
 *
 * Byte-identical body to its supabase/functions/_shared twin (parity test
 * enforces). Pure Deno/Web APIs, no Node deps. Port of @skillsmith/core
 * SecurityScanner.exec.ts so the prod edge quarantine gate detects the same two
 * top-tier attack classes the core scanner now does (merged core 4.2, ac56767f):
 *
 *  • code_execution     — a skill instructing a remote fetch piped into an
 *    interpreter (curl|bash and friends), or — SMI-6033 Wave 4, Gap 1 — the
 *    same instruction as free-text prose with no shell syntax
 *    (IMPERATIVE_FETCH_EXEC_PROSE, security-scanner-edge.patterns.ts). ONE
 *    medium finding on its own (score 12, sub-threshold); escalated to
 *    critical (score 40, quarantines) only when it co-occurs with a
 *    NON-documentation exfil / privilege / obfuscation signal, OR — SMI-6033
 *    Wave 4, Gap 6 — with TWO DISTINCT high-confidence advisory-tier signals
 *    (CO_SIGNAL_MIN_SEVERITY below).
 *  • obfuscated_directive — a verb+object directive concealed with zero-width /
 *    bidi / tag-block / combining chars or homoglyphs (Cyrillic, Greek,
 *    fullwidth-Latin, Mathematical-Alphanumeric) and revealed only after
 *    de-obfuscation. Delta-gated + verb+object-anchored. ONE critical finding
 *    (score 40, quarantines alone). A blanket NFKC pass is intentionally NOT used
 *    (it folds fullwidth CJK to ASCII and false-positives); fullwidth Latin is
 *    mapped by offset, NFKC is applied per-char ONLY to the math-alphanumeric
 *    range (no CJK). Unlike code_execution, this has NO doc-context downgrade — a
 *    live concealed payload is an attack even inside a fence.
 */

import type {
  SecurityFinding,
  SecurityFindingType,
  SecuritySeverity,
  LineContext,
} from './security-scanner-edge.context.ts'
import { isDocumentationContext } from './security-scanner-edge.context.ts'
// SMI-6033 Wave 1: CODE_EXECUTION_PATTERNS moved to the patterns sibling (single
// source of truth — this file previously re-declared the identical array inline
// instead of importing it, so an edit to one copy silently didn't apply to the other).
// SMI-6033 Wave 4 (Gap 1): IMPERATIVE_FETCH_EXEC_PROSE joins it there.
import {
  CODE_EXECUTION_PATTERNS,
  IMPERATIVE_FETCH_EXEC_PROSE,
} from './security-scanner-edge.patterns.ts'

// ReDoS protection: maximum line length for regex matching (mirrors scanner).
const MAX_LINE_LENGTH = 10000

function safeRegexTest(pattern: RegExp, input: string): RegExpMatchArray | null {
  const safeInput = input.length > MAX_LINE_LENGTH ? input.slice(0, MAX_LINE_LENGTH) : input
  return safeInput.match(pattern)
}

// ============================================================================
// code_execution: remote-fetch-to-interpreter patterns
// ============================================================================

/**
 * code_execution: single-emission — at most one MEDIUM finding per skill (first
 * match, in line order), from EITHER literal shell syntax
 * (CODE_EXECUTION_PATTERNS) or — SMI-6033 Wave 4, Gap 1 — a natural-language
 * fetch-and-execute imperative with no shell syntax at all
 * (IMPERATIVE_FETCH_EXEC_PROSE). escalateCodeExecution() promotes it to
 * CRITICAL on co-occurrence.
 *
 * Ordering is line-major (each line tested against the literal-syntax set
 * first, then the prose set, before moving on), so a document containing only
 * literal-syntax matches produces byte-identical output to the pre-Gap-1
 * detector. The message names which set fired.
 */
export function scanCodeExecution(lines: string[], contexts: LineContext[]): SecurityFinding[] {
  const emit = (
    index: number,
    line: string,
    matched: string,
    prefix: string
  ): SecurityFinding[] => {
    const ctx = contexts[index]
    const inDocContext = ctx ? isDocumentationContext(ctx) : false
    return [
      {
        type: 'code_execution',
        severity: 'medium',
        message: `${prefix}: "${matched.slice(0, 60)}"`,
        lineNumber: index + 1,
        location: line.trim().slice(0, 100),
        inDocumentationContext: inDocContext,
        confidence: 'high',
      },
    ]
  }

  for (const [index, line] of lines.entries()) {
    for (const pattern of CODE_EXECUTION_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) return emit(index, line, match[0], 'Remote fetch piped to an interpreter')
    }
    // SMI-6033 Wave 4 (Gap 1): same finding type, same medium/advisory tier —
    // only the evidence shape differs (free-text imperative, no shell syntax).
    for (const pattern of IMPERATIVE_FETCH_EXEC_PROSE) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        return emit(
          index,
          line,
          match[0],
          'Natural-language instruction to fetch a remote file and execute it'
        )
      }
    }
  }
  return []
}

// ============================================================================
// obfuscated_directive: Unicode-concealment de-obfuscation
// ============================================================================

const INVISIBLE_RANGE =
  '\\u0300-\\u036F\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF'
const INVISIBLE_TEST = new RegExp('[' + INVISIBLE_RANGE + ']|[\\u{E0000}-\\u{E007F}]', 'u')
const INVISIBLE_STRIP = new RegExp('[' + INVISIBLE_RANGE + ']|[\\u{E0000}-\\u{E007F}]', 'gu')

/** Conservative UTS-#39 homoglyph subset: unambiguous Cyrillic/Greek look-alikes. */
const CONFUSABLES: Record<string, string> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  һ: 'h',
  к: 'k',
  м: 'm',
  т: 't',
  в: 'b',
  н: 'h',
  ο: 'o',
  α: 'a',
  ρ: 'p',
  ε: 'e',
  τ: 't',
  ι: 'i',
  κ: 'k',
  υ: 'u',
  χ: 'x',
  ν: 'v',
  ϲ: 'c',
  β: 'b',
}

function isFullwidthLatin(cp: number): boolean {
  return (cp >= 0xff21 && cp <= 0xff3a) || (cp >= 0xff41 && cp <= 0xff5a)
}

function isMathAlphanumeric(cp: number): boolean {
  return cp >= 0x1d400 && cp <= 0x1d7ff
}

function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_STRIP, '')
}

/** Map homoglyphs + fullwidth Latin + math-alphanumeric to their ASCII skeleton. */
function confusableSkeleton(s: string): string {
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (isFullwidthLatin(cp)) {
      out += String.fromCodePoint(cp - 0xfee0)
    } else if (isMathAlphanumeric(cp)) {
      // NFKC folds a math-styled glyph to its base; chain through CONFUSABLES so a
      // math-styled Greek/Cyrillic homoglyph (folds to Greek/Cyrillic) still maps
      // to Latin (SMI-5359 retro NIT). Safe: the range contains no CJK.
      const folded = ch.normalize('NFKC')
      out += CONFUSABLES[folded] ?? folded
    } else if (CONFUSABLES[ch]) {
      out += CONFUSABLES[ch]
    } else {
      out += ch
    }
  }
  return out
}

function hasConfusable(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (isFullwidthLatin(cp) || isMathAlphanumeric(cp) || CONFUSABLES[ch]) return true
  }
  return false
}

/**
 * Verb+object directive payloads worth concealing. STRICTLY verb+object — never a
 * bare keyword/noun-phrase — so a benign de-obfuscated word (or "developer mode"
 * in fullwidth/math glyphs) cannot trip it. Bounded (ReDoS-safe), non-global.
 */
const OBFUSCATION_DIRECTIVE_PATTERN =
  /(?:ignore|disregard|forget)\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instruction|prompt|rule|direction)|bypass\s+(?:all\s+)?(?:restriction|filter|safety|guard|security)|(?:reveal|show|print|dump|leak)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:system\s+)?(?:prompt|instruction)|(?:curl|wget)\b[^\n|]{0,120}?(?:https?:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[\w-]{2,63}\.[a-z]{2,24})[^\n|]{0,120}?\|\s*(?:ba|z)?sh\b/i

/**
 * obfuscated_directive: single-emission CRITICAL. Delta-gated — a directive
 * already plainly visible in the raw line is left to the jailbreak detector.
 */
export function scanObfuscatedDirective(lines: string[]): SecurityFinding[] {
  for (const [index, raw] of lines.entries()) {
    const hasInvisible = INVISIBLE_TEST.test(raw)
    const hasConf = hasConfusable(raw)
    if (!hasInvisible && !hasConf) continue
    // Already visible => not concealed; another detector owns it.
    if (safeRegexTest(OBFUSCATION_DIRECTIVE_PATTERN, raw)) continue

    const transforms: string[] = []
    if (hasInvisible) transforms.push(stripInvisible(raw))
    if (hasConf) transforms.push(confusableSkeleton(raw))
    if (hasInvisible && hasConf) transforms.push(confusableSkeleton(stripInvisible(raw)))

    for (const transformed of transforms) {
      if (transformed === raw) continue
      const match = safeRegexTest(OBFUSCATION_DIRECTIVE_PATTERN, transformed)
      if (match) {
        return [
          {
            type: 'obfuscated_directive',
            severity: 'critical',
            message: `Security directive concealed via Unicode obfuscation, revealed after de-obfuscation: "${match[0].slice(0, 60)}"`,
            lineNumber: index + 1,
            location: raw.trim().slice(0, 100),
            inDocumentationContext: false,
            confidence: 'high',
          },
        ]
      }
    }
  }
  return []
}

// ============================================================================
// Co-occurrence escalation
// ============================================================================

/**
 * SMI-6033 Wave 4 (Gap 6): per-type MINIMUM co-signal severity, replacing the
 * flat `CODE_EXECUTION_CO_OCCURRENCE` set. Equality-parity-pinned against
 * core's own map (packages/core/src/security/scanner/SecurityScanner.exec.ts)
 * — identical keys AND identical values, not a superset; see
 * scripts/tests/indexer/security-scanner-edge.co-signal-escalation.test.ts.
 *
 * A `'high'` minimum means "one such co-signal escalates on its own" (path a
 * below — byte-identical to today for the original four types). A `'medium'`
 * minimum means "advisory tier: never sufficient alone, but two DISTINCT such
 * types together escalate" (path b). A type absent from this map is not a
 * co-signal at all.
 */
const CO_SIGNAL_MIN_SEVERITY: Partial<Record<SecurityFindingType, SecuritySeverity>> = {
  // Existing four — behavior byte-identical to today, min 'high'.
  data_exfiltration: 'high',
  privilege_escalation: 'high',
  sensitive_path: 'high',
  obfuscated_directive: 'high',
  // New ClawHavoc advisory-tier categories — eligible at 'medium'.
  decoy_misdirection: 'medium',
  archive_evasion: 'medium',
  paste_host_fetch: 'medium',
  gatekeeper_bypass: 'medium', // its correlated/critical form already quarantines on its own
}

/** Ordinal ranking so "at or above its type's minimum" is a single comparison. */
const SEVERITY_RANK: Record<SecuritySeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 }

/**
 * Maximum line distance between the `code_execution` finding and the co-signal
 * that escalates it (SMI-5880, ported here SMI-6033 Wave 1 — previously edge had
 * no locality gate, so a co-signal ANYWHERE in the document escalated the single
 * `code_execution` finding regardless of distance). Deliberately the same 40 as
 * core's own constant (SecurityScanner.exec.ts) but kept as its own copy, not
 * imported — edge twins cannot import from core and must carry their own copy.
 */
const MAX_CODE_EXECUTION_CO_SIGNAL_LINE_DISTANCE = 40

/**
 * Locality gate for `escalateCodeExecution`. Fail-CLOSED on missing metadata:
 * when either side has no `lineNumber` the distance is unknowable, and this
 * subsystem's convention is that missing metadata must never SILENTLY weaken
 * detection. Every emitter of the eight CO_SIGNAL_MIN_SEVERITY types sets
 * `lineNumber` unconditionally, so this branch is unreachable through
 * scanSkillContent today — kept explicit so a future detector that forgets
 * `lineNumber` degrades safe instead of silently ceasing to escalate.
 */
function isWithinCoSignalWindow(codeExecLine?: number, coSignalLine?: number): boolean {
  if (typeof codeExecLine !== 'number' || typeof coSignalLine !== 'number') return true
  return Math.abs(codeExecLine - coSignalLine) <= MAX_CODE_EXECUTION_CO_SIGNAL_LINE_DISTANCE
}

/**
 * Escalate the code_execution finding (literal `curl|bash` syntax OR a Gap-1
 * IMPERATIVE_FETCH_EXEC_PROSE match — same finding type either way) to
 * CRITICAL, on either of two paths. Both require: the code_execution finding
 * ITSELF to be non-documentation (see the adversarial-review fix note
 * below), the co-signal to be NON-documentation, and the co-signal to be
 * WITHIN MAX_CODE_EXECUTION_CO_SIGNAL_LINE_DISTANCE lines. Mutates in place.
 *
 * Path (a) — ONE co-signal whose type's CO_SIGNAL_MIN_SEVERITY minimum is
 * `'high'`, at `high` or `critical`. Byte-identical to the pre-SMI-6033
 * behavior for the original four types EXCEPT for the codeExec-own-doc-context
 * fix below (the pre-existing behavior there was a real gap, not an
 * intentional design): same co-signal membership test, same severity test,
 * same locality gate, same message. Deliberately NO confidence requirement on
 * the CO-SIGNAL here — adding one would change existing behavior, which the
 * Gap 6 design explicitly forbids.
 *
 * Path (b) — SMI-6033 Wave 4 (Gap 6), only evaluated when path (a) did not
 * fire: at least TWO DISTINCT `'medium'`-minimum types (two findings of the
 * SAME type do not count), each at or above its own minimum. A single fuzzy
 * medium signal (one decoy mismatch alone, one transfer.sh link alone) can
 * therefore never flip a legitimate vendor `curl|bash` to critical.
 *
 * Confidence requirement (revised after adversarial review, 2026-08-16 — see
 * docs/internal/code_review/2026-08-15-smi6033-wave4-escalation-model.md for
 * the full account): the plan's literal text requires confidence:'high' on
 * both path-(b) co-signals. An earlier revision of this file relaxed that to
 * `confidence !== 'low'` GLOBALLY, reasoning that scanPasteHostFetch's
 * ANON/TRANSIENT medium form is ALWAYS confidence:'medium' by construction
 * and would otherwise be permanently unable to satisfy path (b) despite
 * being a registered-eligible type. That reasoning was correct for
 * paste_host_fetch specifically, but the GLOBAL relaxation was wrong: it
 * also admitted scanArchiveEvasion's prose-only co-occurrence sub-signal
 * (explicitly documented as "the fuzzy, FP-prone case" and capped at
 * confidence:'medium' for exactly that reason) and scanDecoyMisdirection's
 * no-authority-affix form (also confidence:'medium') — an adversarial review
 * constructed a working false-positive example combining exactly those two
 * fuzzy medium-confidence signals with a real vendor curl|bash, and it
 * escalated to a hard quarantine. Fixed by narrowing the confidence
 * carve-out to ONLY paste_host_fetch (CO_SIGNAL_MEDIUM_CONFIDENCE_EXCEPTION
 * below) — every other medium-minimum type reverts to requiring
 * confidence:'high', matching the plan's literal text. gatekeeper_bypass
 * loses nothing by this (its own detector always emits confidence:'high'
 * regardless of severity); archive_evasion and decoy_misdirection now only
 * participate via their own higher-confidence forms, which is exactly the
 * "not noise" signal path (b) was meant to require. Byte-identical to core's
 * SecurityScanner.exec.ts — see that file for the same rationale.
 *
 * codeExec-own-doc-context fix (same adversarial review): neither path
 * previously checked codeExec.inDocumentationContext itself — only the
 * CO-SIGNAL's doc-context was checked. A code_execution finding inside a
 * fenced security-research example could therefore still be escalated by two
 * genuine (non-doc) co-signals elsewhere in the document. This gap predates
 * Wave 4 (path (a) had it too) but Wave 4's new path (b) co-signal types
 * meaningfully widen how often it's reachable, so it's fixed here for both
 * paths.
 */
const CO_SIGNAL_MEDIUM_CONFIDENCE_EXCEPTION: ReadonlySet<SecurityFindingType> = new Set([
  'paste_host_fetch',
])

export function escalateCodeExecution(findings: SecurityFinding[]): void {
  const codeExec = findings.find((f) => f.type === 'code_execution')
  if (!codeExec) return
  if (codeExec.inDocumentationContext === true) return

  const eligible = findings.filter(
    (f) =>
      f !== codeExec &&
      CO_SIGNAL_MIN_SEVERITY[f.type] !== undefined &&
      f.inDocumentationContext !== true &&
      isWithinCoSignalWindow(codeExec.lineNumber, f.lineNumber)
  )

  // Path (a): one high-minimum co-signal at high/critical.
  const hasDangerousCoSignal = eligible.some(
    (f) =>
      CO_SIGNAL_MIN_SEVERITY[f.type] === 'high' &&
      (f.severity === 'high' || f.severity === 'critical')
  )
  if (hasDangerousCoSignal) {
    codeExec.severity = 'critical'
    codeExec.message = `Remote fetch piped to an interpreter, co-occurring with exfiltration/privilege/credential signals — likely supply-chain execution. ${codeExec.message}`
    return
  }

  // Path (b): two DISTINCT medium-minimum types, each confidence 'high' —
  // except paste_host_fetch, whose medium form is always confidence:'medium'
  // by construction (see this function's doc comment for the full rationale).
  const advisoryTypes = new Set(
    eligible
      .filter((f) => {
        const min = CO_SIGNAL_MIN_SEVERITY[f.type]
        const confidenceOk = CO_SIGNAL_MEDIUM_CONFIDENCE_EXCEPTION.has(f.type)
          ? f.confidence !== 'low'
          : f.confidence === 'high'
        return min === 'medium' && SEVERITY_RANK[f.severity] >= SEVERITY_RANK[min] && confidenceOk
      })
      .map((f) => f.type)
  )
  if (advisoryTypes.size >= 2) {
    codeExec.severity = 'critical'
    codeExec.message = `Remote fetch/execute instruction corroborated by two independent advisory-tier signals (${[
      ...advisoryTypes,
    ]
      .sort()
      .join(', ')}) — likely supply-chain execution. ${codeExec.message}`
  }
}
