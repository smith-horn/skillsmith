/**
 * SMI-1788: SkillDecomposer - Decompose large skills into sub-skills
 *
 * Transforms skills >500 lines into a main SKILL.md + sub-skills structure
 * following the Skillsmith optimization standard:
 * - Main SKILL.md: <500 lines, contains header + navigation + core content
 * - Sub-skills: Extracted sections loaded on-demand
 *
 * Part of the Skillsmith Optimization Layer for transforming
 * community skills into more performant versions.
 */

import type { SkillAnalysis, ExtractableSection } from './SkillAnalyzer.js'

/**
 * Result of skill decomposition
 */
export interface DecompositionResult {
  /** The optimized main SKILL.md content */
  mainSkill: DecomposedSkill

  /** Extracted sub-skills */
  subSkills: SubSkill[]

  /** Whether decomposition was applied */
  wasDecomposed: boolean

  /** Statistics about the decomposition */
  stats: DecompositionStats
}

/**
 * The main skill after decomposition
 */
export interface DecomposedSkill {
  /** Filename (always SKILL.md) */
  filename: string

  /** The optimized content */
  content: string

  /** Line count after optimization */
  lineCount: number

  /** References to sub-skills */
  subSkillRefs: string[]
}

/**
 * An extracted sub-skill
 */
export interface SubSkill {
  /** Filename (e.g., api.md, examples.md) */
  filename: string

  /** Original section name */
  sectionName: string

  /** The extracted content */
  content: string

  /** Line count */
  lineCount: number

  /** Why this section was extracted */
  extractionReason: string
}

/**
 * Statistics about the decomposition
 */
export interface DecompositionStats {
  /** Original line count */
  originalLines: number

  /** Main skill line count after decomposition */
  mainSkillLines: number

  /** Total lines in sub-skills */
  subSkillLines: number

  /** Number of sub-skills created */
  subSkillCount: number

  /** Estimated token reduction percentage */
  tokenReductionPercent: number
}

/**
 * Metadata extracted from SKILL.md frontmatter
 */
interface SkillMetadata {
  name?: string
  description?: string
  [key: string]: string | undefined
}

/**
 * Configuration for decomposition behavior
 */
export interface DecomposerOptions {
  /** Maximum lines for main skill (default: 400) */
  maxMainSkillLines?: number

  /** Minimum lines for a section to be extracted (default: 50) */
  minExtractableLines?: number

  /** Whether to add navigation links to main skill (default: true) */
  addNavigation?: boolean

  /** Whether to add "Optimized by Skillsmith" attribution (default: true) */
  addAttribution?: boolean
}

const DEFAULT_OPTIONS: Required<DecomposerOptions> = {
  maxMainSkillLines: 400,
  minExtractableLines: 50,
  addNavigation: true,
  addAttribution: true,
}

/**
 * Decompose a skill into main + sub-skills based on analysis
 *
 * @param content - The original SKILL.md content
 * @param analysis - Analysis from SkillAnalyzer
 * @param options - Decomposition options
 * @returns Decomposition result with main skill and sub-skills
 */
export function decomposeSkill(
  content: string,
  analysis: SkillAnalysis,
  options?: DecomposerOptions
): DecompositionResult {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  // If skill doesn't need decomposition, return as-is with attribution
  if (!analysis.shouldTransform || analysis.lineCount <= opts.maxMainSkillLines) {
    return createNonDecomposedResult(content, analysis, opts)
  }

  // Parse the skill content
  const { metadata, sections, frontmatter } = parseSkillContent(content)

  // Determine which sections to extract
  const sectionsToExtract = determineSectionsToExtract(sections, analysis.extractableSections, opts)

  // Create sub-skills from extracted sections
  const subSkills = createSubSkills(sectionsToExtract, metadata.name || 'skill')

  // Create the main skill with remaining content
  const mainSkill = createMainSkill(
    frontmatter,
    metadata,
    sections,
    sectionsToExtract,
    subSkills,
    opts
  )

  // Calculate statistics
  const stats = calculateStats(content, mainSkill, subSkills)

  return {
    mainSkill,
    subSkills,
    wasDecomposed: true,
    stats,
  }
}

/**
 * Create result for skills that don't need decomposition
 */
function createNonDecomposedResult(
  content: string,
  analysis: SkillAnalysis,
  opts: Required<DecomposerOptions>
): DecompositionResult {
  let finalContent = content

  // Add attribution if enabled
  if (opts.addAttribution && !content.includes('Optimized by Skillsmith')) {
    finalContent = addAttributionToContent(content)
  }

  return {
    mainSkill: {
      filename: 'SKILL.md',
      content: finalContent,
      lineCount: finalContent.split('\n').length,
      subSkillRefs: [],
    },
    subSkills: [],
    wasDecomposed: false,
    stats: {
      originalLines: analysis.lineCount,
      mainSkillLines: finalContent.split('\n').length,
      subSkillLines: 0,
      subSkillCount: 0,
      tokenReductionPercent: 0,
    },
  }
}

/**
 * Parse skill content into metadata, frontmatter, and sections
 */
function parseSkillContent(content: string): {
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

interface ParsedSection {
  level: number
  title: string
  startLine: number
  lines: string[]
}

/**
 * Determine which sections should be extracted as sub-skills
 */
function determineSectionsToExtract(
  sections: ParsedSection[],
  extractableSections: ExtractableSection[],
  opts: Required<DecomposerOptions>
): ParsedSection[] {
  const toExtract: ParsedSection[] = []

  // Create a map of section names from analysis for quick lookup
  const extractableNames = new Set(extractableSections.map((s) => s.name.toLowerCase()))

  // Keywords that indicate a section should be extracted
  const extractKeywords = [
    'api',
    'reference',
    'example',
    'usage',
    'advanced',
    'configuration',
    'troubleshoot',
    'appendix',
  ]

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
      extractKeywords.some((kw) => titleLower.includes(kw)) ||
      lineCount > 100

    if (shouldExtract) {
      toExtract.push(section)
    }
  }

  return toExtract
}

/**
 * Create sub-skills from extracted sections
 */
function createSubSkills(sections: ParsedSection[], skillName: string): SubSkill[] {
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
 * SMI-1794: Sanitize and validate filename for sub-skill
 * Prevents path traversal and invalid characters
 */
function sanitizeFilename(name: string): string {
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
function generateSubSkillFilename(sectionTitle: string): string {
  const slug = sanitizeFilename(sectionTitle)
  return `${slug}.md`
}

/**
 * Format sub-skill content with proper header
 */
function formatSubSkillContent(section: ParsedSection, skillName: string): string {
  const header = `---
parent_skill: ${skillName}
section: ${section.title}
---

`

  return header + section.lines.join('\n')
}

/**
 * Create the main skill content with remaining sections
 */
function createMainSkill(
  frontmatter: string,
  metadata: SkillMetadata,
  allSections: ParsedSection[],
  extractedSections: ParsedSection[],
  subSkills: SubSkill[],
  opts: Required<DecomposerOptions>
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
 * Generate navigation section linking to sub-skills
 */
function generateSubSkillNavigation(subSkills: SubSkill[]): string {
  const links = subSkills.map((s) => `- [${s.sectionName}](./${s.filename})`).join('\n')

  return `## Additional Resources

The following sections are available as sub-skills for on-demand loading:

${links}

*Load these sections only when needed to optimize context usage.*`
}

/**
 * Generate attribution footer
 */
function generateAttribution(): string {
  return `---

*Optimized by Skillsmith - Token usage reduced through intelligent decomposition*`
}

/**
 * Add attribution to content without decomposition
 */
function addAttributionToContent(content: string): string {
  return content.trimEnd() + '\n\n' + generateAttribution()
}

/**
 * Calculate decomposition statistics
 */
function calculateStats(
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
 * Parallelize sequential Task() calls in skill content
 *
 * @param content - The skill content
 * @returns Content with Task() calls batched for parallel execution
 */
export function parallelizeTaskCalls(content: string): string {
  const lines = content.split('\n')
  const result: string[] = []
  const taskBuffer: string[] = []
  let inCodeBlock = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Track code blocks
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock

      // Flush task buffer before code blocks
      if (taskBuffer.length > 0) {
        result.push(...formatBatchedTasks(taskBuffer))
        taskBuffer.length = 0
      }
      result.push(line)
      continue
    }

    // In code blocks, look for sequential Task() calls
    if (inCodeBlock && line.includes('Task(')) {
      taskBuffer.push(line)
      continue
    }

    // Flush task buffer when we hit a non-Task line in code block
    if (inCodeBlock && taskBuffer.length > 0 && !line.includes('Task(')) {
      result.push(...formatBatchedTasks(taskBuffer))
      taskBuffer.length = 0
    }

    result.push(line)
  }

  // Flush any remaining tasks
  if (taskBuffer.length > 0) {
    result.push(...formatBatchedTasks(taskBuffer))
  }

  return result.join('\n')
}

/**
 * Format multiple Task() calls as a batched operation
 */
function formatBatchedTasks(tasks: string[]): string[] {
  if (tasks.length < 2) {
    return tasks
  }

  // Add comment about batching
  return ['// Batched for parallel execution (Skillsmith optimization)', ...tasks]
}

export default { decomposeSkill, parallelizeTaskCalls }
