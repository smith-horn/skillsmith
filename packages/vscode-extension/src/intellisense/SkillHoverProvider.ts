/**
 * SkillHoverProvider - Provides hover documentation for SKILL.md files
 * Implements HoverProvider for YAML frontmatter fields and Markdown elements
 *
 * @module intellisense/SkillHoverProvider
 */
import * as vscode from 'vscode'

/**
 * Frontmatter field documentation
 */
interface FieldDocumentation {
  description: string
  type: string
  required: boolean
  example: string
  tips?: string[]
}

/**
 * Documentation for all frontmatter fields
 */
const FIELD_DOCUMENTATION: Record<string, FieldDocumentation> = {
  name: {
    description: 'The display name of the skill shown in Claude Code and the skill browser.',
    type: 'string',
    required: true,
    example: 'name: "Docker Manager"',
    tips: [
      'Use Title Case for consistency',
      'Keep it concise (2-4 words)',
      "Make it descriptive of the skill's purpose",
    ],
  },
  description: {
    description:
      'A brief description explaining what the skill does. This appears in search results and the skill detail view.',
    type: 'string',
    required: true,
    example: 'description: "Manages Docker containers and images directly from Claude Code"',
    tips: [
      'Keep under 150 characters for best display',
      'Start with an action verb (Manages, Creates, Generates)',
      'Mention key features or integrations',
    ],
  },
  version: {
    description:
      'Semantic version number following semver.org conventions. Used for update detection.',
    type: 'string',
    required: false,
    example: 'version: "1.2.3"',
    tips: [
      'Follow semantic versioning (MAJOR.MINOR.PATCH)',
      'Increment MAJOR for breaking changes',
      'Increment MINOR for new features',
      'Increment PATCH for bug fixes',
    ],
  },
  author: {
    description: 'The author or organization that created the skill.',
    type: 'string',
    required: false,
    example: 'author: "Skillsmith Team"',
  },
  category: {
    description: "The category that best describes the skill's functionality.",
    type: 'string',
    required: false,
    example: 'category: "development"',
    tips: [
      'Common categories: development, testing, documentation, productivity, devops, security',
      'Helps users find related skills',
    ],
  },
  tags: {
    description: 'List of tags for improved discoverability in search.',
    type: 'array',
    required: false,
    example: 'tags:\n  - docker\n  - containers\n  - devops',
    tips: ['Use lowercase tags', 'Include related technologies', 'Add common synonyms'],
  },
  triggers: {
    description: 'Phrases that activate this skill when mentioned in Claude Code conversations.',
    type: 'array',
    required: false,
    example: 'triggers:\n  - "manage docker"\n  - "docker containers"',
    tips: [
      'Include natural language phrases',
      'Add both short and long variants',
      'Consider common misspellings',
    ],
  },
  repository: {
    description: "URL to the skill's source code repository.",
    type: 'string',
    required: false,
    example: 'repository: "https://github.com/skillsmith/docker-skill"',
  },
  license: {
    description: 'The software license for the skill.',
    type: 'string',
    required: false,
    example: 'license: "MIT"',
    tips: ['Use SPDX license identifiers (MIT, Apache-2.0, GPL-3.0)'],
  },
}

/**
 * Section documentation for common SKILL.md sections
 */
const SECTION_DOCUMENTATION: Record<string, string> = {
  'what this skill does': `
## What This Skill Does

This section provides a detailed explanation of the skill's functionality.
Include:
- Main purpose and use cases
- Key features and capabilities
- How it integrates with Claude Code
`,
  'quick start': `
## Quick Start

This section helps users get started quickly.
Include:
- Minimal setup steps
- A simple example
- The most common trigger phrase
`,
  'trigger phrases': `
## Trigger Phrases

Lists the phrases that activate this skill.
Claude Code monitors conversations for these triggers.
Example triggers:
- "manage docker containers"
- "create dockerfile"
`,
  examples: `
## Examples

Provides concrete usage examples.
Include:
- Code snippets with language identifiers
- Expected outputs
- Common scenarios
`,
  configuration: `
## Configuration

Documents available configuration options.
Use a table format:
| Option | Type | Default | Description |
`,
  requirements: `
## Requirements

Lists prerequisites for using the skill.
Include:
- Required software/tools
- Environment variables
- Permissions needed
`,
}

/**
 * SkillHoverProvider provides hover documentation for SKILL.md files
 */
export class SkillHoverProvider implements vscode.HoverProvider {
  /**
   * Provides hover information for the current position
   */
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    // Only provide hovers for SKILL.md files
    if (!this.isSkillMdFile(document)) {
      return null
    }

    const line = document.lineAt(position.line)
    const lineText = line.text

    // Check if we're in frontmatter
    if (this.isInFrontmatter(document, position)) {
      return this.getFrontmatterHover(lineText, position)
    }

    // Check if we're on a section header
    if (lineText.trimStart().startsWith('#')) {
      return this.getSectionHover(lineText)
    }

    return null
  }

  /**
   * Checks if the document is a SKILL.md file
   */
  private isSkillMdFile(document: vscode.TextDocument): boolean {
    const fileName = document.fileName.toLowerCase()
    return fileName.endsWith('skill.md')
  }

  /**
   * Checks if the cursor is within YAML frontmatter
   */
  private isInFrontmatter(document: vscode.TextDocument, position: vscode.Position): boolean {
    const text = document.getText()
    const cursorOffset = document.offsetAt(position)

    if (!text.startsWith('---')) {
      return false
    }

    const closingIndex = text.indexOf('---', 3)
    if (closingIndex === -1) {
      return cursorOffset > 3
    }

    return cursorOffset > 3 && cursorOffset < closingIndex + 3
  }

  /**
   * Gets hover for frontmatter fields
   */
  private getFrontmatterHover(lineText: string, position: vscode.Position): vscode.Hover | null {
    // Extract field name from line
    const match = lineText.match(/^(\s*)(\w+)(:)/)
    if (!match || !match[1] || !match[2]) {
      return null
    }

    const indent = match[1]
    const fieldNamePart = match[2]
    const fieldName = fieldNamePart.toLowerCase()
    const fieldDoc = FIELD_DOCUMENTATION[fieldName]

    if (!fieldDoc) {
      return null
    }

    // Check if cursor is over the field name
    const fieldStart = indent.length
    const fieldEnd = fieldStart + fieldNamePart.length
    if (position.character < fieldStart || position.character > fieldEnd) {
      return null
    }

    const md = new vscode.MarkdownString()
    md.appendMarkdown(`### \`${fieldName}\`\n\n`)
    md.appendMarkdown(`${fieldDoc.description}\n\n`)
    md.appendMarkdown(`**Type:** \`${fieldDoc.type}\`\n\n`)
    md.appendMarkdown(`**Required:** ${fieldDoc.required ? 'Yes' : 'No'}\n\n`)
    md.appendMarkdown(`**Example:**\n\`\`\`yaml\n${fieldDoc.example}\n\`\`\`\n`)

    if (fieldDoc.tips && fieldDoc.tips.length > 0) {
      md.appendMarkdown(`\n**Tips:**\n`)
      for (const tip of fieldDoc.tips) {
        md.appendMarkdown(`- ${tip}\n`)
      }
    }

    return new vscode.Hover(md)
  }

  /**
   * Gets hover for section headers
   */
  private getSectionHover(lineText: string): vscode.Hover | null {
    // Extract section name from header
    const match = lineText.match(/^#+\s*(.+)/)
    if (!match || !match[1]) {
      return null
    }

    const sectionName = match[1].toLowerCase().trim()
    const sectionDoc = SECTION_DOCUMENTATION[sectionName]

    if (!sectionDoc) {
      return null
    }

    const md = new vscode.MarkdownString()
    md.appendMarkdown(sectionDoc.trim())

    return new vscode.Hover(md)
  }
}
