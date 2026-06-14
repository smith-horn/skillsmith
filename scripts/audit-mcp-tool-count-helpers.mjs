/**
 * Helper for audit:standards Check 25 (MCP Tool Count parity, SMI-3886 / SMI-5216).
 *
 * Counts the tools in `packages/mcp-server/src/index.ts`'s `toolDefinitions`
 * array, resolving spread builders (`...builder()`) to the number of `*ToolSchema`
 * identifiers they can contribute.
 *
 * IMPORTANT — counts the MAXIMUM tool set: every tool a spread builder CAN
 * contribute, conditional `.push()` included. The runtime may register fewer
 * (e.g. `apply_recommended_edit` is gated on `APPLY_TEMPLATE_REGISTRY.size`);
 * runtime-registration correctness is covered by the ListTools-registry test in
 * `packages/mcp-server`, NOT by this counter. The invariant this enables is:
 * "the README documents every tool that CAN register." (SMI-5216)
 *
 * Pure / side-effect-free: no I/O of its own (the caller injects
 * `resolveModuleSource`) so it can be unit-tested without running the full audit
 * (audit-standards.mjs executes every check on import).
 */

/** A tool schema is any identifier matching `<word>ToolSchema`. */
const SCHEMA_IDENTIFIER = /\b\w+ToolSchema\b/g

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Find the import specifier (module path) that `name` is imported from in `source`.
 * Handles single- and multi-line `import { … } from '<spec>'` (incl. `import type`).
 * @returns {string | null} the specifier (e.g. './audit-tool-dispatch.js') or null.
 */
export function findImportSpecifier(name, source) {
  const importRe = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g
  const nameRe = new RegExp(`(^|[\\s,{])${escapeRegExp(name)}(\\s|,|}|$)`)
  let m
  while ((m = importRe.exec(source)) !== null) {
    if (nameRe.test(m[1])) return m[2]
  }
  return null
}

/**
 * Extract a builder's block body by walking balanced braces from the body-opening
 * `{` (the first `{` encountered at paren-depth 0 after the declaration anchor, so
 * parameter-destructuring braces are skipped). Supports `function NAME(...)` and
 * `const|let|var NAME = (...) =>` / `= function (...)` forms.
 * @returns {string | null} the body text, or null if the declaration/body isn't
 *   found or the braces can't balance (caller treats null as count-as-1 + warn).
 */
export function extractBuilderBody(name, source) {
  const anchor = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegExp(name)}\\b|` +
      `(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=`
  )
  const am = anchor.exec(source)
  if (!am) return null

  // Find the body-opening brace at paren-depth 0 (skip param-list / destructuring braces).
  let parenDepth = 0
  let braceStart = -1
  for (let i = am.index + am[0].length; i < source.length; i++) {
    const ch = source[i]
    if (ch === '(') parenDepth++
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)
    else if (ch === '{' && parenDepth === 0) {
      braceStart = i
      break
    }
  }
  if (braceStart === -1) return null

  // Walk balanced braces to the matching close.
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(braceStart + 1, i)
    }
  }
  return null // unbalanced
}

/**
 * Resolve a spread builder to the count of distinct `*ToolSchema` identifiers in
 * its body (the max set). Returns null on ANY failure — import specifier not found,
 * `resolveModuleSource` returns null/throws, body can't be isolated, or 0 schemas
 * found — so the caller can count-as-1 and warn rather than silently undercount.
 */
function resolveBuilderToolCount(builderName, indexContent, resolveModuleSource) {
  const spec = findImportSpecifier(builderName, indexContent)
  if (!spec) return null

  let moduleSource
  try {
    moduleSource = resolveModuleSource(spec)
  } catch {
    return null
  }
  if (!moduleSource) return null

  const body = extractBuilderBody(builderName, moduleSource)
  if (body === null) return null

  const matches = body.match(SCHEMA_IDENTIFIER)
  if (!matches || matches.length === 0) return null
  return new Set(matches).size
}

/**
 * Count the maximum tools registered via `toolDefinitions` in `indexContent`.
 *
 * @param {object} opts
 * @param {string} opts.indexContent - source text of mcp-server/src/index.ts.
 * @param {(spec: string) => string | null} opts.resolveModuleSource - maps an import
 *   specifier (e.g. './audit-tool-dispatch.js') to that module's source text, or null.
 * @returns {{ count: number, unresolvedSpreads: string[] }} - `count` is the static
 *   maximum tool count; `unresolvedSpreads` lists builder names that could not be
 *   resolved (each counted as 1) so the caller can emit a warn.
 */
export function countToolDefinitions({ indexContent, resolveModuleSource }) {
  const unresolvedSpreads = []
  const defMatch = indexContent.match(/const toolDefinitions\s*=\s*\[([\s\S]*?)\]/)
  if (!defMatch) return { count: 0, unresolvedSpreads }

  let count = 0
  for (const rawLine of defMatch[1].split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('//')) continue

    const spread = line.match(/^\.\.\.\s*([A-Za-z0-9_$]+)\s*\(/)
    if (!spread) {
      // A plain entry (identifier or inline object) — counts as one tool
      // regardless of whether it matches *ToolSchema (e.g. installTool/uninstallTool).
      count += 1
      continue
    }

    const builderName = spread[1]
    const resolved = resolveBuilderToolCount(builderName, indexContent, resolveModuleSource)
    if (resolved === null) {
      unresolvedSpreads.push(builderName)
      count += 1
    } else {
      count += resolved
    }
  }

  return { count, unresolvedSpreads }
}
