/**
 * @fileoverview Edit-suggester core (SMI-4589 Wave 3 Steps 2-3).
 * @module @skillsmith/mcp-server/audit/edit-suggester
 *
 * Takes the semantic-collision flags from Wave 1's `InventoryAuditResult`
 * and produces `RecommendedEdit[]` — templated, deterministic prose-edit
 * suggestions. No LLM calls. No fuzziness.
 *
 * Per-template gate (ratified 2026-05-01): v1 ships only
 * `add_domain_qualifier` (4.10/5 from GPT-5.4 reviewer-#2 scoring). The
 * other two templates (`narrow_scope` 1.70/5, `reword_trigger_verb`
 * 2.35/5) FAILED the gate and are NOT shipped in any form — neither as
 * auto-apply nor as `manual_review`. They route to SMI-4593 for
 * reauthoring. Test cases 2-3 in `edit-suggester.test.ts` assert empty
 * output for collisions that would have matched those failing templates,
 * guarding against accidental re-registration before the gate clears.
 *
 * Dispatch pattern (plan §1):
 *   1. Walk `result.semanticCollisions[]`, collect unique file paths
 *      across the surviving template's `applies()` checks.
 *   2. `await Promise.all(uniqueFilePaths.map(fs.readFile))` — single
 *      parallel read phase. Latency budget is linear in unique-files,
 *      not templates × collisions.
 *   3. Iterate flags; for each, walk templates pre-sorted by descending
 *      `priority`; first `applies()` true wins; `generate()` is
 *      synchronous over the cached `fileContent`.
 *   4. Filter null results (template matched but generate() couldn't
 *      synthesize a valid edit — e.g. file content drifted).
 *
 * Plan: docs/internal/implementation/smi-4589-edit-suggester.md §1, §Steps 2-3.
 */

import * as fs from 'node:fs/promises'

import type { InventoryAuditResult, SemanticCollisionFlag } from './collision-detector.types.js'
import type { EditTemplate, EditTemplatePattern, RecommendedEdit } from './edit-suggester.types.js'

/**
 * `add_domain_qualifier` template. Fires for `description_overlap` flags
 * where one entry has a `meta.tags[0]` value the other lacks. Inserts
 * `for <tag> tasks` after the trigger verb in the description, narrowing
 * the trigger surface enough to differentiate from the partner.
 *
 * Per-template gate verdict 2026-05-01: 4.10/5 (GPT-5.4 reviewer-#2).
 * PASS — registered in `APPLY_TEMPLATE_REGISTRY`.
 */
const ADD_DOMAIN_QUALIFIER: EditTemplate = {
  category: 'description_overlap',
  pattern: 'add_domain_qualifier',
  priority: 100,

  applies(flag: SemanticCollisionFlag): boolean {
    // Both entries must carry a description (the prose surface we mutate),
    // and at least one entry must have a unique tag the other lacks (the
    // qualifier text we insert). The tag-asymmetry check is the
    // distinguishing feature of `add_domain_qualifier` versus a hypothetical
    // `narrow_scope` template — same shape but different remediation.
    const aTag = pickQualifierTag(flag.entryA, flag.entryB)
    const bTag = pickQualifierTag(flag.entryB, flag.entryA)
    if (aTag === null && bTag === null) return false
    if (!flag.entryA.meta?.description && !flag.entryB.meta?.description) {
      return false
    }
    return true
  },

  generate(flag: SemanticCollisionFlag, context: { fileContent: string }): RecommendedEdit | null {
    // Pick the entry on whose file we'll mutate. Prefer the one with a
    // unique tag (the qualifier text comes from that tag). If both have
    // unique tags, prefer entryA — deterministic by `applies()` ordering.
    const aTag = pickQualifierTag(flag.entryA, flag.entryB)
    const target = aTag !== null ? { entry: flag.entryA, tag: aTag, partner: flag.entryB } : null
    const fallback =
      target !== null
        ? target
        : (() => {
            const bTag = pickQualifierTag(flag.entryB, flag.entryA)
            return bTag !== null ? { entry: flag.entryB, tag: bTag, partner: flag.entryA } : null
          })()
    if (!fallback) return null

    const description = fallback.entry.meta?.description
    if (!description) return null

    // Locate the description block in the file. Skill SKILL.md uses YAML
    // frontmatter with a `description:` key; we match the description text
    // verbatim and identify the line range it spans. Multi-line block-scalar
    // descriptions are handled by line-range expansion (start = first line,
    // end = last line whose trimmed text appears in the description).
    const located = locateDescription(context.fileContent, description)
    if (!located) return null

    // Compose the after-snippet by injecting `for <tag> tasks` after the
    // first trigger verb in the description. The trigger verb is the first
    // word matching /^(use|trigger|run|when|whenever|invoke)/i; if none
    // matches, we prepend `for <tag> tasks: ` to the description body
    // instead. Either way the edit is deterministic.
    const after = injectQualifier(located.snippet, fallback.tag)
    if (after === null || after === located.snippet) {
      // Snippet didn't change — would emit a no-op edit. Skip.
      return null
    }

    const cosine = flag.cosineScore.toFixed(2)
    const rationale = `differentiates from \`${fallback.partner.identifier}\` (cosine ${cosine}) by inserting domain qualifier "for ${fallback.tag} tasks"`

    return {
      collisionId: flag.collisionId,
      category: 'description_overlap',
      pattern: 'add_domain_qualifier',
      filePath: fallback.entry.source_path,
      lineRange: { start: located.startLine, end: located.endLine },
      before: located.snippet,
      after,
      rationale,
      applyAction: 'recommended_edit',
      // Per-template gate cleared: ships at apply_with_confirmation.
      applyMode: 'apply_with_confirmation',
      otherEntry: {
        identifier: fallback.partner.identifier,
        sourcePath: fallback.partner.source_path,
      },
    }
  },
}

/**
 * Registry of templates that ship in v1. Pre-sorted by descending
 * priority. The dispatcher walks this list per flag.
 *
 * Wave 3 ships a single template (`add_domain_qualifier`). SMI-4593
 * reauthors `narrow_scope` and `reword_trigger_verb` and re-registers
 * them upon clearing the per-template gate.
 */
const V1_TEMPLATES: ReadonlyArray<EditTemplate> = [ADD_DOMAIN_QUALIFIER]

/**
 * Run the edit-suggester over an `InventoryAuditResult`'s semantic
 * collisions. Returns `RecommendedEdit[]` — one per flag that matches a
 * registered template AND whose template successfully synthesized a
 * non-empty edit.
 *
 * Order of returned edits: same as `result.semanticCollisions[]` input
 * order. Tests assert this stability so PR diffs in the audit-report
 * markdown are deterministic.
 *
 * I/O: reads each unique referenced file ONCE, in parallel, before
 * iterating templates. Templates see only `fileContent` strings, not
 * paths — keeps templates pure and unit-testable without fixtures on
 * disk.
 *
 * Failure model: any per-flag template error (fileRead failure, snippet
 * locate failure, `generate()` returning null) skips that flag silently.
 * The other flags still produce edits. An empty
 * `result.semanticCollisions[]` short-circuits with no I/O.
 */
export async function runEditSuggester(
  result: InventoryAuditResult,
  opts?: { templateOverrides?: ReadonlyArray<EditTemplate> }
): Promise<RecommendedEdit[]> {
  if (result.semanticCollisions.length === 0) return []

  const templates = sortByPriority(opts?.templateOverrides ?? V1_TEMPLATES)
  if (templates.length === 0) return []

  // Phase 1: collect unique file paths referenced by any flag whose
  // partner-pair would feed into a template's `applies()`.
  const uniquePaths = new Set<string>()
  for (const flag of result.semanticCollisions) {
    uniquePaths.add(flag.entryA.source_path)
    uniquePaths.add(flag.entryB.source_path)
  }

  // Phase 2: parallel reads. Failed reads degrade to `null` content; the
  // template will return null when it can't locate the description.
  const fileCache = new Map<string, string | null>()
  await Promise.all(
    Array.from(uniquePaths).map(async (filePath) => {
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        fileCache.set(filePath, content)
      } catch (err) {
        // Soft-warn; per plan §Tests case 9 a missing file emits no edit.
        console.warn(
          `[edit-suggester] read failed for ${filePath} (${(err as Error).message}); skipping flags that target it`
        )
        fileCache.set(filePath, null)
      }
    })
  )

  // Phase 3: iterate flags, dispatch to templates synchronously over
  // cached content.
  const edits: RecommendedEdit[] = []
  for (const flag of result.semanticCollisions) {
    const template = templates.find((t) => t.applies(flag))
    if (!template) continue

    // Templates target one of the two entries' files. We let `generate()`
    // pick which (it has the asymmetry logic). For now, hand it whichever
    // entry's file content is available — `generate()` will return null
    // if it needed the other side. We pick entryA's content first since
    // `add_domain_qualifier`'s `generate` prefers entryA when both have
    // unique tags.
    const aContent = fileCache.get(flag.entryA.source_path)
    const bContent = fileCache.get(flag.entryB.source_path)

    const candidates: Array<string | null> = [aContent ?? null, bContent ?? null]
    let edit: RecommendedEdit | null = null
    for (const content of candidates) {
      if (!content) continue
      const result = template.generate(flag, { fileContent: content })
      if (result) {
        edit = result
        break
      }
    }
    if (edit) edits.push(edit)
  }

  return edits
}

// ---------------------------------------------------------------------------
// Template helpers (kept inline; ~150-LOC budget for this file)
// ---------------------------------------------------------------------------

/**
 * Stable-sort templates by descending priority. Stable to preserve
 * registration order on ties.
 */
function sortByPriority(templates: ReadonlyArray<EditTemplate>): EditTemplate[] {
  return [...templates].sort((a, b) => b.priority - a.priority)
}

/**
 * Pick the first tag from `entry` that does NOT appear in `partner.meta.tags`.
 * Returns `null` if `entry` has no tags or all tags overlap.
 */
function pickQualifierTag(
  entry: { meta?: { tags?: string[] } },
  partner: { meta?: { tags?: string[] } }
): string | null {
  const ours = entry.meta?.tags ?? []
  const theirs = new Set(partner.meta?.tags ?? [])
  for (const tag of ours) {
    if (typeof tag !== 'string') continue
    const trimmed = tag.trim()
    if (!trimmed) continue
    if (!theirs.has(trimmed)) return trimmed
  }
  return null
}

/**
 * Locate the `description` text block within `fileContent`. Returns the
 * matched snippet plus 1-indexed inclusive line range, or `null` if the
 * description cannot be located (file content drifted since scan time).
 *
 * Strategy: split the description into lines (trimmed), then scan
 * fileContent line-by-line for the first line that matches the first
 * description line. Once anchored, walk forward to confirm subsequent
 * description lines match in order. Returns the byte-exact snippet from
 * the original file (preserves leading whitespace, comments, etc.).
 */
function locateDescription(
  fileContent: string,
  description: string
): { snippet: string; startLine: number; endLine: number } | null {
  const fileLines = fileContent.split('\n')
  const descLines = description
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (descLines.length === 0) return null

  for (let i = 0; i < fileLines.length; i++) {
    const fileLine = fileLines[i]?.trim() ?? ''
    if (!fileLine.includes(descLines[0]!)) continue
    // Try to match all description lines in order from this anchor.
    let cursor = i
    let matched = true
    for (let j = 0; j < descLines.length; j++) {
      // Walk forward; allow blank lines between description fragments.
      while (cursor < fileLines.length) {
        const candidate = fileLines[cursor]?.trim() ?? ''
        if (candidate.includes(descLines[j]!)) break
        if (candidate.length === 0 && j > 0) {
          cursor++
          continue
        }
        matched = false
        break
      }
      if (!matched || cursor >= fileLines.length) {
        matched = false
        break
      }
      if (j < descLines.length - 1) cursor++
    }
    if (matched) {
      const startLine = i + 1 // 1-indexed
      const endLine = cursor + 1
      const snippet = fileLines.slice(i, cursor + 1).join('\n')
      return { snippet, startLine, endLine }
    }
  }
  return null
}

/**
 * Insert ` for <tag> tasks` after the first trigger verb match in
 * `snippet`. If no trigger verb is found, prepend `for <tag> tasks: ` to
 * the description body (after any leading frontmatter prefix like
 * `description:`).
 *
 * Returns the modified snippet, or `null` if the qualifier text is
 * already present (idempotent — no-op edits are filtered out by caller).
 */
function injectQualifier(snippet: string, tag: string): string | null {
  const qualifierPhrase = `for ${tag} tasks`
  if (snippet.toLowerCase().includes(qualifierPhrase.toLowerCase())) {
    // Already qualified.
    return null
  }

  // Trigger-verb pattern: case-insensitive match for verb at start of a
  // word boundary, optionally preceded by `description:` prefix.
  const triggerVerbPattern = /\b(use|trigger|run|when|whenever|invoke)\b(\s+\w+)?/i
  const match = triggerVerbPattern.exec(snippet)
  if (match && match.index >= 0) {
    const insertAt = match.index + match[0].length
    return `${snippet.slice(0, insertAt)} ${qualifierPhrase}${snippet.slice(insertAt)}`
  }

  // No trigger verb: inject after the description-key prefix if present,
  // else prepend to the snippet body.
  const descKeyMatch = /^(\s*description\s*:\s*)(.*)$/im.exec(snippet)
  if (descKeyMatch && descKeyMatch.index >= 0) {
    const prefix = descKeyMatch[1]!
    const rest = descKeyMatch[2]!
    return snippet.replace(descKeyMatch[0], `${prefix}${qualifierPhrase}: ${rest}`)
  }

  return `${qualifierPhrase}: ${snippet}`
}

/**
 * Public registry-key accessor. Re-exports the pattern strings so the
 * apply-path registry (`edit-applier.ts`) can import a single source of
 * truth instead of stringly-typed literals.
 */
export const V1_TEMPLATE_PATTERNS: ReadonlyArray<EditTemplatePattern> = V1_TEMPLATES.map(
  (t) => t.pattern
)
