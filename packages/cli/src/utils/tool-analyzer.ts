/**
 * SMI-1389: Tool Detection for Subagent Generation
 *
 * Analyzes SKILL.md content to determine minimal required tools
 * for subagent execution, enabling context isolation and token savings.
 */

export interface ToolAnalysis {
  requiredTools: string[]
  recommendedTools: string[]
  detectedPatterns: string[]
  confidence: 'high' | 'medium' | 'low'
}

interface ToolPattern {
  always?: boolean
  patterns: string[]
}

/**
 * Tool detection patterns
 * Each tool has patterns that indicate its requirement
 */
export const TOOL_PATTERNS: Record<string, ToolPattern> = {
  Read: { always: true, patterns: [] },
  Write: {
    patterns: [
      'write',
      'create file',
      'save',
      'output to file',
      'generate file',
      'write to',
      'create new file',
    ],
  },
  Edit: {
    patterns: [
      'edit',
      'modify',
      'update file',
      'patch',
      'change file',
      'replace in file',
      'refactor',
    ],
  },
  Bash: {
    patterns: [
      'bash',
      'npm',
      'npx',
      'run command',
      'execute',
      'terminal',
      'shell',
      'command line',
      'cli',
      'git ',
      'docker',
      'yarn',
      'pnpm',
    ],
  },
  Grep: {
    patterns: [
      'search',
      'find text',
      'grep',
      'pattern match',
      'search for',
      'look for',
      'find in files',
    ],
  },
  Glob: {
    patterns: ['find file', 'glob', 'file pattern', 'locate file', 'list files', 'find files'],
  },
  WebFetch: {
    patterns: [
      'fetch',
      'http',
      'api call',
      'url',
      'web request',
      'download',
      'get from url',
      'request',
    ],
  },
  WebSearch: {
    patterns: ['web search', 'search online', 'google', 'lookup online', 'search the web'],
  },
}

/**
 * Analyze skill content to determine required tools
 *
 * @param skillContent - The full SKILL.md content
 * @returns Analysis of required and recommended tools
 */
export function analyzeToolRequirements(skillContent: string): ToolAnalysis {
  const content = skillContent.toLowerCase()
  const tools = new Set<string>()
  const patterns: string[] = []

  for (const [tool, config] of Object.entries(TOOL_PATTERNS)) {
    // Always include tools marked as 'always'
    if (config.always) {
      tools.add(tool)
      continue
    }

    // Check each pattern for the tool
    for (const pattern of config.patterns) {
      if (content.includes(pattern)) {
        tools.add(tool)
        patterns.push(`${tool}: matched "${pattern}"`)
        break // Only need one match per tool
      }
    }
  }

  // Determine confidence based on pattern matches
  const matchCount = patterns.length
  const confidence: 'high' | 'medium' | 'low' =
    matchCount >= 3 ? 'high' : matchCount >= 1 ? 'medium' : 'low'

  const toolList = Array.from(tools)

  return {
    requiredTools: toolList,
    recommendedTools: toolList,
    detectedPatterns: patterns,
    confidence,
  }
}

/**
 * Format tool list for YAML output
 *
 * @param tools - Array of tool names
 * @returns Formatted string for YAML tools field
 */
export function formatToolList(tools: string[]): string {
  if (tools.length === 0) {
    return 'Read'
  }
  return tools.join(', ')
}

/**
 * Parse comma-separated tools string into array
 *
 * @param toolsString - Comma-separated tools (e.g., "Read, Write, Bash")
 * @returns Array of tool names
 */
export function parseToolsString(toolsString: string): string[] {
  return toolsString
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/**
 * Validate that all tools in the list are recognized
 *
 * @param tools - Array of tool names to validate
 * @returns Object with valid boolean and any unrecognized tools
 */
export function validateTools(tools: string[]): { valid: boolean; unrecognized: string[] } {
  const validTools = new Set(Object.keys(TOOL_PATTERNS))
  const unrecognized = tools.filter((t) => !validTools.has(t))

  return {
    valid: unrecognized.length === 0,
    unrecognized,
  }
}
