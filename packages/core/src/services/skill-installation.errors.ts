/**
 * @fileoverview Failure-result builders for SkillInstallationService.
 * @module @skillsmith/core/services/skill-installation.errors
 * @see SMI-4795: install telemetry — populate `errorCode` at every failure
 *
 * Centralizes the `success: false` `InstallResult` shape so the main service
 * file stays under the 500-line gate (audit:standards Check 1) while every
 * failure path threads its taxonomy code into install telemetry.
 *
 * Importers should never destructure these results — always return the
 * builder's output verbatim so the caller's emitInstallEvent() observes the
 * canonical `errorCode` + `trustTier` pair.
 */

import type { ScanReport } from '../security/index.js'
import type { TrustTier } from '../types/skill.js'
import type { InstallErrorCode, InstallResult } from './skill-installation.types.js'

/** Common arguments for every failure-result builder */
export interface InstallFailureArgs {
  /** Original skillId from the caller (echoed back into the result) */
  skillId: string
  /** Path the install would have written to; '' when unresolvable */
  installPath: string
  /** Trust tier resolved at the failure point (defaults to 'unknown') */
  trustTier?: TrustTier
  /** Sanitized human-readable error message */
  error: string
  /** Optional remediation tips surfaced to UI */
  tips?: string[]
  /** Optional scan report when failure originated from the security scanner */
  securityReport?: ScanReport
}

/**
 * Build a `success: false` InstallResult with the given `errorCode`.
 *
 * Why a builder instead of inline literals: every failure path must populate
 * `errorCode` for SMI-4795 telemetry; pulling the construction out of the
 * service prevents drift where a future failure return forgets the code.
 */
export function buildInstallFailure(
  errorCode: InstallErrorCode,
  args: InstallFailureArgs
): InstallResult {
  const result: InstallResult = {
    success: false,
    skillId: args.skillId,
    installPath: args.installPath,
    errorCode,
    error: args.error,
  }
  if (args.trustTier !== undefined) {
    result.trustTier = args.trustTier
  }
  if (args.tips !== undefined) {
    result.tips = args.tips
  }
  if (args.securityReport !== undefined) {
    result.securityReport = args.securityReport
  }
  return result
}

/**
 * Build a CONFIRMATION_REQUIRED failure — distinct from buildInstallFailure
 * because it carries `requiresConfirmation: true` + `confirmationReason`
 * fields the UI uses to render the prompt.
 */
export function buildConfirmationRequired(args: {
  skillId: string
  installPath: string
  trustTier: TrustTier
  securityReport?: ScanReport
  confirmationReason: string
  tips?: string[]
}): InstallResult {
  const result: InstallResult = {
    success: false,
    skillId: args.skillId,
    installPath: args.installPath,
    errorCode: 'CONFIRMATION_REQUIRED',
    trustTier: args.trustTier,
    requiresConfirmation: true,
    confirmationReason: args.confirmationReason,
  }
  if (args.tips !== undefined) {
    result.tips = args.tips
  }
  if (args.securityReport !== undefined) {
    result.securityReport = args.securityReport
  }
  return result
}
