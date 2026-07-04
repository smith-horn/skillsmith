/**
 * Hostile-Update Detection — R0 Wave 2A (SMI-5535)
 * @module @skillsmith/core/security/scanner/SecurityScanner.hostile-update
 *
 * A PURE comparator (no I/O, no clock, no mutation of its inputs) that detects a
 * benign→malicious "rug-pull" between two SecurityScanner scans of the SAME
 * skill. The scanner already blocks a skill that is malicious on first sight;
 * this detector catches the harder case where an initially-clean skill is
 * silently updated to exfiltrate credentials or execute remote payloads.
 *
 * The verdict is delta-based: it never re-scores content, it only reasons about
 * what changed between `previous` and `current`. "hostile" is reserved for the
 * benign→malicious transition — a skill that was ALREADY flagged and merely got
 * worse is a worsening (`suspicious`), not a fresh rug-pull.
 */

import type {
  HostileUpdateVerdict,
  ScanReport,
  SecurityFinding,
  SecurityFindingType,
  SecuritySeverity,
} from './types.js'

/**
 * Default risk-score threshold. Mirrors SecurityScanner's `riskThreshold`
 * default (SMI-5359) so the "crossed the failure bar" signal here lines up with
 * the `passed` computation in `SecurityScanner.scan`.
 */
export const DEFAULT_RISK_THRESHOLD = 40

/**
 * Minimum positive risk jump (short of crossing the threshold) that still counts
 * as a "material" worsening worth a `suspicious` verdict.
 */
const MATERIAL_RISK_DELTA = 10

/**
 * Co-occurrence finding types that, paired with a NEW `code_execution` finding,
 * indicate a supply-chain execution rug-pull. Mirrors the intuition of
 * `escalateCodeExecution`'s CODE_EXECUTION_CO_OCCURRENCE set (SecurityScanner.exec.ts),
 * minus `obfuscated_directive` — a live concealed directive is already critical
 * and self-quarantines on its own, so it needs no code_execution pairing here.
 */
const SUPPLY_CHAIN_CO_SIGNALS: ReadonlySet<SecurityFindingType> = new Set([
  'data_exfiltration',
  'privilege_escalation',
  'sensitive_path',
])

const SEVERITY_ORDER: Record<SecuritySeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
}

function isHighOrCritical(f: SecurityFinding): boolean {
  return f.severity === 'high' || f.severity === 'critical'
}

/**
 * Normalize free-text so cosmetic churn (whitespace runs, casing) does not make
 * an otherwise-identical finding look "new". lineNumber is deliberately excluded
 * from the key (see `findingKey`) because inserting benign prose above a finding
 * shifts its line without changing the finding itself.
 */
function normalizeText(text: string | undefined): string {
  if (!text) return ''
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Stable identity for a finding: type + severity + normalized message + location.
 * Severity is part of the key on purpose — an escalation (e.g. code_execution
 * medium→critical, which also rewrites the message) is a genuinely NEW hostile
 * signal, not the "same" finding. A finding that got SAFER (higher→lower
 * severity, or disappeared entirely) therefore never shows up in `newFindings`.
 */
function findingKey(f: SecurityFinding): string {
  return [f.type, f.severity, normalizeText(f.message), normalizeText(f.location)].join('\u0000')
}

/** Findings present in `current` whose key is absent from `previous`. */
function diffNewFindings(previous: ScanReport, current: ScanReport): SecurityFinding[] {
  const previousKeys = new Set(previous.findings.map(findingKey))
  return current.findings.filter((f) => !previousKeys.has(findingKey(f)))
}

function highestSeverity(findings: SecurityFinding[]): SecurityFinding {
  return findings.reduce((worst, f) =>
    SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[worst.severity] ? f : worst
  )
}

/** Compact, one-line, single-number formatting for a (possibly fractional) score. */
function fmt(n: number): string {
  const rounded = Math.round(n * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function signed(n: number): string {
  return n > 0 ? `+${fmt(n)}` : fmt(n)
}

function describeFinding(f: SecurityFinding): string {
  const msg = f.message.length > 80 ? `${f.message.slice(0, 77)}...` : f.message
  return `${f.type} (${f.severity}): ${msg}`
}

/**
 * A NEW, non-documentation `code_execution` finding paired with a NEW,
 * non-documentation high/critical exfiltration/privilege/credential-path
 * finding = supply-chain execution. Requiring both to be new (and non-doc)
 * keeps a security-research skill that merely documents these techniques from
 * tripping the strongest signal.
 */
function detectSupplyChain(
  newFindings: SecurityFinding[]
): { codeExec: SecurityFinding; coSignal: SecurityFinding } | null {
  const codeExec = newFindings.find(
    (f) => f.type === 'code_execution' && f.inDocumentationContext !== true
  )
  if (!codeExec) return null

  const coSignal = newFindings.find(
    (f) =>
      f !== codeExec &&
      SUPPLY_CHAIN_CO_SIGNALS.has(f.type) &&
      f.inDocumentationContext !== true &&
      isHighOrCritical(f)
  )
  if (!coSignal) return null

  return { codeExec, coSignal }
}

/**
 * Compare two scans of the same skill and classify the transition.
 *
 * Ordering is hostile → suspicious → benign so the strongest signal wins.
 *
 * @param previous  Scan of the prior (trusted) version.
 * @param current   Scan of the incoming version.
 * @param threshold Risk-score failure bar; defaults to {@link DEFAULT_RISK_THRESHOLD}.
 *
 *   CALLER CONTRACT (LOW-2): this value MUST equal the `riskThreshold` the
 *   `SecurityScanner` instance used to produce BOTH `previous` and `current`
 *   (i.e. the same `ScannerOptions.riskThreshold` — or the scanner's own
 *   default of 40, which is why this parameter also defaults to
 *   {@link DEFAULT_RISK_THRESHOLD}). `previouslyBenign` below is derived from
 *   `previous.passed`, which was computed by the scanner against ITS OWN
 *   `riskThreshold` at scan time — if the caller passes a `threshold` here
 *   that differs from that value, `crossedThreshold`'s "did the score cross
 *   the bar" signal and `previouslyBenign`'s "was it passing" signal are
 *   reasoning about two different bars, and the hostile/suspicious/benign
 *   verdict can disagree with what `previous.passed` / `current.passed`
 *   would say under a freshly-run scan.
 */
export function compareScanReports(
  previous: ScanReport,
  current: ScanReport,
  threshold: number = DEFAULT_RISK_THRESHOLD
): HostileUpdateVerdict {
  const newFindings = diffNewFindings(previous, current)
  const riskDelta = current.riskScore - previous.riskScore

  const previouslyBenign = previous.passed === true
  const crossedThreshold = previous.riskScore < threshold && current.riskScore >= threshold

  const newHighCritical = newFindings.filter(isHighOrCritical)
  // Mirror escalateCodeExecution's non-doc gate: a new high/critical finding that
  // lives ONLY in a documentation context (a fenced example) is weak rug-pull
  // evidence, so it does not on its own trip `hostile` — it falls to `suspicious`.
  const newHighCriticalNonDoc = newHighCritical.filter((f) => f.inDocumentationContext !== true)
  const newMedium = newFindings.filter((f) => f.severity === 'medium')
  const materialDelta = riskDelta >= MATERIAL_RISK_DELTA
  // A new medium finding only signals a worsening when the overall risk actually
  // rose. This suppresses the case where an old high finding was DOWNGRADED to
  // medium (its medium variant is technically "new" under the severity-keyed diff,
  // but the net change made the skill safer — riskDelta <= 0).
  const mediumWorsening = newMedium.length > 0 && riskDelta > 0

  const scoreClause = `risk ${fmt(previous.riskScore)}->${fmt(current.riskScore)}`

  // ---- hostile: a benign→malicious flip ----------------------------------
  if (previouslyBenign && (newHighCriticalNonDoc.length > 0 || crossedThreshold)) {
    const supplyChain = detectSupplyChain(newFindings)
    let reason: string
    if (supplyChain) {
      reason =
        `Rug-pull: previously-benign skill now ships a remote-execution command ` +
        `[${describeFinding(supplyChain.codeExec)}] co-occurring with a fresh ` +
        `${supplyChain.coSignal.type} signal [${describeFinding(supplyChain.coSignal)}] - ` +
        `classic supply-chain execution (${scoreClause}).`
    } else if (newHighCriticalNonDoc.length > 0) {
      const worst = highestSeverity(newHighCriticalNonDoc)
      reason =
        `Rug-pull: previously-benign skill introduced ${newHighCriticalNonDoc.length} new ` +
        `high/critical finding(s), e.g. ${describeFinding(worst)} (${scoreClause}).`
    } else {
      reason =
        `Rug-pull: previously-benign skill's risk score crossed the failure bar ` +
        `(${fmt(previous.riskScore)} -> ${fmt(current.riskScore)} >= ${threshold}).`
    }
    return { verdict: 'hostile', newFindings, riskDelta, reason }
  }

  // ---- suspicious: a worsening short of a benign→malicious flip -----------
  if (newHighCritical.length > 0 || mediumWorsening || materialDelta) {
    let reason: string
    if (newHighCritical.length > 0) {
      const worst = highestSeverity(newHighCritical)
      const base = previouslyBenign
        ? `Update added ${newHighCritical.length} new high/critical finding(s) confined to a documentation context`
        : `Already-flagged skill added ${newHighCritical.length} new high/critical finding(s) - a worsening, not a fresh benign->malicious transition`
      reason = `${base}, e.g. ${describeFinding(worst)} (${scoreClause}).`
    } else if (newMedium.length > 0) {
      reason =
        `Update introduced ${newMedium.length} new medium finding(s) without reaching the ` +
        `hostile bar (${scoreClause}).`
    } else {
      reason =
        `Risk score rose materially (${scoreClause}, delta ${signed(riskDelta)}) ` +
        `without any new high/critical findings.`
    }
    return { verdict: 'suspicious', newFindings, riskDelta, reason }
  }

  // ---- benign: unchanged, reduced, or harmless churn ---------------------
  let reason: string
  if (newFindings.length === 0) {
    reason =
      riskDelta < 0
        ? `No new findings; risk score fell (${scoreClause}) - a safer revision or benign churn.`
        : `No new findings and no risk increase (${scoreClause}) - content unchanged or benign churn.`
  } else {
    reason =
      `No new high/critical findings and no threshold crossing (${scoreClause}); ` +
      `${newFindings.length} minor new finding(s) below the suspicious bar.`
  }
  return { verdict: 'benign', newFindings, riskDelta, reason }
}
