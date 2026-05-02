/**
 * @fileoverview Install pre-flight namespace check (SMI-4588 Wave 2 Step 5, PR #3).
 * @module @skillsmith/mcp-server/audit/install-preflight
 *
 * Detects namespace collisions between an in-flight install candidate and
 * the user's existing local inventory BEFORE any side effects. Returns both
 * a non-blocking `warnings[]` shape (for `power_user` / `governance` modes)
 * AND a blocking `pendingCollision` envelope (for `preventative` mode). The
 * mode gate lives in the install.ts caller — this module is pure detection
 * + suggestion generation + audit-history persistence.
 *
 * Plan §3 + §Step 5 + Edits 2/3/6/7.
 *
 * Inventory contract (Edit 7):
 *   - `existingInventory` — pre-candidate snapshot, passed to
 *     `generateSuggestionChain` (chain self-collides at tier 1 otherwise).
 *   - `augmentedInventory` — existing + the synthesized candidate, passed to
 *     `detectCollisions`. Filtering to flags involving the candidate keeps
 *     pre-existing collisions from re-surfacing on every install.
 *
 * Failure model (Edit 2):
 *   - Pre-flight scanner failure (ledger malformed unrecoverably, fs error,
 *     unexpected throw) is ALWAYS non-blocking. The caller treats `warnings:
 *     [], pendingCollision: null` as a degraded-but-clean pass and proceeds
 *     with the install.
 *
 * Edit 6 — `readLedger()` may throw `namespace.ledger.version_unsupported`.
 * The pre-flight catches it and degrades to non-blocking; bubbling would
 * brick installs after a ledger downgrade.
 */

import { detectCollisions } from './collision-detector.js'
import type {
  AuditId,
  CollisionId,
  ExactCollisionFlag,
  GenericTokenFlag,
  InventoryAuditResult,
  InventoryEntry,
  SemanticCollisionFlag,
} from './collision-detector.types.js'
import type { NamespaceWarning, PendingCollision } from './namespace-audit.types.js'
import { newAuditId, writeAuditHistory } from './audit-history.js'
import type { AuditMode, Tier } from '@skillsmith/core/config/audit-mode'

import { generateSuggestionChain } from './suggestion-chain.js'
import type { RenameAction, RenameSuggestion } from './rename-engine.types.js'

/**
 * One synthesized candidate skill being considered for install. The
 * pre-flight builds an `InventoryEntry` for it so the existing
 * `detectCollisions` pipeline can compare it against the user's inventory.
 */
export interface CandidateSkill {
  /** Skill identifier post-install (e.g. `"code-helper"`). */
  identifier: string
  /**
   * Path the skill WILL occupy post-install. The pre-flight runs before
   * the install touches disk, so this is a projected path used for
   * suggestion-chain `authorPath` derivation. Real on-disk state is not
   * inspected here.
   */
  projectedSourcePath: string
  /** Optional Skillsmith manifest skillId (`<author>/<name>`). */
  skillId?: string | null
  /** Optional `meta.author` slug (`anthropic`) — flows to suggestion chain. */
  author?: string | null
  /** Optional `meta.tags` for the suggestion-chain tag fallback. */
  tags?: string[]
  /** Optional `meta.description` (round-tripped for audit-history). */
  description?: string
  /**
   * Pack-domain hint (e.g. `codehelper`) used at chain tier 2/3. The install
   * caller derives this from the registry response or manifest; pre-flight
   * passes it through unchanged.
   */
  packDomain?: string | null
}

export interface RunInstallPreflightInput {
  /** Pre-candidate snapshot of `~/.claude/{skills,commands,agents}` + CLAUDE.md. */
  existingInventory: ReadonlyArray<InventoryEntry>
  /** Synthesized candidate skill being considered for install. */
  candidate: CandidateSkill
  /** Resolved audit mode (`'preventative'` blocks install in caller). */
  mode: AuditMode
  /** Subscription tier (drives default mode for the inner detector run). */
  tier: Tier
}

export interface RunInstallPreflightResult {
  /** Non-blocking warnings (`power_user` / `governance` mode shape). */
  warnings: NamespaceWarning[]
  /**
   * Blocking envelope for `preventative` mode. Populated only when at
   * least one candidate-related collision is detected. Caller decides
   * whether to surface it based on `mode`.
   */
  pendingCollision: PendingCollision | null
  /**
   * ULID written to audit history. Bubbled explicitly per Edit 7 so the
   * install caller does not re-derive it for telemetry / ledger linkage.
   */
  auditId: AuditId
}

/**
 * Synthesize an `InventoryEntry` for the candidate skill. Mirrors the
 * shape `scanLocalInventory` produces for `~/.claude/skills/*`.
 */
function synthesizeCandidateEntry(candidate: CandidateSkill): InventoryEntry {
  return {
    kind: 'skill',
    source_path: candidate.projectedSourcePath,
    identifier: candidate.identifier,
    triggerSurface: [candidate.identifier],
    meta: {
      author: candidate.author ?? undefined,
      tags: candidate.tags,
      description: candidate.description,
    },
  }
}

/**
 * Filter detector flags to those that involve the candidate skill. The
 * user has already accepted any pre-existing collisions; only newly
 * introduced ones surface at install time.
 */
function flagInvolvesCandidate(
  flag: ExactCollisionFlag | GenericTokenFlag | SemanticCollisionFlag,
  candidatePath: string
): boolean {
  if (flag.kind === 'exact') {
    return flag.entries.some((e) => e.source_path === candidatePath)
  }
  if (flag.kind === 'generic') {
    return flag.entry.source_path === candidatePath
  }
  // semantic
  return flag.entryA.source_path === candidatePath || flag.entryB.source_path === candidatePath
}

/**
 * Find the inventory entry on the OTHER side of a flag — the entry the
 * candidate collides with. Used when constructing `RenameSuggestion`
 * shapes whose `entry` field points at the candidate (so the apply path
 * mutates the candidate, not the existing entry).
 */
function candidateEntryFromFlag(
  flag: ExactCollisionFlag | GenericTokenFlag | SemanticCollisionFlag,
  candidatePath: string
): InventoryEntry | null {
  if (flag.kind === 'exact') {
    return flag.entries.find((e) => e.source_path === candidatePath) ?? null
  }
  if (flag.kind === 'generic') {
    return flag.entry
  }
  return flag.entryA.source_path === candidatePath ? flag.entryA : flag.entryB
}

/**
 * Pick the apply-action for the candidate based on its kind. The candidate
 * is always synthesized as `kind: 'skill'`; this stays a switch so future
 * candidate kinds (commands, agents added at install time) are supported.
 */
function actionForEntry(entry: InventoryEntry): RenameAction {
  switch (entry.kind) {
    case 'command':
      return 'rename_command_file'
    case 'agent':
      return 'rename_agent_file'
    case 'skill':
    case 'claude_md_rule':
    default:
      return 'rename_skill_dir_and_frontmatter'
  }
}

/**
 * Build a `RenameSuggestion` for the candidate, picking the first
 * non-colliding chain candidate as `suggested`. Falls back to chain
 * candidate[0] when all collide (the agent surfaces the chain via
 * `pendingCollision.suggestionChain`).
 */
function buildCandidateSuggestion(args: {
  flag: ExactCollisionFlag | GenericTokenFlag | SemanticCollisionFlag
  candidate: CandidateSkill
  candidateEntry: InventoryEntry
  existingInventory: ReadonlyArray<InventoryEntry>
}): { suggestion: RenameSuggestion; chain: string[]; exhausted: boolean } {
  const chain = generateSuggestionChain({
    token: args.candidate.identifier,
    author: args.candidate.author ?? null,
    packDomain: args.candidate.packDomain ?? null,
    tagFallback: args.candidate.tags?.[0] ?? null,
    authorPath: args.candidate.projectedSourcePath,
    existingInventory: args.existingInventory,
  })

  // First non-colliding candidate, or fall back to first slot when all
  // collide (caller surfaces `chainExhausted` separately).
  const lowercaseInventory = new Set(args.existingInventory.map((e) => e.identifier.toLowerCase()))
  const firstFree = chain.candidates.find((c) => !lowercaseInventory.has(c.toLowerCase()))
  const suggested = firstFree ?? chain.candidates[0] ?? args.candidate.identifier

  const reason = buildReason(args.flag, args.candidate.projectedSourcePath)

  return {
    suggestion: {
      collisionId: args.flag.collisionId as CollisionId,
      entry: args.candidateEntry,
      currentName: args.candidate.identifier,
      suggested,
      applyAction: actionForEntry(args.candidateEntry),
      reason,
    },
    chain: chain.candidates,
    exhausted: chain.exhausted,
  }
}

function buildReason(
  flag: ExactCollisionFlag | GenericTokenFlag | SemanticCollisionFlag,
  candidatePath?: string
): string {
  if (flag.kind === 'exact') {
    // Exclude the candidate from the rendered list so the message reads
    // as "X collides with the existing entries", not "X collides with X
    // and the existing entries".
    const others = flag.entries
      .filter((e) => e.source_path !== candidatePath)
      .map((e) => `${e.kind}:${e.identifier}`)
      .join(', ')
    return `exact collision with ${others}`
  }
  if (flag.kind === 'generic') {
    return `generic-token flag (${flag.matchedTokens.join(', ')})`
  }
  return `semantic overlap (cosine ${flag.cosineScore.toFixed(2)}) with ${flag.entryB.identifier}`
}

/**
 * Filter out the candidate skill's own prior on-disk presence from the
 * inventory snapshot.
 *
 * On reinstall (`force: true`), `scanLocalInventory` returns an entry for
 * the already-installed skill at `<projectedSourcePath>/SKILL.md`. If we
 * left it in `existingInventory`, the augmented inventory would contain
 * both the prior entry AND the synthesized candidate with the same
 * `identifier`, and `detectExactCollisions` would surface a false-positive
 * "namespace collision" that blocks reinstall in `preventative` mode.
 *
 * The reinstall flow is owned by `install.conflict.ts` (three-way merge,
 * backup, force semantics). Pre-flight is for *new* namespace conflicts
 * with *other* skills, not for the candidate's own prior copy.
 */
function excludeSelfReinstall(
  existing: ReadonlyArray<InventoryEntry>,
  candidate: CandidateSkill
): InventoryEntry[] {
  const candidateDir = candidate.projectedSourcePath
  const candidateIdentifier = candidate.identifier.toLowerCase()
  return existing.filter((entry) => {
    if (entry.kind !== 'skill') return true
    if (entry.identifier.toLowerCase() !== candidateIdentifier) return true
    // Skill entries' source_path is `<dir>/SKILL.md`; match by parent dir.
    // Also accept exact-equality for forward-compat with future synthesis
    // shapes that may use the directory path directly.
    if (entry.source_path === candidateDir) return false
    if (entry.source_path.startsWith(`${candidateDir}/`)) return false
    return true
  })
}

/**
 * Run the install pre-flight. Pure function over `existingInventory` +
 * `candidate`; emits an audit-history entry as a side effect so the agent's
 * later `apply_namespace_rename` call can re-derive context via `auditId`.
 *
 * Failure model: any unexpected throw inside this function returns the
 * degraded shape (`warnings: []`, `pendingCollision: null`, fresh
 * `auditId`) — the install MUST proceed when the detector breaks (Edit 2).
 */
export async function runInstallPreflight(
  input: RunInstallPreflightInput
): Promise<RunInstallPreflightResult> {
  const { existingInventory, candidate, mode, tier } = input

  // Allocate the audit id up front so the degraded path returns a valid
  // ULID even when the inner detector throws before producing a result.
  const auditId = newAuditId()

  let inventoryWithoutSelf: InventoryEntry[]
  let augmentedInventory: InventoryEntry[]
  let result: InventoryAuditResult
  try {
    // Exclude the candidate's own prior on-disk copy (reinstall) so the
    // detector doesn't surface it as a namespace collision against itself.
    inventoryWithoutSelf = excludeSelfReinstall(existingInventory, candidate)
    const candidateEntry = synthesizeCandidateEntry(candidate)
    augmentedInventory = [...inventoryWithoutSelf, candidateEntry]
    result = await detectCollisions(augmentedInventory, {
      auditId,
      tier,
      auditModeOverride: mode,
    })
  } catch (err) {
    // Edit 2: pre-flight failure is always non-blocking. Log + degrade.
    // The catch covers `excludeSelfReinstall` (rejects non-iterable
    // inputs), `synthesizeCandidateEntry`, the spread, AND
    // `detectCollisions`. Any pre-flight failure → install proceeds.
    console.warn(
      `[install-preflight] detector failed (${(err as Error).message}); degrading to non-blocking pass`
    )
    return { warnings: [], pendingCollision: null, auditId }
  }

  // Filter to flags involving the candidate. Pre-existing collisions are
  // out of scope at install time.
  const allFlags: Array<ExactCollisionFlag | GenericTokenFlag | SemanticCollisionFlag> = [
    ...result.exactCollisions,
    ...result.genericFlags,
    ...result.semanticCollisions,
  ]
  const candidateFlags = allFlags.filter((f) =>
    flagInvolvesCandidate(f, candidate.projectedSourcePath)
  )

  if (candidateFlags.length === 0) {
    // Clean candidate. Persist the audit history (zero-flag run) so the
    // agent's later inspection by auditId still resolves; absence of an
    // audit file would be ambiguous.
    await tryWriteAuditHistory(result)
    return { warnings: [], pendingCollision: null, auditId }
  }

  // Build a NamespaceWarning + suggestion-chain for each candidate-related
  // flag. We surface the first flag's chain in `pendingCollision` (the
  // dominant collision); all flags surface in `warnings[]`.
  const warnings: NamespaceWarning[] = []
  let pendingCollision: PendingCollision | null = null

  for (let i = 0; i < candidateFlags.length; i++) {
    const flag = candidateFlags[i]!
    const candidateEntry = candidateEntryFromFlag(flag, candidate.projectedSourcePath)
    if (!candidateEntry) continue

    const built = buildCandidateSuggestion({
      flag,
      candidate,
      candidateEntry,
      // Pass the self-excluded snapshot so the chain doesn't treat the
      // candidate's own prior install (during a force-reinstall) as a
      // colliding entry — that would force `chainExhausted: true` on
      // every reinstall.
      existingInventory: inventoryWithoutSelf,
    })

    warnings.push({
      collisionId: flag.collisionId as CollisionId,
      kind: flag.kind,
      severity: 'warning',
      message: buildWarningMessage(flag, candidate, built.suggestion.suggested),
      suggestion: built.suggestion,
      auditId,
    })

    // First candidate-flag becomes the pendingCollision envelope.
    if (i === 0) {
      pendingCollision = {
        auditId,
        suggestedRename: built.suggestion,
        suggestionChain: built.chain,
        chainExhausted: built.exhausted,
        remediationHint:
          "call apply_namespace_rename({ auditId, action: 'apply' }) then re-invoke install_skill",
      }
    }
  }

  await tryWriteAuditHistory(result)

  return { warnings, pendingCollision, auditId }
}

function buildWarningMessage(
  flag: ExactCollisionFlag | GenericTokenFlag | SemanticCollisionFlag,
  candidate: CandidateSkill,
  suggested: string
): string {
  const reason = buildReason(flag, candidate.projectedSourcePath)
  return `Namespace ${flag.kind} collision installing "${candidate.identifier}": ${reason}. Suggested rename: "${suggested}".`
}

/**
 * Persist the audit history. Errors here are logged + swallowed — pre-flight
 * is non-blocking (Edit 2), and a missing audit file degrades the agent's
 * later `apply_namespace_rename` lookup but does not break install.
 */
async function tryWriteAuditHistory(result: InventoryAuditResult): Promise<void> {
  try {
    await writeAuditHistory(result)
  } catch (err) {
    console.warn(
      `[install-preflight] writeAuditHistory failed (${(err as Error).message}); auditId will be unrecoverable but install proceeds`
    )
  }
}
