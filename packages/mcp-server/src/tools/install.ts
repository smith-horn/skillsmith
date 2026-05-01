/**
 * @fileoverview MCP Install Skill Tool for downloading and installing skills
 * @module @skillsmith/mcp-server/tools/install
 * @see SMI-2741: Split to meet 500-line standard
 * @see SMI-3137: Wave 4 — Dependency intelligence persistence
 * @see SMI-3483: Wave 0 — Delegate to SkillInstallationService from core
 *
 * Skills are installed to ~/.claude/skills/ and tracked in ~/.skillsmith/manifest.json
 *
 * The core install logic lives in @skillsmith/core SkillInstallationService.
 * This file is the MCP tool wrapper that:
 * - Bridges ToolContext to the service's constructor params
 * - Adds conflict resolution (three-way merge, backup) on top
 * - Wires onProgress to MCP protocol notifications
 */

import {
  SkillInstallationService,
  emitInstallEvent,
  type RegistryLookup,
  type RegistrySkillInfo,
} from '@skillsmith/core'
import { addLink, getInstallPath, resolveClientPath } from '@skillsmith/core/install'
import { resolveAuditMode, isAuditMode, type Tier } from '@skillsmith/core/config/audit-mode'
import type { ToolContext } from '../context.js'
import { getToolContext } from '../context.js'
import { CLAUDE_SKILLS_DIR, installInputSchema, type InstallResult } from './install.types.js'
import { loadManifest, lookupSkillFromRegistry } from './install.helpers.js'

// SMI-1867: Conflict resolution logic (extracted per governance review)
import { checkForConflicts } from './install.conflict.js'

// SMI-4588 Wave 2 PR #3: namespace pre-flight + ledger replay + mode gate.
import { runNamespaceGate } from './install.namespace-gate.js'
import type { CandidateSkill } from '../audit/install-preflight.js'
import * as path from 'path'

// SMI-2741: MCP tool definition extracted to companion file
export { installTool } from './install.tool.js'
export { default } from './install.tool.js'

// Re-export only public API types (SMI-1718: trimmed internal exports)
export { installInputSchema, type InstallInput, type InstallResult } from './install.types.js'

/**
 * Adapter that wraps ToolContext's registry lookup as a RegistryLookup.
 * Bridges the MCP-specific ToolContext to the core service abstraction.
 */
class McpRegistryLookup implements RegistryLookup {
  constructor(private context: ToolContext) {}

  async lookup(skillId: string): Promise<RegistrySkillInfo | null> {
    return lookupSkillFromRegistry(skillId, this.context)
  }
}

/**
 * Build an application-level validation failure result.
 *
 * SMI-4288 / GitHub #599: When an MCP caller passes a malformed argument
 * payload (e.g. `{}`, wrong `skillId` type, invalid `conflictAction` enum),
 * return a structured `InstallResult` with `success: false` rather than
 * throwing. Matches the existing `team-workspace.ts` error-envelope
 * convention (application-level failure, not MCP protocol-level `isError`).
 *
 * @see #599
 */
function buildValidationError(message: string): InstallResult {
  return {
    success: false,
    skillId: '',
    installPath: '',
    error: `Invalid install input: ${message}`,
  }
}

/**
 * Install a skill from GitHub to the local agent skills directory (~/.claude/skills/).
 *
 * Delegates core logic to SkillInstallationService from @skillsmith/core.
 * Adds MCP-specific conflict resolution (three-way merge, backup).
 *
 * SMI-4288 / GitHub #599: Signature accepts `unknown` so the Zod `safeParse`
 * guard actually runs at the MCP tool boundary. The prior `InstallInput`
 * parameter type made the guard unreachable — callers passed a pre-typed
 * object, leaving the underlying `request.params.arguments` crash surface
 * unprotected when the dispatcher forwards raw args.
 *
 * @param input - Raw MCP tool arguments (unvalidated); parsed via Zod here
 * @param _context - Optional tool context (falls back to singleton)
 * @returns Installation result with success status, security report, and dep intel
 */
export async function installSkill(input: unknown, _context?: ToolContext): Promise<InstallResult> {
  // SMI-4288 / #599: Zod validation boundary. Unlike the previous typed
  // signature, this runs at every call site (tool-dispatch, runFirstTimeSetup,
  // integration tests). Validation failures return a structured InstallResult
  // instead of throwing, preserving the MCP application-level error envelope.
  const parsed = installInputSchema.safeParse(input)
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => {
        // Renamed from `path` to `issuePath` to avoid shadowing the
        // module-level `path` import (no-shadow hygiene).
        const issuePath = issue.path.length > 0 ? issue.path.join('.') : '<root>'
        return `${issuePath}: ${issue.message}`
      })
      .join('; ')
    return buildValidationError(message)
  }
  const validInput = parsed.data

  // SMI-4588 Wave 2 PR #3: namespace pre-flight + mode gate. Runs BEFORE
  // service construction so a `preventative`-mode collision short-circuits
  // the install with no side effects. Pre-flight failure is non-blocking
  // (Edit 2) — `runNamespaceGate` swallows internal throws and returns
  // `decision: 'proceed'`.
  const candidate = buildPreflightCandidate(validInput.skillId)
  const tier = resolveCallerTier()
  const auditMode = resolveAuditMode({
    tier,
    override: readAuditModeOverride(),
  })
  const gate = await runNamespaceGate({ candidate, mode: auditMode, tier })
  if (gate.decision === 'block') {
    // Decision #2: preventative mode blocks; agent must call
    // `apply_namespace_rename` then re-invoke install. The skill is NOT
    // touched on disk.
    return {
      success: false,
      skillId: validInput.skillId,
      installPath: '',
      error: 'Namespace collision detected; install blocked in preventative audit mode.',
      ...gate.resultPatch,
    }
  }

  const context = _context ?? getToolContext()

  // SMI-4578: resolve target install directory. Explicit `client` arg
  // wins; otherwise fall back to SKILLSMITH_CLIENT env (or claude-code).
  const effectiveSkillsDir = validInput.client
    ? getInstallPath(validInput.client)
    : resolveClientPath()

  // SMI-3483: Create core service instance with MCP context wiring
  // SMI-3873: aiDefenceFeedback omitted -- MCP server cannot call Ruflo tools.
  const service = new SkillInstallationService({
    db: context.db,
    skillRepo: context.skillRepository,
    skillDependencyRepo: context.skillDependencyRepository,
    registryLookup: new McpRegistryLookup(context),
    coInstallRecorder: context.coInstallRepository,
    sessionInstalledSkillIds: context.sessionInstalledSkillIds,
    skillsDir: effectiveSkillsDir,
  })

  // SMI-1867: Pre-flight conflict check for reinstall with force
  // This is MCP-specific (three-way merge UI, backup, storeOriginal)
  if (validInput.force && validInput.conflictAction) {
    try {
      const manifest = await loadManifest()
      const skillName = extractSkillName(validInput.skillId)

      if (manifest.installedSkills[skillName]) {
        const installPath = manifest.installedSkills[skillName].installPath

        const conflictCheck = await checkForConflicts(
          skillName,
          installPath,
          manifest,
          validInput.conflictAction,
          validInput.skillId
        )

        if (!conflictCheck.shouldProceed) {
          return conflictCheck.earlyReturn!
        }
      }
    } catch {
      // Conflict check failed; proceed with normal install
    }
  }

  // Delegate to core service
  const installStart = Date.now()
  const result = await service.install(validInput.skillId, {
    force: validInput.force,
    skipScan: validInput.skipScan,
    skipOptimize: validInput.skipOptimize,
    conflictAction: validInput.conflictAction,
    confirmed: validInput.confirmed,
  })

  // SMI-4182: fire-and-forget install telemetry for usage report funnel
  void emitInstallEvent({
    skillId: validInput.skillId,
    source: 'mcp',
    success: result.success,
    durationMs: Date.now() - installStart,
  })

  // SMI-4578: fan-out to additional clients after primary install. Failures
  // are logged but do NOT mark the overall install as failed — canonical
  // install at `client` is already complete.
  if (result.success && validInput.alsoLink.length > 0) {
    const fromClient = validInput.client ?? 'claude-code'
    const skillName = extractSkillName(validInput.skillId)
    for (const target of validInput.alsoLink) {
      if (target === fromClient) continue
      try {
        await addLink({
          skillId: skillName,
          fromClient,
          toClient: target,
          preferSymlink: validInput.symlink,
          force: validInput.force,
        })
      } catch (linkErr) {
        // Best-effort fan-out — log but don't fail the install
        console.error(
          `[install] alsoLink to ${target} failed:`,
          linkErr instanceof Error ? linkErr.message : String(linkErr)
        )
      }
    }
  }

  // SMI-4588 Wave 2 PR #3: surface non-blocking namespace warnings (and
  // installComplete=true marker) on `power_user` / `governance` paths.
  // `pendingCollision` is intentionally not merged here — it is exclusive
  // to the blocking-mode early return above.
  if (gate.resultPatch.warnings && gate.resultPatch.warnings.length > 0) {
    return {
      ...result,
      installComplete: gate.resultPatch.installComplete,
      warnings: gate.resultPatch.warnings,
    }
  }

  return result
}

/**
 * Build the `CandidateSkill` shape consumed by `runNamespaceGate`. The
 * pre-flight runs before any disk write, so the path is projected.
 *
 * `extractSkillName` mirrors the manifest-key derivation used elsewhere in
 * this file; the `skillId` is propagated when the input is a registry id
 * (`<author>/<name>`) so ledger lookups key on the canonical form.
 */
function buildPreflightCandidate(skillId: string): CandidateSkill {
  const skillName = extractSkillName(skillId)
  const isRegistryId = skillId.includes('/') && !skillId.startsWith('https://')
  const author = isRegistryId ? skillId.split('/')[0] : null
  return {
    identifier: skillName,
    projectedSourcePath: path.join(CLAUDE_SKILLS_DIR, skillName),
    skillId: isRegistryId ? skillId : null,
    author,
  }
}

/**
 * Resolve the caller's subscription tier for the audit-mode resolver.
 * Reads `SKILLSMITH_TIER` env var; falls through to `'community'` (the
 * resolver's fail-safe default) when unset or invalid. The MCP subprocess
 * has no JWT context, so env var is the only signal available without
 * cross-cutting changes (Wave 4 will revisit if richer tier resolution
 * becomes load-bearing).
 */
function resolveCallerTier(): Tier {
  const raw = process.env['SKILLSMITH_TIER']
  if (raw === 'community' || raw === 'individual' || raw === 'team' || raw === 'enterprise') {
    return raw
  }
  return 'community'
}

/**
 * Read the optional `SKILLSMITH_AUDIT_MODE` override. Invalid values fall
 * through to `null` so the resolver applies the tier default.
 */
function readAuditModeOverride() {
  const raw = process.env['SKILLSMITH_AUDIT_MODE']
  return isAuditMode(raw) ? raw : null
}

/**
 * Best-effort skill name extraction for conflict pre-check.
 * Does not need to be perfect -- just needs to match manifest keys.
 */
function extractSkillName(skillId: string): string {
  if (skillId.includes('/')) {
    const parts = skillId.split('/')
    return parts[parts.length - 1]
  }
  return skillId
}
