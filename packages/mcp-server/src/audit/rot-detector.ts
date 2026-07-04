/**
 * @fileoverview Standalone rot detector for the consumer namespace audit
 *               (SMI-5536 Wave 2B — R0 rot detection).
 * @module @skillsmith/mcp-server/audit/rot-detector
 * @see SMI-5536
 *
 * Mirrors the collision-detector module shape: a single async
 * `detectRot(inventory, opts)` entrypoint returning a flat array of
 * `RotFinding`s. Detection-only — no file mutation, no network access.
 *
 * Signals (see `rot-detector.types.ts` for the full contract):
 *   - `dead-ref` — the skill/command/agent's own markdown content
 *     contains a placeholder/dead link or an explicit deprecation marker.
 *     Fully offline: reads `entry.source_path` from disk, nothing else.
 *   - `version-drift` — "the registry has a newer version of this skill
 *     than what's installed." Scaffolded but NOT implemented in v1 (see
 *     the feasibility note below) — `detectVersionDrift` always returns
 *     `[]`.
 *
 * ---
 * Version-drift feasibility (plan decision, SMI-5536 Wave 2B):
 *
 * `InventoryEntry` (`../utils/local-inventory.types.ts`) carries no
 * version, no source URL, and no install date — only `mtime` + `meta` +
 * `source_path` (the A4 constraint). Resolving "registry has a newer
 * version" the way `skill_updates` (`tools/skill-updates.ts`) and
 * `skill_outdated` (`tools/outdated.ts`) do requires a
 * `SkillVersionRepository` query against `context.db`, keyed by the
 * manifest's registry `id` + tracked content hash.
 *
 * That data is NOT reachable from the audit path without new plumbing:
 * `skill_inventory_audit`'s implementation (`tools/skill-inventory-
 * audit.ts`'s `skillInventoryAuditImpl(input: unknown)`) takes no
 * `ToolContext` / db handle at all, and neither does `runInventoryAudit`
 * → `detectCollisions` → (now) `detectRot`. Threading a db handle through
 * that whole call chain — plus the CLI's `sklx audit collisions`
 * equivalent — is a materially larger, separate change, not a detector
 * implementation detail.
 *
 * Per the task's decision rule: dead-ref ships as the primary signal;
 * version-drift is a clearly-marked scaffold that returns nothing rather
 * than faking a comparison. Wire it up once the db-handle plumbing lands
 * (track via a follow-up Linear issue — do not backfill this comment with
 * a fake diff instead of doing the plumbing).
 * ---
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'

import type { InventoryEntry } from '../utils/local-inventory.types.js'
import type { DetectRotOptions, RotFinding, RotSignal } from './rot-detector.types.js'

/**
 * Kinds whose `source_path` is a per-entry markdown file worth content-
 * scanning. `claude_md_rule` entries all point at the SAME shared
 * CLAUDE.md file (one inventory row per matched rule, per
 * `local-inventory.helpers.ts`) — scanning it once per rule would produce
 * N duplicate "dead ref in CLAUDE.md" findings for a single real issue,
 * so those are skipped here entirely.
 */
const SCANNABLE_KINDS: ReadonlySet<InventoryEntry['kind']> = new Set(['skill', 'command', 'agent'])

/**
 * Case-insensitive patterns matching a dead/placeholder link left in a
 * skill's own markdown — gated to a markdown LINK-TARGET context (i.e.
 * inside `](...)`), never a bare prose mention. A skill that merely
 * *mentions* "example.com" or `http://localhost:3000` in prose (or a
 * fenced `curl` example) is not evidence of rot; a skill that actually
 * *links to* one of these as its documentation target is. Every pattern
 * here targets a link target: an RFC 2606 reserved placeholder domain, an
 * empty link target, a bare `#` anchor, a literal TODO/TBD/FIXME link
 * target, or a localhost URL used as a link target. Chosen to keep false
 * positives on a well-formed skill very low — every pattern targets a
 * link-target or (see `DEPRECATED_MARKERS` / `SELF_REFERENTIAL_DEPRECATION_PATTERN`
 * below) a self-referential deprecation, never a prose mention.
 */
const DEAD_LINK_PATTERNS: ReadonlyArray<RegExp> = [
  /\]\(\s*<?https?:\/\/(www\.)?example\.(com|org|net)\b[^)]*\)/i,
  /]\(\s*\)/, // markdown link with an empty target: [text]()
  /]\(\s*#\s*\)/, // markdown link pointing at a bare `#` anchor
  /]\(\s*(TODO|TBD|FIXME)\s*\)/i,
  /\]\(\s*<?https?:\/\/localhost(:\d+)?\b[^)]*\)/i,
]

/**
 * Literal (lowercased) substrings that, if present anywhere in a skill's
 * markdown, are a high-confidence signal that the author explicitly
 * marked the skill/command/agent ITSELF as no longer maintained/
 * supported. Deliberately specific, self-referential phrases rather than
 * a bare "deprecated" token — a skill that merely *discusses* a
 * third-party deprecation (e.g. a migration guide: "the old API is
 * superseded by X") must not be flagged.
 */
const DEPRECATED_MARKERS: ReadonlyArray<string> = [
  'this skill is deprecated',
  'this command is deprecated',
  'this agent is deprecated',
  'do not use this skill',
]

/**
 * Self-referential deprecation regex covering the phrasings that are too
 * generic to treat as bare substrings ("no longer maintained", "no longer
 * supported", "superseded by") — those fire on migration guides discussing
 * a THIRD-PARTY subject ("the old API is superseded by X") unless gated to
 * a "this skill/command/agent" subject appearing shortly before the
 * deprecation phrase. `[^.\n]{0,60}` caps the subject-to-verb distance at
 * one clause (60 chars, no sentence/line break) so an unrelated sentence
 * later in the doc can't accidentally bridge a real subject to someone
 * else's deprecation notice.
 */
const SELF_REFERENTIAL_DEPRECATION_PATTERN =
  /\bthis (skill|command|agent)\b[^.\n]{0,60}\b(is (deprecated|no longer (maintained|supported))|has been superseded)\b/i

/**
 * Run the rot-detection pass over an inventory snapshot. Pure detection —
 * safe to call repeatedly, never mutates the filesystem.
 *
 * Entries are visited in the order the caller passed them in — no
 * priority reordering by `mtime` or anything else. The RETURNED findings
 * are then sorted by a stable key (`entry.source_path`, then `signal`) so
 * the report's "Rot / dead references" section is deterministic across
 * runs: a mere file `touch` (which changes `mtime` but not content) must
 * not reorder the section and produce diff noise.
 */
export async function detectRot(
  inventory: ReadonlyArray<InventoryEntry>,
  opts: DetectRotOptions = {}
): Promise<RotFinding[]> {
  const auditId = opts.auditId ?? 'unscoped'
  const findings: RotFinding[] = []

  for (const entry of inventory) {
    if (!SCANNABLE_KINDS.has(entry.kind)) continue

    const content = await readEntryContent(entry.source_path)
    if (content === null) continue // unreadable — fail toward no finding, never a crash.

    const deadRefReason = findDeadRefReason(content)
    if (deadRefReason !== null) {
      findings.push(buildFinding(auditId, entry, 'dead-ref', 'warning', deadRefReason))
    }
  }

  // Version-drift: scaffold only — see module header. Always empty in v1.
  findings.push(...(await detectVersionDrift(inventory, opts)))

  return findings.sort(compareBySourcePathThenSignal)
}

/**
 * Stable sort comparator for the findings `detectRot` returns: primarily
 * by `source_path`, then by `signal` as a tiebreak (relevant once
 * version-drift ships and an entry can carry two findings). Deliberately
 * NOT `mtime`-based — see {@link detectRot}'s doc comment.
 */
function compareBySourcePathThenSignal(a: RotFinding, b: RotFinding): number {
  if (a.entry.source_path !== b.entry.source_path) {
    return a.entry.source_path < b.entry.source_path ? -1 : 1
  }
  if (a.signal !== b.signal) {
    return a.signal < b.signal ? -1 : 1
  }
  return 0
}

/**
 * TODO(SMI-5537): wire this up once the audit pipeline can
 * accept a `SkillVersionRepository` / db handle (requires threading a
 * `ToolContext` through `runInventoryAudit` → `detectRot` — see the
 * module header's feasibility note). Deliberately always returns `[]`
 * today; this is an intentional no-op scaffold, not a stub that fakes a
 * comparison.
 */
async function detectVersionDrift(
  inventory: ReadonlyArray<InventoryEntry>,
  opts: DetectRotOptions
): Promise<RotFinding[]> {
  void inventory
  void opts
  return []
}

/** Read a file's UTF-8 content, or `null` on any read failure (never throws). */
async function readEntryContent(sourcePath: string): Promise<string | null> {
  try {
    return await fs.readFile(sourcePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Return a human-readable reason string the first time either a dead-link
 * pattern, a literal self-referential deprecation phrase, or the
 * self-referential deprecation regex matches, or `null` when none match.
 * Honest labeling per plan: "dead source reference" — never "old"/"stale".
 */
function findDeadRefReason(content: string): string | null {
  for (const pattern of DEAD_LINK_PATTERNS) {
    if (pattern.test(content)) {
      return 'Contains a dead source reference (placeholder or empty link target).'
    }
  }
  const lower = content.toLowerCase()
  for (const marker of DEPRECATED_MARKERS) {
    if (lower.includes(marker)) {
      return `Contains a dead source reference (explicit deprecation marker: "${marker}").`
    }
  }
  const selfReferentialMatch = SELF_REFERENTIAL_DEPRECATION_PATTERN.exec(lower)
  if (selfReferentialMatch) {
    return `Contains a dead source reference (explicit deprecation marker: "${selfReferentialMatch[0]}").`
  }
  return null
}

function buildFinding(
  auditId: string,
  entry: InventoryEntry,
  signal: RotSignal,
  severity: RotFinding['severity'],
  reason: string
): RotFinding {
  return {
    kind: 'rot',
    rotId: deriveRotId(auditId, entry, signal),
    entry,
    severity,
    signal,
    reason,
  }
}

/**
 * Derive a stable per-finding id, mirroring `deriveCollisionId`'s
 * sha256(auditId + ':' + ...) shape from `audit-history.ts`.
 */
function deriveRotId(auditId: string, entry: InventoryEntry, signal: RotSignal): string {
  const input = `${auditId}:${entry.source_path}:${signal}`
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16)
}
