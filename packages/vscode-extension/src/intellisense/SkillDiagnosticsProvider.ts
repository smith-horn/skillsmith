/**
 * SkillDiagnosticsProvider - Provides validation diagnostics for SKILL.md files
 * Validates YAML frontmatter and document structure
 *
 * @module intellisense/SkillDiagnosticsProvider
 */
import * as vscode from 'vscode'

/**
 * Required frontmatter fields
 */
const REQUIRED_FIELDS = ['name', 'description']

/**
 * Known frontmatter fields (for typo detection)
 */
const KNOWN_FIELDS = new Set([
  'name',
  'description',
  'version',
  'author',
  'category',
  'tags',
  'triggers',
  'repository',
  'license',
])

/**
 * Recommended sections for SKILL.md files
 */
const RECOMMENDED_SECTIONS = ['What This Skill Does', 'Quick Start', 'Trigger Phrases']

/**
 * Diagnostic codes for different issue types
 */
export const DIAGNOSTIC_CODES = {
  MISSING_FRONTMATTER: 'skillsmith.missingFrontmatter',
  UNCLOSED_FRONTMATTER: 'skillsmith.unclosedFrontmatter',
  MISSING_REQUIRED_FIELD: 'skillsmith.missingRequiredField',
  EMPTY_FIELD: 'skillsmith.emptyField',
  UNKNOWN_FIELD: 'skillsmith.unknownField',
  INVALID_YAML: 'skillsmith.invalidYaml',
  MISSING_SECTION: 'skillsmith.missingSection',
  MISSING_HEADING: 'skillsmith.missingHeading',
} as const

/**
 * SkillDiagnosticsProvider validates SKILL.md files and reports issues
 */
export class SkillDiagnosticsProvider {
  private diagnosticCollection: vscode.DiagnosticCollection

  constructor() {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('skillsmith')
  }

  /**
   * Disposes of the diagnostic collection
   */
  dispose(): void {
    this.diagnosticCollection.dispose()
  }

  /**
   * Validates a document and updates diagnostics
   */
  validateDocument(document: vscode.TextDocument): void {
    // Only validate SKILL.md files
    if (!this.isSkillMdFile(document)) {
      this.diagnosticCollection.delete(document.uri)
      return
    }

    const diagnostics: vscode.Diagnostic[] = []
    const text = document.getText()

    // Validate frontmatter
    this.validateFrontmatter(document, text, diagnostics)

    // Validate document structure
    this.validateStructure(document, text, diagnostics)

    this.diagnosticCollection.set(document.uri, diagnostics)
  }

  /**
   * Clears diagnostics for a document
   */
  clearDiagnostics(document: vscode.TextDocument): void {
    this.diagnosticCollection.delete(document.uri)
  }

  /**
   * Checks if the document is a SKILL.md file
   */
  private isSkillMdFile(document: vscode.TextDocument): boolean {
    const fileName = document.fileName.toLowerCase()
    return fileName.endsWith('skill.md')
  }

  /**
   * Validates YAML frontmatter
   */
  private validateFrontmatter(
    document: vscode.TextDocument,
    text: string,
    diagnostics: vscode.Diagnostic[]
  ): void {
    // Check if frontmatter exists
    if (!text.startsWith('---')) {
      const range = new vscode.Range(0, 0, 0, 0)
      diagnostics.push(
        this.createDiagnostic(
          range,
          'SKILL.md should start with YAML frontmatter (---)',
          vscode.DiagnosticSeverity.Warning,
          DIAGNOSTIC_CODES.MISSING_FRONTMATTER
        )
      )
      return
    }

    // Find closing delimiter
    const closingIndex = text.indexOf('---', 3)
    if (closingIndex === -1) {
      const range = new vscode.Range(0, 0, 0, 3)
      diagnostics.push(
        this.createDiagnostic(
          range,
          'YAML frontmatter is not closed (missing ---)',
          vscode.DiagnosticSeverity.Error,
          DIAGNOSTIC_CODES.UNCLOSED_FRONTMATTER
        )
      )
      return
    }

    // Extract and parse frontmatter
    const frontmatter = text.substring(4, closingIndex)
    const fields = this.parseFrontmatter(frontmatter)

    // Check for required fields
    for (const requiredField of REQUIRED_FIELDS) {
      if (!fields.has(requiredField)) {
        const range = new vscode.Range(0, 0, 0, 3)
        diagnostics.push(
          this.createDiagnostic(
            range,
            `Missing required field: ${requiredField}`,
            vscode.DiagnosticSeverity.Error,
            DIAGNOSTIC_CODES.MISSING_REQUIRED_FIELD
          )
        )
      }
    }

    // Validate each field
    const frontmatterLines = frontmatter.split('\n')
    let lineOffset = 1 // Skip opening ---

    for (const line of frontmatterLines) {
      this.validateFrontmatterLine(document, line, lineOffset, fields, diagnostics)
      lineOffset++
    }
  }

  /**
   * Validates a single frontmatter line
   */
  private validateFrontmatterLine(
    document: vscode.TextDocument,
    line: string,
    lineNumber: number,
    fields: Map<string, string>,
    diagnostics: vscode.Diagnostic[]
  ): void {
    const match = line.match(/^(\s*)(\w+)(:)(.*)$/)
    if (!match || match.length < 5) {
      return
    }

    const indent = match[1] ?? ''
    const fieldName = (match[2] ?? '').toLowerCase()
    const value = (match[4] ?? '').trim()

    // Check for unknown fields (possible typos)
    if (indent.length === 0 && !KNOWN_FIELDS.has(fieldName)) {
      const range = new vscode.Range(
        lineNumber,
        indent.length,
        lineNumber,
        indent.length + fieldName.length
      )
      diagnostics.push(
        this.createDiagnostic(
          range,
          `Unknown field "${fieldName}". Did you mean one of: ${Array.from(KNOWN_FIELDS).join(', ')}?`,
          vscode.DiagnosticSeverity.Warning,
          DIAGNOSTIC_CODES.UNKNOWN_FIELD
        )
      )
    }

    // Check for empty required fields
    if (REQUIRED_FIELDS.includes(fieldName) && !value && !fields.get(fieldName)) {
      const range = document.lineAt(lineNumber).range
      diagnostics.push(
        this.createDiagnostic(
          range,
          `Required field "${fieldName}" should not be empty`,
          vscode.DiagnosticSeverity.Error,
          DIAGNOSTIC_CODES.EMPTY_FIELD
        )
      )
    }
  }

  /**
   * Parses frontmatter into a map of field names to values
   */
  private parseFrontmatter(frontmatter: string): Map<string, string> {
    const fields = new Map<string, string>()
    const lines = frontmatter.split('\n')

    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.*)$/)
      if (match && match[1] && match[2] !== undefined) {
        fields.set(match[1].toLowerCase(), match[2].trim())
      }
    }

    return fields
  }

  /**
   * Validates document structure (headings, sections)
   */
  private validateStructure(
    document: vscode.TextDocument,
    text: string,
    diagnostics: vscode.Diagnostic[]
  ): void {
    // Check for main heading (# Title)
    const hasMainHeading = /^#\s+.+$/m.test(text)
    if (!hasMainHeading) {
      // Find first non-frontmatter line
      const lines = text.split('\n')
      let firstContentLine = 0

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line !== undefined && !line.startsWith('---') && line.trim().length > 0) {
          // Skip if we're in frontmatter
          const textBefore = lines.slice(0, i + 1).join('\n')
          const frontmatterStart = textBefore.indexOf('---')
          const frontmatterEnd = textBefore.indexOf('---', frontmatterStart + 3)

          if (frontmatterEnd > 0 && i > 0) {
            firstContentLine = i
            break
          }
        }
      }

      const range = new vscode.Range(firstContentLine, 0, firstContentLine, 0)
      diagnostics.push(
        this.createDiagnostic(
          range,
          'SKILL.md should have a main heading (# Title)',
          vscode.DiagnosticSeverity.Information,
          DIAGNOSTIC_CODES.MISSING_HEADING
        )
      )
    }

    // Check for recommended sections
    const lowerText = text.toLowerCase()
    for (const section of RECOMMENDED_SECTIONS) {
      const sectionPattern = new RegExp(`^##\\s+${section.toLowerCase()}`, 'm')
      if (!sectionPattern.test(lowerText)) {
        // Add hint at end of document
        const lastLine = document.lineCount - 1
        const range = new vscode.Range(lastLine, 0, lastLine, 0)
        diagnostics.push(
          this.createDiagnostic(
            range,
            `Consider adding a "## ${section}" section`,
            vscode.DiagnosticSeverity.Hint,
            DIAGNOSTIC_CODES.MISSING_SECTION
          )
        )
      }
    }
  }

  /**
   * Creates a diagnostic with the given parameters
   */
  private createDiagnostic(
    range: vscode.Range,
    message: string,
    severity: vscode.DiagnosticSeverity,
    code: string
  ): vscode.Diagnostic {
    const diagnostic = new vscode.Diagnostic(range, message, severity)
    diagnostic.code = code
    diagnostic.source = 'Skillsmith'
    return diagnostic
  }
}
