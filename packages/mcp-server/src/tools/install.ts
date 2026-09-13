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
  checkInstallTarget,
  manifestKeyFor,
  type RegistryLookup,
  type RegistrySkillInfo,
} from '@skillsmith/core'
import { withTelemetry } from '@skillsmith/core/telemetry'
import {
  addLink,
  parseInstallScope,
  resolveClientId,
  resolveScopedSkillsDir,
  UnsatisfiableWorkspaceScopeError,
  InvalidScopeValueError,
} from '@skillsmith/core/install'
import { resolveAuditMode } from '@skillsmith/core/config/audit-mode'
import type { ToolContext } from '../context.js'
import { getToolContext } from '../context.js'
import { MANIFEST_PATH, installInputSchema, type InstallResult } from './install.types.js'
import { loadManifest, lookupSkillFromRegistry } from './install.helpers.js'

// SMI-1867: Conflict resolution logic (extracted per governance review)
import { checkForConflicts } from './install.conflict.js'

// SMI-4588 Wave 2 PR #3: namespace pre-flight + ledger replay + mode gate.
// SMI-6529 round 4: buildPreflightCandidate/resolveCallerTier/
// readAuditModeOverride/extractSkillName moved here too (pure move) to stay
// under the 500-line CI gate — extractSkillName re-exported below so its
// external import path (used directly by SMI-4737's tests) is unaffected.
import {
  runNamespaceGate,
  attachGateProblems,
  buildPreflightCandidate,
  resolveCallerTier,
  readAuditModeOverride,
  extractSkillName,
} from './install.namespace-gate.js'
import type { CandidateSkill } from '../audit/install-preflight.js'
import * as path from 'path'

export { extractSkillName } from './install.namespace-gate.js'

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
 * SMI-4737: structured tool-error envelope for `extractSkillName` throws.
 * Adversarial `skillId` values that survive Zod's 512-char boundary but
 * produce an over-cap (>128 char) extracted segment are rejected here so
 * the throw never escapes the MCP handler. Mirrors the `buildValidationError`
 * shape (application-level failure, not MCP protocol-level `isError`).
 */
function buildInvalidSkillIdError(skillId: string, message: string): InstallResult {
  return {
    success: false,
    skillId,
    installPath: '',
    error: `invalid_skill_id: ${message}`,
  }
}

/**
 * ADR-139 (SMI-6274 Wave 4) / GPT-5.6-Sol PR review: structured tool-error
 * envelope for an unsatisfiable/invalid `scope` request — mirrors
 * {@link buildValidationError}'s precedent (a structured `success: false`
 * result, not an MCP protocol-level throw) so an unsatisfiable
 * `scope: 'workspace'` request still surfaces as the "HARD ERROR naming the
 * reason" ADR-139 point 2 requires, through the SAME structured channel
 * every other pre-flight failure in this tool already uses, rather than an
 * uncaught throw escaping into an MCP protocol-level error the caller can't
 * distinguish from a transport failure.
 */
function buildScopeError(skillId: string, error: Error): InstallResult {
  return {
    success: false,
    skillId,
    installPath: '',
    error: error.message,
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
async function installSkillImpl(input: unknown, _context?: ToolContext): Promise<InstallResult> {
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
  // SMI-4737: extractSkillName (called via buildPreflightCandidate) throws on
  // over-cap (>128 char) extracted segments; surface as structured envelope.
  let candidate: CandidateSkill
  try {
    candidate = buildPreflightCandidate(validInput.skillId)
  } catch (err) {
    return buildInvalidSkillIdError(
      validInput.skillId,
      err instanceof Error ? err.message : String(err)
    )
  }
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

  // SMI-4578: resolve target client + install directory together. Explicit
  // `client` arg wins; otherwise fall back to SKILLSMITH_CLIENT env (or
  // claude-code). SMI-5894 review: previously only the directory was
  // resolved here and `client` was never passed to SkillInstallationService,
  // so a non-canonical MCP install (e.g. Cursor) landed in the right
  // directory but was keyed in the manifest as if it were canonical --
  // colliding with a real canonical install of the same skill name and
  // invisible to `name::cursor`-scoped removal.
  const effectiveClient = resolveClientId(validInput.client)

  // ADR-139 (SMI-6274 Wave 4) / GPT-5.6-Sol PR review: resolve global-vs-
  // workspace scope via the SAME shared core resolver the CLI's install/
  // list/update/remove commands use — this was the actual finding: the MCP
  // server previously called `getInstallPath(effectiveClient)` directly,
  // the OLD global-only resolution, and could never reach workspace scope
  // at all (the ADR's own stated MCP requirement, point 7). `cwd` (when the
  // calling client passes it — see its own doc comment above) is used as
  // the ancestor-walk starting point instead of this long-running server's
  // own launch-time `process.cwd()`, exactly the same reason `cwd` exists
  // for the companion-agent path. `explicitScope` (the new `scope` param,
  // rank 1) and SKILLSMITH_SCOPE (rank 2, read automatically by
  // resolveScopedSkillsDir when explicitScope is undefined) both apply. An
  // unsatisfiable explicit `scope: 'workspace'` throws
  // UnsatisfiableWorkspaceScopeError — caught below and surfaced as a
  // structured hard error (ADR-139 point 2), never a silent downgrade.
  let scopeTarget: ReturnType<typeof resolveScopedSkillsDir>
  try {
    scopeTarget = resolveScopedSkillsDir({
      client: effectiveClient,
      explicitScope: parseInstallScope(validInput.scope),
      ...(validInput.cwd !== undefined && { cwd: validInput.cwd }),
      globalManifestPath: MANIFEST_PATH,
    })
  } catch (scopeError) {
    if (
      scopeError instanceof UnsatisfiableWorkspaceScopeError ||
      scopeError instanceof InvalidScopeValueError
    ) {
      return attachGateProblems(buildScopeError(validInput.skillId, scopeError), gate.problems)
    }
    throw scopeError
  }
  const effectiveSkillsDir = scopeTarget.dir

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
    // ADR-139: route the manifest write to the SAME manifest scopeTarget
    // resolved — the workspace-local one when scope === 'workspace', else
    // the global one (byte-identical to the previous default).
    manifestPath: scopeTarget.manifestPath,
    client: effectiveClient,
    // SMI-5982 code-review fix #1: only Antigravity's directory-package mode
    // actually consumes this today (its `dir` is the only relative one) —
    // harmless for every other client since their `dir` is absolute.
    companionBaseDir: validInput.cwd,
  })

  // SMI-1867: Pre-flight conflict check for reinstall with force
  // This is MCP-specific (three-way merge UI, backup, storeOriginal) —
  // `SkillInstallationService.install()` itself never reads `conflictAction`
  // at all (confirmed: it's declared on `InstallOptions` but nowhere
  // consumed in `packages/core/src/services/*.ts`), so this pre-flight is
  // its ENTIRE effect. An earlier version of this fix gated the whole block
  // to `scopeTarget.scope === 'global'`, reasoning that consulting the
  // GLOBAL manifest for a workspace-scoped reinstall would either miss
  // (silently dropping `conflictAction`, e.g. a `cancel` request would be
  // ignored and the install would proceed and overwrite anyway) or worse,
  // false-positive against an unrelated same-named global entry — both real
  // problems, but the fix is to read the RIGHT manifest, not to skip the
  // check. `loadManifest()` (install.helpers.js) now takes the manifest path
  // as an optional argument (default: global, unchanged for its other 3
  // callers — outdated.ts, skill-updates.ts, updateManifestSafely) — passing
  // `scopeTarget.manifestPath` here makes this pre-flight correct for BOTH
  // scopes instead of gated to one.
  // SMI-6585: collected here rather than swallowed, and surfaced via `tips`
  // below alongside the fan-out failures.
  const preflightProblems: string[] = []
  if (validInput.force && validInput.conflictAction) {
    try {
      const manifest = await loadManifest(scopeTarget.manifestPath)
      const skillName = extractSkillName(validInput.skillId)
      // SMI-6529 N5 (round 4): look up the SAME manifest key
      // `service.install()` itself will read/write (`manifestKeyFor(name,
      // client)`) — a bare-name lookup silently misses every non-canonical
      // client's entry (their key is always `name::client`), which used to
      // skip this WHOLE pre-flight block for them regardless of what's
      // actually on disk.
      const manifestKey = manifestKeyFor(skillName, effectiveClient)
      const existingEntry = manifest.installedSkills[manifestKey]

      if (existingEntry) {
        // SMI-6529 N5 (round 4): compute installPath the SAME way core's
        // install() does — `path.join(effectiveSkillsDir, skillName)` — NOT
        // the manifest's own recorded `installPath`. Those can legitimately
        // differ (the manifest entry can be scoped to a different
        // scope/client's directory entirely); passing the WRONG installPath
        // into `checkInstallTarget` together with THIS client's
        // `effectiveSkillsDir` broke its rule (d) ancestor walk — installPath
        // was never actually inside skillsDir, so the walk never met it and
        // silently climbed toward the filesystem root (probe-preflight.mjs).
        const installPath = path.join(effectiveSkillsDir, skillName)

        // SMI-6529 L20 (round 2): run the SAME pre-write target guard
        // `service.install()` runs internally, BEFORE this MCP-only
        // conflict pre-flight's backup + GC side effects
        // (`createSkillBackup`/`cleanupOldBackups`, inside `checkForConflicts`
        // below). A refusal here (an untracked directory, a git working
        // tree, etc.) must short-circuit BEFORE a backup file gets written
        // and old backups get swept for an install that was going to be
        // refused anyway — not discovered only after those side effects
        // already ran, inside `service.install()`'s own later call to this
        // same guard.
        const targetCheck = await checkInstallTarget({
          installPath,
          skillsDir: effectiveSkillsDir,
          manifestEntry: existingEntry,
          force: validInput.force,
        })
        if (!targetCheck.ok) {
          return attachGateProblems(
            {
              success: false,
              skillId: validInput.skillId,
              installPath,
              error: targetCheck.error,
              ...(targetCheck.tips !== undefined && { tips: targetCheck.tips }),
            },
            gate.problems
          )
        }

        const conflictCheck = await checkForConflicts(
          skillName,
          installPath,
          manifest,
          validInput.conflictAction,
          validInput.skillId
        )

        if (!conflictCheck.shouldProceed) {
          return attachGateProblems(conflictCheck.earlyReturn!, gate.problems)
        }
      }
    } catch (err) {
      // SMI-6585: this catch predates the guard it encloses — Wave A0 moved
      // `checkInstallTarget` inside it, turning a fail-closed guard fail-open.
      // The install's OUTCOME is deliberately unchanged (`service.install()`
      // runs the same target guard unconditionally before any fetch or write),
      // so swallowing the outcome is correct; swallowing the FACT is not. The
      // failure now rides `tips`, letting a caller tell "pre-flight passed"
      // from "pre-flight could not be evaluated".
      // SMI-6588 confirmation round: a Symbol `message` skipped the bound below
      // and threw at interpolation. Third of three instances — see describeCause.
      let cause: string
      try {
        const raw: unknown = err instanceof Error ? err.message : err
        cause = typeof raw === 'string' ? raw : String(raw)
      } catch {
        cause = 'the thrown value could not be described'
      }
      // Bound it: this string is returned to the caller, and an unbounded
      // message from an arbitrary throw site is not something to pass through.
      if (cause.length > 300) cause = cause.slice(0, 300) + '…'

      // SMI-6585 cross-model review: "was not applied" claimed more than the
      // code can know. `checkForConflicts` can throw AFTER writing a backup,
      // so the action may have been partially applied. Say what is true.
      preflightProblems.push(
        `the install pre-flight (conflict check and target guard) could not be evaluated ` +
          `(${cause}); the install proceeded and its target was still checked by the ` +
          `installer's own guard, but any requested conflictAction may not have been fully ` +
          `applied.`
      )
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

  // SMI-4182 / SMI-4795: fire-and-forget install telemetry for usage report
  // funnel. `trustTier` is included on every event (when known) and
  // `errorCode` is included only on failures so the wire payload stays
  // minimal for successful installs.
  void emitInstallEvent({
    skillId: validInput.skillId,
    source: 'mcp',
    success: result.success,
    durationMs: Date.now() - installStart,
    ...(result.trustTier !== undefined && { trustTier: result.trustTier }),
    ...(!result.success && result.errorCode !== undefined && { errorCode: result.errorCode }),
  })

  // SMI-4578: fan-out to additional clients after primary install. Failures
  // are logged but do NOT mark the overall install as failed — canonical
  // install at `client` is already complete.
  //
  // SMI-6529 N7 (round 4): a failure here used to ONLY go to stderr — a
  // caller reading the returned InstallResult had no way to know a
  // requested `alsoLink` target was silently refused (e.g. the fan-out
  // destination is a real, un-recorded directory). Collected into `tips` (a
  // plain string[] already on InstallResult) below, alongside the stderr
  // log which stays for `docker logs`/local debugging.
  const alsoLinkFailures: string[] = []
  if (result.success && validInput.alsoLink.length > 0) {
    const fromClient = validInput.client ?? 'claude-code'
    const skillName = extractSkillName(validInput.skillId)
    for (const target of validInput.alsoLink) {
      if (target === fromClient) continue
      try {
        const linked = await addLink({
          skillId: skillName,
          fromClient,
          toClient: target,
          preferSymlink: validInput.symlink,
          force: validInput.force,
        })
        // SMI-6529 round 7: hidden backups from an interrupted refresh.
        for (const warning of linked.warnings ?? []) {
          alsoLinkFailures.push(`alsoLink to ${target}: ${warning}`)
        }
      } catch (linkErr) {
        const message = linkErr instanceof Error ? linkErr.message : String(linkErr)
        // Best-effort fan-out — log but don't fail the install
        console.error(`[install] alsoLink to ${target} failed:`, message)
        alsoLinkFailures.push(`alsoLink to ${target} failed: ${message}`)
      }
    }
  }

  // SMI-6529 round 7 / SMI-6585 / SMI-6588: every non-fatal problem this
  // function knows about rides one surface — a fan-out refusal, a conflict
  // pre-flight that could not be evaluated, and a namespace pre-flight that
  // never ran. None of them changes whether the install itself succeeded.
  const nonFatalProblems = [...preflightProblems, ...gate.problems, ...alsoLinkFailures]
  const resultWithTips: InstallResult =
    nonFatalProblems.length > 0
      ? { ...result, tips: [...(result.tips ?? []), ...nonFatalProblems] }
      : result

  // SMI-4588 Wave 2 PR #3: surface non-blocking namespace warnings (and
  // installComplete=true marker) on `power_user` / `governance` paths.
  // `pendingCollision` is intentionally not merged here — it is exclusive
  // to the blocking-mode early return above.
  //
  // SMI-6585 cross-model review: this used to REPLACE the installer's own
  // warnings with the gate's. That is the same shape as the catch this change
  // fixes — a line whose meaning inverts the day a producer elsewhere starts
  // returning data it previously never did. Merge instead, as the `tips` code
  // above does, so neither source can silently erase the other.
  if (gate.resultPatch.warnings && gate.resultPatch.warnings.length > 0) {
    return {
      ...resultWithTips,
      installComplete: gate.resultPatch.installComplete,
      warnings: [...(resultWithTips.warnings ?? []), ...gate.resultPatch.warnings],
    }
  }

  return resultWithTips
}

// SMI-5017 W2.S2: wrap at export boundary
export const installSkill = withTelemetry(installSkillImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'install_skill',
  extractFramework: () => 'unknown',
})
