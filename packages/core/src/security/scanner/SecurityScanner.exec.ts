/**
 * Security Scanner — code-execution & obfuscated-directive detectors
 * @module @skillsmith/core/security/scanner/SecurityScanner.exec
 *
 * SMI-5359 Wave 4.2: two top-tier (categoryWeight 2.0, coefficient 0.40) single-
 * emission detectors that give the scanner real teeth against supply-chain and
 * Unicode-concealment attacks the prod edge gate currently scores at ~1 point:
 *
 *  • code_execution     — a skill instructing a remote fetch piped into an
 *    interpreter (curl|bash and friends). Emits ONE medium finding (score 12,
 *    sub-threshold) on its own; escalated to critical (score 40, quarantines)
 *    only when it co-occurs with a NON-documentation exfiltration / privilege /
 *    credential-path / obfuscation signal. The non-doc gate keeps legitimate
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

import type { SecurityFinding, SecurityFindingType } from './types.js'
import { CODE_EXECUTION_PATTERNS } from './patterns.js'
import { safeRegexTest, safeRegexCheck } from './regex-utils.js'
import type { LineContext } from './SecurityScanner.helpers.js'
import { analyzeMarkdownContext, isDocumentationContext } from './SecurityScanner.helpers.js'

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
 * Conservative homoglyph map (a curated subset of UTS-#39 confusables): only the
 * unambiguous Cyrillic / Greek look-alikes that real homoglyph attacks use to
 * disguise Latin letters. Fullwidth Latin (offset 0xFEE0) and the Mathematical
 * Alphanumeric Symbols block (U+1D400-1D7FF, e.g. bold/italic/script 𝐢𝐠𝐧𝐨𝐫𝐞)
 * are handled programmatically below — never via a blanket NFKC pass, which would
 * also fold fullwidth CJK to ASCII and false-positive. (NFKC is applied per-char
 * ONLY to the math-alphanumeric range, which contains no CJK.)
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic -> Latin
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
  // Greek -> Latin
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

/** Mathematical Alphanumeric Symbols (bold/italic/script/fraktur/double-struck/sans/mono). */
function isMathAlphanumeric(cp: number): boolean {
  return cp >= 0x1d400 && cp <= 0x1d7ff
}

/** Remove invisible/format/bidi/tag/combining characters. */
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
      // to Latin (SMI-5359 retro NIT). Safe: the range contains no CJK; a reserved
      // hole stays unchanged (won't match).
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
  /(?:ignore|disregard|forget)\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instruction|prompt|rule|direction)|bypass\s+(?:all\s+)?(?:restriction|filter|safety|guard|security)|(?:reveal|show|print|dump|leak)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:system\s+)?(?:prompt|instruction)|(?:curl|wget)\b[^\n|]{0,120}?(?:https?:\/\/|[\w-]{2,}\.[a-z]{2,})[^\n|]{0,120}?\|\s*(?:ba|z)?sh\b/i

// ============================================================================
// Detectors
// ============================================================================

/**
 * code_execution: remote fetch piped into an interpreter. Single-emission — at
 * most one MEDIUM finding per skill (the first match). escalateCodeExecution()
 * promotes it to CRITICAL on co-occurrence.
 */
export function scanCodeExecution(
  content: string,
  lineContexts?: LineContext[]
): SecurityFinding[] {
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const pattern of CODE_EXECUTION_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const ctx = contexts[i]
        const inDocContext = ctx ? isDocumentationContext(ctx) : false
        return [
          {
            type: 'code_execution',
            severity: 'medium',
            message: `Remote fetch piped to an interpreter: "${match[0].slice(0, 60)}${
              match[0].length > 60 ? '...' : ''
            }"`,
            location: line.trim().slice(0, 100),
            lineNumber: i + 1,
            category: 'code_execution',
            inDocumentationContext: inDocContext,
            confidence: 'high',
          },
        ]
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
 * Co-occurrence types that turn a remote-fetch-to-interpreter from "suspicious"
 * (medium) into "supply-chain execution" (critical).
 */
const CODE_EXECUTION_CO_OCCURRENCE: ReadonlySet<SecurityFindingType> = new Set([
  'data_exfiltration',
  'privilege_escalation',
  'sensitive_path',
  'obfuscated_directive',
])

/**
 * Escalate the code_execution finding to CRITICAL when a NON-documentation
 * high/critical exfiltration / privilege / credential-path / obfuscation signal
 * is also present. Mutates the finding in place. Requiring the co-signal to be
 * non-documentation keeps legitimate security-research skills (whose examples
 * live in fenced blocks) at MEDIUM.
 */
export function escalateCodeExecution(findings: SecurityFinding[]): void {
  const codeExec = findings.find((f) => f.type === 'code_execution')
  if (!codeExec) return

  const hasDangerousCoSignal = findings.some(
    (f) =>
      f !== codeExec &&
      CODE_EXECUTION_CO_OCCURRENCE.has(f.type) &&
      f.inDocumentationContext !== true &&
      (f.severity === 'high' || f.severity === 'critical')
  )

  if (hasDangerousCoSignal) {
    codeExec.severity = 'critical'
    codeExec.message = `Remote fetch piped to an interpreter, co-occurring with exfiltration/privilege/credential signals — likely supply-chain execution. ${codeExec.message}`
  }
}
