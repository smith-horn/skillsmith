/**
 * SMI-638: Session Checkpointing to Claude-Flow Memory
 *
 * Provides checkpoint data structures for session state persistence.
 * Integrates with claude-flow memory hooks for cross-session continuity.
 *
 * Security Fixes:
 * - SMI-660: Command injection prevention via file-based data transfer
 * - SMI-661: Prototype pollution prevention via input validation
 * - SMI-663: Cryptographically secure ID generation via crypto.randomUUID()
 */

import { randomUUID } from 'node:crypto'

/**
 * Status of a todo item in the checkpoint
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/**
 * Todo item snapshot
 */
export interface CheckpointTodo {
  id: string
  content: string
  status: TodoStatus
}

/**
 * File modification record
 */
export interface FileModification {
  path: string
  action: 'created' | 'modified' | 'deleted'
  timestamp: string
}

/**
 * Test execution result
 */
export interface TestResult {
  name: string
  passed: boolean
  duration: number
  timestamp: string
}

/**
 * Session checkpoint data structure
 * Designed to be compact (< 10KB) for efficient memory storage
 */
export interface SessionCheckpointData {
  /** Unique checkpoint identifier */
  id: string
  /** ISO timestamp of checkpoint creation */
  timestamp: string
  /** Session identifier for grouping checkpoints */
  sessionId: string
  /** Current working directory */
  workingDirectory: string
  /** Current git branch if in a git repo */
  branch?: string
  /** Files modified since last checkpoint */
  filesModified: FileModification[]
  /** Test results since last checkpoint */
  testsRun: TestResult[]
  /** Current todo list state */
  todos: CheckpointTodo[]
  /** Custom metadata for extensions */
  metadata?: Record<string, unknown>
}

/**
 * Dangerous keys that indicate prototype pollution attempts
 */
const DANGEROUS_KEYS = ['__proto__', 'prototype', 'constructor']

/**
 * Shell metacharacters that could enable command injection
 */
const SHELL_METACHAR_PATTERN = /[;|&$`\\'"<>(){}[\]!#*?~]/

/**
 * Pattern to detect prototype pollution in raw JSON strings
 * This catches attempts before JSON.parse can strip them
 */
const PROTOTYPE_POLLUTION_PATTERN = /"(__proto__|prototype|constructor)"\s*:/gi

/**
 * Validates raw JSON string for prototype pollution attempts BEFORE parsing
 * JSON.parse in modern engines may silently strip __proto__, so we must check raw input
 * @throws Error if dangerous keys are found in the raw JSON string
 */
function validateNoPrototypePollutionInRawJson(json: string): void {
  const match = json.match(PROTOTYPE_POLLUTION_PATTERN)
  if (match) {
    const key = match[0].match(/"([^"]+)"/)?.[1] ?? 'unknown'
    throw new Error(
      `Invalid or dangerous key "${key}" found in JSON. Prototype pollution attempt detected.`
    )
  }
}

/**
 * Validates that an object does not contain prototype pollution attempts
 * @throws Error if dangerous keys are found
 */
function validateNoPrototypePollution(obj: unknown, path = 'root'): void {
  if (obj === null || typeof obj !== 'object') {
    return
  }

  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      validateNoPrototypePollution(item, `${path}[${index}]`)
    })
    return
  }

  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.includes(key)) {
      throw new Error(
        `Invalid or dangerous key "${key}" found at ${path}. Prototype pollution attempt detected.`
      )
    }
    validateNoPrototypePollution((obj as Record<string, unknown>)[key], `${path}.${key}`)
  }
}

/**
 * Sanitizes a string for safe use in file paths and memory keys
 * Removes shell metacharacters to prevent command injection
 */
function sanitizeForPath(input: string): string {
  return input.replace(SHELL_METACHAR_PATTERN, '_')
}

/**
 * Generates a unique checkpoint ID using cryptographically secure random
 * SMI-663: Uses crypto.randomUUID() instead of Math.random()
 */
export function generateCheckpointId(): string {
  return `ckpt_${randomUUID()}`
}

/**
 * Generates a unique session ID using cryptographically secure random
 * SMI-663: Uses crypto.randomUUID() instead of Math.random()
 */
export function generateSessionId(): string {
  return `sess_${randomUUID()}`
}

/**
 * Session checkpoint with serialization methods
 */
export class SessionCheckpoint {
  private data: SessionCheckpointData

  constructor(
    data: Partial<SessionCheckpointData> & { sessionId: string; workingDirectory: string }
  ) {
    this.data = {
      id: data.id ?? generateCheckpointId(),
      timestamp: data.timestamp ?? new Date().toISOString(),
      sessionId: data.sessionId,
      workingDirectory: data.workingDirectory,
      branch: data.branch,
      filesModified: data.filesModified ?? [],
      testsRun: data.testsRun ?? [],
      todos: data.todos ?? [],
      metadata: data.metadata,
    }
  }

  /**
   * Get the checkpoint ID
   */
  get id(): string {
    return this.data.id
  }

  /**
   * Get the checkpoint timestamp
   */
  get timestamp(): string {
    return this.data.timestamp
  }

  /**
   * Get the session ID
   */
  get sessionId(): string {
    return this.data.sessionId
  }

  /**
   * Get all checkpoint data
   */
  getData(): Readonly<SessionCheckpointData> {
    return { ...this.data }
  }

  /**
   * Add a file modification record
   */
  addFileModification(file: FileModification): void {
    // Remove any existing record for this file
    this.data.filesModified = this.data.filesModified.filter((f) => f.path !== file.path)
    this.data.filesModified.push(file)
  }

  /**
   * Add a test result
   */
  addTestResult(test: TestResult): void {
    this.data.testsRun.push(test)
  }

  /**
   * Update todos snapshot
   */
  setTodos(todos: CheckpointTodo[]): void {
    this.data.todos = [...todos]
  }

  /**
   * Set custom metadata
   */
  setMetadata(key: string, value: unknown): void {
    if (!this.data.metadata) {
      this.data.metadata = {}
    }
    this.data.metadata[key] = value
  }

  /**
   * Serialize checkpoint to JSON string
   * Optimized for compact storage (< 10KB target)
   */
  serialize(): string {
    return JSON.stringify(this.data)
  }

  /**
   * Get serialized size in bytes
   */
  getSerializedSize(): number {
    return new TextEncoder().encode(this.serialize()).length
  }

  /**
   * Check if checkpoint exceeds size limit
   */
  exceedsSizeLimit(limitBytes: number = 10240): boolean {
    return this.getSerializedSize() > limitBytes
  }

  /**
   * Deserialize checkpoint from JSON string
   * SMI-661: Validates against prototype pollution before creating object
   * @throws Error if prototype pollution is detected
   */
  static deserialize(json: string): SessionCheckpoint {
    // SMI-661: Check raw string for prototype pollution BEFORE parsing
    // JSON.parse in modern engines strips __proto__, so we must check the raw input
    validateNoPrototypePollutionInRawJson(json)

    const data = JSON.parse(json) as unknown

    // Also validate the parsed object (for any keys that weren't stripped)
    validateNoPrototypePollution(data)

    return new SessionCheckpoint(data as SessionCheckpointData)
  }

  /**
   * Create checkpoint from raw data
   */
  static fromData(data: SessionCheckpointData): SessionCheckpoint {
    return new SessionCheckpoint(data)
  }

  /**
   * Generate claude-flow memory key for this checkpoint
   * SMI-660: Sanitizes session and checkpoint IDs to prevent injection
   */
  toMemoryKey(): string {
    const safeSessionId = sanitizeForPath(this.data.sessionId)
    const safeCheckpointId = sanitizeForPath(this.data.id)
    return `session/${safeSessionId}/checkpoint/${safeCheckpointId}`
  }

  /**
   * Generate claude-flow hook command for storing this checkpoint
   * SMI-660: Uses file-based data transfer instead of inline JSON
   * The actual data should be written to a temp file and passed via --file flag
   */
  toHookCommand(): string {
    const memoryKey = this.toMemoryKey()
    // SMI-660: Command no longer contains the data inline
    // Data should be passed via a secure temp file
    return `npx claude-flow@alpha hooks post-edit --memory-key "${memoryKey}" --file checkpoint.json`
  }

  /**
   * Get the arguments array for spawning subprocess
   * SMI-660: Returns array format for execFile instead of shell string
   */
  toHookArgs(): string[] {
    return [
      'claude-flow@alpha',
      'hooks',
      'post-edit',
      '--memory-key',
      this.toMemoryKey(),
      '--file',
      'checkpoint.json',
    ]
  }
}
