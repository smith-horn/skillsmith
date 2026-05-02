/**
 * @fileoverview Frontmatter-rewrite helpers for the rename engine
 *               (SMI-4588 Wave 2 Step 3, PR #2).
 * @module @skillsmith/mcp-server/audit/rename-engine.helpers
 *
 * **Frontmatter rewrite only.** Backup is owned by the canonical
 * `createSkillBackup` helper at `tools/install.conflict-helpers.ts`; the
 * caller (`rename-engine.ts`) invokes it BEFORE delegating frontmatter work
 * here. Plan §1 Edit 4 rule is binding — do NOT add a backup writer to this
 * file.
 *
 * The rewrite uses careful line-replacement of the `name:` field rather
 * than a full YAML re-emit. This preserves comments, block-scalar shapes,
 * and formatting nuances that a re-emit would lose. Round-trip parsing via
 * `parseYamlFrontmatter` validates the rewrite before returning.
 *
 * Plan: docs/internal/implementation/smi-4588-rename-engine-ledger-install.md §1.
 */

import { parseYamlFrontmatter } from '../tools/validate.helpers.js'

/**
 * Frontmatter rewrite errors. Discriminated by `kind` so callers can
 * handle each case without parsing strings.
 */
export type FrontmatterRewriteError =
  | { kind: 'no_frontmatter'; message: string }
  | { kind: 'no_name_field'; message: string }
  | { kind: 'multiple_name_fields'; message: string }
  | { kind: 'verification_failed'; message: string }

export type FrontmatterRewriteResult =
  | { ok: true; content: string }
  | { ok: false; error: FrontmatterRewriteError }

/**
 * Locate the closing `---` of the frontmatter block. Returns the index
 * just AFTER the closing fence, or `-1` if no valid block exists.
 *
 * Frontmatter must start at byte 0 (after optional UTF-8 BOM stripped at
 * the seam by the caller, if needed). The opening fence is `---` followed
 * by a newline; the closing fence is `\n---` followed by a newline or EOF.
 */
function findFrontmatterEnd(content: string): number {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return -1
  }
  const after = content.indexOf('\n---', 3)
  if (after === -1) return -1

  // Confirm the closing fence is at the start of a line and is followed by
  // newline or EOF. Reject `--- foo` style trailing tokens.
  const fenceStart = after + 1 // index of the second '---'
  const charAfterFence = content[fenceStart + 3]
  if (
    charAfterFence !== undefined &&
    charAfterFence !== '\n' &&
    charAfterFence !== '\r' &&
    charAfterFence !== ' '
  ) {
    return -1
  }
  // Index of the byte AFTER the closing fence + its terminator.
  return fenceStart + 3
}

/**
 * Rewrite the YAML `name:` field in a SKILL.md frontmatter block,
 * preserving comments, block-scalar/array shapes, and surrounding lines.
 *
 * Constraints:
 *
 * - The `name:` field MUST appear exactly once at the top level of the
 *   frontmatter. Multiple matches return `multiple_name_fields` (signals
 *   either a malformed file or a nested mapping the simple line-replace
 *   strategy can't safely handle).
 * - Quoted values (`name: "old"` / `name: 'old'`) are preserved with their
 *   original quote style.
 * - Inline comments (`name: old  # comment`) are preserved.
 * - Round-trip verified via `parseYamlFrontmatter` post-rewrite.
 *
 * The rewrite is careful by design — re-emitting via a YAML library would
 * destroy comments, alter block-scalar markers, and inflate the diff
 * surface for review.
 */
export function rewriteFrontmatterName(skillMd: string, newName: string): FrontmatterRewriteResult {
  const fmEnd = findFrontmatterEnd(skillMd)
  if (fmEnd === -1) {
    return {
      ok: false,
      error: {
        kind: 'no_frontmatter',
        message: 'SKILL.md does not start with a `---` frontmatter block',
      },
    }
  }

  // Slice the frontmatter body (between the two `---` fences) and the rest.
  const headerEnd = skillMd.indexOf('\n', 0) + 1 // after first `---\n`
  const closingFenceStart = skillMd.lastIndexOf('\n---', fmEnd - 4) // before closing
  const bodyStart = headerEnd
  const bodyEnd = closingFenceStart === -1 ? fmEnd - 4 : closingFenceStart
  const body = skillMd.slice(bodyStart, bodyEnd)
  const before = skillMd.slice(0, bodyStart)
  const after = skillMd.slice(bodyEnd)

  // Find the `name:` line(s) at top-level (no leading whitespace). The
  // simple line-replace strategy refuses to touch nested mappings.
  const lines = body.split('\n')
  const nameLineIndices: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^name\s*:/.test(line)) {
      nameLineIndices.push(i)
    }
  }

  if (nameLineIndices.length === 0) {
    return {
      ok: false,
      error: {
        kind: 'no_name_field',
        message: 'frontmatter has no top-level `name:` field',
      },
    }
  }
  if (nameLineIndices.length > 1) {
    return {
      ok: false,
      error: {
        kind: 'multiple_name_fields',
        message: `frontmatter has ${String(nameLineIndices.length)} top-level \`name:\` fields; refusing to rewrite ambiguously`,
      },
    }
  }

  const idx = nameLineIndices[0]
  if (idx === undefined) {
    return {
      ok: false,
      error: {
        kind: 'no_name_field',
        message: 'frontmatter has no top-level `name:` field',
      },
    }
  }
  const original = lines[idx] ?? ''

  // Preserve quote style + inline comment. Capture: leading whitespace +
  // `name:` + space, then the value, then optional `# …` comment trailer.
  const match = original.match(/^(name\s*:\s*)(.*?)(\s*(?:#.*)?)$/)
  if (!match) {
    return {
      ok: false,
      error: {
        kind: 'verification_failed',
        message: `unable to parse \`name:\` line: ${JSON.stringify(original)}`,
      },
    }
  }
  const [, head, valuePart, trailer] = match

  // Re-emit the value preserving quote style. Plain → plain, single → single,
  // double → double. New name must be safely emittable; we conservatively
  // require it to match `^[A-Za-z0-9_./-]+$` for plain emission and fall back
  // to double-quoted otherwise.
  let rewrittenValue: string
  if (valuePart === undefined || valuePart === '') {
    return {
      ok: false,
      error: {
        kind: 'verification_failed',
        message: `\`name:\` has no value: ${JSON.stringify(original)}`,
      },
    }
  } else if (valuePart.startsWith('"') && valuePart.endsWith('"')) {
    rewrittenValue = `"${escapeForDoubleQuoted(newName)}"`
  } else if (valuePart.startsWith("'") && valuePart.endsWith("'")) {
    rewrittenValue = `'${newName.replace(/'/g, "''")}'`
  } else if (/^[A-Za-z0-9_./-]+$/.test(newName)) {
    rewrittenValue = newName
  } else {
    rewrittenValue = `"${escapeForDoubleQuoted(newName)}"`
  }

  lines[idx] = `${head ?? ''}${rewrittenValue}${trailer ?? ''}`
  const newBody = lines.join('\n')
  const rewritten = `${before}${newBody}${after}`

  // Verify via round-trip parse. The local `parseYamlFrontmatter` is
  // intentionally simple and does NOT strip trailing inline comments from
  // scalar values, so a comment on the `name:` line surfaces verbatim in
  // the parsed string. Strip that here before comparing — the comment is
  // a property of the SOURCE FILE, not the value, and was preserved by the
  // line rewrite.
  const parsed = parseYamlFrontmatter(rewritten)
  if (parsed === null || typeof parsed['name'] !== 'string') {
    return {
      ok: false,
      error: {
        kind: 'verification_failed',
        message: `post-rewrite parse mismatch: expected name=${JSON.stringify(newName)}, got ${JSON.stringify(parsed?.['name'])}`,
      },
    }
  }
  const parsedName = stripInlineComment(parsed['name']).trim()
  if (parsedName !== newName) {
    return {
      ok: false,
      error: {
        kind: 'verification_failed',
        message: `post-rewrite parse mismatch: expected name=${JSON.stringify(newName)}, got ${JSON.stringify(parsedName)}`,
      },
    }
  }

  return { ok: true, content: rewritten }
}

/**
 * Strip a trailing `# comment` from a scalar value, respecting quoted
 * strings (a `#` inside `"..."` or `'...'` is content, not a comment).
 * Used only for the post-rewrite verification path — the SOURCE file's
 * comment is preserved verbatim by the line rewrite.
 */
function stripInlineComment(value: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '#' && !inSingle && !inDouble) {
      return value.slice(0, i)
    }
  }
  return value
}

/**
 * Conservative escape for double-quoted YAML scalars: backslashes and
 * double quotes are escaped; nothing else is touched. Round-trip safe for
 * the inputs the rename engine produces (sanitized identifiers).
 */
function escapeForDoubleQuoted(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
