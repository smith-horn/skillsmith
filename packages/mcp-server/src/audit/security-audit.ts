/**
 * @fileoverview Local security audit (SMI-5541 Wave 2C, Option 1).
 * @module @skillsmith/mcp-server/audit/security-audit
 *
 * The PRODUCER that feeds the shipped 2A rug-pull comparator
 * (`compareScanReports`, SMI-5535). For each installed skill it reads the
 * on-disk SKILL.md/command/agent content, scans it with `@skillsmith/core`'s
 * `SecurityScanner`, and — against a per-skill baseline persisted across runs
 * (`security-baseline.ts`) — classifies the skill's current security posture:
 *
 *   - `hostile`    — a benign→malicious rug-pull between the last baseline and
 *     now (the differentiated 2A signal: `compareScanReports` verdict).
 *   - `malicious`  — the skill FAILS the scanner right now (whether first-sight
 *     or persistently). Surfaced every run so the in-tool audit always shows
 *     the current posture, not just deltas.
 *   - `suspicious` — a material worsening that did not fail the scanner.
 *
 * One finding per skill, strongest label wins (hostile > malicious >
 * suspicious). The baseline is rebuilt each run from the currently-present
 * skills only (uninstalled skills are pruned → the store stays bounded), and
 * always advances to the current scan so the NEXT run compares against the
 * most-recent known state (a fix-then-rebreak still re-detects as hostile).
 *
 * Design note — content lives ONLY on the client (ADR-124 keeps the inventory
 * data plane metadata-only, so no server-side scan is possible). This is why
 * the continuous audit runs here, in the CLI/MCP, where the content is.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'

import { SecurityScanner, compareScanReports, DEFAULT_RISK_THRESHOLD } from '@skillsmith/core'
import type { ScanReport } from '@skillsmith/core'

import { scanLocalInventory } from '../utils/local-inventory.js'
import type { InventoryEntry } from '../utils/local-inventory.types.js'
import { newAuditId } from './audit-history.js'
import {
  defaultBaselinePath,
  emptyBaseline,
  loadSecurityBaseline,
  reviveReport,
  saveSecurityBaseline,
  serializeReport,
  type SecurityBaseline,
} from './security-baseline.js'
import type {
  RunSecurityAuditOptions,
  RunSecurityAuditResult,
  SecurityAuditFinding,
  SecurityAuditSummary,
  SecurityVerdict,
} from './security-audit.types.js'

/**
 * Only installed skills / commands / agents carry scannable content. The
 * user's own `CLAUDE.md` (`claude_md_rule`) is their config, not an installed
 * artifact — excluded so the audit never flags a user's own instructions.
 */
const SCANNABLE_KINDS: ReadonlySet<InventoryEntry['kind']> = new Set(['skill', 'command', 'agent'])

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

/** Bounded, never-throwing default content reader. Returns null on any failure. */
function defaultReadContent(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf-8')
  } catch {
    return null
  }
}

function severityFor(verdict: SecurityVerdict): 'critical' | 'medium' {
  return verdict === 'suspicious' ? 'medium' : 'critical'
}

/** Count of high/critical findings — the actionable subset for the reason line. */
function seriousCount(report: ScanReport): number {
  return report.findings.filter((f) => f.severity === 'high' || f.severity === 'critical').length
}

function buildFinding(params: {
  auditId: string
  entry: InventoryEntry
  verdict: SecurityVerdict
  riskScore: number
  riskDelta: number | null
  newFindingCount: number
  reason: string
}): SecurityAuditFinding {
  const { auditId, entry, verdict, riskScore, riskDelta, newFindingCount, reason } = params
  return {
    kind: 'security',
    securityId: sha256(`${auditId}:${entry.source_path}:${verdict}`).slice(0, 16),
    entry,
    verdict,
    severity: severityFor(verdict),
    riskScore,
    riskDelta,
    newFindingCount,
    reason,
  }
}

/**
 * INTERNAL test seams — deliberately NOT exported (and NOT part of the public
 * `RunSecurityAuditOptions`), so the published entry point cannot accept a stub
 * scanner / reader that would silently neuter the audit while still reporting a
 * plausible count. The co-located test passes these via the same options bag
 * (the parameter type below is the intersection).
 */
interface SecurityAuditSeams {
  /** Override the baseline store path. */
  baselinePath?: string
  /** Override the content reader; returns null on failure, never throws. */
  readContent?: (absPath: string) => string | null
  /** Override the run's audit id (default: a fresh ULID). */
  auditId?: string
  /** Override the scanner with a deterministic stub. */
  scan?: (skillId: string, content: string) => ScanReport
}

/**
 * Run the local security audit over the current inventory. Stateless w.r.t.
 * its own result, but it reads AND advances the per-skill baseline so
 * rug-pulls are detected on the transition run.
 */
export async function runSecurityAudit(
  opts: RunSecurityAuditOptions & SecurityAuditSeams = {}
): Promise<RunSecurityAuditResult> {
  const startedAt = process.hrtime.bigint()

  const homeDir = opts.homeDir ?? os.homedir()
  const auditId = opts.auditId ?? newAuditId()
  const threshold = opts.riskThreshold ?? DEFAULT_RISK_THRESHOLD
  const readContent = opts.readContent ?? defaultReadContent
  const baselinePath = opts.baselinePath ?? defaultBaselinePath(homeDir)

  const inventory = opts.inventory ?? (await scanLocalInventory({ homeDir })).entries

  const prior = loadSecurityBaseline(baselinePath)
  // Rebuilt from currently-present skills only → prunes GENUINELY-uninstalled
  // skills. A skill we simply couldn't audit this run is carried forward (see
  // `preserve`), NOT pruned.
  const next: SecurityBaseline = emptyBaseline()
  // One scanner instance for the whole run (its config must match `threshold`).
  const scanner = new SecurityScanner({ riskThreshold: threshold })
  const scan = opts.scan ?? ((skillId: string, content: string) => scanner.scan(skillId, content))
  const nowIso = (): string => new Date().toISOString()

  const findings: SecurityAuditFinding[] = []
  let scanned = 0
  let unchanged = 0
  let unreadable = 0

  // Couldn't audit this skill this run (unreadable content or a scanner throw):
  // carry its prior baseline forward so a transient hiccup never masquerades as
  // an uninstall — which would prune the baseline and downgrade a later
  // rug-pull to a first-sight `malicious`. Count it separately so coverage is
  // honestly reported, never folded into "unchanged".
  const preserve = (entry: InventoryEntry): void => {
    const priorEntry = prior.skills[entry.source_path]
    if (priorEntry) next.skills[entry.source_path] = priorEntry
    unreadable += 1
  }

  for (const entry of inventory) {
    if (!SCANNABLE_KINDS.has(entry.kind)) continue

    const content = readContent(entry.source_path)
    if (content === null) {
      preserve(entry)
      continue
    }

    const contentHash = sha256(content)
    const priorEntry = prior.skills[entry.source_path]
    // "Unchanged" requires identical bytes AND the same threshold the stored
    // verdict was computed under — a threshold change re-scans rather than
    // trusting a verdict from a different bar (compareScanReports contract).
    const sameThreshold = priorEntry !== undefined && priorEntry.threshold === threshold
    const isUnchanged = sameThreshold && priorEntry.contentHash === contentHash

    // Current report: reuse the stored one byte-for-byte when unchanged (no
    // re-scan) but STILL evaluate posture (a persistently-failing skill keeps
    // surfacing); else scan — isolating a scanner throw to THIS skill so one
    // bad skill never aborts the whole batch.
    let current: ScanReport
    if (isUnchanged) {
      current = reviveReport(priorEntry.report)
      unchanged += 1
    } else {
      try {
        current = scan(entry.identifier, content)
      } catch {
        preserve(entry)
        continue
      }
      scanned += 1
    }

    // Rug-pull detection needs a prior produced under the SAME threshold AND an
    // actual content change (an unchanged skill can't have transitioned).
    let transition: SecurityVerdict | null = null
    let riskDelta: number | null = null
    let newFindingCount = 0
    let transitionReason = ''
    if (priorEntry && !isUnchanged && sameThreshold) {
      const verdict = compareScanReports(reviveReport(priorEntry.report), current, threshold)
      riskDelta = verdict.riskDelta
      newFindingCount = verdict.newFindings.length
      transitionReason = verdict.reason
      if (verdict.verdict === 'hostile' || verdict.verdict === 'suspicious') {
        transition = verdict.verdict
      }
    }

    // One finding per skill; strongest label wins: hostile > malicious > suspicious.
    if (transition === 'hostile') {
      findings.push(
        buildFinding({
          auditId,
          entry,
          verdict: 'hostile',
          riskScore: current.riskScore,
          riskDelta,
          newFindingCount,
          reason: transitionReason,
        })
      )
    } else if (!current.passed) {
      const serious = seriousCount(current)
      const reason = priorEntry
        ? `Installed skill still fails the security scan (risk ${current.riskScore}, ${serious} high/critical finding(s)).`
        : `Installed skill fails the security scan (risk ${current.riskScore}, ${serious} high/critical finding(s)); no prior baseline — establishing one now.`
      findings.push(
        buildFinding({
          auditId,
          entry,
          verdict: 'malicious',
          riskScore: current.riskScore,
          riskDelta: null,
          newFindingCount: 0,
          reason,
        })
      )
    } else if (transition === 'suspicious') {
      findings.push(
        buildFinding({
          auditId,
          entry,
          verdict: 'suspicious',
          riskScore: current.riskScore,
          riskDelta,
          newFindingCount,
          reason: transitionReason,
        })
      )
    }

    // Advance the baseline: on the unchanged fast path carry the prior entry
    // forward but refresh `updatedAt` (it WAS re-verified this run); else store
    // the fresh scan stamped with the threshold it was produced under.
    next.skills[entry.source_path] = isUnchanged
      ? { ...priorEntry, updatedAt: nowIso() }
      : {
          contentHash,
          threshold,
          report: serializeReport(current),
          updatedAt: current.scannedAt.toISOString(),
        }
  }

  // Best-effort persist: a lost baseline simply re-establishes next run.
  try {
    saveSecurityBaseline(baselinePath, next)
  } catch {
    /* swallow — see security-baseline.ts fail-safe contract */
  }

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
  const summary: SecurityAuditSummary = {
    scanned,
    unchanged,
    unreadable,
    hostile: findings.filter((f) => f.verdict === 'hostile').length,
    suspicious: findings.filter((f) => f.verdict === 'suspicious').length,
    malicious: findings.filter((f) => f.verdict === 'malicious').length,
    durationMs,
  }

  return { auditId, findings, summary }
}
