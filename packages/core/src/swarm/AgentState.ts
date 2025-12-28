/**
 * Agent State Management for Swarm Coordination
 * SMI-634: Swarm Coordination Improvements
 *
 * Tracks agent status, current task assignments, files being modified,
 * and heartbeat timestamps for multi-agent coordination.
 */

/**
 * Agent status enumeration
 */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'offline'

/**
 * Agent type categorization
 */
export type AgentType =
  | 'researcher'
  | 'coder'
  | 'tester'
  | 'reviewer'
  | 'architect'
  | 'documenter'
  | 'coordinator'
  | 'generic'

/**
 * Files currently being modified by an agent
 */
export interface FileModification {
  /** Absolute path to the file */
  path: string
  /** Type of modification */
  operation: 'read' | 'write' | 'delete'
  /** When the modification started */
  startedAt: number
}

/**
 * Current task assignment for an agent
 */
export interface TaskAssignment {
  /** Task ID */
  taskId: string
  /** Task description */
  description: string
  /** Priority level */
  priority: 'low' | 'medium' | 'high' | 'critical'
  /** When the task was assigned */
  assignedAt: number
  /** Expected completion time (optional) */
  estimatedCompletionAt?: number
}

/**
 * Full agent state representation
 */
export interface AgentStateData {
  /** Unique agent identifier */
  id: string
  /** Human-readable agent name */
  name: string
  /** Agent type/role */
  type: AgentType
  /** Current status */
  status: AgentStatus
  /** Current task assignment (if any) */
  currentTask: TaskAssignment | null
  /** Files currently being modified */
  modifiedFiles: FileModification[]
  /** Last heartbeat timestamp (epoch ms) */
  lastHeartbeat: number
  /** Agent capabilities/tags */
  capabilities: string[]
  /** Additional metadata */
  metadata: Record<string, unknown>
}

/**
 * AgentState class for managing individual agent state
 */
export class AgentState {
  private readonly data: AgentStateData
  private readonly heartbeatTimeoutMs: number

  constructor(
    id: string,
    name: string,
    type: AgentType = 'generic',
    options: {
      capabilities?: string[]
      metadata?: Record<string, unknown>
      heartbeatTimeoutMs?: number
    } = {}
  ) {
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30000 // 30s default
    this.data = {
      id,
      name,
      type,
      status: 'idle',
      currentTask: null,
      modifiedFiles: [],
      lastHeartbeat: Date.now(),
      capabilities: options.capabilities ?? [],
      metadata: options.metadata ?? {},
    }
  }

  /**
   * Get agent ID
   */
  get id(): string {
    return this.data.id
  }

  /**
   * Get agent name
   */
  get name(): string {
    return this.data.name
  }

  /**
   * Get agent type
   */
  get type(): AgentType {
    return this.data.type
  }

  /**
   * Get current status
   */
  get status(): AgentStatus {
    // Check if heartbeat has timed out
    if (Date.now() - this.data.lastHeartbeat > this.heartbeatTimeoutMs) {
      return 'offline'
    }
    return this.data.status
  }

  /**
   * Get current task assignment
   */
  get currentTask(): TaskAssignment | null {
    return this.data.currentTask
  }

  /**
   * Get files being modified
   */
  get modifiedFiles(): readonly FileModification[] {
    return this.data.modifiedFiles
  }

  /**
   * Get last heartbeat timestamp
   */
  get lastHeartbeat(): number {
    return this.data.lastHeartbeat
  }

  /**
   * Get agent capabilities
   */
  get capabilities(): readonly string[] {
    return this.data.capabilities
  }

  /**
   * Check if agent is available for work
   */
  isAvailable(): boolean {
    return this.status === 'idle'
  }

  /**
   * Check if agent is online (has recent heartbeat)
   */
  isOnline(): boolean {
    return this.status !== 'offline'
  }

  /**
   * Update heartbeat timestamp
   */
  heartbeat(): void {
    this.data.lastHeartbeat = Date.now()
  }

  /**
   * Set agent status
   */
  setStatus(status: AgentStatus): void {
    this.data.status = status
    this.heartbeat()
  }

  /**
   * Assign a task to this agent
   */
  assignTask(task: Omit<TaskAssignment, 'assignedAt'>): void {
    this.data.currentTask = {
      ...task,
      assignedAt: Date.now(),
    }
    this.data.status = 'working'
    this.heartbeat()
  }

  /**
   * Complete current task
   */
  completeTask(): TaskAssignment | null {
    const task = this.data.currentTask
    this.data.currentTask = null
    this.data.modifiedFiles = []
    this.data.status = 'idle'
    this.heartbeat()
    return task
  }

  /**
   * Mark agent as blocked
   */
  setBlocked(reason?: string): void {
    this.data.status = 'blocked'
    if (reason) {
      this.data.metadata.blockReason = reason
    }
    this.heartbeat()
  }

  /**
   * Start modifying a file
   */
  startFileModification(path: string, operation: FileModification['operation'] = 'write'): void {
    const existing = this.data.modifiedFiles.find((f) => f.path === path)
    if (!existing) {
      this.data.modifiedFiles.push({
        path,
        operation,
        startedAt: Date.now(),
      })
    }
    this.heartbeat()
  }

  /**
   * Complete file modification
   */
  completeFileModification(path: string): void {
    this.data.modifiedFiles = this.data.modifiedFiles.filter((f) => f.path !== path)
    this.heartbeat()
  }

  /**
   * Check if agent is modifying a specific file
   */
  isModifyingFile(path: string): boolean {
    return this.data.modifiedFiles.some((f) => f.path === path)
  }

  /**
   * Check if agent has a specific capability
   */
  hasCapability(capability: string): boolean {
    return this.data.capabilities.includes(capability)
  }

  /**
   * Add a capability
   */
  addCapability(capability: string): void {
    if (!this.data.capabilities.includes(capability)) {
      this.data.capabilities.push(capability)
    }
  }

  /**
   * Get full state snapshot
   */
  toJSON(): AgentStateData {
    return {
      ...this.data,
      status: this.status, // Use getter to check heartbeat timeout
    }
  }

  /**
   * Create AgentState from JSON data
   */
  static fromJSON(data: AgentStateData, heartbeatTimeoutMs?: number): AgentState {
    const agent = new AgentState(data.id, data.name, data.type, {
      capabilities: [...data.capabilities],
      metadata: { ...data.metadata },
      heartbeatTimeoutMs,
    })
    agent.data.status = data.status
    agent.data.currentTask = data.currentTask
    agent.data.modifiedFiles = [...data.modifiedFiles]
    agent.data.lastHeartbeat = data.lastHeartbeat
    return agent
  }
}
