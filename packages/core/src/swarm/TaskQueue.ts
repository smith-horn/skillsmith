/**
 * Task Queue for Swarm Coordination
 * SMI-634: Swarm Coordination Improvements
 *
 * Priority queue with dependency tracking, agent assignment,
 * and completion callbacks for multi-agent task orchestration.
 */

/**
 * Task priority levels
 */
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical'

/**
 * Task status enumeration
 */
export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'assigned'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * Task definition
 */
export interface Task {
  /** Unique task identifier */
  id: string
  /** Task description */
  description: string
  /** Priority level */
  priority: TaskPriority
  /** Current status */
  status: TaskStatus
  /** IDs of tasks this depends on */
  dependencies: string[]
  /** Required capabilities for assignment */
  requiredCapabilities: string[]
  /** Assigned agent ID (if assigned) */
  assignedTo: string | null
  /** When the task was created */
  createdAt: number
  /** When the task was assigned */
  assignedAt: number | null
  /** When the task started running */
  startedAt: number | null
  /** When the task completed */
  completedAt: number | null
  /** Task result (on completion) */
  result: unknown
  /** Error message (on failure) */
  error: string | null
  /** Additional metadata */
  metadata: Record<string, unknown>
}

/**
 * Task creation input
 */
export interface TaskInput {
  id?: string
  description: string
  priority?: TaskPriority
  dependencies?: string[]
  requiredCapabilities?: string[]
  metadata?: Record<string, unknown>
}

/**
 * Task completion callback
 */
export type TaskCallback = (task: Task, error?: Error) => void | Promise<void>

/**
 * Priority weight mapping
 */
const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
}

/**
 * Generate unique task ID
 */
function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * TaskQueue class for managing task queue with priority and dependencies
 */
export class TaskQueue {
  private readonly tasks: Map<string, Task> = new Map()
  private readonly completionCallbacks: Map<string, TaskCallback[]> = new Map()
  private readonly globalCallbacks: TaskCallback[] = []

  /**
   * Add a task to the queue
   */
  enqueue(input: TaskInput): Task {
    const taskId = input.id ?? generateTaskId()
    const dependencies = input.dependencies ?? []

    // SMI-669: Check for self-referencing task (circular dependency)
    if (dependencies.includes(taskId)) {
      throw new Error(`Circular dependency detected: task "${taskId}" depends on itself`)
    }

    // Validate dependencies exist
    for (const depId of dependencies) {
      if (!this.tasks.has(depId)) {
        throw new Error(`Dependency task not found: ${depId}`)
      }
    }

    // SMI-669: Check for circular dependencies in the dependency graph
    this.detectCycle(taskId, dependencies)

    const task: Task = {
      id: taskId,
      description: input.description,
      priority: input.priority ?? 'medium',
      status: 'pending',
      dependencies,
      requiredCapabilities: input.requiredCapabilities ?? [],
      assignedTo: null,
      createdAt: Date.now(),
      assignedAt: null,
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      metadata: input.metadata ?? {},
    }

    // Check if dependencies are complete
    const allDepsComplete = this.areDependenciesComplete(task.dependencies)
    task.status = allDepsComplete ? 'queued' : 'pending'

    this.tasks.set(task.id, task)
    return task
  }

  /**
   * SMI-669: Detect circular dependencies using DFS
   * Throws an error if adding the new task would create a cycle
   */
  private detectCycle(taskId: string, dependencies: string[]): void {
    const visited = new Set<string>()
    const path = new Set<string>()

    const hasCycle = (currentId: string): boolean => {
      // If we've seen this task in the current path, we have a cycle
      if (path.has(currentId)) return true
      // If we've already fully explored this task, no cycle from here
      if (visited.has(currentId)) return false

      visited.add(currentId)
      path.add(currentId)

      const task = this.tasks.get(currentId)
      if (task) {
        for (const depId of task.dependencies) {
          if (hasCycle(depId)) return true
        }
      }

      path.delete(currentId)
      return false
    }

    // Check if any dependency would create a cycle back to taskId
    // by checking if taskId is reachable from any dependency
    for (const depId of dependencies) {
      // Temporarily add taskId to the path to detect if dep reaches back to it
      path.clear()
      visited.clear()
      path.add(taskId)

      if (hasCycle(depId)) {
        throw new Error(`Circular dependency detected: task "${taskId}" creates a cycle`)
      }
    }
  }

  /**
   * Get a task by ID
   */
  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId)
  }

  /**
   * Get all tasks
   */
  getAll(): Task[] {
    return Array.from(this.tasks.values())
  }

  /**
   * Get tasks by status
   */
  getByStatus(status: TaskStatus): Task[] {
    return this.getAll().filter((t) => t.status === status)
  }

  /**
   * Get next available task for assignment based on priority and capabilities
   */
  getNextAvailable(agentCapabilities: string[] = []): Task | undefined {
    const available = this.getAll()
      .filter((t) => t.status === 'queued' && this.canAssign(t, agentCapabilities))
      .sort((a, b) => {
        // Sort by priority (descending), then by creation time (ascending)
        const priorityDiff = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]
        if (priorityDiff !== 0) return priorityDiff
        return a.createdAt - b.createdAt
      })

    return available[0]
  }

  /**
   * Check if a task can be assigned to an agent with given capabilities
   */
  canAssign(task: Task, agentCapabilities: string[]): boolean {
    if (task.status !== 'queued') return false
    if (!this.areDependenciesComplete(task.dependencies)) return false

    // Check required capabilities
    for (const cap of task.requiredCapabilities) {
      if (!agentCapabilities.includes(cap)) {
        return false
      }
    }

    return true
  }

  /**
   * Assign a task to an agent
   */
  assign(taskId: string, agentId: string): Task {
    const task = this.tasks.get(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }
    if (task.status !== 'queued') {
      throw new Error(`Task ${taskId} is not available for assignment (status: ${task.status})`)
    }

    task.status = 'assigned'
    task.assignedTo = agentId
    task.assignedAt = Date.now()

    return task
  }

  /**
   * Mark a task as running
   */
  start(taskId: string): Task {
    const task = this.tasks.get(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }
    if (task.status !== 'assigned') {
      throw new Error(`Task ${taskId} must be assigned before starting`)
    }

    task.status = 'running'
    task.startedAt = Date.now()

    return task
  }

  /**
   * Complete a task with result
   */
  async complete(taskId: string, result?: unknown): Promise<Task> {
    const task = this.tasks.get(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }

    task.status = 'completed'
    task.completedAt = Date.now()
    task.result = result ?? null

    // Update dependent tasks
    this.updateDependentTasks(taskId)

    // Execute callbacks
    await this.executeCallbacks(task)

    return task
  }

  /**
   * Fail a task with error
   */
  async fail(taskId: string, error: string | Error): Promise<Task> {
    const task = this.tasks.get(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }

    task.status = 'failed'
    task.completedAt = Date.now()
    task.error = error instanceof Error ? error.message : error

    // Execute callbacks with error
    await this.executeCallbacks(task, error instanceof Error ? error : new Error(error))

    return task
  }

  /**
   * Cancel a task
   */
  cancel(taskId: string): Task {
    const task = this.tasks.get(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }

    if (task.status === 'completed' || task.status === 'failed') {
      throw new Error(`Cannot cancel finished task: ${taskId}`)
    }

    task.status = 'cancelled'
    task.completedAt = Date.now()

    return task
  }

  /**
   * Unassign a task (return to queue)
   */
  unassign(taskId: string): Task {
    const task = this.tasks.get(taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }

    if (task.status !== 'assigned' && task.status !== 'running') {
      throw new Error(`Task ${taskId} is not assigned`)
    }

    task.status = 'queued'
    task.assignedTo = null
    task.assignedAt = null
    task.startedAt = null

    return task
  }

  /**
   * Register a callback for task completion
   */
  onComplete(taskId: string, callback: TaskCallback): void {
    const callbacks = this.completionCallbacks.get(taskId) ?? []
    callbacks.push(callback)
    this.completionCallbacks.set(taskId, callbacks)
  }

  /**
   * Register a global callback for all task completions
   */
  onAnyComplete(callback: TaskCallback): void {
    this.globalCallbacks.push(callback)
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    total: number
    pending: number
    queued: number
    assigned: number
    running: number
    completed: number
    failed: number
    cancelled: number
  } {
    const tasks = this.getAll()
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      queued: tasks.filter((t) => t.status === 'queued').length,
      assigned: tasks.filter((t) => t.status === 'assigned').length,
      running: tasks.filter((t) => t.status === 'running').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      cancelled: tasks.filter((t) => t.status === 'cancelled').length,
    }
  }

  /**
   * Clear completed tasks from queue
   */
  clearCompleted(): number {
    let cleared = 0
    for (const [id, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        this.tasks.delete(id)
        this.completionCallbacks.delete(id)
        cleared++
      }
    }
    return cleared
  }

  /**
   * Check if all dependencies are complete
   */
  private areDependenciesComplete(dependencies: string[]): boolean {
    for (const depId of dependencies) {
      const dep = this.tasks.get(depId)
      if (!dep || dep.status !== 'completed') {
        return false
      }
    }
    return true
  }

  /**
   * Update dependent tasks when a task completes
   */
  private updateDependentTasks(completedTaskId: string): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' && task.dependencies.includes(completedTaskId)) {
        if (this.areDependenciesComplete(task.dependencies)) {
          task.status = 'queued'
        }
      }
    }
  }

  /**
   * Execute callbacks for a task
   */
  private async executeCallbacks(task: Task, error?: Error): Promise<void> {
    // Task-specific callbacks
    const callbacks = this.completionCallbacks.get(task.id) ?? []
    for (const cb of callbacks) {
      try {
        await cb(task, error)
      } catch (e) {
        console.error(`Callback error for task ${task.id}:`, e)
      }
    }

    // Global callbacks
    for (const cb of this.globalCallbacks) {
      try {
        await cb(task, error)
      } catch (e) {
        console.error(`Global callback error for task ${task.id}:`, e)
      }
    }
  }

  /**
   * Export queue state for persistence
   */
  toJSON(): { tasks: Task[]; stats: ReturnType<TaskQueue['getStats']> } {
    return {
      tasks: this.getAll(),
      stats: this.getStats(),
    }
  }

  /**
   * Import queue state from persistence
   */
  static fromJSON(data: { tasks: Task[] }): TaskQueue {
    const queue = new TaskQueue()
    for (const task of data.tasks) {
      queue.tasks.set(task.id, task)
    }
    return queue
  }
}
