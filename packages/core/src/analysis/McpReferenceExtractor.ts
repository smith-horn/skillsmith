/**
 * @fileoverview Extracts MCP tool references from SKILL.md content
 * @module @skillsmith/core/analysis/McpReferenceExtractor
 * @see SMI-3145: Build McpReferenceExtractor
 * @see SMI-5676: Wave 1 Step 3b — harden extraction (26-file validation found a
 *   71% false-negative rate against real SKILL.md files)
 *
 * Scans skill content for three kinds of MCP dependency signal:
 *  1. Inline `mcp__<server>__<tool>` references in prose/code (original
 *     SMI-3145 behavior), tracking fenced-code-block state for confidence.
 *  2. Frontmatter `allowed-tools`/`tools` YAML fields, including the
 *     bare-server (`mcp__linear`) and wildcard (`mcp__linear__*`) forms.
 *  3. Embedded `mcpServers` JSON registration blocks (e.g. a fenced code
 *     block showing how to add the skill's server to `.mcp.json`).
 *
 * All three feed the same `references`/`servers`/`highConfidenceServers`
 * output — hardening changes what gets *extracted*, not how extracted
 * results get scored (see `DependencyMerger.ts`, unchanged).
 *
 * A fourth signal, `registeredServers`, lets a caller cross-check every
 * candidate server name against the consuming project's own `.mcp.json`.
 * This is advisory tagging only (`serverResolutions`) — a name is NEVER
 * excluded from `references`/`servers` just because it doesn't resolve,
 * since a real (but not-yet-installed) dependency looks identical to a
 * stale/renamed one from here. See `serverResolutions` doc below.
 */

import { LineCounter, isScalar, isSeq, parseDocument } from 'yaml'

/** A single MCP tool reference found in content */
export interface McpReference {
  /** MCP server name, e.g. "linear" */
  server: string
  /**
   * MCP tool name, e.g. "save_issue". `'*'` marks a server-level reference
   * with no specific tool named — the bare-server frontmatter form
   * (`mcp__linear`), the wildcard frontmatter form (`mcp__linear__*`), or an
   * `mcpServers` JSON registration entry (which names a server, not a tool).
   */
  tool: string
  /** 1-indexed line number where the reference appears */
  line: number
  /** true if the reference is inside a fenced code block */
  inCodeBlock: boolean
}

/**
 * Resolution of a candidate server name against the consuming project's
 * `.mcp.json` (SMI-5676's `registeredServers` cross-check).
 * - `registered`: found in the `registeredServers` list passed in
 * - `unregistered`: `registeredServers` was provided but didn't contain this
 *   name (e.g. the `claude-flow` -> `ruflo` rename: bundled skill docs still
 *   say `mcp__claude-flow__*`, but this project's `.mcp.json` only registers
 *   `ruflo`)
 * - `unknown`: no `registeredServers` list was available to cross-check
 *   (caller passed nothing — e.g. `.mcp.json` missing/unparseable; fail open)
 */
export type McpServerResolution = 'registered' | 'unregistered' | 'unknown'

/** Aggregated extraction result */
export interface McpExtractionResult {
  /** All individual references found */
  references: McpReference[]
  /** Unique server names across all references */
  servers: string[]
  /** Servers referenced at least once outside a code block */
  highConfidenceServers: string[]
  /** true if input exceeded the 100KB cap and was truncated */
  truncated?: boolean
  /**
   * Resolution state for every name in `servers`, keyed by server name. See
   * {@link McpServerResolution}. Optional only for backward compatibility
   * with hand-constructed `McpExtractionResult` fixtures predating SMI-5676
   * (e.g. `DependencyMerger.test.ts`'s helpers) — {@link extractMcpReferences}
   * itself always populates this (with `'unknown'` entries when
   * `registeredServers` wasn't passed), so a real caller can always rely on
   * it being present.
   */
  serverResolutions?: Record<string, McpServerResolution>
}

/** Maximum input size in bytes before truncation */
const MAX_INPUT_BYTES = 100 * 1024

/**
 * Pattern matching `mcp__<server>__<tool>` identifiers.
 * Server: lowercase letter followed by lowercase alphanumeric or hyphens.
 * Tool: lowercase letter followed by lowercase alphanumeric or underscores.
 */
const MCP_PATTERN = /mcp__([a-z][a-z0-9-]*)__([a-z][a-z0-9_]*)/g

/** Matches the opening or closing of a fenced code block */
const FENCE_PATTERN = /^(`{3,}|~{3,})/

/** Matches a bare `---` frontmatter delimiter line */
const FRONTMATTER_DELIMITER = /^---\s*$/

/** Frontmatter fields scanned for `mcp__*` tool references (SMI-5676) */
const TOOL_LIST_FIELDS = ['allowed-tools', 'tools'] as const

/**
 * Matches a single `mcp__` token from a frontmatter tools list. Supports:
 *  - bare server: `mcp__linear` (capture 2 undefined)
 *  - wildcard: `mcp__linear__*` (capture 2 === '*')
 *  - full: `mcp__linear__save_issue` (capture 2 is the tool name)
 */
const FRONTMATTER_MCP_TOKEN = /^mcp__([a-z][a-z0-9-]*)(?:__([a-z][a-z0-9_]*|\*))?$/

/** Plausible JSON object key for an MCP server name in an `mcpServers` block */
const JSON_SERVER_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/

/**
 * Cap on `"mcpServers"` marker occurrences processed per document. Real
 * skills have at most 1-2 legitimate registration blocks; without a cap,
 * adversarial content with many unclosed `"mcpServers": {` occurrences would
 * each trigger an O(remaining-document-length) brace scan in
 * {@link findMatchingBrace} — O(n^2) worst case even though the 100KB input
 * cap already bounds n (SMI-5676 review finding).
 */
const MAX_MCP_SERVERS_MARKERS = 20

/**
 * Extract all MCP tool references from skill content.
 *
 * Scans each line for `mcp__server__tool` patterns, tracking fenced
 * code block state to distinguish high-confidence (prose) references
 * from low-confidence (code example) references. Also parses frontmatter
 * `allowed-tools`/`tools` fields and embedded `mcpServers` JSON blocks
 * (SMI-5676).
 *
 * @param content - Raw SKILL.md content (markdown)
 * @param registeredServers - Optional list of MCP server names actually
 *   registered in the consuming project's `.mcp.json`. When provided
 *   (even as `[]`), every candidate server name is tagged `registered` or
 *   `unregistered` in the result's `serverResolutions` map — never filtered
 *   out. Omit (or pass `undefined`) when the caller couldn't determine this
 *   (e.g. `.mcp.json` missing/unparseable); every name is then tagged
 *   `unknown` rather than assumed unregistered.
 * @returns Extraction result with references, servers, and confidence info
 */
export function extractMcpReferences(
  content: string,
  registeredServers?: string[]
): McpExtractionResult {
  let truncated: boolean | undefined

  // Cap input at 100KB
  if (new TextEncoder().encode(content).byteLength > MAX_INPUT_BYTES) {
    content = content.slice(0, MAX_INPUT_BYTES)
    truncated = true
  }

  const lines = content.split('\n')
  const references: McpReference[] = []
  const serverSet = new Set<string>()
  const highConfidenceSet = new Set<string>()
  /** Per-line fenced-code-block state, reused by the mcpServers JSON pass below */
  const lineInCodeBlock: boolean[] = []

  // SMI-5676 review fix: the frontmatter block (open delimiter, YAML body,
  // close delimiter) is excluded from the base inline-regex scan below, so a
  // full-form frontmatter entry like `- mcp__linear__save_issue` is only
  // ever counted once (by extractFrontmatterMcpRefs), not twice.
  const frontmatterBlock = extractFrontmatterBlock(lines)
  const frontmatterEndLine = frontmatterBlock ? frontmatterBlock.endLine : 0

  let inCodeBlock = false
  let fenceChar: string | null = null
  let fenceLength = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNumber = i + 1
    const inFrontmatter = lineNumber <= frontmatterEndLine

    // Check for fence toggle
    const fenceMatch = FENCE_PATTERN.exec(line)
    if (fenceMatch) {
      const matchChar = fenceMatch[1][0]
      const matchLength = fenceMatch[1].length

      if (!inCodeBlock) {
        inCodeBlock = true
        fenceChar = matchChar
        fenceLength = matchLength
      } else if (matchChar === fenceChar && matchLength >= fenceLength) {
        // Closing fence must use same character and be at least as long
        inCodeBlock = false
        fenceChar = null
        fenceLength = 0
      }
    }

    // Find all MCP references on this line (skip the frontmatter block —
    // handled separately below, so full-form entries aren't double-counted)
    if (!inFrontmatter) {
      let match: RegExpExecArray | null
      // Reset lastIndex for each line since we reuse the global regex
      MCP_PATTERN.lastIndex = 0
      while ((match = MCP_PATTERN.exec(line)) !== null) {
        const server = match[1]
        const tool = match[2]

        references.push({
          server,
          tool,
          line: lineNumber,
          inCodeBlock,
        })

        serverSet.add(server)
        if (!inCodeBlock) {
          highConfidenceSet.add(server)
        }
      }
    }

    lineInCodeBlock.push(inCodeBlock)
  }

  // SMI-5676: frontmatter allowed-tools/tools YAML fields (bare-server +
  // wildcard forms). Always high-confidence — an explicit declaration, not a
  // prose/code example.
  for (const ref of extractFrontmatterMcpRefs(frontmatterBlock)) {
    references.push({ server: ref.server, tool: ref.tool, line: ref.line, inCodeBlock: false })
    serverSet.add(ref.server)
    highConfidenceSet.add(ref.server)
  }

  // SMI-5676: embedded mcpServers JSON registration blocks. Confidence
  // follows the same fenced-code-block state as inline references, since
  // these blocks are themselves almost always fenced JSON examples.
  for (const ref of extractMcpServersJsonRefs(content)) {
    const refInCodeBlock = lineInCodeBlock[ref.line - 1] ?? false
    references.push({ server: ref.server, tool: '*', line: ref.line, inCodeBlock: refInCodeBlock })
    serverSet.add(ref.server)
    if (!refInCodeBlock) {
      highConfidenceSet.add(ref.server)
    }
  }

  // Keep a stable, file-order-ish `references` array across the three
  // detection passes above (each pass is internally in-order already;
  // Array#sort is stable in Node, so same-line entries keep their order).
  references.sort((a, b) => a.line - b.line)

  // SMI-5676: cross-check every candidate against the consuming project's
  // .mcp.json — tag, never exclude (see McpServerResolution doc).
  const serverResolutions: Record<string, McpServerResolution> = {}
  for (const server of serverSet) {
    serverResolutions[server] =
      registeredServers === undefined
        ? 'unknown'
        : registeredServers.includes(server)
          ? 'registered'
          : 'unregistered'
  }

  const result: McpExtractionResult = {
    references,
    servers: [...serverSet].sort(),
    highConfidenceServers: [...highConfidenceSet].sort(),
    serverResolutions,
  }

  if (truncated) {
    result.truncated = true
  }

  return result
}

/** The frontmatter block's location within a SKILL.md file's lines */
interface FrontmatterBlock {
  /** The YAML content lines, between (not including) the `---` delimiters */
  yamlLines: string[]
  /** Absolute 1-indexed line number of the first YAML content line */
  startLine: number
  /**
   * Absolute 1-indexed line number of the CLOSING `---` delimiter — i.e. the
   * last line of the whole frontmatter block (open delimiter + YAML body +
   * close delimiter all fall on or before this line).
   */
  endLine: number
}

/**
 * Locate the frontmatter block (between the first two `---` delimiter
 * lines) and return its YAML lines, the absolute file line number of the
 * first YAML content line, and the absolute line number of the closing
 * delimiter (used by callers to exclude the whole block from other line
 * scans). Returns null if there's no well-formed frontmatter (no delimiters
 * at all, or an unterminated block) — fails open.
 */
function extractFrontmatterBlock(lines: string[]): FrontmatterBlock | null {
  if (lines.length === 0 || !FRONTMATTER_DELIMITER.test(lines[0])) return null

  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_DELIMITER.test(lines[i])) {
      return { yamlLines: lines.slice(1, i), startLine: 2, endLine: i + 1 }
    }
  }

  return null
}

/**
 * Parse the frontmatter's `allowed-tools`/`tools` fields (structurally, via
 * the `yaml` package — already a `@skillsmith/core` dependency, used the
 * same way in `agent-config-merge.yaml.ts`) and pull out any `mcp__*`
 * tokens, in whichever YAML shape the author used: block list (`- item`),
 * flow list (`[item, item]`), or a single bare scalar. Fails open (returns
 * `[]`) on missing frontmatter, missing fields, or a YAML parse error.
 *
 * @param block - The already-located frontmatter block (or null if the
 *   content has none), from {@link extractFrontmatterBlock} — computed once
 *   by the caller and shared with the base inline-regex scan's exclusion
 *   range, rather than re-derived here.
 */
function extractFrontmatterMcpRefs(
  block: FrontmatterBlock | null
): Array<{ server: string; tool: string; line: number }> {
  if (!block || block.yamlLines.length === 0) return []

  const yamlSource = block.yamlLines.join('\n')
  const lineCounter = new LineCounter()

  let doc: ReturnType<typeof parseDocument>
  try {
    doc = parseDocument(yamlSource, { lineCounter })
  } catch {
    return []
  }
  if (doc.errors.length > 0) return []

  const refs: Array<{ server: string; tool: string; line: number }> = []

  for (const field of TOOL_LIST_FIELDS) {
    let node: unknown
    try {
      node = doc.get(field, true)
    } catch {
      continue
    }
    if (node === undefined || node === null) continue

    const scalarNodes = isSeq(node) ? node.items : isScalar(node) ? [node] : []

    for (const item of scalarNodes) {
      if (!isScalar(item) || typeof item.value !== 'string') continue

      const tokenMatch = FRONTMATTER_MCP_TOKEN.exec(item.value.trim())
      if (!tokenMatch) continue

      const server = tokenMatch[1]
      const tool = tokenMatch[2] && tokenMatch[2] !== '*' ? tokenMatch[2] : '*'
      const range = item.range
      const relativeLine = range ? lineCounter.linePos(range[0]).line : 1

      refs.push({ server, tool, line: block.startLine + relativeLine - 1 })
    }
  }

  return refs
}

/**
 * Find the index of the `}` that closes the `{` at `openIdx`, respecting
 * JSON string literals (so braces inside string values don't miscount).
 * Returns -1 if unterminated.
 */
function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 0
  let inString = false
  let escapeNext = false

  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]

    if (escapeNext) {
      escapeNext = false
      continue
    }
    if (inString) {
      if (ch === '\\') escapeNext = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }

  return -1
}

/**
 * Detect `"mcpServers": { ... }` JSON registration blocks embedded anywhere
 * in the content (typically inside a fenced code example showing how to add
 * the skill's server to `.mcp.json`/`settings.json`). Each top-level key of
 * the object is a candidate server name. Fails open (skips) on invalid JSON
 * rather than throwing.
 */
function extractMcpServersJsonRefs(content: string): Array<{ server: string; line: number }> {
  const refs: Array<{ server: string; line: number }> = []
  const marker = '"mcpServers"'
  let fromIdx = 0
  let markersProcessed = 0

  while (markersProcessed < MAX_MCP_SERVERS_MARKERS) {
    const markerIdx = content.indexOf(marker, fromIdx)
    if (markerIdx === -1) break
    fromIdx = markerIdx + marker.length
    markersProcessed++

    let i = markerIdx + marker.length
    while (i < content.length && /\s/.test(content[i])) i++
    if (content[i] !== ':') continue
    i++
    while (i < content.length && /\s/.test(content[i])) i++
    if (content[i] !== '{') continue

    const closeIdx = findMatchingBrace(content, i)
    if (closeIdx === -1) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(content.slice(i, closeIdx + 1))
    } catch {
      continue
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const lineNumber = content.slice(0, markerIdx).split('\n').length
      for (const server of Object.keys(parsed as Record<string, unknown>)) {
        if (JSON_SERVER_NAME.test(server)) {
          refs.push({ server, line: lineNumber })
        }
      }
    }
  }

  return refs
}
