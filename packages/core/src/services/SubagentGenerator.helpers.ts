/**
 * SMI-1788: Pure helper functions for SubagentGenerator — tool detection,
 * trigger-phrase extraction, model selection, and Claude-tool-named
 * guidance text. Split out under the 500-line standard (SMI-6276) following
 * this directory's existing `.helpers.ts` convention (see
 * SkillAnalyzer.helpers.ts / SkillDecomposer.helpers.ts).
 */

import type { ToolUsageAnalysis } from './SkillAnalyzer.js'
import { CLAUDE_MODELS, type ClaudeModel } from './SubagentGenerator.types.js'

/**
 * Tool detection patterns for analyzing skill content
 */
export const TOOL_PATTERNS: Record<string, { patterns: string[]; priority: number }> = {
  Read: {
    patterns: ['read file', 'read the', 'examine', 'view file', 'Read tool', 'check file'],
    priority: 1,
  },
  Write: {
    patterns: ['write file', 'create file', 'save to', 'output to', 'Write tool', 'generate file'],
    priority: 2,
  },
  Edit: {
    patterns: [
      'edit file',
      'modify',
      'update file',
      'patch',
      'Edit tool',
      'change file',
      'refactor',
    ],
    priority: 2,
  },
  Bash: {
    patterns: [
      'bash',
      'npm',
      'npx',
      'git',
      'docker',
      'yarn',
      'pnpm',
      'terminal',
      'shell',
      'command',
    ],
    priority: 3,
  },
  Grep: {
    patterns: ['grep', 'search for', 'find text', 'pattern match', 'Grep tool', 'search in'],
    priority: 1,
  },
  Glob: {
    patterns: ['glob', 'find file', 'file pattern', 'list files', 'Glob tool', 'locate'],
    priority: 1,
  },
  WebFetch: {
    patterns: ['fetch', 'http', 'api call', 'url', 'WebFetch', 'download', 'request'],
    priority: 2,
  },
  WebSearch: {
    patterns: ['web search', 'search online', 'lookup online', 'WebSearch', 'search the web'],
    priority: 2,
  },
}

/**
 * Minimum tools that most subagents need
 */
export const BASE_TOOLS = ['Read']

/**
 * SMI-1819: Maximum length for subagent names to prevent overly long identifiers
 */
export const MAX_SUBAGENT_NAME_LENGTH = 100

/**
 * Generate tool usage guidelines for a subagent (Claude-named tools).
 * Only used for clients whose `toolsPolicy` is `'claude-native'` — see
 * `SubagentGenerator.client-profiles.ts` and `OMITTED_TOOLS_GUIDANCE`.
 */
export function generateToolGuidelines(tools: string[]): string {
  const guidelines: string[] = []

  if (tools.includes('Read')) {
    guidelines.push('- **Read**: Use to examine files before modifications')
  }
  if (tools.includes('Write')) {
    guidelines.push('- **Write**: Use for creating new files only')
  }
  if (tools.includes('Edit')) {
    guidelines.push('- **Edit**: Use for modifying existing files')
  }
  if (tools.includes('Bash')) {
    guidelines.push('- **Bash**: Use for command execution, prefer non-destructive commands')
  }
  if (tools.includes('Grep')) {
    guidelines.push('- **Grep**: Use for searching file contents')
  }
  if (tools.includes('Glob')) {
    guidelines.push('- **Glob**: Use for finding files by pattern')
  }
  if (tools.includes('WebFetch')) {
    guidelines.push('- **WebFetch**: Use for fetching web content')
  }
  if (tools.includes('WebSearch')) {
    guidelines.push('- **WebSearch**: Use for searching the web')
  }

  return guidelines.length > 0 ? guidelines.join('\n') : '- Use tools minimally and efficiently'
}

/**
 * SMI-6276: fallback tool-usage guidance for any client whose companion
 * subagent file does not carry Claude-named tools in its `tools:`
 * frontmatter — either because the field is omitted entirely, or because it
 * was translated into that client's OWN vocabulary (`mapped-array`, e.g.
 * AntiGravity's `view_file`/`run_command`). Naming Claude-specific tool
 * identifiers in this prose body would be misleading either way, so this
 * stays generic. See `SubagentGenerator.client-profiles.ts`.
 */
export const OMITTED_TOOLS_GUIDANCE =
  '- Use the tools available on this platform minimally and efficiently'

/**
 * Generate CLAUDE.md integration snippet
 *
 * NOTE (SMI-6276): deliberately NOT client-parameterized — CLAUDE.md is
 * inherently a Claude Code artifact regardless of which client the
 * companion-agent FILE itself targets, so this always describes the
 * Claude-side delegation recommendation. Out of this wave's scope; see
 * `SubagentGenerator.client-profiles.ts`'s header for what IS in scope.
 */
export function generateClaudeMdSnippet(
  skillName: string,
  description: string,
  triggerPhrases: string[],
  tools: string[],
  model: ClaudeModel
): string {
  const triggerPatterns =
    triggerPhrases.length > 0
      ? triggerPhrases.map((p) => `- "${p}"`).join('\n')
      : '- [add trigger patterns]'

  const exampleTask = triggerPhrases.length > 0 ? triggerPhrases[0] : `execute ${skillName} task`

  return `
### Subagent Delegation: ${skillName}

When tasks match ${skillName} triggers, delegate to the ${skillName}-specialist
subagent instead of executing directly. This provides context isolation and
~37-97% token savings.

**Trigger Patterns:**
${triggerPatterns}

**Delegation Example:**
\`\`\`
Task("${skillName}-specialist", "${exampleTask}", "${skillName}-specialist")
\`\`\`

**Model:** ${model}
**Tools:** ${tools.join(', ')}
`
}

/**
 * Extract trigger phrases from skill description and content
 */
export function extractTriggerPhrases(description: string, content: string): string[] {
  const phrases: string[] = []

  // Common trigger phrase patterns
  const patterns = [
    /when\s+(?:you\s+)?(?:need\s+to\s+)?(.+?)(?:[.,]|$)/gi,
    /use\s+(?:this\s+)?(?:when|for)\s+(.+?)(?:[.,]|$)/gi,
    /(?:helps?\s+(?:you\s+)?(?:to\s+)?)?(.+?)(?:\s+tasks?|\s+operations?)/gi,
  ]

  const textToSearch = description + ' ' + content.slice(0, 2000) // Search first 2000 chars

  for (const pattern of patterns) {
    for (const match of textToSearch.matchAll(pattern)) {
      const phrase = match[1].trim().toLowerCase()
      if (phrase.length >= 5 && phrase.length <= 50 && !phrases.includes(phrase)) {
        phrases.push(phrase)
      }
    }
  }

  // Extract from "trigger" or "invoke" mentions
  const triggerMatch = content.match(/trigger[s]?\s*[:=]\s*["`']([^"`']+)["`']/gi)
  if (triggerMatch) {
    for (const match of triggerMatch) {
      const phrase = match.replace(/trigger[s]?\s*[:=]\s*["`']/i, '').replace(/["`']$/, '')
      if (!phrases.includes(phrase.toLowerCase())) {
        phrases.push(phrase.toLowerCase())
      }
    }
  }

  return phrases.slice(0, 5) // Limit to 5 phrases
}

/**
 * Determine optimal model for subagent
 * SMI-1795: Uses CLAUDE_MODELS constants for type safety
 */
export function determineModel(toolUsage: ToolUsageAnalysis, lineCount: number): ClaudeModel {
  // Haiku for simple, fast operations
  if (toolUsage.detectedTools.length <= 2 && lineCount < 200) {
    return CLAUDE_MODELS.HAIKU
  }

  // Opus for complex, reasoning-heavy tasks
  if (
    toolUsage.bashCommandCount > 5 ||
    (toolUsage.fileReadCount > 3 && toolUsage.fileWriteCount > 3)
  ) {
    return CLAUDE_MODELS.OPUS
  }

  // Sonnet for balanced workloads (default)
  return CLAUDE_MODELS.SONNET
}

/**
 * Detect tools needed from skill content
 */
export function detectTools(content: string): string[] {
  const lowerContent = content.toLowerCase()
  const detectedTools = new Set<string>(BASE_TOOLS)

  for (const [tool, config] of Object.entries(TOOL_PATTERNS)) {
    for (const pattern of config.patterns) {
      if (lowerContent.includes(pattern.toLowerCase())) {
        detectedTools.add(tool)
        break
      }
    }
  }

  return Array.from(detectedTools)
}
