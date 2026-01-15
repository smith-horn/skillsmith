/**
 * SMI-1389: Subagent Definition Template
 *
 * Templates for generating companion specialist agents that enable
 * parallel skill execution with 37-97% token savings.
 */

export interface SubagentTemplateData {
  skillName: string
  description: string
  triggerPhrases: string[]
  tools: string[]
  model: 'sonnet' | 'opus' | 'haiku'
}

/**
 * Main subagent definition template
 * Generates ~/.claude/agents/[skill-name]-specialist.md
 */
export const SUBAGENT_MD_TEMPLATE = `---
name: {{skillName}}-specialist
description: {{description}} Use when {{triggerPhrases}}.
skills: {{skillName}}
tools: {{tools}}
model: {{model}}
---

## Operating Protocol

1. Execute the {{skillName}} skill for the delegated task
2. Process all intermediate results internally
3. Return ONLY a structured summary to the orchestrator

## Output Format

- **Task:** [what was requested]
- **Actions:** [what you did]
- **Results:** [key outcomes, max 3-5 bullet points]
- **Artifacts:** [file paths or outputs created]

Keep response under 500 tokens unless explicitly requested otherwise.

## Tool Usage Guidelines

{{toolGuidelines}}

## Error Handling

If the task cannot be completed:
- Report specific blocking issue
- Suggest alternative approaches
- Do not retry indefinitely
`

/**
 * CLAUDE.md integration snippet template
 * Users can copy this to their project's CLAUDE.md
 */
export const CLAUDE_MD_SNIPPET_TEMPLATE = `
### Subagent Delegation: {{skillName}}

When tasks match {{skillName}} triggers, delegate to the {{skillName}}-specialist
subagent instead of executing directly. This provides context isolation and
~37-97% token savings.

**Trigger Patterns:**
{{triggerPatterns}}

**Delegation Example:**
\`\`\`
Task("{{skillName}}-specialist", "{{exampleTask}}", "{{skillName}}-specialist")
\`\`\`
`

/**
 * Generate tool usage guidelines based on detected tools
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
 * Render the subagent definition template
 *
 * @param data - Template data including skill name, description, tools, etc.
 * @returns Rendered subagent markdown content
 */
export function renderSubagentTemplate(data: SubagentTemplateData): string {
  const toolGuidelines = generateToolGuidelines(data.tools)
  const triggerPhrasesFormatted =
    data.triggerPhrases.length > 0
      ? data.triggerPhrases.map((p) => `"${p}"`).join(', ')
      : '[describe trigger conditions]'

  return SUBAGENT_MD_TEMPLATE.replace(/\{\{skillName\}\}/g, data.skillName)
    .replace(/\{\{description\}\}/g, data.description)
    .replace(/\{\{triggerPhrases\}\}/g, triggerPhrasesFormatted)
    .replace(/\{\{tools\}\}/g, data.tools.join(', '))
    .replace(/\{\{model\}\}/g, data.model)
    .replace(/\{\{toolGuidelines\}\}/g, toolGuidelines)
}

/**
 * Render the CLAUDE.md integration snippet
 *
 * @param data - Template data
 * @returns Rendered CLAUDE.md snippet
 */
export function renderClaudeMdSnippet(data: SubagentTemplateData): string {
  const triggerPatterns =
    data.triggerPhrases.length > 0
      ? data.triggerPhrases.map((p) => `- "${p}"`).join('\n')
      : '- [add trigger patterns]'

  const exampleTask =
    data.triggerPhrases.length > 0 ? `${data.triggerPhrases[0]}` : `execute ${data.skillName} task`

  return CLAUDE_MD_SNIPPET_TEMPLATE.replace(/\{\{skillName\}\}/g, data.skillName)
    .replace(/\{\{triggerPatterns\}\}/g, triggerPatterns)
    .replace(/\{\{exampleTask\}\}/g, exampleTask)
}
