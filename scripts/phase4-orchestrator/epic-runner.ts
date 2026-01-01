/**
 * Epic Runner Module
 *
 * Executes a single epic using claude-flow hive mind:
 * - Spawns specialist agents based on sub-issue labels
 * - Resolves dependencies between sub-issues
 * - Stores results in memory for cross-session persistence
 */

import { spawn } from 'child_process'
import { Epic, SubIssue, SPECIALISTS, CONFIG } from './config.js'

export interface EpicResult {
  epicId: string
  success: boolean
  completedSubIssues: string[]
  failedSubIssues: string[]
  artifacts: string[]
  errors: string[]
  duration: number
}

export interface AgentTask {
  subIssue: SubIssue
  prompt: string
  outputPath: string
}

/**
 * Resolve sub-issue execution order based on dependencies
 */
export function resolveExecutionOrder(subIssues: SubIssue[]): SubIssue[][] {
  const completed = new Set<string>()
  const batches: SubIssue[][] = []

  while (completed.size < subIssues.length) {
    const batch = subIssues.filter((issue) => {
      if (completed.has(issue.title)) return false

      const deps = issue.dependencies || []
      return deps.every((dep) => completed.has(dep))
    })

    if (batch.length === 0) {
      // Circular dependency or unresolvable
      const remaining = subIssues.filter((i) => !completed.has(i.title))
      console.warn(
        `[EpicRunner] Warning: Could not resolve dependencies for: ${remaining.map((r) => r.title).join(', ')}`
      )
      batches.push(remaining)
      break
    }

    batches.push(batch)
    batch.forEach((issue) => completed.add(issue.title))
  }

  return batches
}

/**
 * Generate agent prompt for a sub-issue
 */
function generateAgentPrompt(subIssue: SubIssue, epic: Epic, memoryContext: string): string {
  return `# Task: ${subIssue.title}

## Context
You are a ${subIssue.specialist} working on Phase 4 of Skillsmith.
Epic: ${epic.title}
Priority: ${subIssue.priority}

## Previous Context (from memory)
${memoryContext || 'No previous context available.'}

## Task Description
${subIssue.description}

## Skillsmith Codebase Location
${CONFIG.skillsmithPath}

## Key Files to Reference
- packages/core/src/analysis/CodebaseAnalyzer.ts - Existing context detection
- packages/core/src/matching/SkillMatcher.ts - Recommendation logic
- packages/mcp-server/src/tools/recommend.ts - Current recommend tool
- packages/core/src/security/scanner.ts - Security patterns

## Requirements
1. Follow existing Skillsmith patterns and conventions
2. Write TypeScript with strict mode
3. Include JSDoc comments for public APIs
4. Create tests for new functionality (target 80% coverage)
5. Store key decisions in memory for next tasks

## Output Format
1. Implementation code (if applicable)
2. Design documentation (if design task)
3. Key decisions made
4. Files created/modified
5. Dependencies on other tasks

## Memory Storage
After completing, store results using:
- Key: phase4/${epic.id}/${subIssue.title.toLowerCase().replace(/\\s+/g, '-')}
- Include: decisions, artifacts, blockers discovered

Begin implementation.`
}

/**
 * Execute a single sub-issue using claude-flow agent
 */
async function executeSubIssue(
  task: AgentTask,
  epic: Epic,
  memoryContext: string,
  dryRun: boolean
): Promise<{ success: boolean; output: string; artifacts: string[] }> {
  const prompt = generateAgentPrompt(task.subIssue, epic, memoryContext)
  const specialist = SPECIALISTS[task.subIssue.specialist] || SPECIALISTS['Backend Specialist']

  if (dryRun) {
    console.log(`[DryRun] Would execute: ${task.subIssue.title}`)
    console.log(`[DryRun] Agent type: ${specialist.type}`)
    console.log(`[DryRun] Capabilities: ${specialist.capabilities.join(', ')}`)
    return { success: true, output: '[DryRun] Simulated completion', artifacts: [] }
  }

  return new Promise((resolve) => {
    const args = [
      'claude-flow',
      'sparc',
      'run',
      specialist.type === 'coder'
        ? 'coder'
        : specialist.type === 'researcher'
          ? 'researcher'
          : 'analyst',
      prompt,
      '--output',
      task.outputPath,
    ]

    console.log(`[EpicRunner] Spawning agent for: ${task.subIssue.title}`)

    const proc = spawn('npx', args, {
      cwd: CONFIG.skillsmithPath,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      resolve({
        success: false,
        output: `Timeout after ${CONFIG.sessionTimeout}ms`,
        artifacts: [],
      })
    }, CONFIG.sessionTimeout)

    proc.on('close', (code) => {
      clearTimeout(timeout)
      resolve({
        success: code === 0,
        output: stdout || stderr,
        artifacts: extractArtifacts(stdout),
      })
    })

    proc.on('error', (err) => {
      clearTimeout(timeout)
      resolve({
        success: false,
        output: err.message,
        artifacts: [],
      })
    })
  })
}

/**
 * Extract artifact paths from agent output
 */
function extractArtifacts(output: string): string[] {
  const artifacts: string[] = []

  // Match file creation patterns
  const filePatterns = [
    /(?:Created|Wrote|Generated):\s*([^\s\n]+\.(?:ts|js|json|md))/gi,
    /File:\s*([^\s\n]+\.(?:ts|js|json|md))/gi,
  ]

  for (const pattern of filePatterns) {
    const matches = output.matchAll(pattern)
    for (const match of matches) {
      if (match[1]) artifacts.push(match[1])
    }
  }

  return [...new Set(artifacts)]
}

/**
 * Store epic results in claude-flow memory
 */
async function storeInMemory(
  epicId: string,
  key: string,
  value: object,
  dryRun: boolean
): Promise<void> {
  if (dryRun) {
    console.log(`[DryRun] Would store in memory: ${CONFIG.memoryNamespace}/${epicId}/${key}`)
    return
  }

  return new Promise((resolve, reject) => {
    const memoryValue = JSON.stringify(value)
    const proc = spawn(
      'npx',
      [
        'claude-flow',
        'memory',
        'store',
        `${epicId}/${key}`,
        memoryValue,
        '--namespace',
        CONFIG.memoryNamespace,
      ],
      {
        cwd: CONFIG.skillsmithPath,
        stdio: 'inherit',
      }
    )

    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Memory store failed with code ${code}`))
    })

    proc.on('error', reject)
  })
}

/**
 * Retrieve context from memory for an epic
 */
async function retrieveMemoryContext(epicId: string, dryRun: boolean): Promise<string> {
  if (dryRun) {
    return '[DryRun] Simulated memory context'
  }

  return new Promise((resolve) => {
    const proc = spawn(
      'npx',
      [
        'claude-flow',
        'memory',
        'get',
        `${epicId}/decisions`,
        '--namespace',
        CONFIG.memoryNamespace,
      ],
      {
        cwd: CONFIG.skillsmithPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )

    let output = ''
    proc.stdout?.on('data', (data) => {
      output += data.toString()
    })

    proc.on('close', () => {
      resolve(output || 'No previous context.')
    })

    proc.on('error', () => {
      resolve('No previous context.')
    })
  })
}

/**
 * Run a complete epic with all sub-issues
 */
export async function runEpic(epic: Epic, dryRun = false): Promise<EpicResult> {
  const startTime = Date.now()
  const result: EpicResult = {
    epicId: epic.id,
    success: true,
    completedSubIssues: [],
    failedSubIssues: [],
    artifacts: [],
    errors: [],
    duration: 0,
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`[EpicRunner] Starting: ${epic.title}`)
  console.log(`${'='.repeat(60)}\n`)

  // Resolve execution order
  const batches = resolveExecutionOrder(epic.subIssues)
  console.log(`[EpicRunner] Execution plan: ${batches.length} batches`)
  batches.forEach((batch, i) => {
    console.log(`  Batch ${i + 1}: ${batch.map((s) => s.title).join(', ')}`)
  })

  // Retrieve any existing context from previous runs
  const memoryContext = await retrieveMemoryContext(epic.id, dryRun)

  // Execute batches sequentially
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx]
    console.log(`\n[EpicRunner] Executing batch ${batchIdx + 1}/${batches.length}`)

    // Execute sub-issues in batch (could be parallelized within batch)
    for (const subIssue of batch) {
      console.log(`\n[EpicRunner] Sub-issue: ${subIssue.title}`)

      const task: AgentTask = {
        subIssue,
        prompt: '',
        outputPath: `${CONFIG.skillsmithPath}/output/${epic.id}/${subIssue.title.toLowerCase().replace(/\s+/g, '-')}`,
      }

      const subResult = await executeSubIssue(task, epic, memoryContext, dryRun)

      if (subResult.success) {
        result.completedSubIssues.push(subIssue.title)
        result.artifacts.push(...subResult.artifacts)
        console.log(`[EpicRunner] ✅ Completed: ${subIssue.title}`)
      } else {
        result.failedSubIssues.push(subIssue.title)
        result.errors.push(`${subIssue.title}: ${subResult.output}`)
        console.log(`[EpicRunner] ❌ Failed: ${subIssue.title}`)

        // Critical failures stop the epic
        if (subIssue.priority === 'critical') {
          result.success = false
          console.log(`[EpicRunner] Critical failure - stopping epic`)
          break
        }
      }
    }

    if (!result.success) break
  }

  // Store results in memory
  await storeInMemory(
    epic.id,
    'results',
    {
      completed: result.completedSubIssues,
      failed: result.failedSubIssues,
      artifacts: result.artifacts,
      timestamp: new Date().toISOString(),
    },
    dryRun
  )

  result.duration = Date.now() - startTime
  console.log(`\n[EpicRunner] Epic completed in ${(result.duration / 1000).toFixed(1)}s`)
  console.log(`[EpicRunner] Success: ${result.success}`)
  console.log(
    `[EpicRunner] Completed: ${result.completedSubIssues.length}/${epic.subIssues.length}`
  )

  return result
}
