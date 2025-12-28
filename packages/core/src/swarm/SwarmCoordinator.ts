/**
 * Swarm Coordinator for Multi-Agent Orchestration
 * SMI-634: Swarm Coordination Improvements
 *
 * Provides agent registration and discovery, task assignment with load balancing,
 * progress aggregation, and conflict detection for parallel development sessions.
 */

import { AgentState, AgentStateData, AgentType, AgentStatus } from './AgentState.js'
import { TaskQueue, Task, TaskInput, TaskPriority, TaskCallback } from './TaskQueue.js'

/**
 * Agent registration input
 */
export interface AgentRegistration {
  id?: string
  name: string
  type: AgentType
  capabilities?: string[]
  metadata?: Record<string, unknown>
}

/**
 * File conflict information
 */
export interface FileConflict {
  /** File path with conflict */
  path: string
  /** Agents modifying this file */
  agents: Array<{ id: string; name: string; operation: string }>
  /** When conflict was detected */
  detectedAt: number
}

/**
 * Swarm progress summary
 */
export interface SwarmProgress {
  /** Total agents registered */
  totalAgents: number
  /** Agents currently working */
  workingAgents: number
  /** Agents available for work */
  idleAgents: number
  /** Agents blocked */
  blockedAgents: number
  /** Agents offline */
  offlineAgents: number
  /** Task queue statistics */
  tasks: {
    total: number
    pending: number
    queued: number
    running: number
    completed: number
    failed: number
  }
  /** Active file conflicts */
  conflicts: FileConflict[]
  /** Overall completion percentage */
  completionPercent: number
}

/**
 * Load balancing strategy
 */
export type LoadBalanceStrategy = 'round-robin' | 'least-loaded' | 'capability-match' | 'random'

/**
 * Coordinator configuration
 */
export interface CoordinatorConfig {
  /** Heartbeat timeout in milliseconds */
  heartbeatTimeoutMs?: number
  /** Load balancing strategy */
  loadBalanceStrategy?: LoadBalanceStrategy
  /** Whether to auto-assign tasks */
  autoAssign?: boolean
  /** Maximum tasks per agent */
  maxTasksPerAgent?: number
  /** SMI-671: Maximum number of agents allowed */
  maxAgents?: number
  /** SMI-671: Maximum number of queued tasks allowed */
  maxQueuedTasks?: number
}

/**
 * Generate unique agent ID
 */
function generateAgentId(): string {
  return `agent_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * SwarmCoordinator class for multi-agent orchestration
 */
export class SwarmCoordinator {
  private readonly agents: Map<string, AgentState> = new Map()
  private readonly taskQueue: TaskQueue
  private readonly config: Required<CoordinatorConfig>
  private roundRobinIndex = 0

  constructor(config: CoordinatorConfig = {}) {
    this.config = {
      heartbeatTimeoutMs: config.heartbeatTimeoutMs ?? 30000,
      loadBalanceStrategy: config.loadBalanceStrategy ?? 'capability-match',
      autoAssign: config.autoAssign ?? true,
      maxTasksPerAgent: config.maxTasksPerAgent ?? 3,
      maxAgents: config.maxAgents ?? Infinity,
      maxQueuedTasks: config.maxQueuedTasks ?? Infinity,
    }
    this.taskQueue = new TaskQueue()
  }

  // ========== Agent Management ==========

  /**
   * Register a new agent with the swarm
   */
  registerAgent(input: AgentRegistration): AgentState {
    const id = input.id ?? generateAgentId()

    if (this.agents.has(id)) {
      throw new Error(`Agent already registered: ${id}`)
    }

    // SMI-671: Check maximum agents limit
    if (this.agents.size >= this.config.maxAgents) {
      throw new Error(
        `Cannot register agent: maximum agents limit (${this.config.maxAgents}) reached`
      )
    }

    const agent = new AgentState(id, input.name, input.type, {
      capabilities: input.capabilities,
      metadata: input.metadata,
      heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
    })

    this.agents.set(id, agent)

    // Auto-assign pending tasks if enabled
    if (this.config.autoAssign) {
      this.tryAutoAssign()
    }

    return agent
  }

  /**
   * Unregister an agent from the swarm
   */
  unregisterAgent(agentId: string): boolean {
    const agent = this.agents.get(agentId)
    if (!agent) return false

    // Unassign any active tasks
    const task = agent.currentTask
    if (task) {
      this.taskQueue.unassign(task.taskId)
    }

    return this.agents.delete(agentId)
  }

  /**
   * Get an agent by ID
   */
  getAgent(agentId: string): AgentState | undefined {
    return this.agents.get(agentId)
  }

  /**
   * Get all registered agents
   */
  getAgents(): AgentState[] {
    return Array.from(this.agents.values())
  }

  /**
   * Get agents by status
   */
  getAgentsByStatus(status: AgentStatus): AgentState[] {
    return this.getAgents().filter((a) => a.status === status)
  }

  /**
   * Get agents by type
   */
  getAgentsByType(type: AgentType): AgentState[] {
    return this.getAgents().filter((a) => a.type === type)
  }

  /**
   * Get available agents (idle and online)
   */
  getAvailableAgents(): AgentState[] {
    return this.getAgents().filter((a) => a.isAvailable() && a.isOnline())
  }

  /**
   * Update agent heartbeat
   */
  heartbeat(agentId: string): boolean {
    const agent = this.agents.get(agentId)
    if (!agent) return false
    agent.heartbeat()
    return true
  }

  /**
   * Discover agents by capability
   */
  discoverAgents(requiredCapabilities: string[]): AgentState[] {
    return this.getAgents().filter((agent) => {
      if (!agent.isOnline()) return false
      return requiredCapabilities.every((cap) => agent.hasCapability(cap))
    })
  }

  // ========== Task Management ==========

  /**
   * Add a task to the queue
   */
  addTask(input: TaskInput): Task {
    // SMI-671: Check maximum queued tasks limit
    // Count only non-completed tasks (pending, queued, assigned, running)
    const activeTasks = this.taskQueue
      .getAll()
      .filter((t) => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled')
    if (activeTasks.length >= this.config.maxQueuedTasks) {
      throw new Error(
        `Cannot add task: maximum queued tasks limit (${this.config.maxQueuedTasks}) reached`
      )
    }

    const task = this.taskQueue.enqueue(input)

    // Auto-assign if enabled
    if (this.config.autoAssign) {
      this.tryAutoAssign()
    }

    return task
  }

  /**
   * Get a task by ID
   */
  getTask(taskId: string): Task | undefined {
    return this.taskQueue.get(taskId)
  }

  /**
   * Get all tasks
   */
  getTasks(): Task[] {
    return this.taskQueue.getAll()
  }

  /**
   * Assign a specific task to a specific agent
   */
  assignTask(taskId: string, agentId: string): Task {
    const agent = this.agents.get(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    if (!agent.isAvailable()) {
      throw new Error(`Agent ${agentId} is not available (status: ${agent.status})`)
    }

    const task = this.taskQueue.assign(taskId, agentId)
    agent.assignTask({
      taskId: task.id,
      description: task.description,
      priority: task.priority,
    })

    return task
  }

  /**
   * SMI-670: Atomically claim the next available task for an agent
   * This prevents race conditions where multiple agents try to claim the same task
   * Returns null if no suitable task is available
   */
  claimTask(agentId: string): Task | null {
    const agent = this.agents.get(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    if (!agent.isAvailable()) {
      return null
    }

    // Get the next available task matching the agent's capabilities
    const task = this.taskQueue.getNextAvailable([...agent.capabilities])
    if (!task) {
      return null
    }

    // Atomically assign the task (will throw if task was already assigned)
    try {
      const assigned = this.taskQueue.assign(task.id, agentId)
      agent.assignTask({
        taskId: assigned.id,
        description: assigned.description,
        priority: assigned.priority,
      })
      return assigned
    } catch {
      // Task was claimed by another agent, return null
      return null
    }
  }

  /**
   * Start a task (mark as running)
   */
  startTask(taskId: string): Task {
    return this.taskQueue.start(taskId)
  }

  /**
   * Complete a task
   */
  async completeTask(taskId: string, result?: unknown): Promise<Task> {
    const task = await this.taskQueue.complete(taskId, result)

    // Update agent state
    if (task.assignedTo) {
      const agent = this.agents.get(task.assignedTo)
      if (agent) {
        agent.completeTask()
      }
    }

    // Auto-assign next tasks
    if (this.config.autoAssign) {
      this.tryAutoAssign()
    }

    return task
  }

  /**
   * Fail a task
   */
  async failTask(taskId: string, error: string | Error): Promise<Task> {
    const task = await this.taskQueue.fail(taskId, error)

    // Update agent state
    if (task.assignedTo) {
      const agent = this.agents.get(task.assignedTo)
      if (agent) {
        agent.completeTask()
      }
    }

    // Auto-assign next tasks
    if (this.config.autoAssign) {
      this.tryAutoAssign()
    }

    return task
  }

  /**
   * Register task completion callback
   */
  onTaskComplete(taskId: string, callback: TaskCallback): void {
    this.taskQueue.onComplete(taskId, callback)
  }

  /**
   * Register global task completion callback
   */
  onAnyTaskComplete(callback: TaskCallback): void {
    this.taskQueue.onAnyComplete(callback)
  }

  // ========== Load Balancing ==========

  /**
   * Select best agent for a task based on load balancing strategy
   */
  selectAgent(task: Task): AgentState | undefined {
    const available = this.getAvailableAgents().filter((agent) =>
      task.requiredCapabilities.every((cap) => agent.hasCapability(cap))
    )

    if (available.length === 0) return undefined

    switch (this.config.loadBalanceStrategy) {
      case 'round-robin':
        return this.selectRoundRobin(available)

      case 'least-loaded':
        return this.selectLeastLoaded(available)

      case 'capability-match':
        return this.selectBestCapabilityMatch(available, task)

      case 'random':
        return available[Math.floor(Math.random() * available.length)]

      default:
        return available[0]
    }
  }

  private selectRoundRobin(agents: AgentState[]): AgentState {
    const agent = agents[this.roundRobinIndex % agents.length]
    this.roundRobinIndex++
    return agent
  }

  private selectLeastLoaded(agents: AgentState[]): AgentState {
    // In this simple model, all available agents have no tasks
    // So just pick the first one (could be enhanced with task history)
    return agents[0]
  }

  private selectBestCapabilityMatch(agents: AgentState[], task: Task): AgentState {
    // Score agents by number of matching capabilities beyond required
    const scored = agents.map((agent) => ({
      agent,
      score: agent.capabilities.filter((cap) => task.requiredCapabilities.includes(cap)).length,
    }))

    scored.sort((a, b) => b.score - a.score)
    return scored[0].agent
  }

  /**
   * Auto-assign queued tasks to available agents
   */
  private tryAutoAssign(): void {
    const available = this.getAvailableAgents()

    for (const agent of available) {
      const task = this.taskQueue.getNextAvailable([...agent.capabilities])
      if (task) {
        try {
          this.assignTask(task.id, agent.id)
        } catch {
          // Agent or task may have become unavailable
          continue
        }
      }
    }
  }

  // ========== Conflict Detection ==========

  /**
   * Register that an agent is starting to modify a file
   */
  startFileEdit(agentId: string, filePath: string): FileConflict | null {
    const agent = this.agents.get(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    // Register the modification first
    agent.startFileModification(filePath, 'write')

    // Then check for conflicts (includes the newly registered agent)
    return this.checkFileConflict(filePath)
  }

  /**
   * Register that an agent finished modifying a file
   */
  endFileEdit(agentId: string, filePath: string): void {
    const agent = this.agents.get(agentId)
    if (agent) {
      agent.completeFileModification(filePath)
    }
  }

  /**
   * Check if a file has conflicts (multiple agents editing)
   */
  checkFileConflict(filePath: string): FileConflict | null {
    const modifiers: FileConflict['agents'] = []

    for (const agent of this.agents.values()) {
      if (agent.isModifyingFile(filePath)) {
        const modification = agent.modifiedFiles.find((f) => f.path === filePath)
        modifiers.push({
          id: agent.id,
          name: agent.name,
          operation: modification?.operation ?? 'write',
        })
      }
    }

    if (modifiers.length > 1) {
      return {
        path: filePath,
        agents: modifiers,
        detectedAt: Date.now(),
      }
    }

    return null
  }

  /**
   * Get all current file conflicts
   */
  getAllConflicts(): FileConflict[] {
    const filePaths = new Set<string>()

    // Collect all files being modified
    for (const agent of this.agents.values()) {
      for (const mod of agent.modifiedFiles) {
        filePaths.add(mod.path)
      }
    }

    // Check each file for conflicts
    const conflicts: FileConflict[] = []
    for (const path of filePaths) {
      const conflict = this.checkFileConflict(path)
      if (conflict) {
        conflicts.push(conflict)
      }
    }

    return conflicts
  }

  // ========== Progress Aggregation ==========

  /**
   * Get swarm progress summary
   */
  getProgress(): SwarmProgress {
    const agents = this.getAgents()
    const taskStats = this.taskQueue.getStats()
    const conflicts = this.getAllConflicts()

    // Count agent statuses
    const statusCounts = {
      working: 0,
      idle: 0,
      blocked: 0,
      offline: 0,
    }

    for (const agent of agents) {
      const status = agent.status
      if (status === 'working') statusCounts.working++
      else if (status === 'idle') statusCounts.idle++
      else if (status === 'blocked') statusCounts.blocked++
      else if (status === 'offline') statusCounts.offline++
    }

    // Calculate completion percentage
    const totalTasks =
      taskStats.completed +
      taskStats.failed +
      taskStats.running +
      taskStats.queued +
      taskStats.pending
    const completedTasks = taskStats.completed
    const completionPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

    return {
      totalAgents: agents.length,
      workingAgents: statusCounts.working,
      idleAgents: statusCounts.idle,
      blockedAgents: statusCounts.blocked,
      offlineAgents: statusCounts.offline,
      tasks: {
        total: taskStats.total,
        pending: taskStats.pending,
        queued: taskStats.queued,
        running: taskStats.running,
        completed: taskStats.completed,
        failed: taskStats.failed,
      },
      conflicts,
      completionPercent,
    }
  }

  // ========== Serialization ==========

  /**
   * Export coordinator state for persistence
   */
  toJSON(): {
    agents: AgentStateData[]
    tasks: ReturnType<TaskQueue['toJSON']>
    config: Required<CoordinatorConfig>
  } {
    return {
      agents: this.getAgents().map((a) => a.toJSON()),
      tasks: this.taskQueue.toJSON(),
      config: this.config,
    }
  }

  /**
   * Create coordinator from persisted state
   */
  static fromJSON(data: ReturnType<SwarmCoordinator['toJSON']>): SwarmCoordinator {
    const coordinator = new SwarmCoordinator(data.config)

    // Restore agents
    for (const agentData of data.agents) {
      const agent = AgentState.fromJSON(agentData, data.config.heartbeatTimeoutMs)
      coordinator.agents.set(agent.id, agent)
    }

    // Restore tasks
    const taskQueue = TaskQueue.fromJSON(data.tasks)
    // Replace internal task queue (access private readonly field)
    ;(coordinator as unknown as { taskQueue: TaskQueue }).taskQueue = taskQueue

    return coordinator
  }
}
