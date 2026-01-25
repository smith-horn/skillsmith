/**
 * SMI-1788: SkillDecomposer Helpers
 *
 * Helper functions and constants for skill decomposition.
 */

import type {
  DecomposerOptions,
  ResolvedDecomposerOptions,
  SkillMetadata,
  ParsedSection,
  SubSkill,
  DecomposedSkill,
  DecompositionStats,
} from './SkillDecomposer.types.js'
import type { ExtractableSection } from './SkillAnalyzer.types.js'

/**
 * Default keywords that indicate a section should be extracted as a sub-skill.
 * These are used when no custom extractKeywords are provided.
 */
export const DEFAULT_EXTRACT_KEYWORDS = [
  'api',
  'reference',
  'example',
  'usage',
  'advanced',
  'configuration',
  'troubleshoot',
  'appendix',
]

/**
 * Default decomposer options
 */
export const DEFAULT_OPTIONS: ResolvedDecomposerOptions = {
  maxMainSkillLines: 400,
  minExtractableLines: 50,
  addNavigation: true,
  addAttribution: true,
  extractKeywords: DEFAULT_EXTRACT_KEYWORDS,
}

/**
 * Merge user options with defaults
 */
export function resolveOptions(options?: DecomposerOptions): ResolvedDecomposerOptions {
  return { ...DEFAULT_OPTIONS, ...options }
}

/**
 * Parse skill content into metadata, frontmatter, and sections
 */
export function parseSkillContent(content: string): {
  metadata: SkillMetadata
  frontmatter: string
  sections: ParsedSection[]
} {
  const lines = content.split('\n')
  let frontmatter = ''
  let contentStart = 0
  const metadata: SkillMetadata = {}

  // Extract frontmatter
  if (lines[0]?.trim() === '---') {
    let frontmatterEnd = -1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        frontmatterEnd = i
        break
      }
    }

    if (frontmatterEnd > 0) {
      frontmatter = lines.slice(0, frontmatterEnd + 1).join('\n')
      contentStart = frontmatterEnd + 1

      // Parse metadata from frontmatter
      const yamlContent = lines.slice(1, frontmatterEnd).join('\n')
      const nameMatch = yamlContent.match(/^name:\s*(.+)$/m)
      const descMatch = yamlContent.match(/^description:\s*(.+)$/m)

      if (nameMatch) metadata.name = nameMatch[1].trim()
      if (descMatch) metadata.description = descMatch[1].trim()
    }
  }

  // Parse sections
  const sections: ParsedSection[] = []
  let currentSection: ParsedSection | null = null

  for (let i = contentStart; i < lines.length; i++) {
    const line = lines[i]
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/)

    if (headerMatch) {
      // Save previous section
      if (currentSection) {
        sections.push(currentSection)
      }

      currentSection = {
        level: headerMatch[1].length,
        title: headerMatch[2].trim(),
        startLine: i,
        lines: [line],
      }
    } else if (currentSection) {
      currentSection.lines.push(line)
    } else {
      // Content before first header
      if (!sections.length && line.trim()) {
        currentSection = {
          level: 0,
          title: '_preamble',
          startLine: i,
          lines: [line],
        }
      }
    }
  }

  // Save last section
  if (currentSection) {
    sections.push(currentSection)
  }

  return { metadata, frontmatter, sections }
}

/**
 * Determine which sections should be extracted as sub-skills
 */
export function determineSectionsToExtract(
  sections: ParsedSection[],
  extractableSections: ExtractableSection[],
  opts: ResolvedDecomposerOptions
): ParsedSection[] {
  const toExtract: ParsedSection[] = []

  // Create a map of section names from analysis for quick lookup
  const extractableNames = new Set(extractableSections.map((s) => s.name.toLowerCase()))

  // Use configurable keywords (defaults provided via DEFAULT_OPTIONS)
  const keywords = opts.extractKeywords ?? DEFAULT_EXTRACT_KEYWORDS

  for (const section of sections) {
    const lineCount = section.lines.length
    const titleLower = section.title.toLowerCase()

    // Skip preamble and very short sections
    if (section.title === '_preamble' || lineCount < opts.minExtractableLines) {
      continue
    }

    // Extract if:
    // 1. In analysis extractable list
    // 2. Has extract keyword in title
    // 3. Is a large section (>100 lines)
    const shouldExtract =
      extractableNames.has(titleLower) ||
      keywords.some((kw) => titleLower.includes(kw)) ||
      lineCount > 100

    if (shouldExtract) {
      toExtract.push(section)
    }
  }

  return toExtract
}

/**
 * SMI-1794: Sanitize and validate filename for sub-skill
 * Prevents path traversal and invalid characters
 */
export function sanitizeFilename(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-') // Only allow alphanumeric, dash, underscore
      .replace(/-+/g, '-') // Collapse multiple dashes
      .replace(/^-|-$/g, '') // Remove leading/trailing dashes
      .slice(0, 64) || 'sub-skill'
  ) // Limit length, provide default
}

/**
 * Generate a filename for a sub-skill
 * SMI-1794: Uses sanitized filename to prevent security issues
 */
export function generateSubSkillFilename(sectionTitle: string): string {
  const slug = sanitizeFilename(sectionTitle)
  return `${slug}.md`
}

/**
 * Format sub-skill content with proper header
 */
export function formatSubSkillContent(section: ParsedSection, skillName: string): string {
  const header = `---
parent_skill: ${skillName}
section: ${section.title}
---

`

  return header + section.lines.join('\n')
}

/**
 * Create sub-skills from extracted sections
 */
export function createSubSkills(sections: ParsedSection[], skillName: string): SubSkill[] {
  return sections.map((section) => {
    const filename = generateSubSkillFilename(section.title)
    const content = formatSubSkillContent(section, skillName)

    // Determine extraction reason
    const titleLower = section.title.toLowerCase()
    let reason = 'Large section suitable for on-demand loading'

    if (titleLower.includes('api') || titleLower.includes('reference')) {
      reason = 'API reference loaded on-demand to reduce initial context'
    } else if (titleLower.includes('example') || titleLower.includes('usage')) {
      reason = 'Examples progressively disclosed when needed'
    } else if (titleLower.includes('advanced') || titleLower.includes('configuration')) {
      reason = 'Advanced content loaded only when required'
    }

    return {
      filename,
      sectionName: section.title,
      content,
      lineCount: content.split('\n').length,
      extractionReason: reason,
    }
  })
}

/**
 * Generate navigation section linking to sub-skills
 */
export function generateSubSkillNavigation(subSkills: SubSkill[]): string {
  const links = subSkills.map((s) => `- [${s.sectionName}](./${s.filename})`).join('\n')

  return `## Additional Resources

The following sections are available as sub-skills for on-demand loading:

${links}

*Load these sections only when needed to optimize context usage.*`
}

/**
 * Generate attribution footer
 */
export function generateAttribution(): string {
  return `---

*Optimized by Skillsmith - Token usage reduced through intelligent decomposition*`
}

/**
 * Add attribution to content without decomposition
 */
export function addAttributionToContent(content: string): string {
  return content.trimEnd() + '\n\n' + generateAttribution()
}

/**
 * Create the main skill content with remaining sections
 */
export function createMainSkill(
  frontmatter: string,
  allSections: ParsedSection[],
  extractedSections: ParsedSection[],
  subSkills: SubSkill[],
  opts: ResolvedDecomposerOptions
): DecomposedSkill {
  const extractedTitles = new Set(extractedSections.map((s) => s.title))

  // Build main content from non-extracted sections
  const remainingSections = allSections.filter((s) => !extractedTitles.has(s.title))
  let mainContent = remainingSections.map((s) => s.lines.join('\n')).join('\n\n')

  // Add navigation to sub-skills if enabled
  if (opts.addNavigation && subSkills.length > 0) {
    const nav = generateSubSkillNavigation(subSkills)
    mainContent = mainContent + '\n\n' + nav
  }

  // Add attribution if enabled
  if (opts.addAttribution) {
    mainContent = mainContent + '\n\n' + generateAttribution()
  }

  // Combine frontmatter and content
  const finalContent = frontmatter ? frontmatter + '\n\n' + mainContent : mainContent

  return {
    filename: 'SKILL.md',
    content: finalContent.trim(),
    lineCount: finalContent.split('\n').length,
    subSkillRefs: subSkills.map((s) => s.filename),
  }
}

/**
 * Calculate decomposition statistics
 */
export function calculateStats(
  originalContent: string,
  mainSkill: DecomposedSkill,
  subSkills: SubSkill[]
): DecompositionStats {
  const originalLines = originalContent.split('\n').length
  const mainSkillLines = mainSkill.lineCount
  const subSkillLines = subSkills.reduce((sum, s) => sum + s.lineCount, 0)

  // Estimate token reduction
  // Main skill is always loaded; sub-skills are loaded on-demand
  // Assume 50% of sub-skill content would have been needed on average
  const effectiveReduction = subSkillLines * 0.5
  const tokenReductionPercent = Math.round((effectiveReduction / originalLines) * 100)

  return {
    originalLines,
    mainSkillLines,
    subSkillLines,
    subSkillCount: subSkills.length,
    tokenReductionPercent,
  }
}

/**
 * Format multiple Task() calls as a batched operation
 */
export function formatBatchedTasks(tasks: string[]): string[] {
  if (tasks.length < 2) {
    return tasks
  }

  // Add comment about batching
  return ['// Batched for parallel execution (Skillsmith optimization)', ...tasks]
}
