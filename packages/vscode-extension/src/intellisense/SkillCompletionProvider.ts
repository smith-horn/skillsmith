/**
 * SkillCompletionProvider - Provides autocompletion for SKILL.md files
 * Implements CompletionItemProvider for YAML frontmatter and Markdown sections
 *
 * @module intellisense/SkillCompletionProvider
 */
import * as vscode from 'vscode'
import { FRONTMATTER_FIELDS, MARKDOWN_SECTIONS } from './completionData.js'

export { FRONTMATTER_FIELDS, MARKDOWN_SECTIONS }

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
