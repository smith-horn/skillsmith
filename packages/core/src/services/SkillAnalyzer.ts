/**
 * SMI-1788: SkillAnalyzer - Analyze skills for optimization patterns
 *
 * Detects optimization opportunities based on:
 * - Line count (>500 lines suggests decomposition)
 * - Tool usage patterns (heavy tool usage suggests subagent)
 * - Sequential Task() calls (can be parallelized)
 * - Large examples sections (can use progressive disclosure)
 *
 * Part of the Skillsmith Optimization Layer for transforming
 * community skills into more performant versions.
 */

/**
 * Analysis result for a skill's optimization potential
 */
export interface SkillAnalysis {
  /** Total line count of the skill content */
  lineCount: number

  /** Number of lines in the main content (excluding examples) */
  mainContentLines: number

  /** Number of lines in examples section */
  examplesLines: number

  /** Tools detected in the skill content */
  toolUsage: ToolUsageAnalysis

  /** Task() call patterns detected */
  taskPatterns: TaskPatternAnalysis

  /** Sections that could be extracted as sub-skills */
  extractableSections: ExtractableSection[]

  /** Recommended optimizations to apply */
  recommendations: OptimizationRecommendation[]

  /** Overall optimization score (0-100) */
  optimizationScore: number

  /** Whether this skill would benefit from transformation */
  shouldTransform: boolean
}

/**
 * Tool usage analysis result
 */
export interface ToolUsageAnalysis {
  /** List of detected tools */
  detectedTools: string[]

  /** Number of Bash commands detected */
  bashCommandCount: number

  /** Number of file reads detected (Read/Glob/Grep) */
  fileReadCount: number

  /** Number of file writes detected (Write/Edit) */
  fileWriteCount: number

  /** Whether heavy tool usage suggests subagent */
  suggestsSubagent: boolean

  /** Confidence in tool detection */
  confidence: 'high' | 'medium' | 'low'
}

/**
 * Task() call pattern analysis
 */
export interface TaskPatternAnalysis {
  /** Total number of Task() calls detected */
  taskCallCount: number

  /** Number of sequential Task() calls that could be parallelized */
  sequentialCalls: number

  /** Whether Task() calls can be batched */
  canBatch: boolean

  /** Estimated token savings from batching (percentage) */
  batchSavingsPercent: number
}

/**
 * Section that could be extracted as a sub-skill
 */
export interface ExtractableSection {
  /** Section name/title */
  name: string

  /** Start line number */
  startLine: number

  /** End line number */
  endLine: number

  /** Number of lines */
  lineCount: number

  /** Extraction priority (1 = highest) */
  priority: number

  /** Reason for extraction recommendation */
  reason: string
}

/**
 * Optimization recommendation
 */
export interface OptimizationRecommendation {
  /** Recommendation type */
  type: 'decompose' | 'parallelize' | 'subagent' | 'progressive-disclosure'

  /** Human-readable description */
  description: string

  /** Estimated token savings (percentage) */
  estimatedSavings: number

  /** Priority (1 = highest) */
  priority: number

  /** Affected sections or patterns */
  affectedAreas: string[]
}

/**
 * Tool detection patterns for analyzing skill content
 */
const TOOL_PATTERNS: Record<string, { patterns: string[]; weight: number }> = {
  Read: {
    patterns: ['read file', 'read the file', 'examine', 'view file', 'cat ', 'Read tool'],
    weight: 1,
  },
  Write: {
    patterns: [
      'write file',
      'create file',
      'save to',
      'output to file',
      'Write tool',
      'write the file',
    ],
    weight: 2,
  },
  Edit: {
    patterns: ['edit file', 'modify file', 'update file', 'patch', 'Edit tool', 'replace in'],
    weight: 2,
  },
  Bash: {
    patterns: [
      'bash',
      'npm ',
      'npx ',
      'git ',
      'docker',
      'yarn ',
      'pnpm ',
      'execute command',
      'run command',
      'terminal',
      'shell',
      'Bash tool',
    ],
    weight: 3,
  },
  Grep: {
    patterns: ['grep', 'search for', 'find text', 'pattern match', 'Grep tool'],
    weight: 1,
  },
  Glob: {
    patterns: ['glob', 'find file', 'file pattern', 'list files', 'Glob tool'],
    weight: 1,
  },
  WebFetch: {
    patterns: ['fetch', 'http', 'api call', 'url', 'WebFetch', 'download', 'request'],
    weight: 2,
  },
  WebSearch: {
    patterns: ['web search', 'search online', 'lookup online', 'WebSearch'],
    weight: 2,
  },
  Task: {
    patterns: ['Task(', 'Task tool', 'spawn agent', 'delegate to', 'subagent'],
    weight: 3,
  },
}

/**
 * Thresholds for optimization decisions
 */
const THRESHOLDS = {
  /** Maximum lines before recommending decomposition */
  maxLinesBeforeDecompose: 500,

  /** Minimum lines for an extractable section */
  minSectionLines: 50,

  /** Heavy tool usage count that suggests subagent */
  heavyToolUsageCount: 5,

  /** Sequential Task() calls that should be parallelized */
  sequentialTaskThreshold: 2,

  /** Minimum optimization score to recommend transformation */
  minTransformScore: 30,

  /** Large examples section threshold */
  largeExamplesThreshold: 200,
}

/**
 * Analyze a skill's content for optimization opportunities
 *
 * @param content - The full SKILL.md content
 * @returns Analysis of optimization potential
 */
export function analyzeSkill(content: string): SkillAnalysis {
  const lines = content.split('\n')
  const lineCount = lines.length

  // Analyze sections
  const { mainContentLines, examplesLines, sections } = analyzeSections(content)

  // Analyze tool usage
  const toolUsage = analyzeToolUsage(content)

  // Analyze Task() patterns
  const taskPatterns = analyzeTaskPatterns(content)

  // Find extractable sections
  const extractableSections = findExtractableSections(sections, lineCount)

  // Generate recommendations
  const recommendations = generateRecommendations(
    lineCount,
    mainContentLines,
    examplesLines,
    toolUsage,
    taskPatterns,
    extractableSections
  )

  // Calculate optimization score
  const optimizationScore = calculateOptimizationScore(
    lineCount,
    toolUsage,
    taskPatterns,
    recommendations
  )

  return {
    lineCount,
    mainContentLines,
    examplesLines,
    toolUsage,
    taskPatterns,
    extractableSections,
    recommendations,
    optimizationScore,
    shouldTransform: optimizationScore >= THRESHOLDS.minTransformScore,
  }
}

/**
 * Analyze sections within the skill content
 */
function analyzeSections(content: string): {
  mainContentLines: number
  examplesLines: number
  sections: Array<{ name: string; startLine: number; endLine: number; content: string }>
} {
  const lines = content.split('\n')
  const sections: Array<{ name: string; startLine: number; endLine: number; content: string }> = []

  let currentSection: { name: string; startLine: number; lines: string[] } | null = null
  let examplesStartLine = -1
  let examplesEndLine = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/)

    if (headerMatch) {
      // Save previous section
      if (currentSection) {
        sections.push({
          name: currentSection.name,
          startLine: currentSection.startLine,
          endLine: i - 1,
          content: currentSection.lines.join('\n'),
        })
      }

      currentSection = {
        name: headerMatch[2].trim(),
        startLine: i,
        lines: [],
      }

      // Track examples section
      const sectionName = headerMatch[2].toLowerCase()
      if (sectionName.includes('example') || sectionName.includes('usage')) {
        examplesStartLine = i
      }
    }

    if (currentSection) {
      currentSection.lines.push(line)
    }
  }

  // Save last section
  if (currentSection) {
    sections.push({
      name: currentSection.name,
      startLine: currentSection.startLine,
      endLine: lines.length - 1,
      content: currentSection.lines.join('\n'),
    })

    if (examplesStartLine >= 0 && examplesEndLine < 0) {
      examplesEndLine = lines.length - 1
    }
  }

  // Calculate line counts
  const examplesLines =
    examplesStartLine >= 0
      ? examplesEndLine - examplesStartLine + 1
      : estimateExamplesLines(content)
  const mainContentLines = lines.length - examplesLines

  return { mainContentLines, examplesLines, sections }
}

/**
 * Estimate examples lines by looking for code blocks
 */
function estimateExamplesLines(content: string): number {
  const codeBlockMatches = content.match(/```[\s\S]*?```/g) || []
  let totalLines = 0

  for (const block of codeBlockMatches) {
    totalLines += block.split('\n').length
  }

  return totalLines
}

/**
 * Analyze tool usage patterns in the content
 */
function analyzeToolUsage(content: string): ToolUsageAnalysis {
  const lowerContent = content.toLowerCase()
  const detectedTools: string[] = []
  let totalWeight = 0

  for (const [tool, config] of Object.entries(TOOL_PATTERNS)) {
    for (const pattern of config.patterns) {
      if (lowerContent.includes(pattern.toLowerCase())) {
        if (!detectedTools.includes(tool)) {
          detectedTools.push(tool)
          totalWeight += config.weight
        }
        break
      }
    }
  }

  // Count specific tool patterns
  const bashCommandCount = (content.match(/\b(npm|npx|git|docker|yarn|pnpm)\s/gi) || []).length
  const fileReadCount = (content.match(/\b(read|cat|head|tail|grep|find)\s/gi) || []).length
  const fileWriteCount = (content.match(/\b(write|edit|modify|create)\s+file/gi) || []).length

  // Determine if heavy tool usage suggests subagent
  const suggestsSubagent =
    bashCommandCount >= THRESHOLDS.heavyToolUsageCount ||
    fileReadCount + fileWriteCount >= THRESHOLDS.heavyToolUsageCount ||
    totalWeight >= 10

  // Calculate confidence
  const matchCount = detectedTools.length
  const confidence: 'high' | 'medium' | 'low' =
    matchCount >= 4 ? 'high' : matchCount >= 2 ? 'medium' : 'low'

  return {
    detectedTools,
    bashCommandCount,
    fileReadCount,
    fileWriteCount,
    suggestsSubagent,
    confidence,
  }
}

/**
 * Analyze Task() call patterns
 */
function analyzeTaskPatterns(content: string): TaskPatternAnalysis {
  // Find Task() calls
  const taskCalls = content.match(/Task\s*\([^)]+\)/g) || []
  const taskCallCount = taskCalls.length

  // Detect sequential patterns (Task calls on consecutive lines without batching)
  const lines = content.split('\n')
  let sequentialCalls = 0
  let consecutiveTaskLines = 0

  for (const line of lines) {
    if (line.includes('Task(') || line.includes('Task (')) {
      consecutiveTaskLines++
    } else if (consecutiveTaskLines > 0) {
      if (consecutiveTaskLines >= THRESHOLDS.sequentialTaskThreshold) {
        sequentialCalls += consecutiveTaskLines
      }
      consecutiveTaskLines = 0
    }
  }

  // Check for final sequence
  if (consecutiveTaskLines >= THRESHOLDS.sequentialTaskThreshold) {
    sequentialCalls += consecutiveTaskLines
  }

  const canBatch = sequentialCalls >= THRESHOLDS.sequentialTaskThreshold

  // Estimate savings from batching
  // Batching reduces context overhead by ~30-50%
  const batchSavingsPercent = canBatch ? Math.min(50, sequentialCalls * 10) : 0

  return {
    taskCallCount,
    sequentialCalls,
    canBatch,
    batchSavingsPercent,
  }
}

/**
 * Find sections that could be extracted as sub-skills
 */
function findExtractableSections(
  sections: Array<{ name: string; startLine: number; endLine: number; content: string }>,
  totalLines: number
): ExtractableSection[] {
  const extractable: ExtractableSection[] = []

  for (const section of sections) {
    const lineCount = section.endLine - section.startLine + 1

    // Skip small sections
    if (lineCount < THRESHOLDS.minSectionLines) {
      continue
    }

    // Calculate priority based on size relative to total
    const sizeRatio = lineCount / totalLines
    let priority = 3

    if (sizeRatio > 0.3) {
      priority = 1
    } else if (sizeRatio > 0.15) {
      priority = 2
    }

    // Determine reason for extraction
    let reason = ''
    const lowerName = section.name.toLowerCase()

    if (lowerName.includes('api') || lowerName.includes('reference')) {
      reason = 'API reference sections can be loaded on-demand'
    } else if (lowerName.includes('example') || lowerName.includes('usage')) {
      reason = 'Examples can be progressively disclosed'
    } else if (lowerName.includes('advanced') || lowerName.includes('configuration')) {
      reason = 'Advanced topics are rarely needed in initial context'
    } else if (lineCount > 100) {
      reason = 'Large section suitable for sub-skill extraction'
    } else {
      reason = 'Section size suggests separate loading benefit'
    }

    extractable.push({
      name: section.name,
      startLine: section.startLine,
      endLine: section.endLine,
      lineCount,
      priority,
      reason,
    })
  }

  // Sort by priority
  return extractable.sort((a, b) => a.priority - b.priority)
}

/**
 * Generate optimization recommendations
 */
function generateRecommendations(
  lineCount: number,
  mainContentLines: number,
  examplesLines: number,
  toolUsage: ToolUsageAnalysis,
  taskPatterns: TaskPatternAnalysis,
  extractableSections: ExtractableSection[]
): OptimizationRecommendation[] {
  const recommendations: OptimizationRecommendation[] = []

  // Recommend decomposition for large skills
  if (lineCount > THRESHOLDS.maxLinesBeforeDecompose) {
    const sectionNames = extractableSections.slice(0, 3).map((s) => s.name)
    recommendations.push({
      type: 'decompose',
      description: `Skill has ${lineCount} lines (threshold: ${THRESHOLDS.maxLinesBeforeDecompose}). Decompose into main SKILL.md + sub-skills.`,
      estimatedSavings: Math.min(70, Math.floor((lineCount - 400) / 10)),
      priority: 1,
      affectedAreas: sectionNames.length > 0 ? sectionNames : ['full-content'],
    })
  }

  // Recommend subagent for heavy tool usage
  if (toolUsage.suggestsSubagent) {
    recommendations.push({
      type: 'subagent',
      description: `Heavy tool usage detected (${toolUsage.bashCommandCount} bash, ${toolUsage.fileReadCount} reads). Generate companion subagent for context isolation.`,
      estimatedSavings: 40,
      priority: 2,
      affectedAreas: toolUsage.detectedTools,
    })
  }

  // Recommend parallelization for sequential Task() calls
  if (taskPatterns.canBatch) {
    recommendations.push({
      type: 'parallelize',
      description: `${taskPatterns.sequentialCalls} sequential Task() calls detected. Batch into single message for parallel execution.`,
      estimatedSavings: taskPatterns.batchSavingsPercent,
      priority: 2,
      affectedAreas: ['Task-calls'],
    })
  }

  // Recommend progressive disclosure for large examples
  if (examplesLines > THRESHOLDS.largeExamplesThreshold) {
    recommendations.push({
      type: 'progressive-disclosure',
      description: `Large examples section (${examplesLines} lines). Move to sub-skill for on-demand loading.`,
      estimatedSavings: Math.min(60, Math.floor(examplesLines / 5)),
      priority: 3,
      affectedAreas: ['examples'],
    })
  }

  // Sort by priority
  return recommendations.sort((a, b) => a.priority - b.priority)
}

/**
 * Calculate overall optimization score
 */
function calculateOptimizationScore(
  lineCount: number,
  toolUsage: ToolUsageAnalysis,
  taskPatterns: TaskPatternAnalysis,
  recommendations: OptimizationRecommendation[]
): number {
  let score = 0

  // Line count factor (0-40 points)
  if (lineCount > THRESHOLDS.maxLinesBeforeDecompose) {
    score += Math.min(40, Math.floor((lineCount - 400) / 10))
  } else if (lineCount > 300) {
    score += Math.floor((lineCount - 300) / 20)
  }

  // Tool usage factor (0-30 points)
  if (toolUsage.suggestsSubagent) {
    score += 20
  }
  score += Math.min(10, toolUsage.detectedTools.length * 2)

  // Task pattern factor (0-20 points)
  if (taskPatterns.canBatch) {
    score += Math.min(20, taskPatterns.sequentialCalls * 5)
  }

  // Recommendation impact (0-10 points)
  score += Math.min(10, recommendations.length * 3)

  return Math.min(100, score)
}

/**
 * Quick check if a skill needs transformation without full analysis
 *
 * @param content - The full SKILL.md content
 * @returns Whether quick transformation check passed
 */
export function quickTransformCheck(content: string): boolean {
  const lineCount = content.split('\n').length

  // Quick checks that indicate transformation needed
  if (lineCount > THRESHOLDS.maxLinesBeforeDecompose) {
    return true
  }

  // Check for heavy tool usage patterns
  const heavyToolPatterns = ['npm ', 'npx ', 'git ', 'docker', 'Bash(']
  let heavyToolCount = 0
  for (const pattern of heavyToolPatterns) {
    if (content.includes(pattern)) {
      heavyToolCount++
    }
  }
  if (heavyToolCount >= 3) {
    return true
  }

  // Check for sequential Task() calls
  const taskMatches = content.match(/Task\s*\(/g) || []
  if (taskMatches.length >= THRESHOLDS.sequentialTaskThreshold) {
    return true
  }

  return false
}

export default { analyzeSkill, quickTransformCheck }
