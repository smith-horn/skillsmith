/**
 * SkillCompletionProvider - Provides autocompletion for SKILL.md files
 * Implements CompletionItemProvider for YAML frontmatter and Markdown sections
 *
 * @module intellisense/SkillCompletionProvider
 */
import * as vscode from 'vscode'

/**
 * YAML frontmatter field definitions with descriptions
 */
const FRONTMATTER_FIELDS = [
  {
    name: 'name',
    description: 'The display name of the skill',
    insertText: 'name: "${1:Skill Name}"',
    required: true,
  },
  {
    name: 'description',
    description: 'A brief description of what the skill does',
    insertText: 'description: "${1:A brief description of the skill}"',
    required: true,
  },
  {
    name: 'version',
    description: 'Semantic version number (e.g., 1.0.0)',
    insertText: 'version: "${1:1.0.0}"',
    required: false,
  },
  {
    name: 'author',
    description: 'Author name or organization',
    insertText: 'author: "${1:Author Name}"',
    required: false,
  },
  {
    name: 'category',
    description: 'Skill category (e.g., development, testing, documentation)',
    insertText: 'category: "${1|development,testing,documentation,productivity,devops,security|}',
    required: false,
  },
  {
    name: 'tags',
    description: 'List of tags for discoverability',
    insertText: 'tags:\n  - ${1:tag1}\n  - ${2:tag2}',
    required: false,
  },
  {
    name: 'triggers',
    description: 'Phrases that activate this skill',
    insertText: 'triggers:\n  - "${1:trigger phrase}"',
    required: false,
  },
  {
    name: 'repository',
    description: 'URL to the skill repository',
    insertText: 'repository: "${1:https://github.com/user/repo}"',
    required: false,
  },
  {
    name: 'license',
    description: 'License identifier (e.g., MIT, Apache-2.0)',
    insertText: 'license: "${1|MIT,Apache-2.0,GPL-3.0,BSD-3-Clause|}"',
    required: false,
  },
]

/**
 * Common SKILL.md section headers with templates
 */
const MARKDOWN_SECTIONS = [
  {
    name: '## What This Skill Does',
    description: 'Describes the main functionality of the skill',
    insertText:
      '## What This Skill Does\n\n${1:Describe the core functionality and purpose of this skill.}\n',
  },
  {
    name: '## Quick Start',
    description: 'Quick start guide for using the skill',
    insertText:
      '## Quick Start\n\n```bash\n${1:# Example command}\n```\n\nOr mention "${2:trigger phrase}" in your conversation.\n',
  },
  {
    name: '## Trigger Phrases',
    description: 'Phrases that activate the skill',
    insertText:
      '## Trigger Phrases\n\n- "${1:first trigger phrase}"\n- "${2:second trigger phrase}"\n',
  },
  {
    name: '## Examples',
    description: 'Usage examples',
    insertText: '## Examples\n\n### Example 1: ${1:Title}\n\n```${2:language}\n${3:code}\n```\n',
  },
  {
    name: '## Configuration',
    description: 'Configuration options for the skill',
    insertText:
      '## Configuration\n\n| Option | Type | Default | Description |\n|--------|------|---------|-------------|\n| ${1:option} | ${2:string} | ${3:-} | ${4:Description} |\n',
  },
  {
    name: '## Requirements',
    description: 'Prerequisites and dependencies',
    insertText: '## Requirements\n\n- ${1:Requirement 1}\n- ${2:Requirement 2}\n',
  },
  {
    name: '## Installation',
    description: 'Installation instructions',
    insertText:
      '## Installation\n\n```bash\n# Clone the skill repository\ngit clone ${1:repository-url}\n\n# Or install via Skillsmith\nskillsmith install ${2:skill-id}\n```\n',
  },
  {
    name: '## API Reference',
    description: 'API documentation section',
    insertText:
      '## API Reference\n\n### `${1:functionName}`\n\n${2:Description}\n\n**Parameters:**\n- `${3:param}`: ${4:description}\n\n**Returns:** ${5:return type}\n',
  },
]

/**
 * SkillCompletionProvider provides intelligent autocompletion for SKILL.md files
 */
export class SkillCompletionProvider implements vscode.CompletionItemProvider {
  /**
   * Provides completion items for the current position
   */
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
    // Only provide completions for SKILL.md files
    if (!this.isSkillMdFile(document)) {
      return []
    }

    const lineText = document.lineAt(position.line).text
    const textBeforeCursor = lineText.substring(0, position.character)

    // Check if we're in frontmatter
    if (this.isInFrontmatter(document, position)) {
      return this.getFrontmatterCompletions(document, textBeforeCursor)
    }

    // Check if we're at the start of a line (for section headers)
    if (this.isAtLineStart(textBeforeCursor)) {
      return this.getSectionCompletions()
    }

    return []
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

    // Check if document starts with ---
    if (!text.startsWith('---')) {
      return false
    }

    // Find the closing ---
    const closingIndex = text.indexOf('---', 3)
    if (closingIndex === -1) {
      // No closing delimiter, assume we're in frontmatter if after first line
      return cursorOffset > 3
    }

    // Check if cursor is between the delimiters
    return cursorOffset > 3 && cursorOffset < closingIndex + 3
  }

  /**
   * Checks if cursor is at the start of a line
   */
  private isAtLineStart(textBeforeCursor: string): boolean {
    const trimmed = textBeforeCursor.trimStart()
    return trimmed.length === 0 || trimmed.startsWith('#')
  }

  /**
   * Gets completion items for YAML frontmatter fields
   */
  private getFrontmatterCompletions(
    document: vscode.TextDocument,
    textBeforeCursor: string
  ): vscode.CompletionItem[] {
    const existingFields = this.getExistingFrontmatterFields(document)
    const items: vscode.CompletionItem[] = []

    // Only suggest fields that aren't already present
    for (const field of FRONTMATTER_FIELDS) {
      if (existingFields.has(field.name)) {
        continue
      }

      // Only suggest if at start of line or after partial match
      const trimmed = textBeforeCursor.trimStart()
      if (trimmed.length > 0 && !field.name.startsWith(trimmed)) {
        continue
      }

      const item = new vscode.CompletionItem(field.name, vscode.CompletionItemKind.Property)

      item.detail = field.required ? '(required)' : '(optional)'
      item.documentation = new vscode.MarkdownString(field.description)
      item.insertText = new vscode.SnippetString(field.insertText)
      item.sortText = field.required ? '0' + field.name : '1' + field.name

      items.push(item)
    }

    return items
  }

  /**
   * Gets existing frontmatter field names from the document
   */
  private getExistingFrontmatterFields(document: vscode.TextDocument): Set<string> {
    const fields = new Set<string>()
    const text = document.getText()

    // Find frontmatter boundaries
    if (!text.startsWith('---')) {
      return fields
    }

    const closingIndex = text.indexOf('---', 3)
    if (closingIndex === -1) {
      return fields
    }

    const frontmatter = text.substring(3, closingIndex)
    const lines = frontmatter.split('\n')

    for (const line of lines) {
      const match = line.match(/^(\w+):/)
      if (match && match[1]) {
        fields.add(match[1])
      }
    }

    return fields
  }

  /**
   * Gets completion items for Markdown section headers
   */
  private getSectionCompletions(): vscode.CompletionItem[] {
    return MARKDOWN_SECTIONS.map((section, index) => {
      const item = new vscode.CompletionItem(section.name, vscode.CompletionItemKind.Snippet)

      item.detail = 'SKILL.md section'
      item.documentation = new vscode.MarkdownString(section.description)
      item.insertText = new vscode.SnippetString(section.insertText)
      item.sortText = String(index).padStart(2, '0')

      return item
    })
  }
}

/**
 * Creates the document selector for SKILL.md files
 */
export function getSkillMdSelector(): vscode.DocumentSelector {
  return [
    { language: 'markdown', pattern: '**/SKILL.md' },
    { language: 'markdown', pattern: '**/skill.md' },
  ]
}
