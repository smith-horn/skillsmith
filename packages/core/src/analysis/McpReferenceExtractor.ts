/**
 * @fileoverview Extracts MCP tool references from SKILL.md content
 * @module @skillsmith/core/analysis/McpReferenceExtractor
 * @see SMI-3145: Build McpReferenceExtractor
 *
 * Scans skill content for `mcp__<server>__<tool>` patterns,
 * tracking whether each reference appears inside a fenced code block.
 */

/** A single MCP tool reference found in content */
export interface McpReference {
  /** MCP server name, e.g. "linear" */
  server: string
  /** MCP tool name, e.g. "save_issue" */
  tool: string
  /** 1-indexed line number where the reference appears */
  line: number
  /** true if the reference is inside a fenced code block */
  inCodeBlock: boolean
}

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

/**
 * Extract all MCP tool references from skill content.
 *
 * Scans each line for `mcp__server__tool` patterns, tracking fenced
 * code block state to distinguish high-confidence (prose) references
 * from low-confidence (code example) references.
 *
 * @param content - Raw SKILL.md content (markdown)
 * @returns Extraction result with references, servers, and confidence info
 */
export function extractMcpReferences(content: string): McpExtractionResult {
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

  let inCodeBlock = false
  let fenceChar: string | null = null
  let fenceLength = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNumber = i + 1

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

    // Find all MCP references on this line
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

  const result: McpExtractionResult = {
    references,
    servers: [...serverSet].sort(),
    highConfidenceServers: [...highConfidenceSet].sort(),
  }

  if (truncated) {
    result.truncated = true
  }

  return result
}
