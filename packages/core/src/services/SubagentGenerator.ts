/**
 * SMI-1788: SubagentGenerator - Generate companion subagent definitions
 *
 * Creates subagent definitions for skills that benefit from parallel
 * execution with context isolation. Subagents enable:
 * - 37-97% token savings through context isolation
 * - Parallel execution of heavy operations
 * - Specialized tool access per agent
 *
 * Part of the Skillsmith Optimization Layer for transforming
 * community skills into more performant versions.
 */

import type { SkillAnalysis, ToolUsageAnalysis } from './SkillAnalyzer.js'

/**
 * SMI-1795: Claude model constants for type safety and consistency
 */
export const CLAUDE_MODELS = {
  HAIKU: 'haiku',
  SONNET: 'sonnet',
  OPUS: 'opus',
} as const

export type ClaudeModel = (typeof CLAUDE_MODELS)[keyof typeof CLAUDE_MODELS]

/**
 * Generated subagent definition
 */
export interface SubagentDefinition {
  /** Subagent name (e.g., "jest-helper-specialist") */
  name: string

  /** Description for the Task tool */
  description: string

  /** Trigger phrases that should invoke this subagent */
  triggerPhrases: string[]

  /** Tools the subagent needs access to */
  tools: string[]

  /** Recommended model */
  model: ClaudeModel

  /** The full markdown content for ~/.claude/agents/ */
  content: string
}

/**
 * Result of subagent generation
 */
export interface SubagentGenerationResult {
  /** Whether a subagent was generated */
  generated: boolean

  /** The subagent definition (if generated) */
  subagent?: SubagentDefinition

  /** Reason if not generated */
  reason?: string

  /** CLAUDE.md integration snippet */
  claudeMdSnippet?: string
}

/**
 * Tool detection patterns for analyzing skill content
 */
const TOOL_PATTERNS: Record<string, { patterns: string[]; priority: number }> = {
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
const BASE_TOOLS = ['Read']

/**
 * Generate tool usage guidelines for a subagent
 */
function generateToolGuidelines(tools: string[]): string {
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
 * Generate subagent markdown content
 */
function generateSubagentContent(
  name: string,
  description: string,
  triggerPhrases: string[],
  tools: string[],
  model: ClaudeModel
): string {
  const triggerString =
    triggerPhrases.length > 0
      ? triggerPhrases.map((p) => `"${p}"`).join(', ')
      : '[describe trigger conditions]'

  const toolGuidelines = generateToolGuidelines(tools)

  return `---
name: ${name}
description: ${description} Use when ${triggerString}.
skills: ${name.replace('-specialist', '')}
tools: ${tools.join(', ')}
model: ${model}
---

## Operating Protocol

1. Execute the ${name.replace('-specialist', '')} skill for the delegated task
2. Process all intermediate results internally
3. Return ONLY a structured summary to the orchestrator

## Output Format

- **Task:** [what was requested]
- **Actions:** [what you did]
- **Results:** [key outcomes, max 3-5 bullet points]
- **Artifacts:** [file paths or outputs created]

Keep response under 500 tokens unless explicitly requested otherwise.

## Tool Usage Guidelines

${toolGuidelines}

## Error Handling

If the task cannot be completed:
- Report specific blocking issue
- Suggest alternative approaches
- Do not retry indefinitely

---

*Generated by Skillsmith Optimization Layer*
`
}

/**
 * Generate CLAUDE.md integration snippet
 */
function generateClaudeMdSnippet(
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
function extractTriggerPhrases(description: string, content: string): string[] {
  const phrases: string[] = []

  // Common trigger phrase patterns
  const patterns = [
    /when\s+(?:you\s+)?(?:need\s+to\s+)?(.+?)(?:[.,]|$)/gi,
    /use\s+(?:this\s+)?(?:when|for)\s+(.+?)(?:[.,]|$)/gi,
    /(?:helps?\s+(?:you\s+)?(?:to\s+)?)?(.+?)(?:\s+tasks?|\s+operations?)/gi,
  ]

  const textToSearch = description + ' ' + content.slice(0, 2000) // Search first 2000 chars

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(textToSearch)) !== null) {
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
function determineModel(toolUsage: ToolUsageAnalysis, lineCount: number): ClaudeModel {
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
function detectTools(content: string): string[] {
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

/**
 * Generate a companion subagent for a skill
 *
 * @param skillName - The name of the skill
 * @param description - The skill's description
 * @param content - The full SKILL.md content
 * @param analysis - Analysis from SkillAnalyzer
 * @returns Subagent generation result
 */
export function generateSubagent(
  skillName: string,
  description: string,
  content: string,
  analysis: SkillAnalysis
): SubagentGenerationResult {
  // Check if subagent is recommended
  if (!analysis.toolUsage.suggestsSubagent && analysis.lineCount < 300) {
    return {
      generated: false,
      reason:
        'Skill does not have heavy tool usage or complexity that would benefit from a subagent',
    }
  }

  // Detect tools from content (supplement analysis)
  const detectedTools = detectTools(content)
  const allTools = Array.from(new Set([...analysis.toolUsage.detectedTools, ...detectedTools]))

  // Extract trigger phrases
  const triggerPhrases = extractTriggerPhrases(description, content)

  // Determine model
  const model = determineModel(analysis.toolUsage, analysis.lineCount)

  // Generate subagent name
  const subagentName = `${skillName}-specialist`

  // Generate subagent description
  const subagentDescription = description || `Specialist agent for ${skillName} operations`

  // Generate content
  const subagentContent = generateSubagentContent(
    subagentName,
    subagentDescription,
    triggerPhrases,
    allTools,
    model
  )

  // Generate CLAUDE.md snippet
  const claudeMdSnippet = generateClaudeMdSnippet(
    skillName,
    subagentDescription,
    triggerPhrases,
    allTools,
    model
  )

  return {
    generated: true,
    subagent: {
      name: subagentName,
      description: subagentDescription,
      triggerPhrases,
      tools: allTools,
      model,
      content: subagentContent,
    },
    claudeMdSnippet,
  }
}

/**
 * Generate a minimal subagent for skills that don't need full analysis
 *
 * @param skillName - The name of the skill
 * @param description - The skill's description
 * @param content - The full SKILL.md content
 * @returns Subagent generation result
 */
export function generateMinimalSubagent(
  skillName: string,
  description: string,
  content: string
): SubagentGenerationResult {
  const detectedTools = detectTools(content)
  const triggerPhrases = extractTriggerPhrases(description, content)

  // Default to sonnet for minimal subagents
  const model: ClaudeModel = CLAUDE_MODELS.SONNET
  const subagentName = `${skillName}-specialist`
  const subagentDescription = description || `Specialist agent for ${skillName} operations`

  const subagentContent = generateSubagentContent(
    subagentName,
    subagentDescription,
    triggerPhrases,
    detectedTools,
    model
  )

  const claudeMdSnippet = generateClaudeMdSnippet(
    skillName,
    subagentDescription,
    triggerPhrases,
    detectedTools,
    model
  )

  return {
    generated: true,
    subagent: {
      name: subagentName,
      description: subagentDescription,
      triggerPhrases,
      tools: detectedTools,
      model,
      content: subagentContent,
    },
    claudeMdSnippet,
  }
}

export default { generateSubagent, generateMinimalSubagent }
