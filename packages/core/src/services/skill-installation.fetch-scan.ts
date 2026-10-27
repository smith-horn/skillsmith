/**
 * SMI-6531 (A1 step 7b): `install()`'s fetch-and-scan pipeline, moved out of
 * `skill-installation.service.ts` unchanged so the in-place update planner
 * (`skill-update.plan.ts`) runs the same tier and skip-scan gate (A1 plan
 * §3.7 item 2; one scan gate, owner decision). `install()` calls the three
 * stages in the order it always ran them, with its optimizer step between the
 * second and the third; the planner calls them with no optimizer at all.
 *
 * Each stage returns `{ ok: true, value }` or `{ ok: false, result }`, where
 * `result` is exactly the `InstallResult` failure `install()` used to return
 * at that point. A throw (an invalid skill ID, a `LockOrderError`) propagates
 * as it did before.
 *
 * @module @skillsmith/core/services/skill-installation.fetch-scan
 */
import * as path from 'path'
import { SecurityScanner } from '../security/index.js'
import { LockOrderError, assertSkillWriteLockNotHeld } from '../config/lock-tracker.js'
import type { TrustTier } from '../types/skill.js'
import {
  TRUSTED_INSTALL_TIERS,
  scannerOptionsForTier,
  type AiDefenceFeedback,
  type InstallResult,
  type ProgressCallback,
  type RegistryLookup,
} from './skill-installation.types.js'
import { recordAiDefenceFeedback } from './skill-installation.feedback.js'
import { hashContent } from './skill-installation.helpers.js'
import {
  parseSkillIdInternal,
  validateSkillMd,
  resolveRegistryInstall,
} from './skill-installation.validate.js'
import {
  fetchFromGitHub,
  fetchAndScanOptionalFiles,
  type OptionalInstallFilesResult,
} from './skill-installation.io.js'
import { buildInstallFailure, buildConfirmationRequired } from './skill-installation.errors.js'

/** A stage's outcome: its value, or the `InstallResult` failure `install()` returns. */
export type FetchScanStage<T> = { ok: true; value: T } | { ok: false; result: InstallResult }

/** Where a skill's files come from, as `install()` resolves it from the skill ID. */
export interface InstallSource {
  owner: string
  repo: string
  /** `''` or a path ending in `/`. */
  basePath: string
  branch: string
  /** The upstream name: `install()` names its folder after it; an in-place update never does. */
  skillName: string
  trustTier: TrustTier
  indexedContentHash?: string | undefined
  fromRegistry: boolean
}

/** Parses the skill ID and, for a registry ID, looks it up. */
export async function resolveInstallSource(
  skillId: string,
  registryLookup: RegistryLookup | undefined,
  onProgress: ProgressCallback
): Promise<FetchScanStage<InstallSource>> {
  onProgress('parse', 'Parsing skill ID')
  const parsed = parseSkillIdInternal(skillId)
  if (!parsed.isRegistryId) {
    return {
      ok: true,
      value: {
        owner: parsed.owner,
        repo: parsed.repo,
        basePath: parsed.path ? parsed.path + '/' : '',
        branch: 'main',
        skillName: parsed.path ? path.basename(parsed.path) : parsed.repo,
        trustTier: 'unknown',
        fromRegistry: false,
      },
    }
  }
  if (!registryLookup) {
    return {
      ok: false,
      result: buildInstallFailure('REGISTRY_LOOKUP_UNAVAILABLE', {
        skillId,
        installPath: '',
        error:
          'Registry lookup not available. ' +
          'Use a full GitHub URL: install { skillId: "https://github.com/owner/repo" }',
      }),
    }
  }
  onProgress('lookup', 'Looking up skill in registry')
  const resolution = await resolveRegistryInstall(skillId, registryLookup)
  if (!resolution.resolved) return { ok: false, result: resolution.failure }
  return {
    ok: true,
    value: {
      owner: resolution.owner,
      repo: resolution.repo,
      basePath: resolution.basePath,
      branch: resolution.branch,
      skillName: resolution.skillName,
      trustTier: resolution.trustTier,
      indexedContentHash: resolution.indexedContentHash,
      fromRegistry: true,
    },
  }
}

export interface SkillMdGateContext {
  skillId: string
  /** Only named in failure results. */
  installPath: string
  skipScan?: boolean
  confirmed?: boolean
  onProgress: ProgressCallback
  aiDefenceFeedback?: AiDefenceFeedback
}

export interface FetchedSkillMd {
  skillMdContent: string
  contentHashMismatch: boolean
  securityReport: InstallResult['securityReport']
}

/** Fetches and validates SKILL.md, then the skip-scan gate, the scan and the confirmation gate. */
export async function fetchAndScanSkillMd(
  source: InstallSource,
  ctx: SkillMdGateContext
): Promise<FetchScanStage<FetchedSkillMd>> {
  const { owner, repo, basePath, branch, fromRegistry, trustTier, indexedContentHash } = source
  const { skillId, installPath, onProgress } = ctx
  const fail = (result: InstallResult): FetchScanStage<FetchedSkillMd> => ({ ok: false, result })
  onProgress('fetch', 'Fetching SKILL.md from GitHub')
  const skillMdPath = basePath + 'SKILL.md'
  let skillMdContent: string
  try {
    skillMdContent = await fetchFromGitHub(owner, repo, skillMdPath, branch)
  } catch (fetchError) {
    // A lock-order refusal is a programming error, not a missing SKILL.md.
    if (fetchError instanceof LockOrderError) throw fetchError
    const repoUrl = 'https://github.com/' + owner + '/' + repo
    return fail(
      buildInstallFailure('FETCH_FAILED', {
        skillId,
        installPath,
        trustTier,
        error: fromRegistry
          ? 'This skill is indexed in the Skillsmith registry but its installation source appears broken (SKILL.md not found at ' +
            (basePath || 'repository root') +
            '). This is a registry data quality issue. Please report it at https://skillsmith.app/contact?topic=registry-quality. Repository: ' +
            repoUrl
          : 'Could not find SKILL.md at ' +
            (basePath || 'repository root') +
            '. Skills must have a SKILL.md file with YAML frontmatter to be installable. Repository: ' +
            repoUrl,
        tips: fromRegistry
          ? [
              'This is a registry data quality issue, not a path format error',
              'Report the broken entry: https://skillsmith.app/contact?topic=registry-quality',
            ]
          : [
              'This skill may be browse-only (no SKILL.md at expected location)',
              'Verify the repository exists: ' + repoUrl,
            ],
      })
    )
  }
  onProgress('validate', 'Validating SKILL.md')
  const validation = validateSkillMd(skillMdContent)
  if (!validation.valid) {
    return fail(
      buildInstallFailure('VALIDATION_FAILED', {
        skillId,
        installPath,
        trustTier,
        error: 'Invalid SKILL.md: ' + validation.errors.join(', '),
        tips: [
          'SKILL.md must have YAML frontmatter with name and description fields',
          'Content must be at least 100 characters',
        ],
      })
    )
  }

  const contentHashMismatch = // SMI-3510
    indexedContentHash != null ? hashContent(skillMdContent) !== indexedContentHash : false
  // SMI-7056: the tier as shown in messages; an empty tier reads "unknown".
  const tierName = trustTier || 'unknown'
  // Security scan — GAP-06: Restrict skipScan to trusted tiers only (SMI-7056: fail-closed allowlist)
  if (ctx.skipScan && !TRUSTED_INSTALL_TIERS.has(trustTier)) {
    return fail(
      buildInstallFailure('SKIP_SCAN_FORBIDDEN', {
        skillId,
        installPath: '',
        trustTier,
        error:
          'Cannot skip security scan for ' +
          tierName +
          ' tier skills. ' +
          'Only official, verified, curated, community, and local tier skills may use skipScan.',
        tips: [
          'Trust tier "' + tierName + '" requires a security scan before installation',
          'If you believe this skill is safe, request a trust tier upgrade from the author',
        ],
      })
    )
  }
  let securityReport: InstallResult['securityReport']
  if (!ctx.skipScan) {
    onProgress('scan', 'Running security scan')
    const scannerOptions = scannerOptionsForTier(trustTier)
    const scanner = new SecurityScanner(scannerOptions)
    assertSkillWriteLockNotHeld('scan: install SKILL.md')
    securityReport = scanner.scan(skillId, skillMdContent)

    if (!securityReport.passed) {
      recordAiDefenceFeedback({
        feedback: ctx.aiDefenceFeedback,
        skillMdContent,
        scanReport: securityReport,
        blocked: true,
      })
      const criticalFindings = securityReport.findings.filter(
        (f) => f.severity === 'critical' || f.severity === 'high'
      )
      // SMI-7056: "Direct GitHub install" only when it was one; a registry skill
      // stored as `unknown` is an unreviewed tier like any other.
      const tierContext =
        !fromRegistry && trustTier === 'unknown'
          ? ' (Direct GitHub install - strictest scanning applied)'
          : trustTier === 'experimental'
            ? ' (Experimental skill - aggressive scanning applied)'
            : !TRUSTED_INSTALL_TIERS.has(trustTier)
              ? ' (Unreviewed trust tier - strictest scanning applied)'
              : ''

      return fail(
        buildInstallFailure('SCAN_REJECTED', {
          skillId,
          installPath,
          trustTier,
          securityReport,
          error:
            'Security scan failed with ' +
            criticalFindings.length +
            ' critical/high findings' +
            tierContext +
            (!TRUSTED_INSTALL_TIERS.has(trustTier)
              ? '. skipScan is not available for ' + tierName + ' tier skills.'
              : '. Use skipScan=true to override (not recommended).'),
          tips: [
            'Trust tier: ' + tierName + ' (threshold: ' + scannerOptions.riskThreshold + ')',
            'Risk score: ' + securityReport.riskScore,
          ],
        })
      )
    }
  }

  // SMI-3863: Pre-install confirmation gate for registry skills outside the trusted tiers (SMI-7056: fail-closed)
  const needsConfirmation = fromRegistry && !TRUSTED_INSTALL_TIERS.has(trustTier) && !ctx.confirmed
  if (needsConfirmation) {
    const scanNote = securityReport
      ? securityReport.passed
        ? 'Skills in this tier have not been reviewed.'
        : 'Security scan detected issues.'
      : 'No security scan was performed.'
    return fail(
      buildConfirmationRequired({
        skillId,
        installPath,
        trustTier,
        securityReport,
        confirmationReason:
          'This skill is in the "' +
          tierName +
          '" trust tier. ' +
          scanNote +
          ' Re-run with confirmed=true to proceed.',
        tips: ['Trust tier: ' + tierName, 'Use confirmed=true to proceed with installation'],
      })
    )
  }
  return { ok: true, value: { skillMdContent, contentHashMismatch, securityReport } }
}

/**
 * SMI-5359 Gap-1: fetches and scans the optional files before anything is
 * written, so a malicious optional file refuses with no file stranded on disk.
 */
export async function fetchAndScanOptional(
  source: InstallSource,
  skillId: string,
  installPath: string,
  skipScan: boolean | undefined
): Promise<FetchScanStage<OptionalInstallFilesResult>> {
  const { owner, repo, basePath, branch, trustTier } = source
  const optionalFiles = await fetchAndScanOptionalFiles(
    owner,
    repo,
    basePath,
    branch,
    skillId,
    skipScan ? null : scannerOptionsForTier(trustTier)
  )
  if (optionalFiles.failedScans.length === 0) return { ok: true, value: optionalFiles }
  const first = optionalFiles.failedScans[0]
  const crit = first.report.findings.filter(
    (f) => f.severity === 'critical' || f.severity === 'high'
  )
  const others = optionalFiles.failedScans.slice(1).map((s) => s.file)
  // SMI-5422: surface the matched finding type so the author knows what to fix.
  const topFinding = crit[0] ?? first.report.findings[0]
  const matchedLabel = topFinding ? (topFinding.category ?? topFinding.type) : 'unknown'
  return {
    ok: false,
    result: buildInstallFailure('SCAN_REJECTED', {
      skillId,
      installPath,
      trustTier,
      securityReport: first.report,
      error:
        'Optional file "' +
        first.file +
        '" failed the security scan with ' +
        crit.length +
        ' critical/high finding(s) (risk score ' +
        first.report.riskScore +
        ', matched: ' +
        matchedLabel +
        '). See https://skillsmith.app/docs/security/scanner',
      tips: [
        'Rejected file: ' + first.file + ' (matched: ' + matchedLabel + ')',
        'Risk score: ' + first.report.riskScore,
        'Security scanner docs: https://skillsmith.app/docs/security/scanner',
        ...(others.length > 0 ? ['Other rejected files: ' + others.join(', ')] : []),
      ],
    }),
  }
}
