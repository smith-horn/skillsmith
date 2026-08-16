/**
 * Security Scanner — code-execution & obfuscated-directive detectors
 * @module @skillsmith/core/security/scanner/SecurityScanner.exec
 *
 * SMI-5359 Wave 4.2: two top-tier (categoryWeight 2.0, coefficient 0.40) single-
 * emission detectors that give the scanner real teeth against supply-chain and
 * Unicode-concealment attacks the prod edge gate currently scores at ~1 point:
 *
 *  • code_execution     — a skill instructing a remote fetch piped into an
 *    interpreter (curl|bash and friends), or — SMI-6033 Wave 4, Gap 1 — the
 *    same instruction written as free-text prose with no shell syntax at all
 *    ("download the installer from thisurl.com and run it",
 *    `IMPERATIVE_FETCH_EXEC_PROSE` in patterns.exec.ts). Emits ONE medium
 *    finding (score 12, sub-threshold) on its own, whichever pattern set
 *    fired; escalated to critical (score 40, quarantines) only when it
 *    co-occurs with a NON-documentation exfiltration / privilege /
 *    credential-path / obfuscation signal, OR — SMI-6033 Wave 4, Gap 6 — with
 *    TWO DISTINCT high-confidence advisory-tier signals
 *    (`CO_SIGNAL_MIN_SEVERITY` below). The non-doc gate keeps legitimate
 *    security-research skills (which document these techniques inside fenced
 *    examples) below the threshold.
 *
 *  • obfuscated_directive — a malicious directive concealed with zero-width /
 *    bidi / tag-block / combining characters or homoglyphs (Cyrillic, Greek,
 *    fullwidth-Latin, Mathematical-Alphanumeric) and revealed only after
 *    de-obfuscation. Delta-gated (the directive must NOT be plainly present in
 *    the raw line) and verb+object-anchored (never a bare keyword/noun-phrase),
 *    so benign Cyrillic/Greek/CJK/fullwidth text stays clean. Emits ONE critical
 *    finding (score 40, quarantines alone). A blanket NFKC pass is intentionally
 *    NOT used — it folds fullwidth CJK to ASCII and false-positives; fullwidth
 *    Latin is mapped by offset and NFKC is applied per-char ONLY to the
 *    math-alphanumeric range (which contains no CJK).
 *    NOTE: unlike code_execution, this detector has NO documentation-context
 *    downgrade (findings are always inDocumentationContext:false). A *live*
 *    concealed payload (real invisibles/homoglyphs, not an escaped textual
 *    representation) is an attack even inside a fenced block — there is no
 *    legitimate reason to ship invisible/homoglyph-spliced directives.
 */

import type { SecurityFinding, SecurityFindingType, SecuritySeverity } from './types.js'
// SMI-6033 Wave 4 (Gap 1): both code_execution pattern sets now live in the
// patterns.exec.ts sibling (patterns.ts re-exports them unchanged); imported
// from their source of truth here.
import { CODE_EXECUTION_PATTERNS, IMPERATIVE_FETCH_EXEC_PROSE } from './patterns.exec.js'
import { safeRegexTest, safeRegexCheck } from './regex-utils.js'
import type { LineContext } from './SecurityScanner.helpers.js'
import { analyzeMarkdownContext, isDocumentationContext } from './SecurityScanner.helpers.js'
// SMI-595: confusable/homoglyph primitives extracted to a standalone module
// (confusables.ts) so the typosquat detector can reuse them without coupling
// to this file's code-execution/obfuscated-directive detectors. Pure
// extraction — no behavior change.
import {
  CONFUSABLES,
  isFullwidthLatin,
  isMathAlphanumeric,
  confusableSkeleton,
} from './confusables.js'

// ============================================================================
// Obfuscation primitives
// ============================================================================

/**
 * Invisible / format / bidi / tag-block / combining code points used to split or
 * hide a keyword. Removing them rejoins a fragmented directive ("ig<ZWSP>nore" ->
 * "ignore") and defuses Zalgo (U+0300-036F combining marks). Two copies: a
 * non-global tester (safe in a per-line loop) and a global stripper.
 */
const INVISIBLE_RANGE =
  '\\u0300-\\u036F\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF'
const INVISIBLE_TEST = new RegExp('[' + INVISIBLE_RANGE + ']|[\\u{E0000}-\\u{E007F}]', 'u')
const INVISIBLE_STRIP = new RegExp('[' + INVISIBLE_RANGE + ']|[\\u{E0000}-\\u{E007F}]', 'gu')

/**
 * Remove invisible/format/bidi/tag/combining characters.
 *
 * Exported (SMI-4703): reused as-is by the memory-injection-scanner's
 * normalization pipeline (invisible-strip step) — not reimplemented there.
 */
export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_STRIP, '')
}

/** True if the line contains a homoglyph / fullwidth-Latin / math-alphanumeric character. */
function hasConfusable(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (isFullwidthLatin(cp) || isMathAlphanumeric(cp) || CONFUSABLES[ch]) return true
  }
  return false
}

/**
 * Verb+object directive payloads worth concealing. STRICTLY verb+object — never a
 * bare keyword or bare noun-phrase — so a single de-obfuscated benign word (or a
 * benign feature phrase like "developer mode" rendered in fullwidth/math glyphs)
 * cannot trip it. Visible "developer mode" / "do anything now" are left to the
 * jailbreak detector, which scans the raw content. Quantifiers are bounded
 * (ReDoS-safe). Non-global so .test / .match never carry lastIndex between calls.
 */
const OBFUSCATION_DIRECTIVE_PATTERN =
  /(?:ignore|disregard|forget)\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instruction|prompt|rule|direction)|bypass\s+(?:all\s+)?(?:restriction|filter|safety|guard|security)|(?:reveal|show|print|dump|leak)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:system\s+)?(?:prompt|instruction)|(?:curl|wget)\b[^\n|]{0,120}?(?:https?:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[\w-]{2,}\.[a-z]{2,})[^\n|]{0,120}?\|\s*(?:ba|z)?sh\b/i

// ============================================================================
// Detectors
// ============================================================================

/**
 * code_execution: remote fetch piped into an interpreter (literal shell
 * syntax), OR — SMI-6033 Wave 4, Gap 1 — the same instruction expressed as a
 * natural-language install-and-run imperative with no shell syntax at all.
 *
 * Single-emission — at most one MEDIUM finding per skill (the first match, in
 * line order), whichever pattern set produced it. escalateCodeExecution()
 * promotes it to CRITICAL on co-occurrence.
 *
 * Ordering is deliberately line-major (each line is tested against the literal
 * syntax set first, then the prose set, before moving to the next line), so a
 * document containing only literal-syntax matches produces byte-identical
 * output to the pre-Gap-1 detector — same line, same message, same severity.
 * The message names WHICH set fired so a reviewer can tell a prose-triggered
 * finding from a syntax-triggered one at a glance.
 */
export function scanCodeExecution(
  content: string,
  lineContexts?: LineContext[]
): SecurityFinding[] {
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)

  const emit = (i: number, line: string, matched: string, prefix: string): SecurityFinding[] => {
    const ctx = contexts[i]
    const inDocContext = ctx ? isDocumentationContext(ctx) : false
    return [
      {
        type: 'code_execution',
        severity: 'medium',
        message: `${prefix}: "${matched.slice(0, 60)}${matched.length > 60 ? '...' : ''}"`,
        location: line.trim().slice(0, 100),
        lineNumber: i + 1,
        category: 'code_execution',
        inDocumentationContext: inDocContext,
        confidence: 'high',
      },
    ]
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const pattern of CODE_EXECUTION_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) return emit(i, line, match[0], 'Remote fetch piped to an interpreter')
    }
    // SMI-6033 Wave 4 (Gap 1): same finding type, same medium/advisory tier —
    // only the evidence shape differs (free-text imperative, no shell syntax).
    for (const pattern of IMPERATIVE_FETCH_EXEC_PROSE) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        return emit(
          i,
          line,
          match[0],
          'Natural-language instruction to fetch a remote file and execute it'
        )
      }
    }
  }
  return []
}

/**
 * obfuscated_directive: a malicious directive concealed by Unicode obfuscation,
 * revealed only after de-obfuscation. Single-emission CRITICAL. Delta-gated: a
 * directive already plainly visible in the raw line is left to the jailbreak /
 * prompt-leaking detectors.
 */
export function scanObfuscatedDirective(content: string): SecurityFinding[] {
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const hasInvisible = INVISIBLE_TEST.test(raw)
    const hasConf = hasConfusable(raw)
    if (!hasInvisible && !hasConf) continue
    // Already visible => not concealed; another detector owns it.
    if (safeRegexCheck(OBFUSCATION_DIRECTIVE_PATTERN, raw)) continue

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
            message: `Security directive concealed via Unicode obfuscation, revealed after de-obfuscation: "${match[0].slice(
              0,
              60
            )}${match[0].length > 60 ? '...' : ''}"`,
            location: raw.trim().slice(0, 100),
            lineNumber: i + 1,
            category: 'obfuscated_directive',
            inDocumentationContext: false,
            confidence: 'high',
          },
        ]
      }
    }
  }
  return []
}

/**
 * SMI-6033 Wave 4 (Gap 6): per-type MINIMUM co-signal severity, replacing the
 * flat `CODE_EXECUTION_CO_OCCURRENCE` set. Equality-parity-pinned against its
 * edge twin (security-scanner-edge.exec.ts) — identical keys AND identical
 * values, not a superset; see the co-signal parity test in
 * scripts/tests/indexer/security-scanner-edge.co-signal-escalation.test.ts.
 *
 * A `'high'` minimum means "one such co-signal escalates on its own" (path a
 * below — today's behavior, byte-identical for the original four types). A
 * `'medium'` minimum means "advisory tier: never sufficient alone, but two
 * DISTINCT such types together escalate" (path b). A type absent from this
 * map is not a co-signal at all.
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
 * that escalates it (SMI-5880). Before this bound, a co-signal ANYWHERE in the
 * document — any distance, any unrelated section — escalated the single
 * `code_execution` finding to critical.
 *
 * Why a bounded window is NOT a bypass vector FOR PATH (a): every `'high'`-
 * minimum co-signal is itself `high` or `critical`, and `scan()`
 * (SecurityScanner.ts) computes `passed = !hasCritical && !hasHigh &&
 * !exceedsThreshold` across ALL findings with no locality filter and no
 * documentation filter. A qualifying path-(a) co-signal anywhere therefore
 * forces `passed === false` on its own, BEFORE this function runs. Splitting
 * the two signals to duck this window cannot turn a failing scan into a
 * passing one; it changes only this finding's own label (medium vs critical)
 * and the risk-score magnitude of a scan that already blocks.
 * Hostile-update detection is likewise untouched: `detectSupplyChain()`
 * (SecurityScanner.hostile-update.ts) pairs a NEW non-doc `code_execution` of ANY
 * severity with a NEW non-doc high/critical co-signal at ANY distance, so a
 * far-apart rug-pull still returns the `hostile` verdict and its supply-chain
 * reason string.
 *
 * SMI-6033 Wave 4 (Gap 6) — that argument does NOT carry over to path (b),
 * and the difference is deliberate, not an oversight. Path (b)'s co-signals
 * are `medium` advisory findings that do NOT independently trip `passed`, so
 * an attacker who spreads the weak `code_execution` finding and its two
 * advisory co-signals more than 40 lines apart genuinely does keep a scan
 * under the bar (12 + 12 + 12 = 36 < the 40 threshold) that would otherwise
 * have escalated to critical. This is the accepted cost of bounding locality
 * at all: the alternative — an unbounded window for fuzzy heuristic signals —
 * re-creates the exact SMI-5880 defect (an unrelated advisory finding in a
 * different section escalating an unrelated `code_execution` finding) with a
 * far higher false-positive rate than the high-tier co-signals ever had,
 * because these signals are approximate by construction. The residual is
 * bounded: the attack still requires the two advisory signals to be real
 * detections in the same document, and `detectSupplyChain()`'s
 * distance-independent rug-pull check above is unaffected.
 *
 * Deliberately the same 40 as the sibling corroboration mechanism's locality
 * constant (SecurityScanner.evidence.ts) so the scanner has ONE locality model
 * — but kept as its own constant, not imported: the two mechanisms are
 * independently tunable, and the edge twins (SMI-5879) cannot import from core
 * and must carry their own copy.
 */
const MAX_CODE_EXECUTION_CO_SIGNAL_LINE_DISTANCE = 40

/**
 * Locality gate for `escalateCodeExecution`. Fail-CLOSED on missing metadata:
 * when either side has no `lineNumber` the distance is unknowable, and this
 * subsystem's convention is that missing metadata must never SILENTLY weaken
 * detection — cf. `classifyEvidence` (SecurityScanner.evidence.ts), whose
 * unmapped-pattern default is the STRONGEST tier for exactly this reason. An
 * unknowable distance therefore preserves the pre-SMI-5880 unbounded behavior for
 * that pair rather than suppressing the co-signal.
 *
 * Unreachable through `scan()` today: `scanCodeExecution` above and every emitter
 * of the eight `CO_SIGNAL_MIN_SEVERITY` types set `lineNumber` unconditionally
 * (the sensitive-path/data-exfiltration/privilege-escalation scanners in the
 * scanners module, the chmod-compound and Gatekeeper-bypass detectors,
 * `scanObfuscatedDirective` above, and — SMI-6033 — the archive-evasion,
 * paste-host and decoy-misdirection detectors). Kept as an explicit,
 * directly-tested branch so a future detector that forgets `lineNumber`
 * degrades safe instead of silently ceasing to escalate.
 */
function isWithinCoSignalWindow(codeExecLine?: number, coSignalLine?: number): boolean {
  if (typeof codeExecLine !== 'number' || typeof coSignalLine !== 'number') return true
  return Math.abs(codeExecLine - coSignalLine) <= MAX_CODE_EXECUTION_CO_SIGNAL_LINE_DISTANCE
}

/**
 * Escalate the code_execution finding (literal `curl|bash` syntax OR a Gap-1
 * `IMPERATIVE_FETCH_EXEC_PROSE` match — same finding type either way) to
 * CRITICAL, on either of two paths. Both require: the `code_execution`
 * finding ITSELF to be non-documentation (see the adversarial-review fix
 * note below), the co-signal to be NON-documentation, and the co-signal to be
 * WITHIN `MAX_CODE_EXECUTION_CO_SIGNAL_LINE_DISTANCE` lines (SMI-5880 —
 * previously any distance qualified, so an unrelated finding in a different
 * section of a long document escalated an unrelated code_execution finding).
 * Mutates the finding in place.
 *
 * Path (a) — ONE co-signal whose type's `CO_SIGNAL_MIN_SEVERITY` minimum is
 * `'high'`, at `high` or `critical`. Byte-identical to the pre-SMI-6033
 * behavior for the original four types (`data_exfiltration`,
 * `privilege_escalation`, `sensitive_path`, `obfuscated_directive`) EXCEPT
 * for the `codeExec`-own-doc-context fix below (see that note — the
 * pre-existing behavior there was a real gap, not an intentional design):
 * same co-signal membership test, same severity test, same locality gate,
 * same message. Deliberately NO confidence requirement on the CO-SIGNAL here
 * — adding one would change existing behavior, which the Gap 6 design
 * explicitly forbids.
 *
 * Path (b) — SMI-6033 Wave 4 (Gap 6), only evaluated when path (a) did not
 * fire: at least TWO DISTINCT `'medium'`-minimum types (two findings of the
 * SAME type do not count), each at or above its own minimum. A single fuzzy
 * medium signal (one decoy mismatch alone, one transfer.sh link alone) can
 * therefore never flip a legitimate vendor `curl|bash` to critical.
 *
 * Confidence requirement (revised after adversarial review, 2026-08-16 —
 * see `docs/internal/code_review/2026-08-15-smi6033-wave4-escalation-model.md`
 * for the full account): the plan's literal text requires `confidence:
 * 'high'` on both path-(b) co-signals. An earlier revision of this file
 * relaxed that to `confidence !== 'low'` GLOBALLY, reasoning that
 * `paste_host_fetch`'s ANON/TRANSIENT medium form is ALWAYS
 * `confidence: 'medium'` by construction (`SecurityScanner.paste-host.ts`)
 * and would otherwise be permanently unable to satisfy path (b) despite
 * being a registered-eligible type. That reasoning was correct for
 * `paste_host_fetch` specifically, but the GLOBAL relaxation was wrong: it
 * also admitted `archive_evasion`'s prose-only co-occurrence sub-signal
 * (explicitly documented in that file's own header as "the fuzzy, FP-prone
 * case" and capped at `confidence: 'medium'` for exactly that reason) and
 * `decoy_misdirection`'s no-authority-affix form (also `confidence:
 * 'medium'`) — an adversarial review constructed a working false-positive
 * example combining exactly those two fuzzy medium-confidence signals (a
 * mundane "distributed from our company site" skill blurb plus an unrelated
 * "supplied as a zip archive... ask your administrator for the password"
 * sentence) with a real vendor `curl|bash`, and it escalated to a hard
 * quarantine. Fixed by narrowing the confidence carve-out to ONLY
 * `paste_host_fetch` (`CO_SIGNAL_MEDIUM_CONFIDENCE_EXCEPTION` below) — every
 * other medium-minimum type reverts to requiring `confidence: 'high'`,
 * matching the plan's literal text. `gatekeeper_bypass` loses nothing by
 * this (its own detector always emits `confidence: 'high'` regardless of
 * severity); `archive_evasion` and `decoy_misdirection` now only participate
 * via their own higher-confidence forms (CLI-syntax inline-secret-adjacent
 * password mentions; an authority-affix-boosted brand claim), which is
 * exactly the "not noise" signal path (b) was meant to require. See the
 * co-signal escalation tests for the pinned behavior of this decision.
 *
 * `codeExec`-own-doc-context fix (same adversarial review): neither path
 * previously checked `codeExec.inDocumentationContext` itself — only the
 * CO-SIGNAL's doc-context was checked. A `code_execution` finding inside a
 * fenced security-research example could therefore still be escalated by
 * two genuine (non-doc) co-signals elsewhere in the document, contradicting
 * this function's own historical doc comments claiming fenced examples stay
 * at MEDIUM. This gap predates Wave 4 (path (a) had it too) but Wave 4's new
 * path (b) co-signal types meaningfully widen how often it's reachable, so
 * it's fixed here for both paths rather than left in place for path (a)
 * alone.
 *
 * Runs BEFORE the sibling corroboration mechanism in `scan()` — see that
 * function's doc comment (SecurityScanner.evidence.ts) for why the ordering is
 * safe in both directions.
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
  // by construction (see this function's doc comment for the full rationale
  // and the adversarial-review finding that narrowed this from a blanket
  // `!== 'low'` relaxation).
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
