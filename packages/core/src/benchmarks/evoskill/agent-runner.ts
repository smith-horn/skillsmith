// EvoSkill agent runner — SMI-3271
// Executes benchmark tasks via Claude API with exponential backoff

import type { BenchmarkTask } from './types.js'
import { EVOSKILL_DEFAULTS } from './types.js'

/** Token usage for a single task execution */
export interface TaskTokenUsage {
  inputTokens: number
  outputTokens: number
}

/** Result of running a single task */
export interface TaskResult {
  taskId: string
  predicted: string
  tokens: TaskTokenUsage
  durationMs: number
  error?: string
}

/** Client interface for Claude API calls — injected to avoid SDK dependency in core */
export interface AgentClient {
  runTask(params: {
    model: string
    systemPrompt: string
    userMessage: string
    maxTokens: number
    temperature: number
    timeoutMs: number
  }): Promise<{
    content: string
    inputTokens: number
    outputTokens: number
  }>
}

export interface AgentRunnerConfig {
  client: AgentClient
  modelId: string
  skills: string[]
  timeoutMs?: number
}

/**
 * Run a single benchmark task through the agent.
 * Skills are injected as system prompt prefix.
 */
export async function runEvoSkillTask(
  task: BenchmarkTask,
  config: AgentRunnerConfig
): Promise<TaskResult> {
  const { client, modelId, skills, timeoutMs = EVOSKILL_DEFAULTS.TASK_TIMEOUT_MS } = config
  const start = Date.now()

  const systemPrompt = buildSystemPrompt(skills)

  try {
    const response = await callWithRetry(
      () =>
        client.runTask({
          model: modelId,
          systemPrompt,
          userMessage: task.question,
          maxTokens: 1024,
          temperature: 0,
          timeoutMs,
        }),
      EVOSKILL_DEFAULTS.RETRY_DELAYS
    )

    return {
      taskId: task.id,
      predicted: response.content.trim(),
      tokens: {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      },
      durationMs: Date.now() - start,
    }
  } catch (err) {
    return {
      taskId: task.id,
      predicted: '',
      tokens: { inputTokens: 0, outputTokens: 0 },
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Run all tasks in a batch, sequentially to respect rate limits */
export async function runEvoSkillBatch(
  tasks: BenchmarkTask[],
  config: AgentRunnerConfig,
  onProgress?: (completed: number, total: number, taskResult: TaskResult) => void
): Promise<TaskResult[]> {
  const results: TaskResult[] = []

  for (let i = 0; i < tasks.length; i++) {
    const result = await runEvoSkillTask(tasks[i], config)
    results.push(result)
    onProgress?.(i + 1, tasks.length, result)
  }

  return results
}

// Base prompt matching Python SEAL-QA agent (prompt.txt)
const RESEARCH_PROMPT =
  'You are an expert research assistant. You will answer questions using web search and information retrieval. Search for relevant information, cross-reference multiple sources, and provide accurate, well-sourced answers. Always verify claims against authoritative sources before responding.'

/** Build system prompt from skill contents */
function buildSystemPrompt(skills: string[]): string {
  if (skills.length === 0) {
    return RESEARCH_PROMPT
  }

  const skillBlock = skills.map((s, i) => `<skill index="${i + 1}">\n${s}\n</skill>`).join('\n\n')

  return `${RESEARCH_PROMPT}\n\nYou also have the following skills available. Use them to help answer the question.\n\n${skillBlock}`
}

/** Call with exponential backoff on rate limit (429) errors */
async function callWithRetry<T>(fn: () => Promise<T>, delays: readonly number[]): Promise<T> {
  let lastError: Error | undefined

  // First attempt (no delay)
  try {
    return await fn()
  } catch (err) {
    if (!isRateLimitError(err)) throw err
    lastError = err instanceof Error ? err : new Error(String(err))
  }

  // Retry attempts with exponential backoff
  for (const delay of delays) {
    await sleep(delay)
    try {
      return await fn()
    } catch (err) {
      if (!isRateLimitError(err)) throw err
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  throw lastError ?? new Error('All retries exhausted')
}

function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.includes('429') || err.message.toLowerCase().includes('rate limit')
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Calculate cost in dollars from token counts */
export function calculateCost(tokens: TaskTokenUsage, modelId: string): number {
  const pricing = MODEL_PRICING[modelId] ?? MODEL_PRICING['default']
  return tokens.inputTokens * pricing.inputPerToken + tokens.outputTokens * pricing.outputPerToken
}

/** Per-token pricing (dollars) — updated for current models */
const MODEL_PRICING: Record<string, { inputPerToken: number; outputPerToken: number }> = {
  'claude-sonnet-4-6': { inputPerToken: 3e-6, outputPerToken: 15e-6 },
  'claude-opus-4-6': { inputPerToken: 15e-6, outputPerToken: 75e-6 },
  default: { inputPerToken: 3e-6, outputPerToken: 15e-6 },
}
